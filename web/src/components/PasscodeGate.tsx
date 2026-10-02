import { useEffect, useRef, useState } from "react"
import { Delete } from "lucide-react"
import { postAuth } from "@/lib/api"
import { cn } from "@/lib/utils"

const PASSCODE_LENGTH = 6

interface PasscodeGateProps {
  onSuccess: () => void
}

/**
 * Full-screen 6-digit passcode entry. Shown on initial 401 from
 * `GET /api/status`, and again any time a later request 401s (session
 * cookie expired or was never set on this device).
 */
export function PasscodeGate({ onSuccess }: PasscodeGateProps) {
  const [digits, setDigits] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const submittedRef = useRef(false)

  useEffect(() => {
    if (digits.length === PASSCODE_LENGTH && !submittedRef.current) {
      submittedRef.current = true
      setSubmitting(true)
      setError(null)
      postAuth(digits)
        .then(() => onSuccess())
        .catch((err) => {
          setError(err instanceof Error ? err.message : "Incorrect passcode")
          setDigits("")
          submittedRef.current = false
        })
        .finally(() => setSubmitting(false))
    }
  }, [digits, onSuccess])

  const press = (d: string) => {
    if (submitting) return
    setError(null)
    setDigits((prev) => (prev.length < PASSCODE_LENGTH ? prev + d : prev))
  }
  const backspace = () => {
    if (submitting) return
    setDigits((prev) => prev.slice(0, -1))
  }

  return (
    <div
      className="flex h-dvh min-h-dvh w-full flex-col items-center justify-center bg-background px-6"
      style={{
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      <div className="mb-10 flex flex-col items-center gap-2 text-center">
        <div className="text-4xl">📖</div>
        <h1 className="text-xl font-semibold">kitab lens</h1>
        <p className="text-sm text-muted-foreground">Enter the 6-digit passcode</p>
      </div>

      <div className="mb-8 flex gap-3">
        {Array.from({ length: PASSCODE_LENGTH }).map((_, i) => (
          <div
            key={i}
            className={cn(
              "h-3.5 w-3.5 rounded-full border-2 border-muted-foreground/50 transition-colors",
              i < digits.length && "border-primary bg-primary",
              error && "border-destructive"
            )}
          />
        ))}
      </div>

      {error && <p className="mb-4 text-sm text-destructive">{error}</p>}

      <div className="grid w-full max-w-xs grid-cols-3 gap-4">
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => press(d)}
            disabled={submitting}
            className="aspect-square rounded-full bg-secondary text-2xl font-medium text-secondary-foreground transition-colors active:bg-accent disabled:opacity-50"
          >
            {d}
          </button>
        ))}
        <div />
        <button
          type="button"
          onClick={() => press("0")}
          disabled={submitting}
          className="aspect-square rounded-full bg-secondary text-2xl font-medium text-secondary-foreground transition-colors active:bg-accent disabled:opacity-50"
        >
          0
        </button>
        <button
          type="button"
          onClick={backspace}
          disabled={submitting || digits.length === 0}
          aria-label="Backspace"
          className="flex aspect-square items-center justify-center rounded-full text-muted-foreground transition-colors active:bg-accent disabled:opacity-30"
        >
          <Delete className="h-6 w-6" />
        </button>
      </div>
    </div>
  )
}
