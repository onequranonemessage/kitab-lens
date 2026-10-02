#!/usr/bin/env bash
# kitab-lens installer: takes a factory-fresh Mac to a runnable kitab-lens.
#
# Assumes nothing beyond what ships with macOS (bash, curl, tar, shasum, hdiutil,
# ditto, osascript). No Homebrew, no Xcode Command Line Tools, no system Python or
# Node. Everything except Google Chrome is installed inside this folder:
#
#   .tools/bin/        uv, uvx, cloudflared
#   .tools/python/     a uv-managed CPython (python-build-standalone)
#   .tools/node/       Node.js + npm (official nodejs.org tarball)
#   .tools/selenium/   chromedriver (Selenium Manager's cache; run.sh uses it too)
#   .tools/*-cache/    uv and npm download caches
#   .venv/             the backend's Python packages (requirements.txt)
#   web/node_modules/  the frontend's packages (web/package-lock.json)
#   web/dist/          the built frontend
#
# Google Chrome goes into /Applications, where Selenium looks for it.
#
# Every step checks first and skips when already done, so re-running is cheap and
# safe (e.g. after moving this folder, which breaks .venv's links -- it's rebuilt).
# Any failure, expected or not, stops the install with a macOS alert saying what
# went wrong and how to fix it; the full output is kept in install.log.
#
# Usage: ./install.sh [--skip-chrome] [--skip-cloudflared] [--help]
#
# Overrides (env):
#   KITAB_PYTHON_VERSION   Python to install (default 3.14)
#   KITAB_NODE_MAJOR       Node.js major line (default 22)
#   KITAB_CHROME_DIR       where to look for / install Google Chrome.app
#                          (default /Applications; anything else is for testing,
#                          since run.sh's Selenium only looks in /Applications)
#   KITAB_NO_POPUP=1       report errors in the terminal only, no alert window
set -eEuo pipefail

LENS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$LENS_ROOT"

PYTHON_VERSION="${KITAB_PYTHON_VERSION:-3.14}"
NODE_MAJOR="${KITAB_NODE_MAJOR:-22}"
NODE_MIN_MAJOR=20  # vite 6 needs 20+ (or 18); an existing node this new is reused
CHROME_DIR="${KITAB_CHROME_DIR:-/Applications}"
CHROME_APP="$CHROME_DIR/Google Chrome.app"
CHROME_BIN="$CHROME_APP/Contents/MacOS/Google Chrome"
CHROME_DMG_URL="https://dl.google.com/chrome/mac/universal/stable/GGRO/googlechrome.dmg"

TOOLS_DIR="$LENS_ROOT/.tools"
BIN_DIR="$TOOLS_DIR/bin"
NODE_DIR="$TOOLS_DIR/node"
VENV_DIR="$LENS_ROOT/.venv"
VENV_PY="$VENV_DIR/bin/python"
REQS="$LENS_ROOT/requirements.txt"
REQS_STAMP="$VENV_DIR/.kitab-requirements.sha256"
WEB_DIR="$LENS_ROOT/web"
LOG="$LENS_ROOT/install.log"

SKIP_CHROME=0
SKIP_CLOUDFLARED=0
for arg in "$@"; do
  case "$arg" in
    --skip-chrome) SKIP_CHROME=1 ;;
    --skip-cloudflared) SKIP_CLOUDFLARED=1 ;;
    -h|--help) sed -n '2,/^set -eEuo/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    *) echo "install.sh: unknown flag '$arg' (see --help)" >&2; exit 1 ;;
  esac
done

# Our tools first, so every check below sees what an earlier run installed.
export PATH="$BIN_DIR:$NODE_DIR/bin:$PATH"
# Keep uv's Pythons and cache, and Selenium's drivers, inside this folder, and
# never let uv pick up some other Python (Homebrew, /usr/bin, pyenv...).
export UV_PYTHON_INSTALL_DIR="$TOOLS_DIR/python"
export UV_CACHE_DIR="$TOOLS_DIR/uv-cache"
export UV_PYTHON_PREFERENCE=only-managed
export SE_CACHE_PATH="$TOOLS_DIR/selenium"
export npm_config_cache="$TOOLS_DIR/npm-cache"
export npm_config_update_notifier=false

