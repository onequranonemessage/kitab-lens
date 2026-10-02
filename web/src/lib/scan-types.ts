// Shared types for a single scan's translation state, used by ResultView
// and the panes/sheet it renders. Kept separate from api.ts (the wire
// contract) since this also tracks purely-client state like "queued".

export type TranslationStageStatus = "queued" | "translating" | "done" | "error"

export interface TranslationState {
  status: TranslationStageStatus
  text?: string
  position?: number
  error?: string
  jobId?: string
}

export type OcrStage = "loading" | "ready" | "empty" | "error"
