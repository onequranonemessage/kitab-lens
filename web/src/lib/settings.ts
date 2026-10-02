// Settings persisted in localStorage, wrapped in try/catch per the plan
// (private browsing / quota can make localStorage throw or be unavailable).

const SETTINGS_KEY = "kitab-lens:settings"

export type ResultLayout = "sheet" | "split"

export interface Settings {
  layout: ResultLayout
  defaultLanguage: string
}

export const DEFAULT_SETTINGS: Settings = {
  layout: "sheet",
  defaultLanguage: "English",
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(raw)
    return { ...DEFAULT_SETTINGS, ...parsed }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(settings: Settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // localStorage may be unavailable — settings just won't persist.
  }
}
