"""Wire kitab-lens to the kitab-translator-vision-ocr project it reuses.

Nothing here is copied from KITAB — we just point sys.path at its src/ and import
straight from it, so a change over there (a selector fix, a prompt tweak) shows up
here for free. The one thing that makes this module special: `recognize` comes from
vision_ocr.py, whose module-level `warmup()` binds PyObjC/Vision symbols on whichever
thread imports it first, and that binding is not thread-safe (see vision_ocr.py's own
docstring). This module MUST therefore be imported on the main thread, before
app.py's job executor (or anything else) spins up a worker thread. Importing it at
the top of app.py, before FastAPI/uvicorn touch threads, satisfies that.
"""

import os
import re
import sys
from pathlib import Path

LENS_ROOT = Path(__file__).resolve().parent.parent

SIBLING_DIR = LENS_ROOT.parent / "kitab-translator-vision-ocr"
VENDOR_DIR = LENS_ROOT / "vendor" / "kitab-translator-vision-ocr"

# The sibling project when it's checked out next to this one (so edits there apply
# live), else the copy vendored for standalone installs (see vendor/.../VENDORED.md).
# KITAB_OCR_DIR overrides both, e.g. for a differently located checkout or a fixture.
# run.sh resolves the same order.
KITAB_DIR = Path(
    os.environ.get("KITAB_OCR_DIR")
    or (SIBLING_DIR if (SIBLING_DIR / "src").is_dir() else VENDOR_DIR)
).resolve()

KITAB_SRC = KITAB_DIR / "src"
if not KITAB_SRC.is_dir():
    raise RuntimeError(
        f"kitab-translator-vision-ocr not found at {KITAB_DIR} "
        "(set KITAB_OCR_DIR to override)."
    )
if str(KITAB_SRC) not in sys.path:
    sys.path.insert(0, str(KITAB_SRC))

# Imported here, at module load, on the main thread -- see the module docstring.
from vision_ocr.vision_ocr import recognize  # noqa: E402
from chatgpt_llm import ChatGPTSelenium  # noqa: E402

PROMPT_PATH = KITAB_DIR / "translation_prompt.txt"


def load_prompt() -> str:
    """The base (English-target) system prompt, read fresh so edits over there apply."""
    return PROMPT_PATH.read_text(encoding="utf-8")


def build_prompt(language: str) -> str:
    """Swap the prompt's target language: a word-boundary replace of "English".

    This mirrors the one-word swap KITAB documents for build_prompt(lang): every
    occurrence of the standalone word "English" becomes the requested language, and
    nothing else in the prompt changes.
    """
    return re.sub(r"\bEnglish\b", language, load_prompt())
