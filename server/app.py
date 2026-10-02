#!/usr/bin/env python3
"""kitab-lens backend: OCR a photographed Arabic page, then translate it via ChatGPT.

Run with (from this directory): uvicorn app:app --host 127.0.0.1 --port 8757
run.sh does exactly that, after generating .env and (optionally) the Cloudflare
tunnel that makes this reachable from a phone.

Two things shape almost every design choice here:
  - There is exactly one Chrome window driving chatgpt.com, so every /api/translate
    job is funneled through a single-worker ThreadPoolExecutor. That same worker
    thread launches the driver at startup (see `_warmup_driver`), so the first real
    scan doesn't pay Chrome's boot time.
  - `kitab` (this directory's kitab.py) must be imported before anything spins up a
    thread pool, because importing it imports vision_ocr, whose warmup() binds
    PyObjC/Vision symbols on the importing thread. Doing that import first, at
    module load, keeps it on the main thread no matter how app.py is invoked.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # so `import kitab` works
# regardless of the invoking process's cwd.

import kitab  # noqa: E402  (must land before any thread pool exists -- see above)
import chatgpt_lens  # noqa: E402

import asyncio
import hashlib
import hmac
import io
import json
import os
import re
import tempfile
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, File, HTTPException, Request, Response, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse
from langchain_core.messages import HumanMessage, SystemMessage
from PIL import Image, ImageOps
from pydantic import BaseModel

LENS_ROOT = kitab.LENS_ROOT
DIST_DIR = LENS_ROOT / "web" / "dist"
RUNTIME_DIR = LENS_ROOT / ".runtime"
TUNNEL_URL_PATH = RUNTIME_DIR / "tunnel_url"
ENV_PATH = LENS_ROOT / ".env"

# --------------------------------------------------------------------------- .env
# run.sh generates .env (passcode + secret) before starting uvicorn. This parser is
# deliberately tiny -- KEY=value lines, optional quotes, '#' comments -- since that's
# all run.sh ever writes; python-dotenv would be a dependency for three lines of code.


def _load_env_file(path: Path) -> None:
    if not path.is_file():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_env_file(ENV_PATH)

PASSCODE = os.environ.get("KITAB_LENS_PASSCODE")
SECRET = os.environ.get("KITAB_LENS_SECRET")
if not PASSCODE or not SECRET:
    raise RuntimeError(
        "KITAB_LENS_PASSCODE / KITAB_LENS_SECRET are not set. Run ./run.sh once from "
        f"{LENS_ROOT} -- it generates {ENV_PATH} -- or export them yourself before "
        "starting uvicorn directly."
    )

# Live-streaming translation (probes/FINDINGS.md): on by default, since the probes
# found the DOM markdown serializer streams reliably. Set KITAB_LENS_STREAMING=0 to
# fall back to the non-streaming invoke() (e.g. if a future ChatGPT UI change makes
# the serializer unreliable again).
STREAMING_ENABLED = os.environ.get("KITAB_LENS_STREAMING", "1").strip().lower() not in (
    "0",
    "false",
    "no",
    "off",
)

# --------------------------------------------------------------------------- auth
COOKIE_NAME = "kitab_lens_auth"
COOKIE_MAX_AGE = 30 * 24 * 3600
AUTH_MESSAGE = b"kitab-lens-ok"
EXEMPT_API_PATHS = {"/api/health", "/api/auth", "/api/connect-info"}


def _cookie_value(secret: str) -> str:
    return hmac.new(secret.encode("utf-8"), AUTH_MESSAGE, hashlib.sha256).hexdigest()


_EXPECTED_COOKIE = _cookie_value(SECRET)


def _is_remote(request: Request) -> bool:
    """Cloudflare tunnel requests all arrive as plain HTTP from 127.0.0.1, so the
    client IP can't tell local from remote. Cloudflare does add its own headers to
    every proxied request, though, so their presence is what "came through the
    tunnel" means here."""
    return "cf-connecting-ip" in request.headers or "cf-ray" in request.headers


class AuthRequest(BaseModel):
    passcode: str


