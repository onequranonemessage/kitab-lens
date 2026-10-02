import { useEffect, useState } from "react"

/** Reactive `matchMedia` — used to detect the ≥768px / landscape breakpoint
 * where the bottom-sheet layout switches to side-by-side panes. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(query).matches : false
  )

  useEffect(() => {
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    onChange()
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }, [query])

  return matches
}

/** True at ≥768px width OR landscape orientation — the plan's "wide" breakpoint. */
export function useIsWideResult(): boolean {
  return useMediaQuery("(min-width: 768px), (orientation: landscape)")
}
