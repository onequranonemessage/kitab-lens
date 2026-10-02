# kitab-lens

Point your phone at a physical Arabic page, get the OCR'd text and a ChatGPT
translation back -- Arabic on the right, translation on the left.

Reuses `kitab-translator-vision-ocr` in place (Apple Vision OCR + a Selenium-driven
chatgpt.com session) behind a small FastAPI backend and a mobile-first web UI.

## Install (one command)

Open **Terminal** (Spotlight: Cmd+Space, type "Terminal"), paste this, and press Return:

```
curl -fsSL https://raw.githubusercontent.com/onequranonemessage/kitab-lens/main/kitab-lens.command | bash
```

That's the whole install. It needs nothing but a stock Mac (macOS 12+, 14+ for Arabic
OCR), and:

1. downloads kitab-lens from `github.com/onequranonemessage/kitab-lens` into
   `~/Library/Application Support/kitab-lens` and installs everything it needs
   (`install.sh`, below -- a few minutes the first time);
2. adds a **kitab-lens** app to `~/Applications`, so next time you just open it from
   Spotlight or Launchpad;
3. starts kitab-lens. Keep the Terminal window open while using it.

Every time kitab-lens starts (from the app, or by pasting the command again), it checks
GitHub and updates itself to the latest commit on `main` first (`update.sh`).

The command runs [`kitab-lens.command`](kitab-lens.command). You can also send someone
that one file to double-click instead -- zip it or AirDrop it (a bare `.command` sent
by email or downloaded in a browser can lose its "executable" permission), and expect
the "Apple could not verify..." block described below the first time (**Open
Anyway**, once). The paste-in command avoids both. Run from inside a full kitab-lens
folder (a clone or "Download ZIP"), the launcher uses that folder instead of
downloading another copy.

## Install from a downloaded folder

Double-click **Install kitab-lens.command**. It opens Terminal and runs the installer.
(`kitab-lens.command` runs it for you on first use.)

The first time, macOS blocks it ("Apple could not verify 'Install kitab-lens.command'
is free of malware"), because it isn't signed by an Apple developer. Click **Done**, then
open **System Settings > Privacy & Security**, scroll down, click **Open Anyway** next
to the message about it, and confirm. You only need to do this once; the installer
clears the block for the whole folder.

Or skip the prompt entirely: open Terminal, type `bash ` (with a space), drag
`install.sh` into the window, and press Return. Either way it's the same as running:

```
bash install.sh
```

Needs nothing but a stock macOS 12+ (14+ for Arabic OCR): no Homebrew, Xcode tools,
Python or Node. It installs uv, Python 3.14, Node.js 22, cloudflared and chromedriver
into `.tools/`, the backend's packages into `.venv/`, the frontend's into
`web/node_modules/`, builds `web/dist/`, and puts Google Chrome in `/Applications` if
it's missing. Every step checks first and skips if already done, so re-running it is
safe (and fixes `.venv` after the folder is moved). If anything fails, a macOS alert explains
what went wrong and how to fix it; the full output is in `install.log`. `--skip-chrome` and
`--skip-cloudflared` skip those two; `--help` lists the rest.

## Run it

Double-click **Start kitab-lens.command**. Keep its Terminal window open while using
kitab-lens; press Control-C there (or close the window) to stop it. From Terminal:

```
./run.sh                  # backend + Cloudflare quick tunnel + opens /connect
./run.sh --no-tunnel      # backend only, 127.0.0.1:8757
./run.sh --no-open        # don't open /connect in a browser
```

(`npm start`, `npm run start:local` and `npm start -- --no-open` do the same, when
Node is on your PATH.)

First run installs `web/`'s dependencies if `node_modules` is missing, and builds
the frontend if `web/dist` is missing or stale (any source file newer than the last
build). It also generates `.env` (a 6-digit passcode and a random HMAC secret).
`/connect` shows the phone URL and passcode as a QR code. A visible Chrome window
(its own profile, under `chrome-profile/`) drives chatgpt.com for translation --
clear any login/verification wall in that window the first time.

The OCR + ChatGPT code comes from `kitab-translator-vision-ocr`: a sibling checkout at
`../kitab-translator-vision-ocr` if there is one, otherwise the copy vendored in
`vendor/` (see `vendor/kitab-translator-vision-ocr/VENDORED.md`). `KITAB_OCR_DIR`
overrides both. `run.sh` uses this folder's `.venv`, falling back to that checkout's.

## Updates

Each time **kitab-lens.command** or **Start kitab-lens.command** runs, `update.sh` asks
GitHub for the latest commit on `main` of `onequranonemessage/kitab-lens` (set `REPO` in
`update.sh` if the repo lives elsewhere). If it's newer than this folder, it updates
automatically: downloads that commit, copies it over this folder, runs `install.sh` for
any new dependencies, and restarts. (`KITAB_AUTO_UPDATE=ask` shows a dialog first.) Local state is kept: `.venv`, `.tools`, `node_modules`, the ChatGPT Chrome
profile, `.env` and logs. No git is needed. `.kitab-version` records the installed commit.

- The repo must be **public**; for a private repo (or offline) the check is skipped and
  kitab-lens starts as-is.
- A folder with a `.git` directory (a clone, e.g. your dev checkout) is never
  auto-updated; use `git pull` there.
- `KITAB_NO_UPDATE=1` skips the check.

To ship an update: commit and push to `main`. The commit message's first line is what
users see as "What's new".

## Layout

- `server/` -- FastAPI backend (`app.py`), the KITAB import shim (`kitab.py`), and
  the server-safe ChatGPT subclass (`chatgpt_lens.py`).
- `web/` -- the frontend (built separately; `server/app.py` serves `web/dist`).
- `vendor/` -- the three files reused from `kitab-translator-vision-ocr`.
- `kitab-lens.command` -- the one-file launcher to send people (download, install,
  update, start). `install.sh` -- installs everything; `run.sh` -- starts everything;
  `update.sh` -- the auto-updater. `Install kitab-lens.command` / `Start
  kitab-lens.command` are the double-clickable versions of the first two. See above.