# --------------------------------------------------------------------------- output
if [[ -t 1 ]]; then
  BOLD=$'\033[1m' RED=$'\033[31m' GREEN=$'\033[32m' YELLOW=$'\033[33m' BLUE=$'\033[34m' RESET=$'\033[0m'
else
  BOLD="" RED="" GREEN="" YELLOW="" BLUE="" RESET=""
fi
STEP=0
TOTAL_STEPS=11
STEP_TITLE="Getting started"
STEP_FIX="Run the installer again. If it keeps failing, open install.log to see the details."

# step TITLE FIX -- FIX is what an unexpected failure during this step tells the user.
step() {
  STEP=$((STEP + 1))
  STEP_TITLE="$1"
  STEP_FIX="$2"
  printf '\n%s[%d/%d] %s%s\n' "$BOLD$BLUE" "$STEP" "$TOTAL_STEPS" "$1" "$RESET"
}
skip() { printf '  %s✓ %s%s\n' "$GREEN" "$1" "$RESET"; }
info() { printf '  %s→%s %s\n' "$BLUE" "$RESET" "$1"; }
done_() { printf '  %s✓ %s%s\n' "$GREEN" "$1" "$RESET"; }

# popup critical|warning TITLE MESSAGE -- a native macOS alert with an "Open Log"
# button. Silently does nothing without a desktop session (SSH) or with
# KITAB_NO_POPUP=1; the same text always goes to the terminal as well.
popup() {
  [[ "${KITAB_NO_POPUP:-0}" == "1" || -n "${SSH_CONNECTION:-}" ]] && return 0
  command -v osascript >/dev/null 2>&1 || return 0
  local choice
  choice="$(osascript - "$1" "$2" "$3" "${KITAB_POPUP_TIMEOUT:-0}" 2>/dev/null <<'OSA'
on run argv
  set alertKind to item 1 of argv
  set t to item 2 of argv
  set m to item 3 of argv
  set giveUp to (item 4 of argv) as integer
  set btns to {"Open Log", "OK"}
  if alertKind is "critical" then
    if giveUp > 0 then
      set r to display alert t message m as critical buttons btns default button "OK" giving up after giveUp
    else
      set r to display alert t message m as critical buttons btns default button "OK"
    end if
  else
    if giveUp > 0 then
      set r to display alert t message m as warning buttons btns default button "OK" giving up after giveUp
    else
      set r to display alert t message m as warning buttons btns default button "OK"
    end if
  end if
  return button returned of r
end run
OSA
)" || return 0
  if [[ "$choice" == "Open Log" && -f "$LOG" ]]; then
    open -e "$LOG" 2>/dev/null || true
  fi
}

# warn MESSAGE [FIX] -- not fatal; the install carries on. A FIX also raises an alert.
warn() {
  printf '  %s! %s%s\n' "$YELLOW" "$1" "$RESET" >&2
  if [[ -n "${2:-}" ]]; then
    printf '    %sHow to fix:%s %s\n' "$YELLOW" "$RESET" "$2" >&2
    popup warning "kitab-lens installed, with a problem" "$1

How to fix:
$2"
  fi
}

# die WHAT FIX -- stop the install, explaining (in plain words) what failed and how
# to fix it, in the terminal and in an alert.
die() {
  trap - ERR
  local what="$1"
  local fix="${2:-$STEP_FIX}"
  printf '\n%s✗ kitab-lens could not be installed%s\n' "$RED$BOLD" "$RESET" >&2
  printf '%sWhat happened:%s %s\n' "$BOLD" "$RESET" "$what" >&2
  printf '%sHow to fix:%s    %s\n' "$BOLD" "$RESET" "$fix" >&2
  [[ "$LOG" == "/dev/null" ]] || printf 'Full details:  %s\n' "$LOG" >&2
  popup critical "kitab-lens could not be installed" "What happened:
$what

How to fix:
$fix

Everything that finished installing is kept, so running the installer again picks up where it stopped."
  exit 1
}

