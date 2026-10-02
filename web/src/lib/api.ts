// Typed client for the FastAPI backend (server/app.py, port 8757). See the
// approved plan's "Backend API" section for the exact contract — this file
// assumes that contract exactly since the backend is being built in
// parallel by a separate agent.

export type ChatGptStatus = "starting" | "ready" | "busy" | "needs_attention" | "error"

export interface StatusResponse {
  chatgpt: ChatGptStatus
  queue: number
}

export interface OcrResponse {
  arabic: string
  line_count: number
  ms: number
}

export interface TranslateStartResponse {
  job_id: string
}

export type JobStatus = "queued" | "started" | "done" | "error"

export interface JobSnapshot {
  status: JobStatus
  position?: number
  text?: string
  error?: string
}

export interface ConnectInfo {
  tunnel_url: string | null
  passcode: string
}

/**
 * Fired on `window` whenever any API call gets a 401. The passcode gate
 * listens for this so it can reappear after the cookie expires or is
 * rejected, without every call site needing to know about auth.
 */
export const UNAUTHORIZED_EVENT = "kitab-lens:unauthorized"

function notifyUnauthorized() {
  window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT))
}

class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(path, { credentials: "same-origin", ...init })
  if (res.status === 401) {
    notifyUnauthorized()
    throw new ApiError(401, "Unauthorized")
  }
  return res
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await request(path, init)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new ApiError(res.status, (data as { detail?: string })?.detail || `Request failed (${res.status})`)
  }
  return data as T
}

export async function getStatus(): Promise<StatusResponse> {
  return requestJson<StatusResponse>("/api/status")
}

export async function postAuth(passcode: string): Promise<void> {
  // Deliberately doesn't go through request()/notifyUnauthorized(): a wrong
  // passcode on the gate itself is an expected 401, not a "session died"
  // 401 — the gate handles that failure inline instead.
  const res = await fetch("/api/auth", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ passcode }),
  })
  if (!res.ok) {
    const message =
      res.status === 401
        ? "Incorrect passcode"
        : res.status === 429
          ? "Too many wrong attempts — wait a while and try again"
          : `Request failed (${res.status})`
    throw new ApiError(res.status, message)
  }
}

export async function getConnectInfo(): Promise<ConnectInfo> {
  return requestJson<ConnectInfo>("/api/connect-info")
}

export async function postOcr(image: Blob, filename = "page.jpg"): Promise<OcrResponse> {
  const form = new FormData()
  form.append("image", image, filename)
  const res = await request("/api/ocr", { method: "POST", body: form })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new ApiError(res.status, (data as { detail?: string })?.detail || `OCR failed (${res.status})`)
  }
  return data as OcrResponse
}

export async function postTranslate(arabic: string, language: string): Promise<TranslateStartResponse> {
  return requestJson<TranslateStartResponse>("/api/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ arabic, language }),
  })
}

export async function getJobSnapshot(jobId: string): Promise<JobSnapshot> {
  return requestJson<JobSnapshot>(`/api/jobs/${jobId}`)
}

export interface JobEventHandlers {
  onQueued?: (position: number) => void
  onStarted?: () => void
  onPartial?: (text: string) => void
  onDone?: (text: string) => void
  onError?: (message: string) => void
}

/**
 * Opens an SSE connection to `/api/jobs/{id}/events` and wires up the named
 * events the plan defines. Returns a cleanup function that closes the
 * connection. The browser's native EventSource already replays missed
 * events via `Last-Event-ID` on its own reconnects; callers additionally
 * re-open on `visibilitychange` (see ResultView) since backgrounded tabs
 * can have their connection killed outright by the OS/browser.
 */
export function subscribeJobEvents(jobId: string, handlers: JobEventHandlers): () => void {
  const source = new EventSource(`/api/jobs/${jobId}/events`)

  const onQueued = (e: MessageEvent) => {
    try {
      handlers.onQueued?.(JSON.parse(e.data).position)
    } catch {
      // ignore malformed event
    }
  }
  const onStarted = () => handlers.onStarted?.()
  const onPartial = (e: MessageEvent) => {
    try {
      handlers.onPartial?.(JSON.parse(e.data).text)
    } catch {
      // ignore malformed event
    }
  }
  const onDone = (e: MessageEvent) => {
    try {
      handlers.onDone?.(JSON.parse(e.data).text)
    } catch {
      // ignore malformed event
    }
    source.close()
  }
  // "error" is overloaded in the SSE spec: the backend's named `event:
  // error` (job failure, carries JSON data) and a plain connection-level
  // error (network drop, no `.data`) both dispatch as type "error". A
  // single handler tells them apart by whether `.data` parses.
  const onError = (e: Event) => {
    let message = "Connection to server lost"
    const data = (e as MessageEvent).data
    if (typeof data === "string") {
      try {
        message = JSON.parse(data).message || message
      } catch {
        // malformed event data — keep the generic message
      }
    }
    handlers.onError?.(message)
    source.close()
  }

  source.addEventListener("queued", onQueued as EventListener)
  source.addEventListener("started", onStarted as EventListener)
  source.addEventListener("partial", onPartial as EventListener)
  source.addEventListener("done", onDone as EventListener)
  source.addEventListener("error", onError)

  return () => source.close()
}
