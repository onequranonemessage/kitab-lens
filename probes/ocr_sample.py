#!/usr/bin/env python3
"""Print the OCR text (and its length) for the sample page, on the main thread."""
import sys
from pathlib import Path

LENS_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(LENS_ROOT / "server"))
import kitab  # noqa: E402  (imports vision_ocr on the main thread, as required)

PAGE_PNG = kitab.KITAB_DIR / "src" / "vision_ocr" / "page.png"

if __name__ == "__main__":
    lines = kitab.recognize(str(PAGE_PNG), langs=["ar"])
    arabic = "\n".join(l["text"] for l in lines)
    print(f"lines={len(lines)} chars={len(arabic)}")
    print("---")
    print(arabic)
