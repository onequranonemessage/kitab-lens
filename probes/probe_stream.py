#!/usr/bin/env python3
"""Phase A streaming probes for kitab-lens.

Sends real translation prompts to chatgpt.com through LensChatGPT's own Chrome
profile and, while the reply streams, samples every ~250ms:
  1. driver.execute_script(SERIALIZE_REPLY, ASSISTANT_BODY_SELECTOR) -- the
     markdown DOM serializer chatgpt_llm.py uses for the final read.
  2. bodies[-1].text -- plain innerText, for comparison.
  3. execute_script() latency for (1), and stop-button presence.

At the end of each trial it also calls the parent's authoritative
`_read_reply()` and compares it to the last streamed sample.

Must NOT run while the kitab-lens server is up (single Chrome profile lock).
Writes one JSON file per trial to probes/results/ and prints a running log.
"""

import json
import sys
import time
from pathlib import Path

PROBES_DIR = Path(__file__).resolve().parent
LENS_ROOT = PROBES_DIR.parent
RESULTS_DIR = PROBES_DIR / "results"
RESULTS_DIR.mkdir(exist_ok=True)

sys.path.insert(0, str(LENS_ROOT / "server"))
import kitab  # noqa: E402  (imports vision_ocr on the main thread -- must be first)
import chatgpt_lens  # noqa: E402

from chatgpt_llm import (  # noqa: E402
    ASSISTANT_BODY_SELECTOR,
    SERIALIZE_REPLY,
    STOP_BUTTON,
    ChatGPTSelenium,
)
from langchain_core.messages import HumanMessage, SystemMessage  # noqa: E402
from selenium.webdriver.common.by import By  # noqa: E402

SAMPLE_INTERVAL = 0.25
STABLE_SAMPLES_NEEDED = 3      # consecutive identical serialized samples => "done"
TRIAL_HARD_TIMEOUT = 300       # safety cap per trial (seconds)


def build_arabic(short: bool) -> str:
    lines = kitab.recognize(str(kitab.KITAB_DIR / "src" / "vision_ocr" / "page.png"), langs=["ar"])
    one_page = "\n".join(l["text"] for l in lines)
    if short:
        return one_page
    # A ~3-4k char "long" input: repeat the real OCR'd page under page markers,
    # exactly the shape build_prompt's rule 4 expects (kept, never merged).
    pages = []
    n = 1
    total = 0
    while total < 3600:
        pages.append(f"--- Page {n} ---\n{one_page}")
        total += len(pages[-1])
        n += 1
    return "\n\n".join(pages)


