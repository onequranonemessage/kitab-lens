#!/bin/bash
# kitab-lens -- installs, updates and starts kitab-lens. Either paste this into
# Terminal:
#
#   curl -fsSL https://raw.githubusercontent.com/onequranonemessage/kitab-lens/main/kitab-lens.command | bash
#
# or send someone this file and have them double-click it (macOS opens it in
# Terminal). Either way it does everything:
#
#   first run   downloads kitab-lens from GitHub into
#               ~/Library/Application Support/kitab-lens, installs it (install.sh),
#               and adds a kitab-lens app to ~/Applications for starting it later
#   every run   updates to the latest version on GitHub if there is one (update.sh),
#               then starts kitab-lens ("Start kitab-lens.command")
#
# Keep the Terminal window open while using kitab-lens; close it (or press
# Control-C) to stop it. This file holds no app logic of its own -- it only fetches
# and hands off -- so a copy sent long ago keeps working as the app changes.
#
# Run from inside a full kitab-lens folder (a clone, or GitHub's "Download ZIP") it
# uses that folder instead of downloading a copy.
#
# Arguments are passed on to run.sh (e.g. --no-tunnel). Env: KITAB_HOME (where to
# install), KITAB_UPDATE_REPO (owner/name), KITAB_UPDATE_BRANCH, KITAB_AUTO_UPDATE=ask
# (ask before updating), KITAB_NO_UPDATE=1.

# Everything is inside main(), called on the last line, so bash has read the whole
# file before running any of it -- this also works piped: curl ... | bash
main() {
  export KITAB_UPDATE_REPO="${KITAB_UPDATE_REPO:-onequranonemessage/kitab-lens}"
  export KITAB_UPDATE_BRANCH="${KITAB_UPDATE_BRANCH:-main}"
  local repo="$KITAB_UPDATE_REPO" branch="$KITAB_UPDATE_BRANCH"
  local api_base="${KITAB_UPDATE_API_BASE:-https://api.github.com}"
  local codeload_base="${KITAB_UPDATE_CODELOAD_BASE:-https://codeload.github.com}"

  local self_dir=""
  if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
    self_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  fi
  if [ -n "$self_dir" ] && [ -f "$self_dir/run.sh" ] && [ -f "$self_dir/install.sh" ]; then
    LENS_ROOT="$self_dir"
  else
    LENS_ROOT="${KITAB_HOME:-$HOME/Library/Application Support/kitab-lens}"
  fi

  # How the user started this, for "try again" hints (and: piped, keep their screen).
  if [ -n "$self_dir" ]; then
    AGAIN="double-click kitab-lens again"
    clear
  else
    AGAIN="paste the install command into Terminal again"
  fi
  echo "kitab-lens"
  echo

  # ------------------------------------------------------------------ download
  if [ ! -f "$LENS_ROOT/run.sh" ]; then
    echo "Downloading kitab-lens (first run only)..."
    local tmp sha code
    tmp="$(mktemp -d "${TMPDIR:-/tmp}/kitab-lens-get.XXXXXX")"
    trap 'rm -rf "$tmp"' EXIT

    # The commit is pinned first so the download and .kitab-version always agree.
    code="$(curl -sS --max-time 20 -o "$tmp/sha" -w '%{http_code}' \
      -H 'Accept: application/vnd.github.sha' \
      "$api_base/repos/$repo/commits/$branch" 2>/dev/null)" || code="000"
    sha="$(tr -dc '0-9a-f' 2>/dev/null < "$tmp/sha")"
    case "$code" in
      200) [ "${#sha}" -eq 40 ] || fail "GitHub's answer about the latest version wasn't understood." "Try again in a few minutes." ;;
      000) fail "This Mac couldn't reach GitHub to download kitab-lens." \
                "Check this Mac's internet connection, then $AGAIN." ;;
      403|429) fail "GitHub is limiting downloads from this network right now." "Wait a few minutes, then $AGAIN." ;;
      *) fail "kitab-lens couldn't be found on GitHub (github.com/$repo answered $code)." \
              "Ask whoever sent you kitab-lens for a new copy." ;;
    esac

    curl -fL --retry 3 --connect-timeout 20 --progress-bar -o "$tmp/src.tar.gz" \
      "$codeload_base/$repo/tar.gz/$sha" \
      || fail "Downloading kitab-lens failed partway." "Check this Mac's internet connection, then $AGAIN."
    mkdir -p "$tmp/src"
    tar -xzf "$tmp/src.tar.gz" -C "$tmp/src" --strip-components 1 2>/dev/null && [ -f "$tmp/src/install.sh" ] \
      || fail "The kitab-lens download was damaged." "To re-download it, $AGAIN."

    mkdir -p "$LENS_ROOT" && ditto "$tmp/src" "$LENS_ROOT" \
      || fail "kitab-lens couldn't be saved to $LENS_ROOT." "Make sure this Mac has free disk space, then $AGAIN."
    printf '%s' "$sha" > "$LENS_ROOT/.kitab-version"
    echo "Saved to $LENS_ROOT"
    echo
  fi

  # ------------------------------------------------------------------ install
  # install.sh writes .kitab-installed only when it finishes, so an interrupted or
  # failed install is simply resumed next time. (It explains its own failures.)
  if [ ! -f "$LENS_ROOT/.kitab-installed" ]; then
    echo "Installing kitab-lens. This takes a few minutes the first time."
    if ! /bin/bash "$LENS_ROOT/install.sh"; then
      echo
      echo "The install stopped -- see the message above. After fixing it, $AGAIN."
      pause_and_exit 1
    fi
    echo
  fi

  # ------------------------------------------------------------------ app shortcut
  # A kitab-lens app in ~/Applications (so it's in Spotlight and Launchpad) that
  # opens the installed copy of this file in Terminal. It's built on this Mac, so
  # Gatekeeper has nothing to block. Not for a folder the user runs in place.
  local app="$HOME/Applications/kitab-lens.app"
  if [ "$LENS_ROOT" != "$self_dir" ] && [ ! -d "$app" ] && [ -f "$LENS_ROOT/kitab-lens.command" ]; then
    local target
    target="$(printf '%s' "$LENS_ROOT/kitab-lens.command" | sed 's/[\\"]/\\&/g')"
    mkdir -p "$HOME/Applications"
    if osacompile -o "$app" -e "do shell script \"open \" & quoted form of \"$target\"" 2>/dev/null; then
      echo "Added kitab-lens to your Applications -- next time, open it from Spotlight or Launchpad."
      echo
    fi
  fi

  # ------------------------------------------------------------------ update + start
  # The Start command runs update.sh first (and restarts itself after an update).
  exec /bin/bash "$LENS_ROOT/Start kitab-lens.command" "$@"
}

fail() {  # fail WHAT FIX
  printf '\nkitab-lens: %s\nHow to fix: %s\n' "$1" "$2" >&2
  if [ "${KITAB_NO_POPUP:-0}" != "1" ]; then
    osascript - "$1" "$2" >/dev/null 2>&1 <<'OSA'
on run argv
  display alert "kitab-lens couldn't start" message ("What happened:" & return & item 1 of argv & return & return & "How to fix:" & return & item 2 of argv) as critical buttons {"OK"} default button "OK"
end run
OSA
  fi
  pause_and_exit 1
}

pause_and_exit() {
  echo
  read -r -p "Press Return to close this window. " _ 2>/dev/null </dev/tty || true
  exit "$1"
}

main "$@"
