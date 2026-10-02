#!/bin/bash
# Double-click this in Finder to start kitab-lens. macOS opens it in Terminal; it
# runs run.sh from this folder (backend + phone tunnel + the /connect page with the
# QR code). kitab-lens runs for as long as this window stays open.
#
# Problems get a macOS alert saying what went wrong and how to fix it, like the
# installer's: fatal ones when run.sh exits, and a phone-tunnel failure (which
# leaves kitab-lens usable on this Mac only) as soon as run.sh reports it.
cd "$(dirname "$0")" || exit 1
LENS_ROOT="$(pwd)"
mkdir -p .runtime
LOG="$LENS_ROOT/.runtime/start.log"
: > "$LOG"

alert() {  # alert critical|warning TITLE MESSAGE
  [ "${KITAB_NO_POPUP:-0}" = "1" ] && return 0
  osascript - "$1" "$2" "$3" >/dev/null 2>&1 <<'OSA'
on run argv
  set alertKind to item 1 of argv
  if alertKind is "critical" then
    display alert (item 2 of argv) message (item 3 of argv) as critical buttons {"OK"} default button "OK"
  else
    display alert (item 2 of argv) message (item 3 of argv) as warning buttons {"OK"} default button "OK"
  end if
end run
OSA
}

finish() {  # finish EXIT_STATUS
  echo
  read -r -p "Press Return to close this window. " _
  exit "$1"
}

clear
if [ ! -x .venv/bin/python ] && [ ! -x ../kitab-translator-vision-ocr/.venv/bin/python ]; then
  echo "kitab-lens isn't installed yet."
  echo "Double-click \"Install kitab-lens.command\" first, then this file again."
  alert critical "kitab-lens isn't installed yet" "What happened:
This folder doesn't have kitab-lens's components installed yet.

How to fix:
Double-click \"Install kitab-lens.command\" (in this same folder) first. When it says \"All done\", double-click \"Start kitab-lens\" again."
  finish 1
fi

# Auto-update from GitHub first (see update.sh). After an update, restart this
# script so the new version of it runs; KITAB_UPDATED stops that from looping.
if [ "${KITAB_UPDATED:-0}" != "1" ]; then
  /bin/bash ./update.sh
  case $? in
    10)
      echo
      echo "kitab-lens was updated -- starting the new version..."
      KITAB_UPDATED=1 exec /bin/bash "./Start kitab-lens.command" "$@"
      ;;
    1)
      echo
      echo "The update didn't finish (see the message above), so kitab-lens wasn't started."
      finish 1
      ;;
  esac
  echo
fi

echo "Starting kitab-lens. Keep this window open while you use it."
echo "To stop kitab-lens: press Control-C here, or close this window."
echo

# The phone tunnel failing isn't fatal (run.sh keeps going, Mac-only), so it can't be
# caught at exit; watch run.sh's output for it instead, for the first two minutes.
(
  for _ in $(seq 1 240); do
    if grep -qE 'cloudflared (exited early|not found)|could not read a trycloudflare' "$LOG" 2>/dev/null; then
      alert warning "kitab-lens started, but your phone can't connect" "What happened:
kitab-lens is running on this Mac, but the secure link that lets your phone reach it (Cloudflare tunnel) didn't start.

How to fix:
Check this Mac's internet connection, then close this Terminal window and double-click \"Start kitab-lens\" again. If cloudflared is missing, double-click \"Install kitab-lens.command\" to reinstall it."
      exit 0
    fi
    grep -q 'kitab-lens is running' "$LOG" 2>/dev/null && ! grep -q 'Starting cloudflared' "$LOG" && exit 0
    sleep 0.5
  done
) &
WATCHER=$!

# Control-C is how the user stops kitab-lens, so it's not an error.
STOPPED_BY_USER=0
trap 'STOPPED_BY_USER=1' INT

./run.sh "$@" 2>&1 | tee -a "$LOG"  # "$@": none from Finder; flags when run by hand
STATUS=${PIPESTATUS[0]}
kill "$WATCHER" 2>/dev/null
wait "$WATCHER" 2>/dev/null  # reap it quietly (else bash prints "Terminated" + its source)

if [ "$STOPPED_BY_USER" = "1" ] || [ "$STATUS" -eq 0 ] || [ "$STATUS" -eq 130 ]; then
  echo
  echo "kitab-lens has stopped. Double-click \"Start kitab-lens\" to start it again."
  finish 0
fi

# Turn run.sh's own error lines into a plain explanation and fix.
if grep -q 'already in use' "$LOG"; then
  WHAT="kitab-lens (or another program) is already running and using its network port (8757)."
  FIX="Look for another Terminal window already running kitab-lens and use that one. If there isn't one, restart this Mac and try again."
elif grep -q 'no Python environment' "$LOG"; then
  WHAT="kitab-lens's components aren't installed (or were deleted)."
  FIX="Double-click \"Install kitab-lens.command\" in this folder, then start kitab-lens again."
elif grep -q 'backend exited before it came up' "$LOG"; then
  WHAT="kitab-lens's server crashed while starting up."
  FIX="Double-click \"Install kitab-lens.command\" to repair the installation, then start kitab-lens again. The error details are in the Terminal window."
else
  WHAT="kitab-lens stopped unexpectedly (exit code $STATUS)."
  FIX="Start it again. If it keeps happening, double-click \"Install kitab-lens.command\" to repair the installation. The details are in the Terminal window and in .runtime/start.log."
fi
echo
echo "kitab-lens stopped: $WHAT"
echo "How to fix: $FIX"
alert critical "kitab-lens stopped" "What happened:
$WHAT

How to fix:
$FIX"
finish "$STATUS"