# --------------------------------------------------------------------------- state
class ChatGPTState:
    """Tracks the one thing /api/status reports: what the single Chrome worker is doing."""

    def __init__(self):
        self._lock = threading.Lock()
        self.phase = "starting"  # "starting" | "ready" | "error"
        self.needs_attention = False
        self.busy = False
        self.last_error: Optional[str] = None

    def set_phase(self, phase: str, error: Optional[str] = None):
        with self._lock:
            self.phase = phase
            self.last_error = error

    def set_needs_attention(self, value: bool):
        with self._lock:
            self.needs_attention = value

    def set_busy(self, value: bool):
        with self._lock:
            self.busy = value

    def snapshot(self):
        with self._lock:
            if self.needs_attention:
                return "needs_attention", self.last_error
            if self.phase == "error":
                return "error", self.last_error
            if self.busy:
                return "busy", None
            if self.phase == "ready":
                return "ready", None
            return "starting", None


state = ChatGPTState()
llm = chatgpt_lens.LensChatGPT(on_status=state.set_needs_attention)
executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="chatgpt-worker")


def _warmup_driver():
    """Boot Chrome on the same worker thread every later job runs on (see module docstring)."""
    try:
        with llm._lock:
            llm._ensure_driver()
        state.set_phase("ready")
    except Exception as exc:  # noqa: BLE001 -- surfaced verbatim via /api/status
        state.set_phase("error", str(exc))


@asynccontextmanager
async def lifespan(_app: FastAPI):
    executor.submit(_warmup_driver)
    yield
    try:
        llm.close()
    except Exception:  # noqa: BLE001 -- shutting down anyway
        pass
    executor.shutdown(wait=False)


app = FastAPI(lifespan=lifespan)


# --------------------------------------------------------------------------- jobs
class Job:
    """One /api/translate request: its event log (for SSE replay) and final result."""

    def __init__(self, arabic: str, language: str):
        self.id = uuid.uuid4().hex[:12]
        self.arabic = arabic
        self.language = language
        self.status = "queued"  # queued | started | done | error
        self.result: Optional[str] = None
        self.partial_text: Optional[str] = None  # latest streamed text, while translating
        self.error: Optional[str] = None
        self.created = time.time()
        self._events: list = []
        self._next_id = 1
        self._events_lock = threading.Lock()

    def publish(self, event: str, data: dict):
        with self._events_lock:
            # Bloat guard for `partial`: a long chunk can stream for minutes at
            # ~2-3 events/sec, which would otherwise pile hundreds of events into
            # the replay log. Only the latest partial is ever useful to a reconnect,
            # so replace the previous partial in place instead of appending to it.
            # Ids stay monotonic (from _next_id) even though old partials are
            # dropped, so an already-connected SSE stream (which advances its own
            # cursor past whatever id it has seen) still sees the next partial's
            # new, higher id normally -- nothing is skipped from its perspective.
            if event == "partial" and self._events and self._events[-1]["event"] == "partial":
                self._events.pop()
            event_id = self._next_id
            self._next_id += 1
            self._events.append({"id": event_id, "event": event, "data": data})

    def events_since(self, last_id: int):
        with self._events_lock:
            return [e for e in self._events if e["id"] > last_id]

    def events_count(self) -> int:
        with self._events_lock:
            return len(self._events)

    def position(self) -> int:
        with jobs_lock:
            if self.id in pending_order:
                return pending_order.index(self.id) + 1
            return 0


jobs: dict = {}
jobs_lock = threading.Lock()
pending_order: list = []  # job ids not yet started, in submission (== run) order
JOB_TTL_SECONDS = 3600

LANGUAGE_PATTERN = re.compile(r"^[A-Za-z][A-Za-z \-()]{0,39}$")


def _purge_old_jobs():
    now = time.time()
    with jobs_lock:
        stale = [
            jid
            for jid, job in jobs.items()
            if job.status in ("done", "error") and now - job.created > JOB_TTL_SECONDS
        ]
        for jid in stale:
            jobs.pop(jid, None)


def _requeue_positions():
    """Republish `queued {position}` for everyone still waiting, after the queue moves."""
    with jobs_lock:
        snapshot = list(pending_order)
    for idx, jid in enumerate(snapshot, start=1):
        job = jobs.get(jid)
        if job is not None:
            job.publish("queued", {"position": idx})


