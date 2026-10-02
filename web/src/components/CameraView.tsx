import { useEffect, useRef, useState } from "react"
import { History, Image as ImageIcon, RefreshCw, Settings } from "lucide-react"
import { computeCaptureRect, computeDownscaledSize } from "@/lib/capture"
import { cn } from "@/lib/utils"

type FacingMode = "environment" | "user"
type CameraErrorKind = "denied" | "no-camera" | "insecure" | "generic"

interface CameraViewProps {
  onCapture: (blob: Blob, previewUrl: string) => void
  onOpenSettings: () => void
  onOpenHistory: () => void
}

const CAMERA_ERROR_COPY: Record<CameraErrorKind, { title: string; body: string }> = {
  denied: {
    title: "Camera access denied",
    body: "Allow camera access in your browser settings to scan a page, or upload a photo instead.",
  },
  "no-camera": {
    title: "No camera found",
    body: "This device doesn't have a usable camera. You can upload a photo instead.",
  },
  insecure: {
    title: "Camera needs a secure connection",
    body: "The camera only works over HTTPS. Open this page through the tunnel link, or upload a photo instead.",
  },
  generic: {
    title: "Camera unavailable",
    body: "Something went wrong starting the camera. You can upload a photo instead.",
  },
}

export function CameraView({ onCapture, onOpenSettings, onOpenHistory }: CameraViewProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const galleryInputRef = useRef<HTMLInputElement>(null)
  const streamRef = useRef<MediaStream | null>(null)

  const [facingMode, setFacingMode] = useState<FacingMode>("environment")
  const [errorKind, setErrorKind] = useState<CameraErrorKind | null>(null)
  const [flashing, setFlashing] = useState(false)
  const [frozenFrame, setFrozenFrame] = useState<string | null>(null)
  const [capturing, setCapturing] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function start() {
      setErrorKind(null)
      if (!window.isSecureContext) {
        setErrorKind("insecure")
        return
      }
      if (!navigator.mediaDevices?.getUserMedia) {
        setErrorKind("insecure")
        return
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode,
            width: { ideal: 3840 },
            height: { ideal: 2160 },
          },
          audio: false,
        })
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
        }
      } catch (err) {
        if (cancelled) return
        const name = (err as DOMException)?.name
        if (name === "NotAllowedError" || name === "PermissionDeniedError") {
          setErrorKind("denied")
        } else if (name === "NotFoundError" || name === "OverconstrainedError") {
          setErrorKind("no-camera")
        } else {
          setErrorKind("generic")
        }
      }
    }

    start()

    return () => {
      cancelled = true
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facingMode])

  function stopStream() {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }

  function handleFlip() {
    setFacingMode((prev) => (prev === "environment" ? "user" : "environment"))
  }

  function handleShutter() {
    const video = videoRef.current
    if (!video || capturing) return
    if (!video.videoWidth || !video.videoHeight) return

    setCapturing(true)

    // Capture exactly what the preview shows: the preview is object-fit: cover,
    // so the full-resolution frame is cropped to the visible area, no more.
    const videoBox = video.getBoundingClientRect()
    const crop = computeCaptureRect(
      { x: 0, y: 0, width: videoBox.width, height: videoBox.height },
      videoBox.width,
      videoBox.height,
      video.videoWidth,
      video.videoHeight,
      0
    )

    const canvas = document.createElement("canvas")
    canvas.width = crop.width
    canvas.height = crop.height
    const ctx = canvas.getContext("2d")
    if (!ctx) {
      setCapturing(false)
      return
    }
    ctx.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height)

    const previewUrl = canvas.toDataURL("image/jpeg", 0.92)
    stopStream()
    setFrozenFrame(previewUrl)
    setFlashing(true)

    canvas.toBlob(
      (blob) => {
        if (!blob) {
          setCapturing(false)
          return
        }
        // Hold the frozen frame + flash on screen briefly before handing off
        // to the crop screen, so the shutter feels like an iOS camera.
        window.setTimeout(() => onCapture(blob, previewUrl), 220)
      },
      "image/jpeg",
      0.92
    )
  }

  // Dev-only test hook: the Browser pane can't drive a real OS file picker,
  // so expose the same code path the hidden <input type=file> uses. Never
  // included in a production build (import.meta.env.DEV is stripped by Vite).
  useEffect(() => {
    if (!import.meta.env.DEV) return
    ;(window as unknown as { __kitabLensDevGalleryUpload?: (file: File) => void }).__kitabLensDevGalleryUpload =
      handleGalleryFile
    return () => {
      delete (window as unknown as { __kitabLensDevGalleryUpload?: (file: File) => void })
        .__kitabLensDevGalleryUpload
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function handleGalleryFile(file: File) {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" })
      const { width, height } = computeDownscaledSize(bitmap.width, bitmap.height, 3000)
      const canvas = document.createElement("canvas")
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext("2d")
      if (!ctx) return
      ctx.drawImage(bitmap, 0, 0, width, height)
      bitmap.close?.()
      const previewUrl = canvas.toDataURL("image/jpeg", 0.92)
      stopStream()
      canvas.toBlob(
        (blob) => {
          if (blob) onCapture(blob, previewUrl)
        },
        "image/jpeg",
        0.92
      )
    } catch {
      // Fall back to sending the original file untouched if decoding fails.
      stopStream()
      const previewUrl = URL.createObjectURL(file)
      onCapture(file, previewUrl)
    }
  }

  if (errorKind) {
    const copy = CAMERA_ERROR_COPY[errorKind]
    return (
      <div
        className="relative flex h-dvh min-h-dvh w-full flex-col items-center justify-center gap-4 bg-background px-8 text-center"
        style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div
          className="absolute inset-x-0 top-0 flex items-center justify-between px-4"
          style={{ paddingTop: "calc(env(safe-area-inset-top) + 0.75rem)" }}
        >
          <button
            type="button"
            onClick={onOpenSettings}
            aria-label="Settings"
            className="flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground active:bg-accent"
          >
            <Settings className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={onOpenHistory}
            aria-label="History"
            className="flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground active:bg-accent"
          >
            <History className="h-5 w-5" />
          </button>
        </div>

        <div className="text-5xl">📷</div>
        <h2 className="text-lg font-semibold">{copy.title}</h2>
        <p className="max-w-sm text-sm text-muted-foreground">{copy.body}</p>
        <button
          type="button"
          onClick={() => galleryInputRef.current?.click()}
          className="mt-4 rounded-full bg-primary px-6 py-3 text-sm font-medium text-primary-foreground active:opacity-90"
        >
          Upload from gallery
        </button>
        <input
          ref={galleryInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) handleGalleryFile(file)
            e.target.value = ""
          }}
        />
      </div>
    )
  }

  return (
    <div className="fixed inset-0 h-dvh w-full overflow-hidden bg-black touch-none">
      <div className="relative h-full w-full">
        {frozenFrame ? (
          // eslint-disable-next-line jsx-a11y/alt-text
          <img src={frozenFrame} className="h-full w-full object-cover" />
        ) : (
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            className={cn("h-full w-full object-cover", facingMode === "user" && "-scale-x-100")}
          />
        )}

        {flashing && (
          <div className="pointer-events-none absolute inset-0 animate-flash bg-white" />
        )}

        {/* Top bar */}
        <div
          className="absolute inset-x-0 top-0 flex items-center justify-between px-4"
          style={{ paddingTop: "calc(env(safe-area-inset-top) + 0.75rem)" }}
        >
          <button
            type="button"
            onClick={onOpenSettings}
            aria-label="Settings"
            className="flex h-11 w-11 items-center justify-center rounded-full bg-black/35 text-white backdrop-blur-sm active:bg-black/50"
          >
            <Settings className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={onOpenHistory}
            aria-label="History"
            className="flex h-11 w-11 items-center justify-center rounded-full bg-black/35 text-white backdrop-blur-sm active:bg-black/50"
          >
            <History className="h-5 w-5" />
          </button>
        </div>

        {/* Bottom bar */}
        <div
          className="absolute inset-x-0 bottom-0 flex items-center justify-between px-8"
          style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 1.5rem)" }}
        >
          <button
            type="button"
            onClick={() => galleryInputRef.current?.click()}
            aria-label="Upload from gallery"
            className="flex h-12 w-12 items-center justify-center rounded-full bg-black/35 text-white backdrop-blur-sm active:bg-black/50"
          >
            <ImageIcon className="h-6 w-6" />
          </button>

          <button
            type="button"
            onClick={handleShutter}
            disabled={capturing}
            aria-label="Capture"
            className="flex h-[72px] w-[72px] items-center justify-center rounded-full border-[4px] border-white bg-white/10 active:scale-95 disabled:opacity-60"
          >
            <span className="h-[58px] w-[58px] rounded-full bg-white" />
          </button>

          <button
            type="button"
            onClick={handleFlip}
            aria-label="Flip camera"
            className="flex h-12 w-12 items-center justify-center rounded-full bg-black/35 text-white backdrop-blur-sm active:bg-black/50"
          >
            <RefreshCw className="h-6 w-6" />
          </button>
        </div>

        <input
          ref={galleryInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) handleGalleryFile(file)
            e.target.value = ""
          }}
        />
      </div>
    </div>
  )
}