# Anything that fails without its own die() lands here, named by the step it was in.
on_error() {
  local code="$1" cmd="$2"
  # Inside a $(...) subshell: just fail; the parent's own ERR/die reports it once.
  # (BASH_SUBSHELL, not BASHPID: macOS's /bin/bash is 3.2, which lacks BASHPID.)
  if (( BASH_SUBSHELL > 0 )); then exit "$code"; fi
  die "Step $STEP of $TOTAL_STEPS ($STEP_TITLE) failed unexpectedly.
(The command \"$cmd\" exited with code $code.)" "$STEP_FIX"
}
trap 'on_error "$?" "$BASH_COMMAND"' ERR

on_interrupt() {
  trap - ERR
  printf '\n%sInstall cancelled.%s Run the installer again to pick up where it stopped.\n' "$YELLOW" "$RESET" >&2
  exit 130
}
trap on_interrupt INT TERM

# --------------------------------------------------------------------------- sanity (pre-log)
# Checked before anything else, since both would break everything below.
if [[ "$(id -u)" == "0" ]]; then
  die "The installer was started as the administrator (with sudo)." \
      "Run it as yourself instead, without sudo: bash install.sh -- it asks for your password itself if it needs to."
fi
if ! { : > "$LOG"; } 2>/dev/null; then
  LOG="/dev/null"
  die "The installer can't write files into the kitab-lens folder ($LENS_ROOT)." \
      "Move the kitab-lens folder somewhere you own, such as your Documents folder (not a disk image or a read-only drive), then run the installer again from there."
fi
# Everything from here on also goes to install.log (minus terminal colors).
exec > >(tee >(sed -l -E "s/"$'\033'"\[[0-9;]*m//g" >> "$LOG")) 2>&1
echo "kitab-lens install -- $(date)"
# Written back at the very end; until then kitab-lens.command treats the install
# as unfinished and runs this again.
rm -f "$LENS_ROOT/.kitab-installed"

# --------------------------------------------------------------------------- helpers
TMP="$(mktemp -d "${TMPDIR:-/tmp}/kitab-lens-install.XXXXXX")"
DMG_MOUNT=""
cleanup() {
  if [[ -n "$DMG_MOUNT" ]]; then hdiutil detach -quiet "$DMG_MOUNT" 2>/dev/null || true; fi
  rm -rf "$TMP"
}
trap cleanup EXIT

NET_FIX="Check that this Mac is connected to the internet (and that no VPN, firewall or content filter is blocking downloads), then run the installer again."

download() {  # download URL DEST WHAT
  curl -fL --retry 3 --retry-delay 2 --connect-timeout 20 --progress-bar -o "$2" "$1" \
    || die "Couldn't download $3 (from $(echo "$1" | cut -d/ -f3))." "$NET_FIX"
}

verify_sha256() {  # verify_sha256 FILE EXPECTED_HEX WHAT
  local actual
  actual="$(shasum -a 256 "$1" | awk '{print $1}')"
  [[ -n "$2" && "$actual" == "$2" ]] || die "The downloaded $3 was damaged (its checksum didn't match)." \
    "Run the installer again to re-download it. If this keeps happening, something on your network is altering downloads -- try a different network."
}

version_major() { echo "${1#v}" | cut -d. -f1; }

chrome_version() {
  /usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "$CHROME_APP/Contents/Info.plist" 2>/dev/null || true
}

python_imports_ok() {
  "$VENV_PY" -c "import fastapi, uvicorn, multipart, PIL, selenium, pyperclip, langchain_core, Vision, Quartz, Foundation" 2>/dev/null
}

# =========================================================================== 1. preflight
step "Checking this Mac" \
     "Run the installer again. If it keeps failing, open install.log to see the details."

[[ "$(uname -s)" == "Darwin" ]] || die "kitab-lens only runs on a Mac (it uses Apple's built-in text recognition)." \
  "Install and run kitab-lens on a Mac with macOS 12 or newer."

MISSING=""
for f in run.sh requirements.txt server/app.py web/package.json web/package-lock.json vendor/kitab-translator-vision-ocr/src/chatgpt_llm.py; do
  [[ -f "$LENS_ROOT/$f" ]] || MISSING="$MISSING $f"
done
[[ -z "$MISSING" ]] || die "The kitab-lens folder is incomplete -- these files are missing:$MISSING" \
  "Download kitab-lens again, unzip it, and run the installer from the new folder."

MACOS_VERSION="$(sw_vers -productVersion)"
MACOS_MAJOR="$(version_major "$MACOS_VERSION")"
(( MACOS_MAJOR >= 12 )) || die "This Mac runs macOS $MACOS_VERSION, but kitab-lens needs macOS 12 (Monterey) or newer." \
  "Update macOS (Apple menu > System Settings > General > Software Update), then run the installer again."

# Native arch even when this shell runs under Rosetta.
if [[ "$(sysctl -in hw.optional.arm64 2>/dev/null)" == "1" ]]; then
  ARCH="arm64"
else
  ARCH="x86_64"
fi
done_ "macOS $MACOS_VERSION ($ARCH)"
(( MACOS_MAJOR >= 14 )) || info "macOS $MACOS_VERSION may not read Arabic text (added in macOS 14) -- checked at the end"

NEED_KB=$(( SKIP_CHROME ? 1500000 : 3000000 ))
FREE_KB="$(df -Pk "$LENS_ROOT" | awk 'NR==2 {print $4}')"
(( FREE_KB >= NEED_KB )) || die "Not enough free disk space: $((FREE_KB / 1024)) MB free, but the install needs about $((NEED_KB / 1024)) MB." \
  "Free up some space (empty the Trash, delete large files from Downloads), then run the installer again."
done_ "$((FREE_KB / 1024 / 1024)) GB free"

curl -fsSI --max-time 15 https://nodejs.org/dist/ >/dev/null 2>&1 \
  || die "This Mac can't reach the internet (nodejs.org didn't answer)." "$NET_FIX"
done_ "internet connection"

mkdir -p "$BIN_DIR"
# Files unzipped from a download carry macOS's quarantine flag, which makes
# Gatekeeper block double-clicking the .command files ("Apple could not verify...").
# Once the user has chosen to run this installer, clear it for the whole folder.
xattr -dr com.apple.quarantine "$LENS_ROOT" 2>/dev/null || true
chmod +x "$LENS_ROOT/run.sh" "$LENS_ROOT/install.sh" "$LENS_ROOT/Install kitab-lens.command" "$LENS_ROOT/Start kitab-lens.command" "$LENS_ROOT/kitab-lens.command" "$LENS_ROOT/update.sh" 2>/dev/null || true

# =========================================================================== 2. uv
step "uv (Python installer / package manager)" "$NET_FIX"

if command -v uv >/dev/null 2>&1; then
  skip "found $(uv --version) at $(command -v uv)"
else
  case "$ARCH" in
    arm64) UV_TARGET="aarch64-apple-darwin" ;;
    x86_64) UV_TARGET="x86_64-apple-darwin" ;;
  esac
  UV_URL="https://github.com/astral-sh/uv/releases/latest/download/uv-$UV_TARGET.tar.gz"
  info "downloading uv ($UV_TARGET)"
  download "$UV_URL" "$TMP/uv.tar.gz" "uv (the tool that installs Python)"
  download "$UV_URL.sha256" "$TMP/uv.tar.gz.sha256" "uv's checksum"
  verify_sha256 "$TMP/uv.tar.gz" "$(awk '{print $1}' "$TMP/uv.tar.gz.sha256")" "uv"
  tar -xzf "$TMP/uv.tar.gz" -C "$TMP"
  install -m 755 "$TMP/uv-$UV_TARGET/uv" "$TMP/uv-$UV_TARGET/uvx" "$BIN_DIR/"
  uv --version >/dev/null 2>&1 || die "uv was downloaded but won't run on this Mac." \
    "Run the installer again. If it keeps failing, make sure this Mac's macOS is up to date."
  done_ "installed $(uv --version) to .tools/bin"
