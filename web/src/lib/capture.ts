// Pure math for mapping an on-screen rectangle (here: the whole camera
// preview) to a crop rectangle in the video element's *intrinsic* pixel
// space, so we can draw exactly the visible region to a canvas at capture
// time. No DOM access here — everything is plain numbers, so this is
// unit-testable without a browser.

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface CoverTransform {
  /** Scale applied to the intrinsic video to fill the display box (object-fit: cover). */
  scale: number
  /** Offset (in CSS px) of the video's top-left corner relative to the display box's top-left, negative when cropped. */
  offsetX: number
  offsetY: number
}

/**
 * Computes the scale + offset `object-fit: cover` applies when an intrinsic
 * `videoWidth x videoHeight` video fills a `displayWidth x displayHeight`
 * box. The video is scaled up until it fully covers the box on both axes,
 * then centered, so the excess on one axis is cropped equally on both sides.
 */
export function computeCoverTransform(
  videoWidth: number,
  videoHeight: number,
  displayWidth: number,
  displayHeight: number
): CoverTransform {
  if (videoWidth <= 0 || videoHeight <= 0 || displayWidth <= 0 || displayHeight <= 0) {
    return { scale: 1, offsetX: 0, offsetY: 0 }
  }
  const scale = Math.max(displayWidth / videoWidth, displayHeight / videoHeight)
  const renderedWidth = videoWidth * scale
  const renderedHeight = videoHeight * scale
  const offsetX = (displayWidth - renderedWidth) / 2
  const offsetY = (displayHeight - renderedHeight) / 2
  return { scale, offsetX, offsetY }
}

/**
 * Maps a rectangle given in display (CSS) pixels — e.g. the page-guide
 * overlay's bounding box — into the video's intrinsic pixel space, using
 * the cover transform computed above. This is the inverse of the
 * scale+offset that `object-fit: cover` applies visually.
 */
export function mapDisplayRectToVideoRect(displayRect: Rect, transform: CoverTransform): Rect {
  const { scale, offsetX, offsetY } = transform
  return {
    x: (displayRect.x - offsetX) / scale,
    y: (displayRect.y - offsetY) / scale,
    width: displayRect.width / scale,
    height: displayRect.height / scale,
  }
}

/**
 * Expands a rect symmetrically by `marginFraction` of its own size (e.g.
 * 0.03 for the plan's 3% capture margin), then clamps it to stay within
 * `[0,0, boundsWidth, boundsHeight]` without changing its center more than
 * necessary.
 */
export function expandAndClampRect(
  rect: Rect,
  marginFraction: number,
  boundsWidth: number,
  boundsHeight: number
): Rect {
  const marginX = rect.width * marginFraction
  const marginY = rect.height * marginFraction

  let x = rect.x - marginX
  let y = rect.y - marginY
  let width = rect.width + marginX * 2
  let height = rect.height + marginY * 2

  // Clamp size to bounds first.
  width = Math.min(width, boundsWidth)
  height = Math.min(height, boundsHeight)

  // Then clamp position so the rect stays fully inside bounds.
  x = Math.min(Math.max(x, 0), boundsWidth - width)
  y = Math.min(Math.max(y, 0), boundsHeight - height)

  return { x, y, width, height }
}

/**
 * Full pipeline: given the guide rect in CSS px (relative to the video
 * element), the video element's displayed size, and its intrinsic size,
 * returns the final crop rect in intrinsic video pixels, expanded by
 * `marginFraction` and clamped to the video bounds. Rounds to integers
 * since canvas APIs want pixel coordinates.
 */
export function computeCaptureRect(
  guideRect: Rect,
  displayWidth: number,
  displayHeight: number,
  videoWidth: number,
  videoHeight: number,
  marginFraction = 0.03
): Rect {
  const transform = computeCoverTransform(videoWidth, videoHeight, displayWidth, displayHeight)
  const videoRect = mapDisplayRectToVideoRect(guideRect, transform)
  const clamped = expandAndClampRect(videoRect, marginFraction, videoWidth, videoHeight)
  return {
    x: Math.round(clamped.x),
    y: Math.round(clamped.y),
    width: Math.round(clamped.width),
    height: Math.round(clamped.height),
  }
}

/**
 * Downscales an image bitmap so its long edge is at most `maxLongEdge`,
 * preserving aspect ratio. Used for gallery uploads, which are sent whole
 * (no crop) but shrunk client-side to save bandwidth over the tunnel.
 * Returns the same dimensions unchanged if already small enough.
 */
export function computeDownscaledSize(
  width: number,
  height: number,
  maxLongEdge: number
): { width: number; height: number } {
  const longEdge = Math.max(width, height)
  if (longEdge <= maxLongEdge) return { width, height }
  const scale = maxLongEdge / longEdge
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}
