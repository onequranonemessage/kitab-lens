#!/usr/bin/env bash
# Start the kitab-lens backend (and, unless told not to, a Cloudflare quick tunnel
# so a phone can reach it) and open the /connect page that shows the QR code.
#
# Flags:
#   --no-tunnel   don't start cloudflared (backend is 127.0.0.1-only)
#   --no-open     don't `open` the /connect page in a browser
set -euo pipefail

LENS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$LENS_ROOT"

NO_TUNNEL=0
NO_OPEN=0
for arg in "$@"; do
  case "$arg" in
    --no-tunnel) NO_TUNNEL=1 ;;
    --no-open) NO_OPEN=1 ;;
    *) echo "run.sh: unknown flag '$arg'" >&2; exit 1 ;;
  esac
done

PORT=8757
BASE_URL="http://127.0.0.1:${PORT}"
RUNTIME_DIR="$LENS_ROOT/.runtime"
TUNNEL_URL_FILE="$RUNTIME_DIR/tunnel_url"
CLOUDFLARED_LOG="$RUNTIME_DIR/cloudflared.log"
ENV_FILE="$LENS_ROOT/.env"

mkdir -p "$RUNTIME_DIR"
rm -f "$TUNNEL_URL_FILE"  # a stale URL from a previous run must never look current

# --------------------------------------------------------------------------- tools
# install.sh puts node/npm, cloudflared and uv under .tools/ (and chromedriver in
# .tools/selenium, Selenium Manager's cache). Prepending is harmless when they're
# absent, e.g. on a machine that already has them on PATH.
export PATH="$LENS_ROOT/.tools/bin:$LENS_ROOT/.tools/node/bin:$PATH"
export SE_CACHE_PATH="${SE_CACHE_PATH:-$LENS_ROOT/.tools/selenium}"

# --------------------------------------------------------------------------- python
# Same resolution order as server/kitab.py: KITAB_OCR_DIR, else a sibling checkout,
# else the vendored copy.
if [[ -z "${KITAB_OCR_DIR:-}" ]]; then
  if [[ -d "$LENS_ROOT/../kitab-translator-vision-ocr/src" ]]; then
    KITAB_OCR_DIR="$LENS_ROOT/../kitab-translator-vision-ocr"
  else
    KITAB_OCR_DIR="$LENS_ROOT/vendor/kitab-translator-vision-ocr"
  fi
fi
export KITAB_OCR_DIR

# Our own .venv (from install.sh), else the sibling checkout's .venv. A venv only
# counts if the backend's packages are actually in it: an interrupted install.sh
# leaves a .venv with a working interpreter and nothing else, and picking that
# one dies later with "No module named uvicorn".
PYTHON=""
for candidate in "$LENS_ROOT/.venv/bin/python" "$KITAB_OCR_DIR/.venv/bin/python"; do
  if [[ -x "$candidate" ]] && "$candidate" -c 'import uvicorn, fastapi, PIL, selenium' >/dev/null 2>&1; then
    PYTHON="$candidate"
    break
  fi
done
if [[ -z "$PYTHON" ]]; then
  echo "run.sh: no Python environment with the backend's packages found -- run ./install.sh first." >&2
  exit 1
fi

# --------------------------------------------------------------------------- web deps
if [[ -f "$LENS_ROOT/web/package.json" && ! -d "$LENS_ROOT/web/node_modules" ]]; then
  echo "Installing web/ dependencies (node_modules missing)..."
  npm --prefix "$LENS_ROOT/web" install --no-audit --no-fund
fi

# --------------------------------------------------------------------------- web build
# Rebuild if dist/index.html is missing, or if any build input (src/, index.html,
# package.json, vite/tailwind config) is newer than the last build's output.
if [[ -f "$LENS_ROOT/web/package.json" ]]; then
  NEEDS_BUILD=0
  DIST_INDEX="$LENS_ROOT/web/dist/index.html"
  if [[ ! -f "$DIST_INDEX" ]]; then
    NEEDS_BUILD=1
  else
    STALE_INPUTS=$(find \
      "$LENS_ROOT/web/src" \
      "$LENS_ROOT/web/index.html" \
      "$LENS_ROOT/web/package.json" \
      "$LENS_ROOT/web/vite.config.ts" \
      "$LENS_ROOT/web/tailwind.config.js" \
      -newer "$DIST_INDEX" 2>/dev/null)
    [[ -n "$STALE_INPUTS" ]] && NEEDS_BUILD=1
  fi
  if [[ "$NEEDS_BUILD" -eq 1 ]]; then
    echo "Building web/ (dist missing or stale)..."
    npm --prefix "$LENS_ROOT/web" run build
  fi
fi

