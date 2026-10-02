import { useCallback, useEffect, useRef, useState } from "react"
import { ChevronLeft, RotateCcw } from "lucide-react"
import { toast } from "sonner"
import {
  getJobSnapshot,
  getStatus,
  postOcr,
  postTranslate,
  subscribeJobEvents,
} from "@/lib/api"
import { newHistoryId, makeThumbnail, saveEntry, type HistoryEntry } from "@/lib/history"
import { DEFAULT_LANGUAGE } from "@/lib/languages"
import type { Settings } from "@/lib/settings"
import type { OcrStage, TranslationState } from "@/lib/scan-types"
import { useIsWideResult } from "@/lib/useMediaQuery"
import { cn } from "@/lib/utils"
import { BottomSheet } from "./BottomSheet"
import { TranslationPane } from "./TranslationPane"
import { ArabicPane } from "./ArabicPane"
import { Button } from "@/components/ui/button"

export type ScanSource =
  | { kind: "capture"; blob: Blob; previewUrl: string }
  | { kind: "history"; entry: HistoryEntry }

interface ResultViewProps {
  source: ScanSource
  settings: Settings
  onRetake: () => void
}

export function ResultView({ source, settings, onRetake }: ResultViewProps) {
  const isWide = useIsWideResult()

  const historyIdRef = useRef(source.kind === "history" ? source.entry.id : newHistoryId())
  const createdAtRef = useRef(source.kind === "history" ? source.entry.createdAt : Date.now())
  const thumbRef = useRef(source.kind === "history" ? source.entry.thumb : "")

  const [photoUrl] = useState(source.kind === "history" ? source.entry.thumb : source.previewUrl)
  const [ocrStage, setOcrStage] = useState<OcrStage>(source.kind === "history" ? "ready" : "loading")
  const [ocrError, setOcrError] = useState<string | null>(null)
  const [arabic, setArabic] = useState(source.kind === "history" ? source.entry.arabic : "")
  const [language, setLanguage] = useState(settings.defaultLanguage || DEFAULT_LANGUAGE)
  const [translations, setTranslations] = useState<Record<string, TranslationState>>(
    source.kind === "history"
      ? Object.fromEntries(
          Object.entries(source.entry.translations).map(([lang, text]) => [
            lang,
            { status: "done" as const, text },
          ])
        )
      : {}
  )
  const [activePane, setActivePane] = useState<"translation" | "arabic">("translation")

  const subscriptionsRef = useRef<Record<string, () => void>>({})
  const pagerRef = useRef<HTMLDivElement>(null)

  const persistHistory = useCallback(
    (nextArabic: string, nextTranslations: Record<string, TranslationState>) => {
      const doneTranslations: Record<string, string> = {}
      for (const [lang, state] of Object.entries(nextTranslations)) {
        if (state.status === "done" && state.text) doneTranslations[lang] = state.text
      }
      const entry: HistoryEntry = {
        id: historyIdRef.current,
        createdAt: createdAtRef.current,
        thumb: thumbRef.current,
        arabic: nextArabic,
        translations: doneTranslations,
      }
      saveEntry(entry).catch(() => {
        // History is a convenience feature — a failed write shouldn't block the UI.
      })
    },
    []
  )

  const startTranslateJob = useCallback(
    (lang: string, arabicText: string, force = false) => {
      setTranslations((prev) => {
        const existing = prev[lang]
        if (!force && (existing?.status === "done" || existing?.status === "queued" || existing?.status === "translating")) {
          return prev
        }
        return { ...prev, [lang]: { status: "queued" } }
      })

      subscriptionsRef.current[lang]?.()
      delete subscriptionsRef.current[lang]

      postTranslate(arabicText, lang)
        .then(({ job_id }) => {
          setTranslations((prev) => ({ ...prev, [lang]: { ...prev[lang], status: "queued", jobId: job_id } }))
          subscriptionsRef.current[lang] = subscribeJobEvents(job_id, {
            onQueued: (position) => {
              setTranslations((prev) => ({ ...prev, [lang]: { ...prev[lang], status: "queued", position } }))
            },
            onStarted: () => {
              setTranslations((prev) => ({ ...prev, [lang]: { ...prev[lang], status: "translating" } }))
            },
            onPartial: (text) => {
              setTranslations((prev) => ({ ...prev, [lang]: { ...prev[lang], status: "translating", text } }))
            },
            onDone: (text) => {
              setTranslations((prev) => {
                const next = { ...prev, [lang]: { ...prev[lang], status: "done" as const, text } }
                persistHistory(arabicText, next)
                return next
              })
            },
            onError: (message) => {
              setTranslations((prev) => ({ ...prev, [lang]: { ...prev[lang], status: "error", error: message } }))
            },
          })
        })
        .catch((err) => {
          setTranslations((prev) => ({
            ...prev,
            [lang]: { ...prev[lang], status: "error", error: err instanceof Error ? err.message : "Failed to start translation" },
          }))
        })
    },
    [persistHistory]
  )

  // Kick off OCR (fresh capture) or, for a reopened history entry, translate
  // any language that isn't cached yet — runs once per mounted scan.
  useEffect(() => {
    if (source.kind === "capture") {
      let cancelled = false
      postOcr(source.blob)
        .then(async (res) => {
          if (cancelled) return
          if (!res.arabic.trim()) {
            setOcrStage("empty")
            return
          }
          setArabic(res.arabic)
          setOcrStage("ready")
          try {
            thumbRef.current = await makeThumbnail(source.blob)
          } catch {
            thumbRef.current = ""
          }
          persistHistory(res.arabic, {})
          startTranslateJob(language, res.arabic)
        })
        .catch((err) => {
          if (cancelled) return
          setOcrStage("error")
          setOcrError(err instanceof Error ? err.message : "OCR failed")
        })
      return () => {
        cancelled = true
      }
    }
    // Reopened from history: translate the default language on demand if missing.
    if (!translations[language]) {
      startTranslateJob(language, arabic)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Close all open SSE connections on unmount.
  useEffect(() => {
    return () => {
      Object.values(subscriptionsRef.current).forEach((close) => close())
    }
  }, [])

  // Poll /api/status every 5s while any translation is in flight, to catch
  // the ChatGPT window needing manual attention on the Mac.
  useEffect(() => {
    const interval = window.setInterval(() => {
      const pending = Object.values(translations).some(
        (t) => t.status === "queued" || t.status === "translating"
      )
      if (!pending) return
      getStatus()
        .then((status) => {
          if (status.chatgpt === "needs_attention") {
            toast.warning("Check the Chrome window on the Mac", { id: "chatgpt-attention" })
          }
        })
        .catch(() => {
          // status polling is best-effort
        })
    }, 5000)
    return () => window.clearInterval(interval)
  }, [translations])

  // Reconnect/refresh pending jobs when the tab becomes visible again
  // (backgrounded tabs can have their SSE connection killed outright).
  useEffect(() => {
    function onVisibilityChange() {
      if (document.visibilityState !== "visible") return
      for (const [lang, state] of Object.entries(translations)) {
        if (state.status !== "queued" && state.status !== "translating") continue
        if (!state.jobId) continue
        getJobSnapshot(state.jobId)
          .then((snapshot) => {
            setTranslations((prev) => ({
              ...prev,
              [lang]: {
                ...prev[lang],
                status: snapshot.status === "queued" ? "queued" : snapshot.status === "started" ? "translating" : snapshot.status,
                position: snapshot.position,
                text: snapshot.text ?? prev[lang]?.text,
                error: snapshot.error,
              },
            }))
            if (snapshot.status !== "done" && snapshot.status !== "error") {
              subscriptionsRef.current[lang]?.()
              subscriptionsRef.current[lang] = subscribeJobEvents(state.jobId!, {
                onQueued: (position) =>
                  setTranslations((prev) => ({ ...prev, [lang]: { ...prev[lang], status: "queued", position } })),
                onStarted: () =>
                  setTranslations((prev) => ({ ...prev, [lang]: { ...prev[lang], status: "translating" } })),
                onPartial: (text) =>
                  setTranslations((prev) => ({ ...prev, [lang]: { ...prev[lang], status: "translating", text } })),
                onDone: (text) =>
                  setTranslations((prev) => {
                    const next = { ...prev, [lang]: { ...prev[lang], status: "done" as const, text } }
                    persistHistory(arabic, next)
                    return next
                  }),
                onError: (message) =>
                  setTranslations((prev) => ({ ...prev, [lang]: { ...prev[lang], status: "error", error: message } })),
              })
            }
          })
          .catch(() => {
            // snapshot fetch is best-effort
          })
      }
    }
    document.addEventListener("visibilitychange", onVisibilityChange)
    return () => document.removeEventListener("visibilitychange", onVisibilityChange)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [translations, arabic])

  function handleLanguageChange(nextLanguage: string) {
    setLanguage(nextLanguage)
    setActivePane("translation")
    const existing = translations[nextLanguage]
    if (!existing || existing.status === "error") {
      startTranslateJob(nextLanguage, arabic)
    }
  }

  function handleArabicRetranslate(newArabic: string) {
    setArabic(newArabic)
    setTranslations({})
    persistHistory(newArabic, {})
    startTranslateJob(language, newArabic, true)
  }

  function scrollToPane(pane: "translation" | "arabic") {
    setActivePane(pane)
    const el = pagerRef.current
    if (!el) return
    el.scrollTo({ left: pane === "translation" ? 0 : el.clientWidth, behavior: "smooth" })
  }

  function onPagerScroll() {
    const el = pagerRef.current
    if (!el) return
    setActivePane(el.scrollLeft > el.clientWidth / 2 ? "arabic" : "translation")
  }

  const translationPaneEl = (
    <TranslationPane
      language={language}
      state={translations[language]}
      onLanguageChange={handleLanguageChange}
      onRetry={() => startTranslateJob(language, arabic, true)}
      onRetranslate={() => startTranslateJob(language, arabic, true)}
      className="h-full min-w-0"
    />
  )
  const arabicPaneEl = (
    <ArabicPane arabic={arabic} onRetranslate={handleArabicRetranslate} className="h-full min-w-0" />
  )

  if (ocrStage === "loading") {
    return (
      <div className="fixed inset-0 flex h-dvh flex-col items-center justify-center gap-4 bg-black">
        <img src={photoUrl} className="absolute inset-0 h-full w-full object-cover opacity-40" alt="" />
        <div className="relative flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/30 border-t-white" />
          <p className="shimmer-text text-sm font-medium text-white">Reading Arabic…</p>
        </div>
      </div>
    )
  }

  if (ocrStage === "empty" || ocrStage === "error") {
    return (
      <div className="fixed inset-0 flex h-dvh flex-col items-center justify-center gap-4 bg-black px-8 text-center">
        <img src={photoUrl} className="absolute inset-0 h-full w-full object-cover opacity-25" alt="" />
        <div className="relative flex flex-col items-center gap-3">
          <p className="text-lg font-medium text-white">
            {ocrStage === "empty" ? "No Arabic text found" : "Something went wrong"}
          </p>
          {ocrError && <p className="max-w-xs text-sm text-white/70">{ocrError}</p>}
          <Button onClick={onRetake} className="mt-2">
            Retake
          </Button>
        </div>
      </div>
    )
  }

  if (settings.layout === "split") {
    return (
      <div className="fixed inset-0 flex h-dvh flex-col bg-background">
        <div
          className="flex items-center gap-3 border-b border-border px-3 py-2"
          style={{ paddingTop: "calc(env(safe-area-inset-top) + 0.5rem)" }}
        >
          <button
            type="button"
            onClick={onRetake}
            aria-label="Back"
            className="flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground hover:bg-accent"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <img src={photoUrl} className="h-9 w-9 rounded-md object-cover" alt="Scanned page" />
          <span className="text-sm font-medium">Scan result</span>
        </div>

        <div className="grid flex-1 grid-cols-2 divide-x divide-border overflow-hidden">
          {translationPaneEl}
          {arabicPaneEl}
        </div>

        <div
          className="border-t border-border p-3"
          style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 0.5rem)" }}
        >
          <Button onClick={onRetake} className="w-full gap-2">
            <RotateCcw className="h-4 w-4" />
            Scan another
          </Button>
        </div>
      </div>
    )
  }

  // Default "sheet" layout.
  const segmented = !isWide && (
    <div className="flex items-center gap-1 px-4 pb-2">
      <div className="flex rounded-full bg-secondary p-1">
        <button
          type="button"
          onClick={() => scrollToPane("translation")}
          className={cn(
            "rounded-full px-4 py-1.5 text-xs font-medium transition-colors",
            activePane === "translation" ? "bg-background shadow-sm" : "text-muted-foreground"
          )}
        >
          Translation
        </button>
        <button
          type="button"
          onClick={() => scrollToPane("arabic")}
          className={cn(
            "rounded-full px-4 py-1.5 text-xs font-medium transition-colors",
            activePane === "arabic" ? "bg-background shadow-sm" : "text-muted-foreground"
          )}
        >
          العربية
        </button>
      </div>
    </div>
  )

  return (
    <div className="fixed inset-0 h-dvh w-full overflow-hidden bg-black">
      <img src={photoUrl} className="absolute inset-0 h-full w-full object-cover opacity-45" alt="Scanned page" />
      <div className="absolute inset-0 bg-black/25" />

      <button
        type="button"
        onClick={onRetake}
        aria-label="Retake"
        className="absolute left-4 flex h-10 w-10 items-center justify-center rounded-full bg-black/35 text-white backdrop-blur-sm active:bg-black/50"
        style={{ top: "calc(env(safe-area-inset-top) + 0.75rem)" }}
      >
        <ChevronLeft className="h-5 w-5" />
      </button>

      <BottomSheet header={segmented}>
        {isWide ? (
          <div className="grid h-full grid-cols-2 divide-x divide-border overflow-hidden">
            {translationPaneEl}
            {arabicPaneEl}
          </div>
        ) : (
          <div
            ref={pagerRef}
            onScroll={onPagerScroll}
            className="snap-pager flex h-full overflow-x-auto overflow-y-hidden"
          >
            <div className="h-full w-full shrink-0">{translationPaneEl}</div>
            <div className="h-full w-full shrink-0">{arabicPaneEl}</div>
          </div>
        )}
      </BottomSheet>
    </div>
  )
}
