# Vendored from kitab-translator-vision-ocr

The only three files kitab-lens imports from the sibling
[kitab-pdf-translator-vision-ocr](https://github.com/dawoodhq/kitab-pdf-translator-vision-ocr)
project, copied here (same relative layout) so a standalone kitab-lens download
runs without that checkout:

- `src/chatgpt_llm.py` -- the Selenium-driven chatgpt.com backend
- `src/vision_ocr/vision_ocr.py` -- the Apple Vision OCR wrapper
- `translation_prompt.txt` -- the translation system prompt

Copied from the working tree at sibling commit `e3e8a90` (2026-08-28), including
its uncommitted `chatgpt_llm.py` edits as of 2026-09-29.

`server/kitab.py` and `run.sh` still prefer a sibling checkout at
`../kitab-translator-vision-ocr` when one exists (so edits there apply live), and
fall back to this copy otherwise. `KITAB_OCR_DIR` overrides both. To refresh this
copy after changing the sibling, re-copy those three files.