# --------------------------------------------------------------------------- .env
# Generate whichever of the two keys is missing (all of .env on a first run; one
# key if the file was hand-edited or half-written), leaving any existing one alone
# so a phone's saved passcode/cookie keeps working.
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"
if ! grep -q '^KITAB_LENS_PASSCODE=.' "$ENV_FILE"; then
  echo "Generating a passcode in $ENV_FILE ..."
  # Six digits, zero-padded (so e.g. 004821 stays a 6-digit code).
  PASSCODE=$(printf "%06d" $(( (RANDOM * 32768 + RANDOM) % 1000000 )))
  [[ -z "$(tail -c1 "$ENV_FILE")" ]] || echo >> "$ENV_FILE"  # end any unterminated line
  echo "KITAB_LENS_PASSCODE=$PASSCODE" >> "$ENV_FILE"
fi
if ! grep -q '^KITAB_LENS_SECRET=.' "$ENV_FILE"; then
  echo "Generating a secret in $ENV_FILE ..."
  SECRET=$("$PYTHON" -c 'import secrets; print(secrets.token_hex(32))')
  [[ -z "$(tail -c1 "$ENV_FILE")" ]] || echo >> "$ENV_FILE"
  echo "KITAB_LENS_SECRET=$SECRET" >> "$ENV_FILE"
fi

# --------------------------------------------------------------------------- port check
# Fail fast, before touching Chrome at all, if something is already bound to our
# port. uvicorn's own bind-failure would come too late: FastAPI's lifespan startup
# (which launches the ChatGPT Chrome window, see server/app.py's _warmup_driver)
# runs *before* uvicorn binds the socket, so a bind failure after a bad `run.sh`
# launch (e.g. a second instance, or a stale process still holding the port) would
# have already opened an orphan Chrome window for nothing.
if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "run.sh: port $PORT is already in use -- is kitab-lens already running?" >&2
  echo "        lsof -nP -iTCP:$PORT -sTCP:LISTEN" >&2
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >&2 || true
  exit 1
fi

# --------------------------------------------------------------------------- cleanup
SERVER_PID=""
CLOUDFLARED_PID=""
cleanup() {
  trap - EXIT INT TERM
  if [[ -n "$CLOUDFLARED_PID" ]] && kill -0 "$CLOUDFLARED_PID" 2>/dev/null; then
    kill "$CLOUDFLARED_PID" 2>/dev/null || true
  fi
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
  fi
  rm -f "$TUNNEL_URL_FILE"
}
trap cleanup EXIT INT TERM

# --------------------------------------------------------------------------- server
echo "Starting kitab-lens backend on $BASE_URL ..."
( cd "$LENS_ROOT/server" && exec "$PYTHON" -m uvicorn app:app --host 127.0.0.1 --port "$PORT" ) &
SERVER_PID=$!

# Wait for it to actually answer before doing anything else (tunnel, open) so a
# fast failure (e.g. missing deps) is reported before we print a "ready" URL.
for _ in $(seq 1 60); do
  if curl -fsS "$BASE_URL/api/health" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "run.sh: backend exited before it came up -- check the output above." >&2
    exit 1
  fi
  sleep 0.5
done

# --------------------------------------------------------------------------- tunnel
if [[ "$NO_TUNNEL" -eq 0 ]]; then
  if ! command -v cloudflared >/dev/null 2>&1; then
    echo "run.sh: cloudflared not found on PATH -- continuing with --no-tunnel behavior." >&2
  else
    echo "Starting cloudflared tunnel..."
    : > "$CLOUDFLARED_LOG"
    cloudflared tunnel --url "$BASE_URL" --no-autoupdate >>"$CLOUDFLARED_LOG" 2>&1 &
    CLOUDFLARED_PID=$!

    TUNNEL_URL=""
    for _ in $(seq 1 60); do
      TUNNEL_URL=$(grep -oE 'https://[a-zA-Z0-9-]+\.trycloudflare\.com' "$CLOUDFLARED_LOG" | head -n1 || true)
      if [[ -n "$TUNNEL_URL" ]]; then
        break
      fi
      if ! kill -0 "$CLOUDFLARED_PID" 2>/dev/null; then
        echo "run.sh: cloudflared exited early -- see $CLOUDFLARED_LOG" >&2
        break
      fi
      sleep 0.5
    done

    if [[ -n "$TUNNEL_URL" ]]; then
      printf '%s' "$TUNNEL_URL" > "$TUNNEL_URL_FILE"
    else
      echo "run.sh: could not read a trycloudflare.com URL from $CLOUDFLARED_LOG" >&2
    fi
  fi
fi

# --------------------------------------------------------------------------- report
PASSCODE_OUT=$(grep '^KITAB_LENS_PASSCODE=' "$ENV_FILE" | cut -d= -f2)
echo
echo "=========================================================="
echo " kitab-lens is running"
echo "   local:   $BASE_URL"
if [[ -f "$TUNNEL_URL_FILE" ]]; then
  echo "   phone:   $(cat "$TUNNEL_URL_FILE")"
fi
echo "   passcode: $PASSCODE_OUT"
echo "=========================================================="
echo

if [[ "$NO_OPEN" -eq 0 ]]; then
  open "$BASE_URL/connect" || true
fi

wait "$SERVER_PID"