def register_job(job: Job) -> None:
    with jobs_lock:
        jobs[job.id] = job
        pending_order.append(job.id)
        position = len(pending_order)
    job.publish("queued", {"position": position})
    executor.submit(run_translate_job, job.id)
    _purge_old_jobs()


def run_translate_job(job_id: str) -> None:
    """Runs on the single ChatGPT worker thread -- one job at a time, in order."""
    job = jobs.get(job_id)
    if job is None:
        return

    with jobs_lock:
        if job_id in pending_order:
            pending_order.remove(job_id)
    _requeue_positions()

    job.status = "started"
    job.publish("started", {})
    state.set_busy(True)
    try:
        prompt = kitab.build_prompt(job.language)
        messages = [SystemMessage(content=prompt), HumanMessage(content=job.arabic)]
        if STREAMING_ENABLED:
            def on_partial(text: str) -> None:
                job.partial_text = text
                job.publish("partial", {"text": text})

            response = llm.invoke_streaming(messages, on_partial=on_partial)
        else:
            response = llm.invoke(messages)
        job.result = response.content
        job.status = "done"
        job.publish("done", {"text": job.result})
    except Exception as exc:  # noqa: BLE001 -- reported to the client, not swallowed
        job.status = "error"
        job.error = str(exc)
        job.publish("error", {"message": job.error})
        # The driver may be wedged (crashed tab, dead session); drop it so the next
        # job's invoke() -> _ensure_driver() rebuilds from scratch instead of reusing
        # a broken one.
        try:
            llm.close()
        except Exception:  # noqa: BLE001
            pass
    finally:
        state.set_busy(False)


# --------------------------------------------------------------------------- auth middleware
@app.middleware("http")
async def require_auth(request: Request, call_next):
    path = request.url.path
    if path.startswith("/api/") and path not in EXEMPT_API_PATHS:
        if _is_remote(request):
            cookie = request.cookies.get(COOKIE_NAME, "")
            if not cookie or not hmac.compare_digest(cookie, _EXPECTED_COOKIE):
                return JSONResponse(status_code=401, content={"error": "unauthorized"})
    return await call_next(request)


# --------------------------------------------------------------------------- routes
@app.get("/api/health")
async def health():
    return {"ok": True}


@app.post("/api/auth")
async def auth(payload: AuthRequest, request: Request, response: Response):
    if not hmac.compare_digest(payload.passcode.strip(), PASSCODE):
        raise HTTPException(status_code=401, detail="wrong passcode")
    response.set_cookie(
        key=COOKIE_NAME,
        value=_EXPECTED_COOKIE,
        max_age=COOKIE_MAX_AGE,
        httponly=True,
        samesite="lax",
        secure=_is_remote(request),
        path="/",
    )
    return {"ok": True}


@app.get("/api/connect-info")
async def connect_info(request: Request):
    if _is_remote(request):
        raise HTTPException(status_code=403, detail="local only")
    tunnel_url = None
    if TUNNEL_URL_PATH.is_file():
        tunnel_url = TUNNEL_URL_PATH.read_text(encoding="utf-8").strip() or None
    return {"tunnel_url": tunnel_url, "passcode": PASSCODE}


@app.get("/api/status")
async def status():
    chatgpt_status, error = state.snapshot()
    with jobs_lock:
        queue = sum(1 for job in jobs.values() if job.status in ("queued", "started"))
    payload = {"chatgpt": chatgpt_status, "queue": queue}
    if error:
        payload["error"] = error
    return payload


MAX_LONG_EDGE = 3000


def _downscale(image: Image.Image) -> Image.Image:
    width, height = image.size
    long_edge = max(width, height)
    if long_edge <= MAX_LONG_EDGE:
        return image
    scale = MAX_LONG_EDGE / long_edge
    return image.resize((round(width * scale), round(height * scale)), Image.LANCZOS)


