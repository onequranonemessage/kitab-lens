#!/usr/bin/env python3
"""Drive chatgpt.com through a real Chrome window and expose it like a LangChain chat model.

There is no API key involved: Selenium types the prompt into the ChatGPT web
composer, waits for the reply to finish generating, and reads the result back.
A persistent Chrome profile under ./chrome-profile keeps the login alive between
runs — but chatgpt.com also answers anonymously, so a sign-in is optional.

invoke() is serialized behind a lock and each call starts a fresh chat, so chunks
stay independent of each other exactly as they are with the API-backed models.
invoke_many() runs several prompts at once as tabs of the same window, each in its
own fresh chat, driven round-robin from one thread.

ChatGPT rewrote its composer in 2025 (the "wm-app" / web-mobile build): the
prompt box is now a plain <textarea name="prompt"> instead of the old
#prompt-textarea ProseMirror div, the send/stop/copy buttons dropped their
data-testid hooks in favour of aria-labels, and messages render as
<li data-message-role="assistant">. Every selector here therefore tries the new
markup first and falls back to the old testids so a UI still on the previous
build keeps working. Reply text is captured by intercepting the page's own
clipboard write (what "Copy response" copies, i.e. real markdown); if that does
not land, a DOM→markdown serializer reconstructs it, so reading never depends on
the OS clipboard actually receiving focus under automation.
"""

import os
import re
import sys
import threading
import time
from collections import deque
from pathlib import Path

import pyperclip
from selenium import webdriver
from selenium.common.exceptions import (
    StaleElementReferenceException,
    TimeoutException,
    WebDriverException,
)
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

CHATGPT_URL = "https://chatgpt.com"
PROFILE_DIR = Path(
    os.environ.get("CHATGPT_CHROME_PROFILE")
    or Path(__file__).resolve().parent.parent / "chrome-profile"
)

# The prompt composer: new <textarea name="prompt"> first, old ProseMirror div and
# a couple of generic fallbacks after it.
COMPOSER_SELECTORS = (
    "#prompt-textarea",
    "textarea[name='prompt']",
    "#mobile-composer-prompt",
    "form [contenteditable='true']",
    "form textarea",
)
# Send: new build labels the button, old build tagged it with a testid; the form's
# submit button is the last-ditch fallback.
SEND_SELECTORS = (
    'button[data-testid="send-button"]',
    'button[aria-label="Send message"]',
    'button[aria-label="Send prompt"]',
    'form button[type="submit"]',
)
# While a reply streams, the send button becomes a stop button.
STOP_SELECTORS = (
    'button[data-testid="stop-button"]',
    'button[aria-label="Stop generating"]',
    'button[aria-label="Stop streaming"]',
)
# "Copy response" on the finished assistant turn. New build: aria-label only.
COPY_SELECTORS = (
    'button[data-testid="copy-turn-action-button"][aria-label="Copy response"]',
    'button[aria-label="Copy response"][data-copy-message]',
    'button[aria-label="Copy response"]',
    # Long/complex replies used to render inside a "canvas" writing-block panel whose
    # own toolbar copy button is the one that copies the full document.
    '[data-testid="writing-block-header-surface"] button[aria-label="Copy"]',
)
# The rendered assistant message body, used to detect completion and as the
# reply-reading fallback. New build first, old build second.
ASSISTANT_BODY_SELECTOR = (
    'li[data-message-role="assistant"] [data-assistant-markdown], '
    'li[data-message-role="assistant"] .markdown, '
    '[data-message-author-role="assistant"] .markdown, '
    '[data-message-author-role="assistant"]'
)

PROMPT_TEXTAREA = (By.CSS_SELECTOR, ", ".join(COMPOSER_SELECTORS))
DISMISS_WELCOME = (By.CSS_SELECTOR, '[data-testid="dismiss-welcome"]')
# Send is chosen via ChatGPTSelenium._find_send_button (priority order + filtering),
# not a single combined locator: the generic submit-button fallback also matches
# Dismiss/Close/"Back to ChatGPT", so a naive combined match could click the wrong one.
STOP_BUTTON = (By.CSS_SELECTOR, ", ".join(STOP_SELECTORS))
COPY_BUTTON = (By.CSS_SELECTOR, ", ".join(COPY_SELECTORS))

