"""kitab-lens's ChatGPTSelenium subclass: a profile of its own, and no input().

KITAB's ChatGPTSelenium is a CLI tool: when the composer never shows up on the very
first run (a login/verification wall), `_wait_for_composer(first_run=True)` prints a
message and blocks on `input()` until a human presses Enter in the terminal. A
server has no terminal to type into, so that call would hang the request (and every
request queued behind it) forever.

This subclass keeps everything else -- the lock-serialized invoke(), the clipboard
interception, the reply-reading fallbacks -- and replaces only that one blocking
path: instead of input(), it flips a `needs_attention` flag (so /api/status can
report it and the frontend can prompt "check the Chrome window on the Mac") and
polls for the composer for up to `NEEDS_ATTENTION_TIMEOUT` seconds before giving up.

`invoke_streaming()` additionally calls back with growing partial markdown while a
reply streams. See ../probes/FINDINGS.md for why this is safe: across 6 trials
(English/Urdu, short/long, real OCR'd Arabic) the SERIALIZE_REPLY markdown
serializer always grew monotonically and its last streamed sample was byte-identical
to _read_reply()'s authoritative result every time. The one anomaly the probes found
-- plain innerText occasionally shrinking mid-stream (a transient React re-render) --
is why partial sampling uses the serializer, never innerText, plus a shrink guard
below as belt-and-braces.
"""

import time
from pathlib import Path

from chatgpt_llm import (
    ASSISTANT_BODY_SELECTOR,
    COMPOSER_TIMEOUT,
    DISMISS_WELCOME,
    PROMPT_TEXTAREA,
    REPLY_TIMEOUT,
    SERIALIZE_REPLY,
    STOP_BUTTON,
    ChatGPTResponse,
    ChatGPTSelenium,
)
from selenium.common.exceptions import (
    StaleElementReferenceException,
    TimeoutException,
    WebDriverException,
)
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

# How often invoke_streaming() may call on_partial. The probes sampled every
# 250ms with execute_script() costs of a few ms (rare outlier ~150ms), so 400ms
# leaves headroom while still feeling live.
PARTIAL_THROTTLE_SECONDS = 0.4
# Guard from probes: the serializer never legitimately shrinks mid-stream, but
# plain innerText did once (a transient re-render). Treat any drop bigger than
# this as a bad sample and skip it rather than emit a step backwards to the UI.
PARTIAL_SHRINK_TOLERANCE = 20

LENS_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_PROFILE_DIR = LENS_ROOT / "chrome-profile"

NEEDS_ATTENTION_TIMEOUT = 300  # seconds to poll once we've flagged needs_attention
NEEDS_ATTENTION_POLL = 2       # seconds between polls while waiting