fi

# =========================================================================== 3. python
step "Python $PYTHON_VERSION" "$NET_FIX"

if PY_FOUND="$(uv python find "$PYTHON_VERSION" 2>/dev/null)"; then
  skip "found $("$PY_FOUND" --version) (uv-managed)"
else
  info "downloading Python $PYTHON_VERSION"
  uv python install --no-bin "$PYTHON_VERSION" \
    || die "Couldn't download and install Python $PYTHON_VERSION." "$NET_FIX"
  done_ "installed $("$(uv python find "$PYTHON_VERSION")" --version) to .tools/python"
fi

# =========================================================================== 4. node
step "Node.js" "$NET_FIX"

NODE_OK=0
if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  if (( $(version_major "$(node --version)") >= NODE_MIN_MAJOR )); then
    NODE_OK=1
    skip "found node $(node --version) / npm $(npm --version) at $(command -v node)"
  else
    info "found node $(node --version) at $(command -v node), but $NODE_MIN_MAJOR+ is needed -- installing a private copy"
  fi
fi
if (( ! NODE_OK )); then
  case "$ARCH" in
    arm64) NODE_PLATFORM="darwin-arm64" ;;
    x86_64) NODE_PLATFORM="darwin-x64" ;;
  esac
  NODE_BASE="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
  download "$NODE_BASE/SHASUMS256.txt" "$TMP/SHASUMS256.txt" "the Node.js download list"
  NODE_TARBALL="$(grep -m1 -oE "node-v[0-9.]+-$NODE_PLATFORM\.tar\.gz" "$TMP/SHASUMS256.txt" || true)"
  [[ -n "$NODE_TARBALL" ]] || die "nodejs.org doesn't currently list a Node.js $NODE_MAJOR download for this Mac ($NODE_PLATFORM)." \
    "Wait a few minutes and run the installer again (nodejs.org may be mid-release)."
  info "downloading $NODE_TARBALL"
  download "$NODE_BASE/$NODE_TARBALL" "$TMP/$NODE_TARBALL" "Node.js"
  verify_sha256 "$TMP/$NODE_TARBALL" "$(grep "  $NODE_TARBALL\$" "$TMP/SHASUMS256.txt" | awk '{print $1}')" "Node.js"
  rm -rf "$NODE_DIR"
  mkdir -p "$NODE_DIR"
  tar -xzf "$TMP/$NODE_TARBALL" -C "$NODE_DIR" --strip-components 1
  hash -r
  node --version >/dev/null 2>&1 || die "Node.js was downloaded but won't run on this Mac." \
    "Make sure macOS is up to date, then run the installer again."
  done_ "installed node $(node --version) / npm $(npm --version) to .tools/node"