COMPOSER_TIMEOUT = 90    # seconds to wait for the prompt box after a page load
REPLY_TIMEOUT = 900      # a full chunk of book translation generates slowly
CLIPBOARD_TIMEOUT = 30   # navigator.clipboard.writeText() lags on long replies
STALL_TIMEOUT = 45       # multi-tab: no reply started this long after sending => refused
POLL_INTERVAL = 0.5      # multi-tab: pause between round-robin passes over the tabs
LIMIT_COOLDOWN = 45      # multi-tab: first pause on all new sends after a refusal (doubles)
PASTE_MODIFIER = Keys.COMMAND if sys.platform == "darwin" else Keys.CONTROL

# Installed on every document (via CDP) so it survives the navigation to /uc/<id>
# that sending a first message triggers. It records whatever the page copies —
# ChatGPT's "Copy response" calls navigator.clipboard.writeText and/or fires a
# copy event — onto window.__lastCopy, so we can read the exact markdown without
# depending on the OS clipboard receiving focus while Chrome is automated.
CLIPBOARD_HOOK = r"""
(function(){
  if (window.__clipHookInstalled) return;
  window.__clipHookInstalled = true;
  window.__lastCopy = null;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      var orig = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = function(t){
        window.__lastCopy = t;
        try { return orig(t).catch(function(){}); } catch(e){ return Promise.resolve(); }
      };
    }
  } catch(e){}
  document.addEventListener('copy', function(e){
    try {
      var t = e.clipboardData && e.clipboardData.getData('text/plain');
      if (t) window.__lastCopy = t;
    } catch(_){}
  }, true);
})();
"""

# Reconstructs markdown from the rendered assistant message DOM. Used only when the
# clipboard interception yields nothing. innerText alone would drop every bit of
# markdown (headings, bold, lists), which then breaks the downstream md→docx step.
SERIALIZE_REPLY = r"""
var root = document.querySelector(arguments[0]);
if(!root) return null;
function inline(node){
  var out='';
  node.childNodes.forEach(function(n){
    if(n.nodeType===3){ out+=n.textContent; }
    else if(n.nodeType===1){
      var tag=n.tagName.toLowerCase();
      if(tag==='strong'||tag==='b') out+='**'+inline(n)+'**';
      else if(tag==='em'||tag==='i') out+='*'+inline(n)+'*';
      else if(tag==='code') out+='`'+n.textContent+'`';
      else if(tag==='a') out+='['+inline(n)+']('+(n.getAttribute('href')||'')+')';
      else if(tag==='br') out+='\n';
      else out+=inline(n);
    }
  });
  return out;
}
function block(node,depth){
  var out='';
  node.childNodes.forEach(function(n){
    if(n.nodeType===3){ if(n.textContent.trim()) out+=n.textContent; return; }
    if(n.nodeType!==1) return;
    var tag=n.tagName.toLowerCase();
    var pad='  '.repeat(depth);
    if(/^h[1-6]$/.test(tag)) out+='\n'+'#'.repeat(+tag[1])+' '+inline(n).trim()+'\n\n';
    else if(tag==='p') out+=inline(n).trim()+'\n\n';
    else if(tag==='ul'){ n.querySelectorAll(':scope>li').forEach(function(li){ out+=pad+'- '+inline(li).trim()+'\n'; var sub=li.querySelector(':scope>ul,:scope>ol'); if(sub) out+=block(li,depth+1); }); out+='\n'; }
    else if(tag==='ol'){ var i=1; n.querySelectorAll(':scope>li').forEach(function(li){ out+=pad+(i++)+'. '+inline(li).trim()+'\n'; }); out+='\n'; }
    else if(tag==='pre'){ var code=n.querySelector('code'); out+='```\n'+(code?code.textContent:n.textContent)+'\n```\n\n'; }
    else if(tag==='blockquote'){ out+='> '+inline(n).trim()+'\n\n'; }
    else if(tag==='hr') out+='\n---\n\n';
    else if(tag==='table'){
      var rows=[...n.querySelectorAll('tr')];
      rows.forEach(function(tr,ri){
        var cells=[...tr.children].map(function(c){ return inline(c).trim(); });
        out+='| '+cells.join(' | ')+' |\n';
        if(ri===0) out+='| '+cells.map(function(){return '---';}).join(' | ')+' |\n';
      });
      out+='\n';
    }
    else out+=block(n,depth);
  });
  return out;
}
return block(root,0).replace(/\n{3,}/g,'\n\n').trim();
"""