def run_trial(llm: "chatgpt_lens.LensChatGPT", label: str, language: str, arabic: str) -> dict:
    print(f"\n=== trial: {label} (language={language}, arabic_chars={len(arabic)}) ===", flush=True)
    prompt_text = kitab.build_prompt(language)
    messages = [SystemMessage(content=prompt_text), HumanMessage(content=arabic)]
    prompt = ChatGPTSelenium._flatten(messages)

    trial = {
        "label": label,
        "language": language,
        "arabic_chars": len(arabic),
        "samples": [],
        "anomalies": [],
    }

    driver = None
    with llm._lock:
        llm._ensure_driver()
        driver = llm._driver
        llm._new_chat()
        t_send = time.monotonic()
        llm._send_prompt(prompt)

        first_serialized_at = None
        first_plain_at = None
        last_serialized = None
        last_plain_len = None
        stable_count = 0
        t0 = time.monotonic()

        while True:
            now = time.monotonic()
            if now - t0 > TRIAL_HARD_TIMEOUT:
                trial["anomalies"].append(f"hard timeout after {TRIAL_HARD_TIMEOUT}s")
                break

            t_a = time.monotonic()
            try:
                serialized = driver.execute_script(SERIALIZE_REPLY, ASSISTANT_BODY_SELECTOR)
                serialized_err = None
            except Exception as exc:  # noqa: BLE001
                serialized = None
                serialized_err = str(exc)
            serialize_latency = time.monotonic() - t_a

            t_b = time.monotonic()
            try:
                bodies = driver.find_elements(By.CSS_SELECTOR, ASSISTANT_BODY_SELECTOR)
                plain_text = bodies[-1].text if bodies else None
                plain_err = None
            except Exception as exc:  # noqa: BLE001
                plain_text = None
                plain_err = str(exc)
            plain_latency = time.monotonic() - t_b

            stop_present = bool(driver.find_elements(*STOP_BUTTON))

            sample = {
                "t": round(now - t_send, 3),
                "serialized_len": len(serialized) if serialized else 0,
                "serialize_ms": round(serialize_latency * 1000, 1),
                "serialize_err": serialized_err,
                "plain_len": len(plain_text) if plain_text else 0,
                "plain_ms": round(plain_latency * 1000, 1),
                "plain_err": plain_err,
                "stop_present": stop_present,
            }
            trial["samples"].append(sample)

            if serialized and first_serialized_at is None:
                first_serialized_at = now - t_send
            if plain_text and first_plain_at is None:
                first_plain_at = now - t_send

            # Anomaly checks: shrinkage (picked up a different/earlier message),
            # or a serialized sample that isn't a prefix-continuation of the last one.
            if serialized is not None and last_serialized is not None:
                if len(serialized) < len(last_serialized):
                    trial["anomalies"].append(
                        f"t={sample['t']}: serialized length SHRANK {len(last_serialized)} -> {len(serialized)}"
                    )
                elif serialized != last_serialized and not serialized.startswith(last_serialized[: max(0, len(last_serialized) - 40)]):
                    # allow the tail ~40 chars to be rewritten (markdown re-render of
                    # the last open block), but flag a bigger divergence than that.
                    trial["anomalies"].append(
                        f"t={sample['t']}: serialized sample diverged from prior sample's prefix "
                        f"(prev_len={len(last_serialized)}, new_len={len(serialized)})"
                    )
            if plain_text is not None and last_plain_len is not None:
                if len(plain_text) < last_plain_len - 5:
                    trial["anomalies"].append(
                        f"t={sample['t']}: plain innerText length SHRANK {last_plain_len} -> {len(plain_text)}"
                    )

            print(
                f"  t={sample['t']:6.2f}s stop={stop_present!s:5} "
                f"serialized_len={sample['serialized_len']:5} ({sample['serialize_ms']:5.1f}ms)  "
                f"plain_len={sample['plain_len']:5} ({sample['plain_ms']:5.1f}ms)",
                flush=True,
            )

            if not stop_present and serialized is not None and serialized == last_serialized:
                stable_count += 1
            else:
                stable_count = 0
            last_serialized = serialized if serialized is not None else last_serialized
            last_plain_len = len(plain_text) if plain_text else last_plain_len

            if not stop_present and stable_count >= STABLE_SAMPLES_NEEDED:
                break

            time.sleep(SAMPLE_INTERVAL)

        t_stream_done = time.monotonic()
        # Authoritative read, same call the real pipeline makes.
        try:
            final_text = llm._read_reply(baseline=prompt)
            read_err = None
        except Exception as exc:  # noqa: BLE001
            final_text = None
            read_err = str(exc)
        t_read_done = time.monotonic()

        trial["time_to_first_serialized_token_s"] = round(first_serialized_at, 3) if first_serialized_at else None
        trial["time_to_first_plain_token_s"] = round(first_plain_at, 3) if first_plain_at else None
        trial["stream_wall_time_s"] = round(t_stream_done - t_send, 3)
        trial["read_reply_time_s"] = round(t_read_done - t_stream_done, 3)
        trial["total_time_s"] = round(t_read_done - t_send, 3)
        trial["read_err"] = read_err
        trial["final_text_len"] = len(final_text) if final_text else 0
        trial["final_text"] = final_text
        trial["last_streamed_sample"] = last_serialized
        trial["last_streamed_sample_len"] = len(last_serialized) if last_serialized else 0
        trial["identical_to_final"] = (final_text is not None and last_serialized == final_text)

        print(
            f"  -> stream_wall={trial['stream_wall_time_s']}s read_reply={trial['read_reply_time_s']}s "
            f"final_len={trial['final_text_len']} last_stream_len={trial['last_streamed_sample_len']} "
            f"identical={trial['identical_to_final']}",
            flush=True,
        )
        if not trial["identical_to_final"] and final_text and last_serialized:
            # Record a short diff hint rather than the full text twice.
            common_prefix = 0
            for a, b in zip(final_text, last_serialized):
                if a != b:
                    break
                common_prefix += 1
            trial["diff_common_prefix_len"] = common_prefix
            print(
                f"  !! last streamed sample != final text; common prefix len={common_prefix} "
                f"(final={trial['final_text_len']}, last_stream={trial['last_streamed_sample_len']})",
                flush=True,
            )

    out_path = RESULTS_DIR / f"{label}.json"
    out_path.write_text(json.dumps(trial, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  wrote {out_path}", flush=True)
    return trial


def main():
    llm = chatgpt_lens.LensChatGPT()
    short_arabic = build_arabic(short=True)
    long_arabic = build_arabic(short=False)
    print(f"short_arabic chars={len(short_arabic)}  long_arabic chars={len(long_arabic)}")

    trials = [
        ("t1_en_short", "English", short_arabic),
        ("t2_en_long", "English", long_arabic),
        ("t3_urdu_short", "Urdu", short_arabic),
        ("t4_urdu_long", "Urdu", long_arabic),
        ("t5_en_short_repeat", "English", short_arabic),
        ("t6_urdu_long_repeat", "Urdu", long_arabic),
    ]

    summary = []
    try:
        for label, language, arabic in trials:
            trial = run_trial(llm, label, language, arabic)
            summary.append(
                {
                    "label": trial["label"],
                    "language": trial["language"],
                    "arabic_chars": trial["arabic_chars"],
                    "time_to_first_serialized_token_s": trial["time_to_first_serialized_token_s"],
                    "stream_wall_time_s": trial["stream_wall_time_s"],
                    "read_reply_time_s": trial["read_reply_time_s"],
                    "total_time_s": trial["total_time_s"],
                    "final_text_len": trial["final_text_len"],
                    "identical_to_final": trial["identical_to_final"],
                    "num_anomalies": len(trial["anomalies"]),
                    "anomalies": trial["anomalies"],
                }
            )
    finally:
        (RESULTS_DIR / "summary.json").write_text(
            json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        try:
            llm.close()
        except Exception:  # noqa: BLE001
            pass

    print("\n\n=== SUMMARY ===")
    for s in summary:
        print(json.dumps(s, ensure_ascii=False))


if __name__ == "__main__":
    main()
