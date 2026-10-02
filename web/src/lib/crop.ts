// Pure math for the crop screen. The crop rect is kept in *normalized*
// image coordinates (0..1 on both axes) so it is independent of how large
// the image happens to be drawn on screen. No DOM access, so it is
// unit-testable without a browser.

import type { Rect } from "./capture"

export type CropHandle = "move" | "n" | "s" | "e" | "w" | "nw" | "ne" | "sw" | "se"

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

/**
 * Applies a drag of (dx, dy) — in normalized units — to `start` via the given
 * handle. "move" translates the whole rect; the others move the matching
 * edge(s). The rect always stays inside [0,1] and never shrinks below
 * `minWidth` x `minHeight`.
 */
export function dragCrop(
  start: Rect,
  handle: CropHandle,
  dx: number,
  dy: number,
  minWidth: number,
  minHeight: number
): Rect {
  if (handle === "move") {
    return {
      x: clamp(start.x + dx, 0, 1 - start.width),
      y: clamp(start.y + dy, 0, 1 - start.height),
      width: start.width,
      height: start.height,
    }
  }

  let left = start.x
  let top = start.y
  let right = start.x + start.width
  let bottom = start.y + start.height

  if (handle.includes("w")) left = clamp(left + dx, 0, right - minWidth)
  if (handle.includes("e")) right = clamp(right + dx, left + minWidth, 1)
  if (handle.includes("n")) top = clamp(top + dy, 0, bottom - minHeight)
  if (handle.includes("s")) bottom = clamp(bottom + dy, top + minHeight, 1)

  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** Converts a normalized crop rect to integer pixels of the full-size image. */
export function cropToPixels(crop: Rect, imageWidth: number, imageHeight: number): Rect {
  const x = Math.round(crop.x * imageWidth)
  const y = Math.round(crop.y * imageHeight)
  const right = Math.round((crop.x + crop.width) * imageWidth)
  const bottom = Math.round((crop.y + crop.height) * imageHeight)
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) }
}
