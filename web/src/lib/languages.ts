// The curated language list for the translation pane's <Select>, plus the
// "Custom…" escape hatch. Order matches the approved plan.

export interface LanguageOption {
  value: string
  label: string
  /** Render the translation pane right-to-left for this target language. */
  rtl?: boolean
}

export const LANGUAGES: LanguageOption[] = [
  { value: "English", label: "English" },
  { value: "Urdu", label: "Urdu", rtl: true },
  { value: "French", label: "French" },
  { value: "Spanish", label: "Spanish" },
  { value: "German", label: "German" },
  { value: "Turkish", label: "Turkish" },
  { value: "Indonesian", label: "Indonesian" },
  { value: "Malay", label: "Malay" },
  { value: "Bengali", label: "Bengali" },
  { value: "Somali", label: "Somali" },
  { value: "Persian", label: "Persian", rtl: true },
  { value: "Russian", label: "Russian" },
]

export const CUSTOM_LANGUAGE_VALUE = "__custom__"
export const DEFAULT_LANGUAGE = "English"

/**
 * Must start with a plain ASCII letter, then letters/spaces/hyphens/parens,
 * max 40 chars. Mirrors server/app.py's LANGUAGE_PATTERN exactly
 * (`^[A-Za-z][A-Za-z \-()]{0,39}$`) so the client never accepts a custom
 * language the backend would then 400 on (e.g. accented first letters,
 * or a leading space/apostrophe).
 */
const CUSTOM_LANGUAGE_PATTERN = /^[A-Za-z][A-Za-z \-()]{0,39}$/

export function isValidCustomLanguage(value: string): boolean {
  const trimmed = value.trim()
  return trimmed.length > 0 && trimmed.length <= 40 && CUSTOM_LANGUAGE_PATTERN.test(trimmed)
}

/** True if the given target-language string should render right-to-left. */
export function isRtlLanguage(language: string): boolean {
  return LANGUAGES.some((l) => l.value === language && l.rtl)
}
