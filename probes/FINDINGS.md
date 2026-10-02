# Streaming probes — findings

`probe_stream.py` drove the real kitab-lens Chrome profile (`chrome-profile/`)
against chatgpt.com with real OCR'd Arabic from
`kitab-translator-vision-ocr/src/vision_ocr/page.png` (572 chars for "short";
repeated under `--- Page N ---` markers to ~4.1k chars for "long", the same
shape the real translation prompt uses for multi-page chunks). 6 trials across
English/Urdu x short/long, plus 2 repeats, sampling every 250ms.

| trial | language | arabic chars | time to first token | stream wall time | final len | == `_read_reply()`? | anomalies |
|---|---|---|---|---|---|---|---|
| t1_en_short | English | 572 | 1.93s | 4.02s | 964 | yes | 0 |
| t2_en_long | English | 4121 | 3.59s | 10.16s | 6970 | yes | 0 |
| t3_urdu_short | Urdu | 572 | 2.49s | 4.90s | 839 | yes | 0 |
| t4_urdu_long | Urdu | 4121 | 3.38s | 10.59s | 5836 | yes | 1 (see below) |
| t5_en_short_repeat | English | 572 | 1.34s | 3.38s | 988 | yes | 0 |
| t6_urdu_long_repeat | Urdu | 4121 | 3.04s | 9.99s | 5724 | yes | 0 |

Raw per-sample data and full text are in `results/*.json`; `results/summary.json`
has the table above in machine form.

## Answers to the specific questions

1. **Does `SERIALIZE_REPLY` (the markdown DOM serializer) return monotonically
   growing, well-formed partial markdown?** Yes, in all 6 trials, with zero
   anomalies. The probe's anomaly check (flag any sample whose serialized text
   is shorter than the previous sample, or whose content diverges from the
   previous sample's prefix by more than a 40-char tail rewrite) never fired
   for the serializer in any trial. It also never returned `None`/garbage once
   the assistant turn appeared -- before that it's simply `null` (root
   selector matches nothing yet), which is the expected "nothing to show yet"
   state, not garbage.

2. **Does it ever briefly pick up the previous/user message, or pick the
   wrong (not-current) assistant turn?** No. `ASSISTANT_BODY_SELECTOR`'s
   generic form is a *list* of assistant-body elements and the code always
   reads `[-1]` / lets the CSS `,`-joined selector return the last DOM match --
   since `_new_chat()` reloads chatgpt.com into a brand-new conversation
   before every send, there is at most one assistant turn on the page at any
   time during these trials, so "wrong turn" was structurally not possible
   here. This is a limitation of the probe, not proof for every future
   conversation shape -- see Caveats.

3. **`bodies[-1].text` (plain innerText) as a comparison** -- mostly agrees
   with the serializer's growth, but is strictly less trustworthy: in
   `t4_urdu_long` it **shrank** once, 479 -> 470 chars, between two 250ms-apart
   samples (both had `stop_present: True`, i.e. mid-stream). That's exactly
   the kind of transient DOM-diffing hiccup (React reconciling a partially
   re-rendered RTL block) the plan asked me to watch for. The markdown
   serializer read at the *same two ticks* did not shrink -- it went
   3697 -> 4147. This is direct evidence for building `invoke_streaming` on
   `SERIALIZE_REPLY`, not on `.text`, and for guarding against exactly this
   kind of shrink.

4. **Sampling cost.** `execute_script(SERIALIZE_REPLY, ...)` cost 2-10ms in
   the common case, with one outlier at 147ms (`t2_en_long`, t=8.73s, right as
   a large chunk of markdown landed and the DOM was mid-reflow). Plain
   `.text` reads cost more (10-46ms) since Selenium has to resolve the live
   element and pull rendered text rather than run a small JS walk. Both are
   cheap enough to sample every 250ms indefinitely without falling behind.

5. **Stop-button presence over time** tracked cleanly with generation: `True`
   from the first sample until the assistant body stabilizes, then `False`
   for the final 2+ samples before we call it done -- same signal
   `_wait_for_reply()` already uses.

6. **Final streamed sample vs. `_read_reply()`.** Identical in all 6/6
   trials (`identical_to_final: true`), and `_read_reply()` returned near
   instantly (2-3ms) because the serializer path is checked first and had
   already produced the same text -- `_read_reply()` doesn't have to fall back
   to the copy-button/clipboard path at all when the serializer already has
   the full reply, which is the common case.

7. **Time-to-first-token vs. total time -- is streaming worth it?** First
   partial markdown appeared 1.3-3.6s after send, well before the full reply
   (3.4-10.6s for these short test chunks; real book-chunk translations run
   much longer per `REPLY_TIMEOUT=900`). Streaming is worth it: a user waiting
   30-60s+ for a real chunk sees the translation build up within a couple of
   seconds instead of staring at "Translating..." the whole time.

8. **Thinking/"Searching" placeholders, markdown flicker, partial tables, RTL
   issues?** None observed. No web-search/tool-call placeholder states
   appeared for these text-only translation prompts (that UI path is a
   ChatGPT feature for browsing-triggering prompts, not exercised here). No
   partial tables occurred (the translation prompt doesn't produce tables for
   this content). Urdu (RTL) rendered and serialized the same as English with
   no extra anomalies beyond the one innerText shrink noted above, which
   affects the discarded comparison path, not the serializer actually used.

## Caveats (things the probe did not, and could not, fully rule out)

- Every trial ran in a **fresh chat** (`_new_chat()` before each send), so
  there was only ever one assistant turn in the DOM. The "does the serializer
  ever grab the wrong turn" question is only answered for that shape, which
  matches how the real pipeline calls it (`invoke()`/`invoke_streaming()` both
  call `_new_chat()` first) -- so this is the shape that matters, but it's
  worth naming as a scope limit rather than a blanket guarantee.
- Real book-chunk translations are much longer-running (minutes, not seconds)
  and can trigger ChatGPT's own rate limits, longer "thinking" delays, or a
  mid-stream network hiccup that these ~4-10s trials didn't hit. The
  implementation below still degrades safely if that happens: any exception
  in the partial-sampling path is swallowed and the job falls back to silent
  waiting, exactly as the parent's non-streaming path already behaves.
- The probe did not test the `needs_attention` (login/verification wall) path
  interacting with streaming -- that's an existing, orthogonal failure mode
  handled by `LensChatGPT._wait_for_composer`, which runs before any sending
  happens and is unaffected by this change.

## Verdict

Probes support streaming. Implemented in `LensChatGPT.invoke_streaming()`
(see `server/chatgpt_lens.py`), wired into `server/app.py` behind
`KITAB_LENS_STREAMING` (default on).