# Sets the composer's text in-page, without the OS clipboard, so concurrent tabs can't
# clobber each other's paste. The textarea needs React's native value setter + an input
# event or React's state won't see it; the old contenteditable composer takes
# execCommand('insertText').
INSERT_TEXT = r"""
var el = arguments[0], t = arguments[1];
el.focus();
if (el.tagName === 'TEXTAREA') {
  var set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
  set.call(el, t);
  el.dispatchEvent(new Event('input', {bubbles: true}));
} else {
  document.execCommand('selectAll', false, null);
  document.execCommand('insertText', false, t);
}
"""

# Page text outside the conversation messages and composer -- where a rate-limit notice
# shows up. Messages are excluded so a chunk or reply that mentions "limit" can't trip
# the detector.
NON_MESSAGE_TEXT = r"""
var root = (document.querySelector('main') || document.body).cloneNode(true);
root.querySelectorAll('[data-message-role], [data-message-author-role], form, textarea')
    .forEach(function(n){ n.remove(); });
var extra = [...document.querySelectorAll('[role=alert], [role=status], [role=dialog]')]
    .map(function(n){ return n.innerText; }).join('\n');
return root.innerText + '\n' + extra;
"""
LIMIT_PATTERN = (
    r"(reached|hit|exceeded) (the |your |our )?[\w -]{0,25}limit"
    r"|too many (requests|messages)|rate limit|limit (resets|for gpt)"
    r"|usage (cap|limit)|try again (later|in \d)"
)


class ChatGPTResponse:
    """Minimal stand-in for a LangChain AIMessage: all the caller reads is .content."""

    def __init__(self, content):
        self.content = content


