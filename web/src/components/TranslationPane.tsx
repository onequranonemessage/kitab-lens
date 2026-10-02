import { useState } from "react"
import ReactMarkdown from "react-markdown"
import { Check, Copy, RefreshCw } from "lucide-react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { CUSTOM_LANGUAGE_VALUE, LANGUAGES, isRtlLanguage, isValidCustomLanguage } from "@/lib/languages"
import type { TranslationState } from "@/lib/scan-types"
import { cn } from "@/lib/utils"

interface TranslationPaneProps {
  language: string
  state: TranslationState | undefined
  onLanguageChange: (language: string) => void
  onRetry: () => void
  onRetranslate: () => void
  className?: string
}

export function TranslationPane({
  language,
  state,
  onLanguageChange,
  onRetry,
  onRetranslate,
  className,
}: TranslationPaneProps) {
  const isPreset = LANGUAGES.some((l) => l.value === language)
  const [customEditing, setCustomEditing] = useState(false)
  const [customDraft, setCustomDraft] = useState(isPreset ? "" : language)
  const [customError, setCustomError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const rtl = isRtlLanguage(language)

  function handleSelect(value: string) {
    if (value === CUSTOM_LANGUAGE_VALUE) {
      setCustomDraft(isPreset ? "" : language)
      setCustomError(null)
      setCustomEditing(true)
      return
    }
    setCustomEditing(false)
    onLanguageChange(value)
  }

  function confirmCustom() {
    const trimmed = customDraft.trim()
    if (!isValidCustomLanguage(trimmed)) {
      setCustomError("Letters, spaces, hyphens and parentheses only (max 40 chars)")
      return
    }
    setCustomError(null)
    setCustomEditing(false)
    onLanguageChange(trimmed)
  }

  async function copyText() {
    if (!state?.text) return
    try {
      await navigator.clipboard.writeText(state.text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard permission denied — nothing more we can do here
    }
  }

  return (
    <div className={cn("flex h-full min-w-0 flex-col overflow-hidden", className)}>
      <div className="flex flex-wrap items-center gap-2 px-4 pb-2 pt-3">
        <Select value={isPreset ? language : CUSTOM_LANGUAGE_VALUE} onValueChange={handleSelect}>
          <SelectTrigger className="h-8 w-auto min-w-0 max-w-[9rem] text-xs">
            <SelectValue placeholder="Language" />
          </SelectTrigger>
          <SelectContent>
            {LANGUAGES.map((l) => (
              <SelectItem key={l.value} value={l.value}>
                {l.label}
              </SelectItem>
            ))}
            {!isPreset && (
              <SelectItem value={CUSTOM_LANGUAGE_VALUE}>{language} (custom)</SelectItem>
            )}
            {isPreset && <SelectItem value={CUSTOM_LANGUAGE_VALUE}>Custom…</SelectItem>}
          </SelectContent>
        </Select>

        <div className="ml-auto flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2"
            onClick={copyText}
            disabled={!state?.text}
          >
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            <span className="text-xs">{copied ? "Copied" : "Copy"}</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2"
            onClick={onRetranslate}
            disabled={!state || state.status === "queued" || state.status === "translating"}
            aria-label="Re-translate this scan"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            <span className="text-xs">Re-translate</span>
          </Button>
        </div>
      </div>

      {customEditing && (
        <div className="flex flex-col gap-1.5 px-4 pb-2">
          <div className="flex gap-2">
            <Input
              autoFocus
              value={customDraft}
              placeholder="Custom language…"
              maxLength={40}
              onChange={(e) => setCustomDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") confirmCustom()
                if (e.key === "Escape") setCustomEditing(false)
              }}
              className="h-8 text-sm"
            />
            <Button size="sm" className="h-8" onClick={confirmCustom}>
              Use
            </Button>
          </div>
          {customError && <p className="text-xs text-destructive">{customError}</p>}
        </div>
      )}

      <div className="scrollbar-thin flex-1 overflow-y-auto px-4 pb-6">
        {!state && <p className="text-sm text-muted-foreground">Waiting for Arabic text…</p>}

        {state?.status === "queued" && (
          <p className="shimmer-text text-sm text-muted-foreground">
            Queued{state.position ? ` #${state.position}` : ""}…
          </p>
        )}

        {state?.status === "translating" && !state.text && (
          <p className="shimmer-text text-sm text-muted-foreground">Translating…</p>
        )}

        {state?.status === "error" && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-destructive">{state.error || "Translation failed"}</p>
            <Button size="sm" variant="secondary" className="w-fit" onClick={onRetry}>
              Retry
            </Button>
          </div>
        )}

        {(state?.status === "done" || state?.status === "translating") && state.text && (
          <div
            dir={rtl ? "rtl" : "ltr"}
            className={cn(
              "prose prose-invert prose-sm max-w-none leading-relaxed prose-p:my-2 prose-headings:mb-2 prose-headings:mt-4",
              rtl && "font-arabic text-lg"
            )}
          >
            <ReactMarkdown>{state.text}</ReactMarkdown>
            {state.status === "translating" && (
              <p className="shimmer-text mt-3 text-xs text-muted-foreground">Still writing…</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
