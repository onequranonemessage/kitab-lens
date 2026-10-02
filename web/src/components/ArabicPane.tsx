import { Check, Copy, Pencil, X } from "lucide-react"
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

interface ArabicPaneProps {
  arabic: string
  className?: string
  onRetranslate: (editedArabic: string) => void
}

/** The Arabic source pane: read view by default, with an Edit toggle that
 * swaps in an RTL textarea and a Re-translate button that sends the edited
 * text without re-running OCR. */
export function ArabicPane({ arabic, className, onRetranslate }: ArabicPaneProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(arabic)
  const [copied, setCopied] = useState(false)

  function startEdit() {
    setDraft(arabic)
    setEditing(true)
  }

  function cancelEdit() {
    setEditing(false)
  }

  function saveAndRetranslate() {
    setEditing(false)
    if (draft.trim() !== arabic.trim()) {
      onRetranslate(draft)
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(editing ? draft : arabic)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard permission denied — nothing more we can do here
    }
  }

  return (
    <div className={cn("flex h-full min-w-0 flex-col overflow-hidden", className)}>
      <div className="flex flex-wrap items-center justify-between gap-1.5 px-4 pb-2 pt-3">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">العربية</span>
        <div className="flex items-center gap-1.5">
          <Button variant="ghost" size="sm" className="h-7 gap-1 px-2" onClick={copy}>
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            <span className="text-xs">{copied ? "Copied" : "Copy"}</span>
          </Button>
          {editing ? (
            <>
              <Button variant="ghost" size="sm" className="h-7 gap-1 px-2" onClick={cancelEdit}>
                <X className="h-3.5 w-3.5" />
                <span className="text-xs">Cancel</span>
              </Button>
              <Button
                size="sm"
                className="h-7 gap-1 px-2"
                onClick={saveAndRetranslate}
                aria-label="Translate edited Arabic"
              >
                <span className="text-xs">Translate edit</span>
              </Button>
            </>
          ) : (
            <Button variant="ghost" size="sm" className="h-7 gap-1 px-2" onClick={startEdit}>
              <Pencil className="h-3.5 w-3.5" />
              <span className="text-xs">Edit</span>
            </Button>
          )}
        </div>
      </div>

      <div className="scrollbar-thin flex-1 overflow-y-auto px-4 pb-6">
        {editing ? (
          <Textarea
            dir="rtl"
            lang="ar"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="font-arabic min-h-[60vh] text-xl leading-loose"
          />
        ) : (
          <p dir="rtl" lang="ar" className="font-arabic whitespace-pre-wrap text-xl leading-loose">
            {arabic}
          </p>
        )}
      </div>
    </div>
  )
}