@app.post("/api/ocr")
async def ocr(image: UploadFile = File(...)):
    raw = await image.read()
    try:
        pil_image = Image.open(io.BytesIO(raw))
        pil_image.load()  # force full decode now, so a truncated upload 400s here
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"not a readable image: {exc}") from exc

    pil_image = ImageOps.exif_transpose(pil_image)
    pil_image = pil_image.convert("RGB")
    pil_image = _downscale(pil_image)

    start = time.monotonic()
    fd, tmp_name = tempfile.mkstemp(suffix=".png")
    os.close(fd)
    tmp_path = Path(tmp_name)
    try:
        pil_image.save(tmp_path, format="PNG")
        lines = await run_in_threadpool(kitab.recognize, str(tmp_path), langs=["ar"])
    finally:
        tmp_path.unlink(missing_ok=True)

    arabic = "\n".join(line["text"] for line in lines)  # top-to-bottom, per vision_ocr.recognize
    elapsed_ms = round((time.monotonic() - start) * 1000)
    return {"arabic": arabic, "line_count": len(lines), "ms": elapsed_ms}


class TranslateRequest(BaseModel):
    arabic: str
    language: str


@app.post("/api/translate")
async def translate(payload: TranslateRequest):
    language = payload.language.strip()
    if not language or len(language) > 40 or not LANGUAGE_PATTERN.match(language):
        raise HTTPException(
            status_code=400,
            detail="language must be 1-40 characters: letters, spaces, hyphens, parentheses",
        )
    if not payload.arabic.strip():
        raise HTTPException(status_code=400, detail="arabic text is empty")

    job = Job(arabic=payload.arabic, language=language)
    register_job(job)
    return {"job_id": job.id}


@app.get("/api/jobs/{job_id}")
async def job_snapshot(job_id: str):
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="no such job")
    return {
        "status": job.status,
        "position": job.position(),
        # The best text available for this job right now: the final result once
        # done, otherwise whatever has streamed in so far (None before the first
        # partial arrives). The frontend already merges this with its cached text
        # via `snapshot.text ?? prev.text`, so no separate "partial" field is needed.
        "text": job.result if job.result is not None else job.partial_text,
        "error": job.error,
        "events_count": job.events_count(),
    }


SSE_POLL_SECONDS = 0.3
SSE_HEARTBEAT_SECONDS = 15.0
TERMINAL_EVENTS = {"done", "error"}


@app.get("/api/jobs/{job_id}/events")
async def job_events(job_id: str, request: Request):
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="no such job")

    last_id = 0
    header_val = request.headers.get("last-event-id")
    if header_val:
        try:
            last_id = int(header_val)
        except ValueError:
            last_id = 0

    async def stream():
        cursor = last_id
        last_activity = time.monotonic()
        while True:
            new_events = job.events_since(cursor)
            if new_events:
                for ev in new_events:
                    cursor = ev["id"]
                    yield (
                        f"id: {ev['id']}\n"
                        f"event: {ev['event']}\n"
                        f"data: {json.dumps(ev['data'], ensure_ascii=False)}\n\n"
                    )
                    if ev["event"] in TERMINAL_EVENTS:
                        return
                last_activity = time.monotonic()
                continue
            if time.monotonic() - last_activity >= SSE_HEARTBEAT_SECONDS:
                yield ": ping\n\n"
                last_activity = time.monotonic()
            await asyncio.sleep(SSE_POLL_SECONDS)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# --------------------------------------------------------------------------- static / SPA
PLACEHOLDER_HTML = """<!doctype html>
<html><head><meta charset="utf-8"><title>kitab-lens</title></head>
<body style="font-family:sans-serif;background:#111;color:#eee;padding:2rem">
<h1>kitab-lens backend is running</h1>
<p>The web frontend hasn't been built yet: web/dist/index.html is missing.
Build it with <code>cd web && npm install && npm run build</code>, or run
<code>./run.sh</code> from the project root, which does that for you.</p>
</body></html>"""


@app.get("/{full_path:path}")
async def spa(full_path: str):
    if full_path == "api" or full_path.startswith("api/"):
        raise HTTPException(status_code=404)

    if DIST_DIR.is_dir():
        candidate = (DIST_DIR / full_path).resolve()
        dist_resolved = DIST_DIR.resolve()
        if candidate == dist_resolved or dist_resolved in candidate.parents:
            if full_path and candidate.is_file():
                return FileResponse(candidate)
        index = DIST_DIR / "index.html"
        if index.is_file():
            return FileResponse(index)

    return HTMLResponse(PLACEHOLDER_HTML)