class LensChatGPT(ChatGPTSelenium):
    """ChatGPTSelenium with its own profile dir and a server-safe wall handler."""

    def __init__(self, profile_dir=DEFAULT_PROFILE_DIR, headless=False, console=None, on_status=None):
        super().__init__(profile_dir=profile_dir, headless=headless, console=console)
        # Called with True/False whenever needs_attention changes, so app.py can
        # fold it straight into /api/status without polling this object.
        self.on_status = on_status
        self.needs_attention = False

    def _set_needs_attention(self, value: bool):
        if value == self.needs_attention:
            return
        self.needs_attention = value
        if self.on_status is not None:
            try:
                self.on_status(value)
            except Exception:
                pass  # a broken status callback must never break the ChatGPT call

    def _wait_for_composer(self, first_run=False):
        driver = self._driver
        try:
            WebDriverWait(driver, COMPOSER_TIMEOUT).until(
                EC.presence_of_element_located(PROMPT_TEXTAREA)
            )
            self._set_needs_attention(False)
            return
        except TimeoutException:
            pass

        try:
            driver.find_element(*DISMISS_WELCOME).click()
            WebDriverWait(driver, COMPOSER_TIMEOUT).until(
                EC.presence_of_element_located(PROMPT_TEXTAREA)
            )
            self._set_needs_attention(False)
            return
        except Exception:
            pass

        if not first_run:
            raise TimeoutException("ChatGPT prompt box never appeared after starting a new chat.")

        # Same situation the parent hits (a login/verification wall on first launch),
        # but there is no terminal to block on here. Flag it and poll instead --
        # whoever is watching the Chrome window can clear the wall by hand, and the
        # first request just waits for that rather than failing outright.
        self._set_needs_attention(True)
        deadline = time.monotonic() + NEEDS_ATTENTION_TIMEOUT
        while time.monotonic() < deadline:
            if driver.find_elements(*PROMPT_TEXTAREA):
                self._set_needs_attention(False)
                return
            time.sleep(NEEDS_ATTENTION_POLL)
        # Still stuck after 5 minutes: leave needs_attention set (it's still true)
        # and raise. app.py catches this, closes the driver, and lets the next job
        # rebuild it from scratch -- which flips needs_attention back to False until
        # the new attempt hits the wall again.
        raise TimeoutException(
            "ChatGPT prompt box did not appear within "
            f"{NEEDS_ATTENTION_TIMEOUT}s of flagging needs_attention "
            f"(profile: {self.profile_dir})."
        )

    # -- streaming ---------------------------------------------------------

    def _wait_for_reply_streaming(self, on_partial):
        """Like the parent's _wait_for_reply(), but also samples SERIALIZE_REPLY on
        every poll tick and calls on_partial(text) with it, throttled and guarded.

        on_partial is optional (None disables sampling entirely, so this behaves
        exactly like _wait_for_reply()). Any exception raised while sampling or
        inside on_partial itself is swallowed -- a broken partial path must never
        break the underlying translation, only silence the live-updating UI.
        """
        driver = self._driver
        try:
            WebDriverWait(driver, 15).until(
                lambda d: d.find_elements(*STOP_BUTTON)
                or d.find_elements(By.CSS_SELECTOR, ASSISTANT_BODY_SELECTOR)
            )
        except TimeoutException:
            pass

        state = {"last": None, "stable": 0}
        emitted = {"t": 0.0, "text": None}

        def sample_and_emit():
            if on_partial is None:
                return
            now = time.monotonic()
            if now - emitted["t"] < PARTIAL_THROTTLE_SECONDS:
                return
            try:
                serialized = driver.execute_script(SERIALIZE_REPLY, ASSISTANT_BODY_SELECTOR)
            except WebDriverException:
                return
            if not serialized or not serialized.strip():
                return
            if serialized == emitted["text"]:
                return
            if emitted["text"] is not None and len(serialized) < len(emitted["text"]) - PARTIAL_SHRINK_TOLERANCE:
                # Probes never saw the serializer legitimately shrink; a drop this
                # big means a stale/mid-render sample, not real content going away.
                return
            emitted["t"] = now
            emitted["text"] = serialized
            try:
                on_partial(serialized)
            except Exception:
                pass  # a broken on_partial callback must never break the translation

        def is_done(d):
            try:
                sample_and_emit()
            except Exception:
                pass  # sampling must never break the completion check either
            try:
                if d.find_elements(*STOP_BUTTON):
                    state["stable"] = 0
                    return False
                bodies = d.find_elements(By.CSS_SELECTOR, ASSISTANT_BODY_SELECTOR)
                if not bodies:
                    return False
                text = bodies[-1].text or ""
            except StaleElementReferenceException:
                return False  # DOM re-rendered mid-poll; try again next tick
            if not text.strip():
                return False
            if text == state["last"]:
                state["stable"] += 1
                return state["stable"] >= 2
            state["last"] = text
            state["stable"] = 0
            return False

        WebDriverWait(driver, REPLY_TIMEOUT, poll_frequency=PARTIAL_THROTTLE_SECONDS).until(is_done)
        # One last sample right before the authoritative read, in case the final
        # bit of text landed after the last throttled emit but before "done".
        try:
            sample_and_emit()
        except Exception:
            pass

    def invoke_streaming(self, messages, on_partial=None):
        """Like invoke(), but calls on_partial(text) with growing markdown while the
        reply streams (throttled, see PARTIAL_THROTTLE_SECONDS). The text this
        returns always comes from the parent's authoritative _read_reply() -- the
        partial callback is purely a side channel for progress display and never
        changes what is finally returned.
        """
        prompt = self._flatten(messages)
        with self._lock:
            self._ensure_driver()
            self._new_chat()
            self._send_prompt(prompt)
            self._wait_for_reply_streaming(on_partial)
            return ChatGPTResponse(self._read_reply(baseline=prompt))
