import { useEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"

const SNAP_MIN = 0.45 // fraction of viewport height visible when collapsed
const SNAP_MAX = 0.92 // fraction of viewport height visible when expanded

interface BottomSheetProps {
  header: React.ReactNode
  children: React.ReactNode
  className?: string
}

/**
 * A draggable bottom sheet that snaps to ~45% or ~92% of the viewport
 * height, dragged from a handle at its top. The sheet's own height is
 * fixed at the expanded snap point; collapsing translates it down by the
 * difference, so content never reflows mid-drag — only its visible portion
 * changes, which is what makes 1:1 finger tracking feel right.
 */
export function BottomSheet({ header, children, className }: BottomSheetProps) {
  const [expanded, setExpanded] = useState(false)
  const [dragOffset, setDragOffset] = useState<number | null>(null)
  const dragState = useRef<{ startY: number; startOffset: number; moved: number } | null>(null)
  const [maxOffsetPx, setMaxOffsetPx] = useState(0)

  useEffect(() => {
    const compute = () => setMaxOffsetPx(window.innerHeight * (SNAP_MAX - SNAP_MIN))
    compute()
    window.addEventListener("resize", compute)
    window.addEventListener("orientationchange", compute)
    return () => {
      window.removeEventListener("resize", compute)
      window.removeEventListener("orientationchange", compute)
    }
  }, [])

  const baseOffset = expanded ? 0 : maxOffsetPx
  const translateY = dragOffset !== null ? dragOffset : baseOffset

  function onPointerDown(e: React.PointerEvent) {
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    dragState.current = { startY: e.clientY, startOffset: baseOffset, moved: 0 }
    setDragOffset(baseOffset)
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!dragState.current) return
    const delta = e.clientY - dragState.current.startY
    dragState.current.moved = Math.max(dragState.current.moved, Math.abs(delta))
    const next = Math.min(Math.max(dragState.current.startOffset + delta, 0), maxOffsetPx)
    setDragOffset(next)
  }

  function onPointerUp() {
    if (!dragState.current) return
    const { moved } = dragState.current
    if (moved < 6) {
      // Treat as a tap on the handle rather than a drag.
      setExpanded((prev) => !prev)
    } else if (dragOffset !== null) {
      setExpanded(dragOffset < maxOffsetPx / 2)
    }
    dragState.current = null
    setDragOffset(null)
  }

  return (
    <div
      className={cn(
        "fixed inset-x-0 bottom-0 z-30 flex flex-col rounded-t-2xl border-t border-border bg-card shadow-2xl",
        dragOffset === null && "transition-transform duration-300 ease-out",
        className
      )}
      style={{
        height: `${SNAP_MAX * 100}dvh`,
        transform: `translateY(${translateY}px)`,
      }}
    >
      <div
        className="flex shrink-0 cursor-grab touch-none flex-col items-center pb-1 pt-2.5 active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div className="h-1.5 w-10 rounded-full bg-muted-foreground/40" />
      </div>
      <div className="shrink-0">{header}</div>
      <div
        className="flex-1 overflow-hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {children}
      </div>
    </div>
  )
}