fi

# =========================================================================== 5. chrome
CHROME_FIX="Install Google Chrome yourself from https://www.google.com/chrome (drag it into Applications), then run the installer again -- it will find it."
step "Google Chrome" "$CHROME_FIX"

if (( SKIP_CHROME )); then
  info "skipped (--skip-chrome); translation needs Chrome in /Applications"
elif [[ -x "$CHROME_BIN" ]]; then
  skip "found Google Chrome $(chrome_version) in $CHROME_DIR"
else
  info "downloading Google Chrome (universal .dmg, ~250 MB)"
  download "$CHROME_DMG_URL" "$TMP/googlechrome.dmg" "Google Chrome"
  DMG_MOUNT="$TMP/chrome-dmg"
  mkdir -p "$DMG_MOUNT"
  hdiutil attach -quiet -nobrowse -readonly -noautoopen -mountpoint "$DMG_MOUNT" "$TMP/googlechrome.dmg" \
    || die "Google Chrome downloaded, but its installer disk image wouldn't open." "$CHROME_FIX"
  [[ -d "$DMG_MOUNT/Google Chrome.app" ]] || die "Google Chrome's installer disk image didn't contain the Chrome app." "$CHROME_FIX"
  mkdir -p "$CHROME_DIR" 2>/dev/null || true
  info "copying Google Chrome.app to $CHROME_DIR"
  if [[ -w "$CHROME_DIR" ]]; then
    ditto "$DMG_MOUNT/Google Chrome.app" "$CHROME_APP" \
      || die "Couldn't copy Google Chrome into $CHROME_DIR." "$CHROME_FIX"
  else
    info "$CHROME_DIR isn't writable by $(whoami); asking for an admin password"
    sudo ditto "$DMG_MOUNT/Google Chrome.app" "$CHROME_APP" \
      || die "Couldn't copy Google Chrome into $CHROME_DIR -- that needs an administrator password, and none was given." \
             "Run the installer again and enter your Mac login password when asked (your account must be an administrator). Or: $CHROME_FIX"
  fi
  hdiutil detach -quiet "$DMG_MOUNT" || true
  DMG_MOUNT=""
  [[ -x "$CHROME_BIN" ]] || die "Google Chrome was copied, but it isn't where expected ($CHROME_APP)." "$CHROME_FIX"
  done_ "installed Google Chrome $(chrome_version) to $CHROME_DIR"
