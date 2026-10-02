#!/usr/bin/env python3
"""OCR an image using Apple's Vision framework (macOS only).

Usage:
    vision_ocr.py IMAGE [IMAGE ...] [--fast] [--langs en-US,ar] [--json]
    vision_ocr.py --list-langs
"""

import argparse
import json
import sys

import Quartz
import Vision
from Foundation import NSURL


def warmup():
    """Resolve the lazily-bound Vision/Quartz symbols on the current thread.

    PyObjC binds framework functions and constants on first attribute access, and
    that resolution is not thread-safe. When several threads OCR at once with none
    of the symbols bound yet, they race and one raises KeyError. Touching them once
    from the main thread before any pool starts makes concurrent OCR safe.
    """
    for owner, name in (
        (Quartz, "CGImageSourceCreateWithURL"),
        (Quartz, "CGImageSourceCreateImageAtIndex"),
        (Vision, "VNRecognizeTextRequest"),
        (Vision, "VNImageRequestHandler"),
        (Vision, "VNRequestTextRecognitionLevelAccurate"),
        (Vision, "VNRequestTextRecognitionLevelFast"),
    ):
        getattr(owner, name)


warmup()  # runs on the importing (main) thread, before any worker pool


def load_image(path):
    url = NSURL.fileURLWithPath_(str(path))
    source = Quartz.CGImageSourceCreateWithURL(url, None)
    if source is None:
        raise ValueError(f"cannot read image: {path}")
    image = Quartz.CGImageSourceCreateImageAtIndex(source, 0, None)
    if image is None:
        raise ValueError(f"cannot decode image: {path}")
    return image


def make_request(fast, langs, correction):
    request = Vision.VNRecognizeTextRequest.alloc().init()
    request.setRecognitionLevel_(
        Vision.VNRequestTextRecognitionLevelFast
        if fast
        else Vision.VNRequestTextRecognitionLevelAccurate
    )
    request.setUsesLanguageCorrection_(correction)
    if langs:
        request.setRecognitionLanguages_(langs)
    return request


def recognize(path, fast=False, langs=None, correction=True):
    """Return a list of {text, confidence, bbox} dicts, top-to-bottom."""
    request = make_request(fast, langs, correction)
    handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(
        load_image(path), None
    )

    ok, error = handler.performRequests_error_([request], None)
    if not ok:
        raise RuntimeError(f"Vision failed on {path}: {error}")

    lines = []
    for observation in request.results() or []:
        candidate = observation.topCandidates_(1)[0]
        # Vision's bbox is normalized with origin at the bottom-left.
        box = observation.boundingBox()
        lines.append(
            {
                "text": candidate.string(),
                "confidence": round(candidate.confidence(), 4),
                "bbox": {
                    "x": round(box.origin.x, 4),
                    "y": round(box.origin.y, 4),
                    "width": round(box.size.width, 4),
                    "height": round(box.size.height, 4),
                },
            }
        )

    lines.sort(key=lambda line: -line["bbox"]["y"])
    return lines


def supported_languages(fast=False):
    request = make_request(fast, None, True)
    return list(request.supportedRecognitionLanguagesAndReturnError_(None)[0])


def main():
    parser = argparse.ArgumentParser(description="OCR images with Apple's Vision framework.")
    parser.add_argument("images", nargs="*", help="image file paths")
    parser.add_argument("--fast", action="store_true", help="fast instead of accurate recognition")
    parser.add_argument("--langs", help="comma-separated language hints, e.g. en-US,ar")
    parser.add_argument("--no-correction", action="store_true", help="disable language correction")
    parser.add_argument("--json", action="store_true", help="emit JSON with confidence and boxes")
    parser.add_argument("--list-langs", action="store_true", help="list supported languages and exit")
    args = parser.parse_args()

    if args.list_langs:
        print("\n".join(supported_languages(args.fast)))
        return 0

    if not args.images:
        parser.error("give at least one image path (or --list-langs)")

    langs = [lang.strip() for lang in args.langs.split(",")] if args.langs else None
    results = {}
    failed = False

    for path in args.images:
        try:
            results[path] = recognize(path, args.fast, langs, not args.no_correction)
        except (ValueError, RuntimeError) as exc:
            print(f"error: {exc}", file=sys.stderr)
            failed = True

    if args.json:
        print(json.dumps(results, indent=2, ensure_ascii=False))
    else:
        for path, lines in results.items():
            if len(args.images) > 1:
                print(f"===== {path} =====")
            print("\n".join(line["text"] for line in lines))

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
