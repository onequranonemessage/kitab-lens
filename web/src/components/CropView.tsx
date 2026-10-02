import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { Check, RotateCcw } from "lucide-react"
import type { Rect } from "@/lib/capture"
import { cropToPixels, dragCrop, type CropHandle } from "@/lib/crop"

interface CropViewProps {
  /** The captured (or uploaded) photo to crop. */
  previewUrl: string
  /** Called with the cropped photo when the user taps "Use photo". */
  onConfirm: (blob: Blob, previewUrl: string) => void
  /** Discard the photo and go back to the camera. */
  onRetake: () => void
}

const FULL: Rect = { x: 0, y: 0, width: 1, height: 1 }
/** Smallest crop edge, in on-screen CSS px. */
const MIN_EDGE_PX = 64
/** Padding around the image inside the stage so edge handles stay reachable. */
const STAGE_PADDING = 20

const HANDLES: { handle: CropHandle; className: string }[] = [
  // Edges first, corners last so corners win where they overlap.
  { handle: "n", className: "left-0 right-0 -top-4 h-8 cursor-ns-resize" },
  { handle: "s", className: "left-0 right-0 -bottom-4 h-8 cursor-ns-resize" },
  { handle: "w", className: "top-0 bottom-0 -left-4 w-8 cursor-ew-resize" },
  { handle: "e", className: "top-0 bottom-0 -right-4 w-8 cursor-ew-resize" },
  { handle: "nw", className: "-left-5 -top-5 h-11 w-11 cursor-nwse-resize" },
  { handle: "ne", className: "-right-5 -top-5 h-11 w-11 cursor-nesw-resize" },
  { handle: "sw", className: "-bottom-5 -left-5 h-11 w-11 cursor-nesw-resize" },
  { handle: "se", className: "-bottom-5 -right-5 h-11 w-11 cursor-nwse-resize" },
]

const BRACKETS = [
  "left-0 top-0 border-l-[3px] border-t-[3px] rounded-tl-md",
  "right-0 top-0 border-r-[3px] border-t-[3px] rounded-tr-md",
  "left-0 bottom-0 border-l-[3px] border-b-[3px] rounded-bl-md",
  "right-0 bottom-0 border-r-[3px] border-b-[3px] rounded-br-md",
]