fi

# =========================================================================== 6. cloudflared
CF_FIX="$NET_FIX
Or install without phone access for now: bash install.sh --skip-cloudflared (kitab-lens then only works on this Mac)."
step "cloudflared (Cloudflare quick tunnel, for phone access)" "$CF_FIX"

if (( SKIP_CLOUDFLARED )); then
  info "skipped (--skip-cloudflared); run.sh will fall back to local-only (--no-tunnel)"
elif command -v cloudflared >/dev/null 2>&1; then
  skip "found $(cloudflared --version 2>&1 | head -n1) at $(command -v cloudflared)"
else
  case "$ARCH" in
    arm64) CF_ASSET="cloudflared-darwin-arm64.tgz" ;;
    x86_64) CF_ASSET="cloudflared-darwin-amd64.tgz" ;;
  esac
  info "downloading $CF_ASSET"
  curl -fL --retry 3 --retry-delay 2 --connect-timeout 20 --progress-bar -o "$TMP/$CF_ASSET" \
    "https://github.com/cloudflare/cloudflared/releases/latest/download/$CF_ASSET" \
    || die "Couldn't download cloudflared (the tool that lets your phone reach this Mac)." "$CF_FIX"
  mkdir -p "$TMP/cloudflared"
  tar -xzf "$TMP/$CF_ASSET" -C "$TMP/cloudflared"
  install -m 755 "$TMP/cloudflared/cloudflared" "$BIN_DIR/cloudflared"
  cloudflared --version >/dev/null 2>&1 || die "cloudflared was downloaded but won't run on this Mac." "$CF_FIX"
  done_ "installed $(cloudflared --version 2>&1 | head -n1) to .tools/bin"
fi

# =========================================================================== 7. venv
VENV_FIX="Run the installer again. If it keeps failing, delete the hidden .venv and .tools folders inside kitab-lens (in Finder, press Cmd+Shift+. to show them) and run it once more."
step "Python virtual environment (.venv)" "$VENV_FIX"

VENV_OK=0
if [[ -e "$VENV_PY" || -L "$VENV_PY" ]]; then  # -L: a dangling link after a move still counts
  VENV_VERSION="$("$VENV_PY" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || true)"
  if [[ "$VENV_VERSION" == "$PYTHON_VERSION" ]]; then
    VENV_OK=1
    skip ".venv uses Python $VENV_VERSION"
  elif [[ -n "$VENV_VERSION" ]]; then
    info ".venv uses Python $VENV_VERSION, not $PYTHON_VERSION -- rebuilding it"
  else
    info ".venv is broken (moved folder, or its Python was removed) -- rebuilding it"
  fi
