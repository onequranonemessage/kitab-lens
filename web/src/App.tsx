import { useEffect, useState } from "react"
import { Toaster } from "@/components/ui/sonner"
import { PasscodeGate } from "@/components/PasscodeGate"
import { CameraView } from "@/components/CameraView"
import { CropView } from "@/components/CropView"
import { ResultView, type ScanSource } from "@/components/ResultView"
import { SettingsDrawer } from "@/components/SettingsDrawer"
import { HistoryDrawer } from "@/components/HistoryDrawer"
import { ConnectPage } from "@/components/ConnectPage"
import { UNAUTHORIZED_EVENT, getStatus } from "@/lib/api"
import { loadSettings, saveSettings, type Settings } from "@/lib/settings"
import type { HistoryEntry } from "@/lib/history"

type AuthState = "checking" | "gate" | "ok"
type Screen =
  | { kind: "camera" }
  | { kind: "crop"; previewUrl: string }
  | { kind: "result"; source: ScanSource }

export default function App() {
  if (window.location.pathname === "/connect") {
    return <ConnectPage />
  }
  return <MainApp />
}

function MainApp() {
  const [authState, setAuthState] = useState<AuthState>("checking")
  const [settings, setSettings] = useState<Settings>(() => loadSettings())
  const [screen, setScreen] = useState<Screen>({ kind: "camera" })
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)

  useEffect(() => {
    getStatus()
      .then(() => setAuthState("ok"))
      .catch(() => setAuthState("gate"))
  }, [])

  useEffect(() => {
    function onUnauthorized() {
      setAuthState("gate")
    }
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
  }, [])

  function updateSettings(patch: Partial<Settings>) {
    setSettings((prev) => {
      const next = { ...prev, ...patch }
      saveSettings(next)
      return next
    })
  }

  function handleSelectHistoryEntry(entry: HistoryEntry) {
    setHistoryOpen(false)
    setScreen({ kind: "result", source: { kind: "history", entry } })
  }

  if (authState === "checking") {
    return <div className="h-dvh w-full bg-background" />
  }

  if (authState === "gate") {
    return <PasscodeGate onSuccess={() => setAuthState("ok")} />
  }

  return (
    <>
      {screen.kind === "camera" && (
        <CameraView
          onCapture={(_blob, previewUrl) => setScreen({ kind: "crop", previewUrl })}
          onOpenSettings={() => setSettingsOpen(true)}
          onOpenHistory={() => setHistoryOpen(true)}
        />
      )}
      {screen.kind === "crop" && (
        <CropView
          previewUrl={screen.previewUrl}
          onConfirm={(blob, previewUrl) =>
            setScreen({ kind: "result", source: { kind: "capture", blob, previewUrl } })
          }
          onRetake={() => setScreen({ kind: "camera" })}
        />
      )}
      {screen.kind === "result" && (
        <ResultView
          key={screen.source.kind === "history" ? screen.source.entry.id : "capture"}
          source={screen.source}
          settings={settings}
          onRetake={() => setScreen({ kind: "camera" })}
        />
      )}

      <SettingsDrawer
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={settings}
        onChange={updateSettings}
      />
      <HistoryDrawer open={historyOpen} onOpenChange={setHistoryOpen} onSelect={handleSelectHistoryEntry} />
      <Toaster />
    </>
  )
}