export function CropView({ previewUrl, onConfirm, onRetake }: CropViewProps) {
  const stageRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const dragRef = useRef<{
    handle: CropHandle
    startX: number
    startY: number
    startCrop: Rect
  } | null>(null)

  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null)
  /** The image as drawn on screen (object-contain), relative to the stage. */
  const [display, setDisplay] = useState<Rect | null>(null)
  const [crop, setCrop] = useState<Rect>(FULL)
  const [busy, setBusy] = useState(false)

  useLayoutEffect(() => {
    if (!natural) return
    const stage = stageRef.current
    if (!stage) return

    const measure = () => {
      const maxW = stage.clientWidth - STAGE_PADDING * 2
      const maxH = stage.clientHeight - STAGE_PADDING * 2
      if (maxW <= 0 || maxH <= 0) return
      const scale = Math.min(maxW / natural.width, maxH / natural.height)
      const width = natural.width * scale
      const height = natural.height * scale
      setDisplay({
        x: (stage.clientWidth - width) / 2,
        y: (stage.clientHeight - height) / 2,
        width,
        height,
      })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(stage)
    return () => ro.disconnect()
  }, [natural])

  // Keep the browser from treating a drag on the stage as scroll/zoom.
  useEffect(() => {
    const prev = document.body.style.overscrollBehavior
    document.body.style.overscrollBehavior = "none"
    return () => {
      document.body.style.overscrollBehavior = prev
    }
  }, [])

  function handlePointerDown(handle: CropHandle) {
    return (e: React.PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      dragRef.current = { handle, startX: e.clientX, startY: e.clientY, startCrop: crop }
    }
  }

  function handlePointerMove(e: React.PointerEvent) {
    const drag = dragRef.current
    if (!drag || !display) return
    const dx = (e.clientX - drag.startX) / display.width
    const dy = (e.clientY - drag.startY) / display.height
    setCrop(
      dragCrop(
        drag.startCrop,
        drag.handle,
        dx,
        dy,
        Math.min(1, MIN_EDGE_PX / display.width),
        Math.min(1, MIN_EDGE_PX / display.height)
      )
    )
  }

  function handlePointerUp() {
    dragRef.current = null
  }

  async function handleConfirm() {
    const img = imgRef.current
    if (!img || !natural || busy) return
    setBusy(true)

    const isFull = crop.x <= 0 && crop.y <= 0 && crop.width >= 1 && crop.height >= 1
    const px = cropToPixels(crop, natural.width, natural.height)
    const canvas = document.createElement("canvas")
    canvas.width = px.width
    canvas.height = px.height
    const ctx = canvas.getContext("2d")
    if (!ctx) {
      setBusy(false)
      return
    }
    ctx.drawImage(img, px.x, px.y, px.width, px.height, 0, 0, px.width, px.height)

    canvas.toBlob(
      (blob) => {
        if (!blob) {
          setBusy(false)
          return
        }
        // Untouched crop: reuse the existing preview instead of re-encoding it.
        onConfirm(blob, isFull ? previewUrl : canvas.toDataURL("image/jpeg", 0.92))
      },
      "image/jpeg",
      0.92
    )
  }

  const box = display && {
    left: display.x + crop.x * display.width,
    top: display.y + crop.y * display.height,
    width: crop.width * display.width,
    height: crop.height * display.height,
  }

  return (
    <div className="fixed inset-0 flex h-dvh w-full flex-col bg-black text-white touch-none select-none">
      <div
        className="px-4 pb-2 text-center text-sm font-medium text-white/80"
        style={{ paddingTop: "calc(env(safe-area-inset-top) + 0.75rem)" }}
      >
        Drag the corners to crop
      </div>

      <div
        ref={stageRef}
        className="relative min-h-0 flex-1"
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {display && (
          // eslint-disable-next-line jsx-a11y/alt-text
          <img
            ref={imgRef}
            src={previewUrl}
            draggable={false}
            className="pointer-events-none absolute"
            style={{ left: display.x, top: display.y, width: display.width, height: display.height }}
          />
        )}
        {/* Hidden copy used only to learn the natural size before layout. */}
        {!natural && (
          // eslint-disable-next-line jsx-a11y/alt-text
          <img
            src={previewUrl}
            className="hidden"
            onLoad={(e) =>
              setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })
            }
          />
        )}

        {box && (
          <div
            role="presentation"
            data-testid="crop-box"
            className="absolute cursor-move"
            style={{ ...box, boxShadow: "0 0 0 9999px rgba(0,0,0,0.6)" }}
            onPointerDown={handlePointerDown("move")}
          >
            {/* Rule-of-thirds grid */}
            <div className="pointer-events-none absolute inset-0">
              <div className="absolute inset-y-0 left-1/3 w-px bg-white/25" />
              <div className="absolute inset-y-0 left-2/3 w-px bg-white/25" />
              <div className="absolute inset-x-0 top-1/3 h-px bg-white/25" />
              <div className="absolute inset-x-0 top-2/3 h-px bg-white/25" />
              <div className="absolute inset-0 border border-white/70" />
              {BRACKETS.map((cls) => (
                <div key={cls} className={`absolute h-6 w-6 border-white ${cls}`} />
              ))}
            </div>

            {HANDLES.map(({ handle, className }) => (
              <div
                key={handle}
                data-handle={handle}
                className={`absolute ${className}`}
                onPointerDown={handlePointerDown(handle)}
              />
            ))}
          </div>
        )}
      </div>

      <div
        className="flex items-center justify-between gap-3 px-6 pt-3"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 1.5rem)" }}
      >
        <button
          type="button"
          onClick={onRetake}
          className="flex h-12 items-center gap-2 rounded-full bg-white/15 px-5 text-sm font-medium active:bg-white/25"
        >
          <RotateCcw className="h-4 w-4" />
          Retake
        </button>

        <button
          type="button"
          onClick={() => setCrop(FULL)}
          disabled={crop === FULL}
          className="h-12 rounded-full px-4 text-sm font-medium text-white/70 active:text-white disabled:opacity-40"
        >
          Reset
        </button>

        <button
          type="button"
          onClick={handleConfirm}
          disabled={busy || !display}
          className="flex h-12 items-center gap-2 rounded-full bg-primary px-6 text-sm font-semibold text-primary-foreground active:opacity-90 disabled:opacity-60"
        >
          <Check className="h-4 w-4" />
          Use photo
        </button>
      </div>
    </div>
  )
}