fi
if (( ! VENV_OK )); then
  rm -rf "$VENV_DIR"
  uv venv --quiet --python "$PYTHON_VERSION" "$VENV_DIR" \
    || die "Couldn't create kitab-lens's private Python environment (.venv)." "$VENV_FIX"
  done_ "created .venv with $("$VENV_PY" --version)"
fi

# =========================================================================== 8. pip packages
step "Python packages (requirements.txt)" "$NET_FIX"

REQS_HASH="$(shasum -a 256 "$REQS" | awk '{print $1}')"
if [[ -f "$REQS_STAMP" && "$(cat "$REQS_STAMP")" == "$REQS_HASH" ]] && python_imports_ok; then
  skip "already installed and importable"
else
  info "installing into .venv"
  uv pip install --python "$VENV_PY" -r "$REQS" \
    || die "Couldn't download and install the Python packages kitab-lens needs." "$NET_FIX"
  python_imports_ok || die "The Python packages installed, but kitab-lens still can't load them." "$VENV_FIX"
  printf '%s' "$REQS_HASH" > "$REQS_STAMP"
  done_ "installed $(uv pip list --python "$VENV_PY" 2>/dev/null | tail -n +3 | wc -l | tr -d ' ') packages"
fi

# =========================================================================== 9. chromedriver
step "chromedriver (matched to Chrome, via Selenium Manager)" "$NET_FIX"

if [[ ! -x "$CHROME_BIN" ]]; then
  info "skipped (no Chrome to match); Selenium will fetch it on first run"
