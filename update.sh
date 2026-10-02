#!/bin/bash
# kitab-lens auto-updater. "Start kitab-lens.command" runs this before starting.
#
# How it works (no git needed -- a fresh Mac doesn't have it, and installing it
# means Apple's multi-GB Xcode Command Line Tools):
#   1. Ask GitHub's API for the latest commit on $BRANCH of $REPO (one small request).
#   2. Compare it with .kitab-version, the commit this folder was last updated to.
#      Same => up to date, done. (No .kitab-version, e.g. a fresh "Download ZIP":
#      download that commit and compare file contents instead; if they match, just
#      record the commit.)
#   3. Otherwise download that commit's tarball and update to it -- automatically,
#      unless KITAB_AUTO_UPDATE=ask, which asks first (a macOS dialog).
#   4. Copy the new files over this folder, keeping everything local: .venv, .tools,
#      node_modules, the ChatGPT Chrome profile, .env, logs. Files deleted upstream
#      are deleted here too, but only inside the code folders (server/, web/,
#      vendor/, probes/), so nothing the user saved elsewhere in the folder is lost.
#   5. Run install.sh, which only redoes what the new version changed (new Python or
#      npm packages, a frontend rebuild).
#
# Never touches a git checkout (a .git folder here): update those with git pull.
# If GitHub can't be reached (offline, private repo, rate limit), it says so and
# lets kitab-lens start as-is.
#
# Exit status: 0 = nothing to do (or skipped/declined), 10 = updated (the caller
# should restart itself so the new version runs), 1 = the update failed.
#
# Env: KITAB_UPDATE_REPO (owner/name), KITAB_UPDATE_BRANCH, KITAB_NO_UPDATE=1 to
# skip, KITAB_AUTO_UPDATE=yes (default) | ask | no.
set -uo pipefail

cd "$(dirname "$0")" || exit 1
LENS_ROOT="$(pwd)"

REPO="${KITAB_UPDATE_REPO:-onequranonemessage/kitab-lens}"
BRANCH="${KITAB_UPDATE_BRANCH:-main}"
API_BASE="${KITAB_UPDATE_API_BASE:-https://api.github.com}"
CODELOAD_BASE="${KITAB_UPDATE_CODELOAD_BASE:-https://codeload.github.com}"
STAMP="$LENS_ROOT/.kitab-version"
PY="$LENS_ROOT/.venv/bin/python"
UPDATED=10

# Local state that an update must never overwrite or delete.
KEEP=(
  --exclude=/.git/ --exclude=/.venv/ --exclude=/.tools/ --exclude=/chrome-profile/
  --exclude=/.runtime/ --exclude=/.env --exclude=/install.log --exclude=/.kitab-version
  --exclude=/.kitab-installed
  --exclude=/web/node_modules/ --exclude=/web/dist/
  --exclude='__pycache__/' --exclude='.DS_Store' --exclude='*.tsbuildinfo'
)
# Folders that hold only code, where files removed upstream are removed here too.
CODE_DIRS=(server web vendor probes)

# KEEP's anchored patterns are relative to the transfer root, so a per-folder pass
# (root = web/) needs that folder's local state re-anchored, or --delete would
# wipe web/node_modules and web/dist.
keep_in() {  # keep_in DIR -> extra excludes for a pass rooted at DIR/
  case "$1" in
    web) printf '%s\n' --exclude=/node_modules/ --exclude=/dist/ ;;
  esac
}

note() { printf '  [update] %s\n' "$1"; }

alert() {  # alert TITLE MESSAGE
  [ "${KITAB_NO_POPUP:-0}" = "1" ] && return 0
  osascript - "$1" "$2" >/dev/null 2>&1 <<'OSA'
on run argv
  display alert (item 1 of argv) message (item 2 of argv) as critical buttons {"OK"} default button "OK"
end run
OSA
}

fail() {  # fail WHAT FIX
  printf '\n  [update] FAILED: %s\n  [update] How to fix: %s\n' "$1" "$2" >&2
  alert "kitab-lens couldn't update" "What happened:
$1

How to fix:
$2"
  exit 1
}

[ "${KITAB_NO_UPDATE:-0}" = "1" ] && exit 0
if [ -e "$LENS_ROOT/.git" ]; then
  note "this folder is a git checkout -- skipping auto-update (use git pull)"
  exit 0
fi
if [ ! -x "$PY" ]; then
  exit 0  # not installed yet; the Start command tells the user to run the installer
fi

# --------------------------------------------------------------------------- 1. latest commit
note "checking for updates..."
TMP="$(mktemp -d "${TMPDIR:-/tmp}/kitab-lens-update.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

HTTP_CODE="$(curl -sS --max-time 10 -o "$TMP/commit.json" -w '%{http_code}' \
  -H 'Accept: application/vnd.github+json' \
  "$API_BASE/repos/$REPO/commits/$BRANCH" 2>/dev/null)" || HTTP_CODE="000"
case "$HTTP_CODE" in
  200) ;;
  000) note "couldn't reach GitHub (offline?) -- starting the current version"; exit 0 ;;
  404) note "github.com/$REPO isn't reachable (wrong name, or private) -- update check skipped"; exit 0 ;;
  403|429) note "GitHub is rate-limiting update checks right now -- try again later"; exit 0 ;;
  *) note "GitHub answered $HTTP_CODE -- update check skipped"; exit 0 ;;
esac

# sha, date, and first line of the commit message, one per line.
if ! "$PY" - "$TMP/commit.json" > "$TMP/commit.txt" 2>/dev/null <<'PY'
import json, sys
c = json.load(open(sys.argv[1]))
print(c["sha"])
print(c["commit"]["committer"]["date"][:10])
print((c["commit"]["message"].strip().splitlines() or [""])[0][:200])
PY
then
  note "GitHub's answer wasn't understood -- update check skipped"
  exit 0
