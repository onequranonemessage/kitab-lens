import { useEffect, useRef, useState } from "react"
import QRCode from "qrcode"
import { getConnectInfo, type ConnectInfo } from "@/lib/api"

/**
 * Desktop-only page opened on the Mac by run.sh: shows a QR code for the
 * tunnel URL plus the passcode, so scanning it with a phone camera jumps
 * straight to the passcode gate (or straight in, if already trusted).
 */
export function ConnectPage() {
  const [info, setInfo] = useState<ConnectInfo | null>(null)
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)
  const [errored, setErrored] = useState(false)
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    let cancelled = false

    async function poll() {
      try {
        const data = await getConnectInfo()
        if (cancelled) return
        setInfo(data)
        setErrored(false)
        if (data.tunnel_url) {
          const dataUrl = await QRCode.toDataURL(data.tunnel_url, {
            width: 320,
            margin: 1,
            color: { dark: "#0a0a0c", light: "#ffffff" },
          })
          if (!cancelled) setQrDataUrl(dataUrl)
        } else {
          setQrDataUrl(null)
        }
      } catch {
        if (!cancelled) setErrored(true)
      }
      if (!cancelled) {
        timerRef.current = window.setTimeout(poll, 3000)
      }
    }

    poll()
    return () => {
      cancelled = true
      if (timerRef.current) window.clearTimeout(timerRef.current)
    }
  }, [])

  return (
    <div className="flex min-h-dvh w-full flex-col items-center justify-center gap-6 bg-background px-6 py-12 text-center">
      <div className="flex flex-col items-center gap-1">
        <div className="text-4xl">📖</div>
        <h1 className="text-xl font-semibold">kitab lens</h1>
        <p className="text-sm text-muted-foreground">Scan this on your phone to connect</p>
      </div>

      {errored && (
        <p className="max-w-sm text-sm text-destructive">
          Couldn't reach the server. Make sure it's running.
        </p>
      )}

      {!errored && info && !info.tunnel_url && (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-border bg-card p-8">
          <p className="text-base font-medium">Tunnel not running</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            Start it with <code className="rounded bg-secondary px-1.5 py-0.5">./run.sh</code>
          </p>
        </div>
      )}

      {qrDataUrl && info?.tunnel_url && (
        <div className="flex flex-col items-center gap-4">
          <div className="rounded-2xl bg-white p-4 shadow-lg">
            <img src={qrDataUrl} alt="QR code for tunnel URL" className="h-64 w-64" />
          </div>
          <p className="max-w-xs break-all text-sm text-muted-foreground">{info.tunnel_url}</p>
          <div className="flex flex-col items-center gap-1">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">Passcode</span>
            <span className="text-3xl font-bold tracking-widest">{info.passcode}</span>
          </div>
        </div>
      )}
    </div>
  )
}