else
  CHROME_MAJOR="$(version_major "$(chrome_version)")"
  shopt -s nullglob
  CACHED_DRIVERS=("$SE_CACHE_PATH"/chromedriver/*/"$CHROME_MAJOR".*/chromedriver)
  shopt -u nullglob
  if (( ${#CACHED_DRIVERS[@]} )); then
    skip "found $("${CACHED_DRIVERS[0]}" --version | cut -d' ' -f1-2) for Chrome $CHROME_MAJOR"
  else
    info "resolving chromedriver for Chrome $(chrome_version)"
    DRIVER_PATH="$("$VENV_PY" - "$CHROME_BIN" <<'PY'
import sys
from selenium.webdriver.common.selenium_manager import SeleniumManager

paths = SeleniumManager().binary_paths(["--browser", "chrome", "--browser-path", sys.argv[1]])
print(paths["driver_path"])
PY
)" || die "Couldn't download chromedriver (the helper that lets kitab-lens control Chrome)." "$NET_FIX"
    [[ -x "$DRIVER_PATH" ]] || die "chromedriver was reported as downloaded, but the file isn't there ($DRIVER_PATH)." "$NET_FIX"
    done_ "installed $("$DRIVER_PATH" --version | cut -d' ' -f1-2) to .tools/selenium"
  fi
fi

# =========================================================================== 10. web
WEB_FIX="Run the installer again. If it keeps failing, delete the web/node_modules folder inside kitab-lens and run it once more; if that fails too, download kitab-lens again (some files may be damaged)."
step "Frontend (web/node_modules + web/dist)" "$WEB_FIX"

# npm ci rewrites node_modules/.package-lock.json, so it's newer than the lockfile
# exactly when the install matches it.
if [[ -f "$WEB_DIR/node_modules/.package-lock.json" && ! "$WEB_DIR/package-lock.json" -nt "$WEB_DIR/node_modules/.package-lock.json" ]]; then
  skip "node_modules matches package-lock.json"
else
  info "npm ci (exact versions from package-lock.json)"
  npm --prefix "$WEB_DIR" ci --no-audit --no-fund \
    || die "Couldn't download and install the web app's packages (npm)." "$NET_FIX"
  done_ "installed $(ls "$WEB_DIR/node_modules" | wc -l | tr -d ' ') top-level packages"
fi

# Same staleness rule as run.sh: rebuild if dist is missing or any input is newer.
DIST_INDEX="$WEB_DIR/dist/index.html"
NEEDS_BUILD=0
if [[ ! -f "$DIST_INDEX" ]]; then
  NEEDS_BUILD=1
elif [[ -n "$(find "$WEB_DIR/src" "$WEB_DIR/index.html" "$WEB_DIR/package.json" \
               "$WEB_DIR/vite.config.ts" "$WEB_DIR/tailwind.config.js" -newer "$DIST_INDEX" 2>/dev/null)" ]]; then
  NEEDS_BUILD=1
fi
if (( NEEDS_BUILD )); then
  info "building web/dist"
  npm --prefix "$WEB_DIR" run build \
    || die "Couldn't build the web app (the page your phone opens)." "$WEB_FIX"
  done_ "built web/dist"
else
  skip "web/dist is up to date"
fi

# =========================================================================== 11. verify
step "Verifying" "$VENV_FIX"

if [[ -z "${KITAB_OCR_DIR:-}" ]]; then
  if [[ -d "$LENS_ROOT/../kitab-translator-vision-ocr/src" ]]; then
    KITAB_OCR_DIR="$LENS_ROOT/../kitab-translator-vision-ocr"
  else
    KITAB_OCR_DIR="$LENS_ROOT/vendor/kitab-translator-vision-ocr"
  fi
fi
export KITAB_OCR_DIR

# Imports the backend's own shim exactly as app.py does, then asks Vision whether
# it can actually read Arabic on this macOS.
VERIFY_OUT="$(cd "$LENS_ROOT/server" && "$VENV_PY" - <<'PY' 2>&1
import sys
sys.path.insert(0, ".")
import kitab  # resolves KITAB_OCR_DIR, imports vision_ocr + chatgpt_llm
import chatgpt_lens  # noqa: F401
import fastapi, uvicorn  # noqa: F401,E401
from vision_ocr.vision_ocr import supported_languages

langs = supported_languages()
print("source:", kitab.KITAB_DIR)
print("arabic:", ", ".join(l for l in langs if l.startswith("ar")) or "NONE")
PY
)" || { echo "$VERIFY_OUT"; die "Everything downloaded, but kitab-lens's backend fails to load (the error is in install.log)." "$VENV_FIX"; }
done_ "backend imports ($(grep '^source:' <<<"$VERIFY_OUT" | cut -d' ' -f2-))"
[[ -f "$DIST_INDEX" ]] && done_ "web/dist/index.html present"

PROBLEMS=0
if grep -q '^arabic: NONE' <<<"$VERIFY_OUT"; then
  PROBLEMS=1
  warn "This Mac (macOS $MACOS_VERSION) can't read Arabic text yet, so scanning pages won't work." \
       "Update macOS to version 14 (Sonoma) or newer: Apple menu > System Settings > General > Software Update. Nothing needs reinstalling afterwards."
else
  done_ "Apple Vision Arabic OCR ($(grep '^arabic:' <<<"$VERIFY_OUT" | cut -d' ' -f2-))"
fi
if (( SKIP_CHROME )) && [[ ! -x "$CHROME_BIN" ]]; then
  PROBLEMS=1
  warn "Google Chrome isn't installed (skipped with --skip-chrome), so translation won't work." "$CHROME_FIX"
fi

# =========================================================================== done
touch "$LENS_ROOT/.kitab-installed"
if (( PROBLEMS )); then
  printf '\n%s%skitab-lens is installed, with the problem(s) above.%s\n\n' "$BOLD" "$YELLOW" "$RESET"
else
  printf '\n%s%skitab-lens is installed.%s\n\n' "$BOLD" "$GREEN" "$RESET"
fi
cat <<EOF
  Start it:        double-click "Start kitab-lens.command" in this folder
                   (or in Terminal: ./run.sh, or ./run.sh --no-tunnel for this Mac only)

  First run: a Chrome window opens on chatgpt.com. Log in there once (it has
  its own profile in chrome-profile/); after that it stays logged in.
EOF