class ChatGPTSelenium:
    """LangChain-shaped (`invoke(messages) -> .content`) wrapper around the ChatGPT web UI."""

    def __init__(self, profile_dir=PROFILE_DIR, headless=False, console=None):
        self.profile_dir = Path(profile_dir)
        self.headless = headless
        self.console = console
        self._driver = None
        self._lock = threading.Lock()  # one browser window == one conversation at a time

    # -- driver lifecycle ------------------------------------------------

    def _build_driver(self):
        options = webdriver.ChromeOptions()
        options.add_argument(f"--user-data-dir={self.profile_dir}")
        if self.headless:
            options.add_argument("--headless=new")
        options.add_argument("--disable-blink-features=AutomationControlled")
        options.add_experimental_option("excludeSwitches", ["enable-automation"])

        try:
            driver = webdriver.Chrome(options=options)
        except WebDriverException as exc:
            # chromedriver is resolved by Selenium Manager, whose early releases
            # panic ("Downloaded file cannot be uncompressed") instead of falling
            # back to their own cache, leaving a bare "needs to be in PATH" error
            # that points nowhere near the real cause.
            raise RuntimeError(
                f"Could not start Chrome for the ChatGPT backend: {exc}\n"
                "If this mentions chromedriver, upgrade Selenium "
                "('pip install -U \"selenium>=4.30\"'); its bundled driver "
                "resolver is unreliable in older releases."
            ) from exc

        # Install the clipboard interceptor before any page script runs, and re-run
        # it after every navigation (sending the first message hops to /uc/<id>).
        try:
            driver.execute_cdp_cmd(
                "Page.addScriptToEvaluateOnNewDocument", {"source": CLIPBOARD_HOOK}
            )
        except WebDriverException:
            pass  # non-fatal: we re-inject per page and fall back to the serializer
        return driver

    def _ensure_driver(self):
        if self._driver is None:
            self.profile_dir.mkdir(parents=True, exist_ok=True)
            self._driver = self._build_driver()
            self._driver.get(CHATGPT_URL)
            self._wait_for_composer(first_run=True)
        return self._driver

    def close(self):
        if self._driver is not None:
            try:
                self._driver.quit()
            except WebDriverException:
                pass
            self._driver = None

    # -- page interactions -----------------------------------------------

    def _find_composer(self):
        """Return the first present composer element, or None."""
        for selector in COMPOSER_SELECTORS:
            elements = self._driver.find_elements(By.CSS_SELECTOR, selector)
            if elements:
                return elements[-1]
        return None

    # Buttons the generic `form button[type="submit"]` fallback also matches but that
    # must never be treated as "send" — clicking one of these instead of the composer's
    # real send button silently does nothing (or navigates away).
    _NOT_SEND_LABELS = {"dismiss", "close", "back to chatgpt", "stop generating", "stop streaming"}

    def _find_send_button(self):
        """Return the composer's send button, trying selectors in priority order.

        The specific aria-label/testid selectors are unambiguous; the broad
        `form button[type="submit"]` fallback also matches Dismiss/Close/"Back to
        ChatGPT", so for that one we filter to a visible, enabled button that is not a
        known non-send control. (An earlier version clicked the *last* combined match,
        which was "Back to ChatGPT" — so nothing ever sent.)
        """
        for selector in SEND_SELECTORS:
            for element in self._driver.find_elements(By.CSS_SELECTOR, selector):
                if not (element.is_displayed() and element.is_enabled()):
                    continue
                if selector == 'form button[type="submit"]':
                    label = (element.get_attribute("aria-label") or "").strip().lower()
                    if label in self._NOT_SEND_LABELS:
                        continue
                return element
        return None

    def _wait_for_composer(self, first_run=False):
        driver = self._driver
        try:
            WebDriverWait(driver, COMPOSER_TIMEOUT).until(
                EC.presence_of_element_located(PROMPT_TEXTAREA)
            )
            return
        except TimeoutException:
            pass

        try:
            driver.find_element(*DISMISS_WELCOME).click()
            WebDriverWait(driver, COMPOSER_TIMEOUT).until(
                EC.presence_of_element_located(PROMPT_TEXTAREA)
            )
            return
        except Exception:
            pass

        if not first_run:
            raise TimeoutException("ChatGPT prompt box never appeared after starting a new chat.")

        # chatgpt.com answers anonymously, so a missing composer is unusual — usually a
        # transient load or, rarely, a wall. The profile persists, so any hand-off here
        # is a one-time cost rather than something every run pays.
        message = (
            "Could not find the ChatGPT prompt box. If a login/verification wall is "
            f"showing in the open Chrome window, clear it now (profile: {self.profile_dir}); "
            "it is saved for future runs."
        )
        if self.console:
            self.console.print(f"[yellow]{message}[/yellow]")
        else:
            print(message, file=sys.stderr)
        input("Press Enter once the chat prompt box is visible in the browser... ")
        WebDriverWait(driver, COMPOSER_TIMEOUT).until(
            EC.presence_of_element_located(PROMPT_TEXTAREA)
        )

    def _new_chat(self):
        """Reload chatgpt.com so each chunk is translated in its own empty conversation."""
        self._driver.get(CHATGPT_URL)
        self._wait_for_composer()
        # Re-arm the clipboard hook on this freshly loaded document (the CDP
        # on-new-document hook usually covers it, but this is belt-and-braces).
        try:
            self._driver.execute_script(CLIPBOARD_HOOK)
        except WebDriverException:
            pass

    @staticmethod
    def _composer_value(box):
        """Text currently in the composer, for both <textarea> and contenteditable."""
        return (box.get_attribute("value") or box.text or "").strip()

    def _clear_composer(self, box):
        """Empty the composer before typing.

        ChatGPT persists an unsent draft in the profile, so a fresh page load can
        start with leftover text still in the box. Pasting on top of it (the caret
        sits mid-text) interleaves the new prompt into the old draft and corrupts it,
        so the box must be emptied first. Clear it natively (fires the React input
        handler so the framework's own state resets too) and then via select-all.
        """
        try:
            if box.tag_name.lower() == "textarea":
                self._driver.execute_script(
                    "arguments[0].value=''; "
                    "arguments[0].dispatchEvent(new Event('input',{bubbles:true}));",
                    box,
                )
            else:  # contenteditable (old ProseMirror composer)
                self._driver.execute_script(
                    "arguments[0].innerHTML=''; "
                    "arguments[0].dispatchEvent(new Event('input',{bubbles:true}));",
                    box,
                )
        except WebDriverException:
            pass
        box.click()
        ActionChains(self._driver).key_down(PASTE_MODIFIER).send_keys("a").key_up(
            PASTE_MODIFIER
        ).send_keys(Keys.DELETE).perform()

    def _insert_text(self, box, prompt):
        """Set the composer's text in-page (no OS clipboard). True if it landed intact."""
        try:
            self._driver.execute_script(INSERT_TEXT, box, prompt)
        except WebDriverException:
            return False
        return self._composer_value(box) == prompt.strip()

    def _send_prompt(self, prompt, allow_clipboard=True):
        driver = self._driver
        box = WebDriverWait(driver, 30).until(EC.element_to_be_clickable(PROMPT_TEXTAREA))
        box.click()
        self._clear_composer(box)

        # A chunk is tens of thousands of characters; send_keys types it one key
        # event at a time and would take many minutes. Set it in-page first; if that
        # does not land, paste it (single-tab only -- tabs share the OS clipboard), and
        # only fall back to typing if neither landed intact.
        expected = prompt.strip()
        landed = expected if self._insert_text(box, prompt) else None
        if landed is None and allow_clipboard:
            self._clear_composer(box)
            pyperclip.copy(prompt)
            ActionChains(driver).key_down(PASTE_MODIFIER).send_keys("v").key_up(
                PASTE_MODIFIER
            ).perform()
            # A big chunk can take more than a moment to populate, so poll for the box
            # to hold exactly the prompt rather than checking once.
            deadline = time.time() + 8
            landed = self._composer_value(box)
            while landed != expected and time.time() < deadline:
                time.sleep(0.3)
                landed = self._composer_value(box)
        if landed != expected:
            self._clear_composer(box)
            for i, line in enumerate(prompt.split("\n")):
                if i > 0:
                    ActionChains(driver).key_down(Keys.SHIFT).send_keys(
                        Keys.RETURN
                    ).key_up(Keys.SHIFT).perform()
                box.send_keys(line)

        send_button = self._find_send_button()
        if send_button is not None:
            driver.execute_script("arguments[0].click();", send_button)
        else:
            # No button found: only safe on the old ProseMirror composer, where
            # Enter submits. In the new <textarea> Enter is a newline, so guard on it.
            if box.tag_name.lower() != "textarea":
                box.send_keys(Keys.RETURN)
            else:
                raise RuntimeError("ChatGPT send button not found and Enter would not submit.")

        # Confirm the send actually fired. A successful submit clears the composer,
        # spawns the streaming stop button / an assistant turn, and (when anonymous)
        # navigates to /uc/<id>. Query the DOM fresh each poll — the original box
        # reference goes stale across that navigation. If nothing happened, click once
        # more before handing off to the reply wait.
        def _send_registered(d):
            if "/uc/" in d.current_url:
                return True
            if d.find_elements(*STOP_BUTTON):
                return True
            if d.find_elements(By.CSS_SELECTOR, ASSISTANT_BODY_SELECTOR):
                return True
            fresh = self._find_composer()
            return fresh is not None and not self._composer_value(fresh)

        try:
            WebDriverWait(driver, 8).until(_send_registered)
        except TimeoutException:
            resend = self._find_send_button()
            if resend is not None:
                driver.execute_script("arguments[0].click();", resend)

    def _wait_for_reply(self):
        driver = self._driver
        try:
            WebDriverWait(driver, 15).until(
                lambda d: d.find_elements(*STOP_BUTTON)
                or d.find_elements(By.CSS_SELECTOR, ASSISTANT_BODY_SELECTOR)
            )
        except TimeoutException:
            pass

        # For long responses ChatGPT keeps streaming well after the page settles, so
        # "stop button gone" alone is not a reliable done-signal. Poll until the stop
        # button is gone *and* the assistant body text has stopped growing (stable
        # across two samples), with a generous budget for slow, long-form generations.
        state = {"last": None, "stable": 0}

        def is_done(d):
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

        WebDriverWait(driver, REPLY_TIMEOUT, poll_frequency=1).until(is_done)

    def _read_reply(self, baseline, allow_clipboard=True):
        driver = self._driver

        # Primary: reconstruct markdown from the rendered assistant message DOM. The
        # new UI's "Copy response" button copies *plain text* (markdown stripped), so
        # the serializer — which walks the DOM and re-emits headings, bold/italic,
        # lists, code, quotes and tables — is the faithful source. The downstream
        # md→docx step depends on that markdown surviving.
        serialized = driver.execute_script(SERIALIZE_REPLY, ASSISTANT_BODY_SELECTOR)
        if serialized and serialized.strip():
            return serialized

        # Fallback: the copy button. Kept for the old logged-in UI, where a long reply
        # renders in a "canvas" writing-block whose content is not in the inline
        # assistant body the serializer reads — there the toolbar copy button is the
        # only way to get the whole document. Click it with a real gesture (a synthetic
        # JS click does not trigger the new button's copy) and read what it copied via
        # the in-page hook and, as a bonus, the OS clipboard.
        # Skipped when tabs run concurrently: it goes through the shared OS clipboard.
        copy_buttons = driver.find_elements(*COPY_BUTTON) if allow_clipboard else []
        if copy_buttons:
            button = copy_buttons[-1]
            for _attempt in range(3):
                driver.execute_script(
                    "window.__lastCopy = null; arguments[0].scrollIntoView({block: 'center'});",
                    button,
                )
                pyperclip.copy(baseline)  # so a stale clipboard can't masquerade as the reply
                try:
                    ActionChains(driver).move_to_element(button).pause(0.1).click(
                        button
                    ).perform()
                except WebDriverException:
                    driver.execute_script("arguments[0].click();", button)

                deadline = time.time() + CLIPBOARD_TIMEOUT
                while time.time() < deadline:
                    time.sleep(0.3)
                    hooked = driver.execute_script("return window.__lastCopy;")
                    if hooked and hooked != baseline:
                        return hooked
                    clip = pyperclip.paste()
                    if clip and clip != baseline:
                        return clip

        # Last resort: plain text (loses markdown, but better than nothing).
        bodies = driver.find_elements(By.CSS_SELECTOR, ASSISTANT_BODY_SELECTOR)
        if bodies and (bodies[-1].text or "").strip():
            return bodies[-1].text

        raise RuntimeError(
            "Could not read ChatGPT's reply: the copy button produced nothing and no "
            "assistant message text was found."
        )

    # -- LangChain-shaped entry point -------------------------------------

    @staticmethod
    def _flatten(messages):
        """Fold system+human messages into the single prompt the web composer accepts."""
        parts = []
        for message in messages:
            content = getattr(message, "content", message)
            if isinstance(content, str) and content.strip():
                parts.append(content.strip())
        return "\n\n".join(parts)

    def invoke(self, messages):
        prompt = self._flatten(messages)
        with self._lock:
            self._ensure_driver()
            self._new_chat()
            self._send_prompt(prompt)
            self._wait_for_reply()
            # The prompt we just pasted is what's on the clipboard, so it is the
            # baseline the reply has to differ from.
            return ChatGPTResponse(self._read_reply(baseline=prompt))

    # -- multi-tab batch entry point ---------------------------------------

    def _log(self, msg):
        if self.console:
            self.console.print(f"[dim]{msg}[/dim]")
        else:
            print(msg, file=sys.stderr)

    def _poll_tab(self, job):
        """One look at the current tab running `job`: 'streaming', 'done', 'limited' or 'timeout'."""
        driver = self._driver
        if time.time() - job.sent_at > REPLY_TIMEOUT:
            return "timeout"
        if driver.find_elements(*STOP_BUTTON):
            job.stable = 0
            return "streaming"
        bodies = driver.find_elements(By.CSS_SELECTOR, ASSISTANT_BODY_SELECTOR)
        text = (bodies[-1].text or "") if bodies else ""
        if not text.strip():
            # Nothing streaming and no reply: either it hasn't started yet or the send
            # was refused. A refusal (message limit) renders outside the message list,
            # and also shows up as a tab that simply never starts replying.
            notice = driver.execute_script(NON_MESSAGE_TEXT) or ""
            if re.search(LIMIT_PATTERN, notice, re.I):
                return "limited"
            if time.time() - job.sent_at > STALL_TIMEOUT:
                return "limited"
            return "streaming"
        if text == job.last_text:
            job.stable += 1
            return "done" if job.stable >= 2 else "streaming"
        job.last_text = text
        job.stable = 0
        return "streaming"

    def invoke_many(self, message_lists, concurrency=4, stop_event=None, on_result=None,
                    validate=None, max_attempts=3):
        """Ask every prompt, each in its own fresh conversation, up to `concurrency` at
        once as tabs of this one Chrome window. Returns [(reply, error)] aligned with
        `message_lists`; `on_result(index, reply, error)` fires as each one settles
        (completion order, not input order). `validate(index, reply)` may return a
        problem string, in which case the prompt is re-asked in a fresh chat; on the last
        attempt the reply is accepted anyway (with a logged warning) rather than failing
        the whole batch over a cosmetic flaw.

        One thread drives all tabs (a WebDriver session is not thread-safe), polling
        them round-robin; background tabs keep streaming. Message limits are
        account-wide, so when one tab is refused no new prompt is sent to any tab until
        a cooldown passes (doubling each time), and the refused prompt is re-queued up
        to `max_attempts`. When `stop_event` fires, nothing new is sent and the call
        returns once the in-flight tabs finish; unsent prompts are left as None.
        """
        prompts = [self._flatten(m) for m in message_lists]
        results = [None] * len(prompts)
        if not prompts:
            return results
        stopped = stop_event.is_set if stop_event is not None else (lambda: False)

        with self._lock:
            driver = self._ensure_driver()
            home = driver.current_window_handle
            free = [home]
            for _ in range(max(1, min(concurrency, len(prompts))) - 1):
                driver.switch_to.new_window("tab")
                free.append(driver.current_window_handle)
            pending = deque(_TabJob(i, p) for i, p in enumerate(prompts))
            active = {}
            paused_until = 0.0
            backoff = LIMIT_COOLDOWN

            def finish(job, reply, error):
                results[job.index] = (reply, error)
                if on_result:
                    on_result(job.index, reply, error)

            def fail_or_retry(job, reason, pause=True):
                nonlocal paused_until, backoff
                if job.attempts >= max_attempts:
                    finish(job, None, reason)
                    return
                pending.appendleft(job)
                if not pause:
                    self._log(f"chunk {job.index + 1}: {reason}; re-asking")
                    return
                self._log(f"chunk {job.index + 1}: {reason}; re-queued, pausing new sends {backoff}s")
                paused_until = time.time() + backoff
                backoff = min(backoff * 2, 600)

            try:
                while pending or active:
                    if stopped():
                        pending.clear()
                    while pending and free and time.time() >= paused_until and not stopped():
                        job = pending.popleft()
                        handle = free.pop()
                        driver.switch_to.window(handle)
                        job.attempts += 1
                        job.last_text, job.stable = None, 0
                        try:
                            self._new_chat()
                            self._send_prompt(job.prompt, allow_clipboard=False)
                        except Exception as exc:  # noqa: BLE001 -- one bad tab must not sink the batch
                            free.append(handle)
                            fail_or_retry(job, f"send failed: {exc!r}"[:300])
                            continue
                        job.sent_at = time.time()
                        active[handle] = job

                    for handle, job in list(active.items()):
                        driver.switch_to.window(handle)
                        reply = None
                        try:
                            state = self._poll_tab(job)
                            if state == "done":
                                reply = self._read_reply(baseline=job.prompt, allow_clipboard=False)
                        except StaleElementReferenceException:
                            continue  # DOM re-rendered mid-poll; look again next pass
                        except Exception as exc:  # noqa: BLE001
                            state, reply = "error", repr(exc)[:300]
                        if state == "streaming":
                            continue
                        del active[handle]
                        free.append(handle)
                        if state == "done":
                            backoff = LIMIT_COOLDOWN
                            problem = validate(job.index, reply) if validate else None
                            if problem and job.attempts < max_attempts:
                                fail_or_retry(job, f"invalid reply: {problem}", pause=False)
                            else:
                                if problem:
                                    self._log(f"chunk {job.index + 1}: accepting reply after "
                                              f"{job.attempts} attempts despite: {problem}")
                                finish(job, reply, None)
                        elif state == "limited":
                            fail_or_retry(job, "message limit / reply never started")
                        elif state == "timeout":
                            fail_or_retry(job, f"no finished reply after {REPLY_TIMEOUT}s")
                        else:
                            fail_or_retry(job, f"read failed: {reply}")
                    time.sleep(POLL_INTERVAL)
            finally:
                # Close the extra tabs so later invoke() calls run in the original one.
                for handle in driver.window_handles:
                    if handle != home:
                        try:
                            driver.switch_to.window(handle)
                            driver.close()
                        except WebDriverException:
                            pass
                try:
                    driver.switch_to.window(home)
                except WebDriverException:
                    pass

        return results


class _TabJob:
    def __init__(self, index, prompt):
        self.index = index
        self.prompt = prompt
        self.attempts = 0
        self.sent_at = 0.0
        self.last_text = None
        self.stable = 0