fi
REMOTE_SHA="$(sed -n 1p "$TMP/commit.txt")"
REMOTE_DATE="$(sed -n 2p "$TMP/commit.txt")"
REMOTE_MSG="$(sed -n 3p "$TMP/commit.txt")"
LOCAL_SHA="$(cat "$STAMP" 2>/dev/null || true)"

if [ "$LOCAL_SHA" = "$REMOTE_SHA" ]; then
  note "up to date (${REMOTE_SHA:0:7}, $REMOTE_DATE)"
  exit 0
fi

# --------------------------------------------------------------------------- 2. download + compare
if ! curl -fsSL --max-time 120 -o "$TMP/src.tar.gz" "$CODELOAD_BASE/$REPO/tar.gz/$REMOTE_SHA" 2>/dev/null; then
  note "couldn't download the latest version -- starting the current one"
  exit 0
fi
mkdir -p "$TMP/src"
tar -xzf "$TMP/src.tar.gz" -C "$TMP/src" 2>/dev/null || { note "the download was damaged -- starting the current version"; exit 0; }
NEW="$(find "$TMP/src" -mindepth 1 -maxdepth 1 -type d | head -n1)"
if [ -z "$NEW" ] || [ ! -f "$NEW/run.sh" ] || [ ! -f "$NEW/install.sh" ]; then
  note "the download doesn't look like kitab-lens -- update skipped"
  exit 0
fi

# What would change: files that differ or are new anywhere, plus deletions inside
# the code folders. (-c compares contents, since mtimes from a tarball mean nothing.)
# Only ">f" lines are real transfers (new or different contents); macOS's openrsync
# also itemizes timestamp-only differences (".f..T....") even without -t.
CHANGES="$(rsync -rcn -i "${KEEP[@]}" "$NEW/" "$LENS_ROOT/" 2>/dev/null | grep '^>f' || true)"
for d in "${CODE_DIRS[@]}"; do
  [ -d "$NEW/$d" ] && [ -d "$LENS_ROOT/$d" ] || continue
  # shellcheck disable=SC2046  # keep_in's output is a fixed list of single words
  CHANGES="$CHANGES"$'\n'"$(rsync -rcn -i --delete "${KEEP[@]}" $(keep_in "$d") "$NEW/$d/" "$LENS_ROOT/$d/" 2>/dev/null | grep '^\*deleting' | sed "s|^\*deleting *|*deleting $d/|" || true)"
done
CHANGES="$(printf '%s\n' "$CHANGES" | sed '/^$/d' | sort -u)"

if [ -z "$CHANGES" ]; then
  printf '%s' "$REMOTE_SHA" > "$STAMP"
  note "up to date (${REMOTE_SHA:0:7}, $REMOTE_DATE)"
  exit 0
fi
N_CHANGED="$(printf '%s\n' "$CHANGES" | wc -l | tr -d ' ')"

# --------------------------------------------------------------------------- 3. ask (opt-in)
note "an update is available: ${REMOTE_SHA:0:7} ($REMOTE_DATE) -- $REMOTE_MSG"
ANSWER="${KITAB_AUTO_UPDATE:-yes}"
if [ "$ANSWER" = "ask" ] && [ "${KITAB_NO_POPUP:-0}" = "1" ]; then
  ANSWER="no"  # asked to ask, but no way to show the dialog
elif [ "$ANSWER" = "ask" ]; then
  ANSWER="$(osascript - "$REMOTE_DATE" "$REMOTE_MSG" "$N_CHANGED" 2>/dev/null <<'OSA'
on run argv
  set m to "A newer version of kitab-lens is available (from " & item 1 of argv & ")." & return & return & "What's new: " & item 2 of argv & return & return & "Updating changes " & item 3 of argv & " file(s) and takes about a minute. Your settings, ChatGPT login and scan history are kept."
  set r to display alert "Update kitab-lens?" message m buttons {"Not Now", "Update"} default button "Update" cancel button "Not Now"
  return button returned of r
end run
OSA
)" || ANSWER="no"
fi
case "$ANSWER" in
  [Yy]*|Update) ;;
  *) note "update postponed -- you'll be asked again next time"; exit 0 ;;
esac

# --------------------------------------------------------------------------- 4. apply
note "updating ($N_CHANGED file(s))..."
# rsync writes each file to a temp name and renames it into place, so the scripts
# running right now (this one, the Start command) keep reading their old copies.
rsync -rlpc "${KEEP[@]}" "$NEW/" "$LENS_ROOT/" \
  || fail "Copying the new version's files into the kitab-lens folder failed partway." \
          "Download kitab-lens again from github.com/$REPO (Code > Download ZIP), unzip it, and run its installer."
for d in "${CODE_DIRS[@]}"; do
  [ -d "$NEW/$d" ] && [ -d "$LENS_ROOT/$d" ] || continue
  # shellcheck disable=SC2046
  rsync -rlpc --delete "${KEEP[@]}" $(keep_in "$d") "$NEW/$d/" "$LENS_ROOT/$d/" \
    || fail "Removing files that the new version no longer uses failed." \
            "Download kitab-lens again from github.com/$REPO (Code > Download ZIP), unzip it, and run its installer."
done
printf '%s' "$REMOTE_SHA" > "$STAMP"

# --------------------------------------------------------------------------- 5. install
note "installing what the new version needs..."
# install.sh explains its own failures (terminal + alert); just stop here if it fails.
/bin/bash "$LENS_ROOT/install.sh" || exit 1
note "updated to ${REMOTE_SHA:0:7}"
exit "$UPDATED"
