# WhatsApp Archive Viewer

Read your WhatsApp export `.zip` files in a WhatsApp-style web UI —
**read-only, zero extraction, and (in the web version) zero upload**.

Works in two modes with the same single page:

| | Local server mode | Web (static) mode |
|---|---|---|
| How | `python3 server.py` next to your archives | Host `docs/` anywhere static (GitHub Pages) |
| Archive discovery | scans the parent folder for `.zip` files | you pick/drop files from your device |
| Data flow | localhost only | **files never leave the browser** |
| Needs | Python 3 (stdlib only) | a modern browser, nothing else |

## Features

- WhatsApp-style bubbles, day separators, group sender colours, "you" on the
  right (auto-detected, changeable, remembered)
- Photos, videos, GIFs, stickers, voice notes, documents and contact cards,
  decompressed straight out of the zip on demand; full-screen lightbox
- Search (Enter = older, Shift+Enter = newer), calendar jump with
  message-days highlighted, jump-to-latest
- Smooth reading in huge chats: messages load in pages, media loads lazily,
  and scroll position is held steady while media streams in
- **Repairs damaged exports**: some WhatsApp zips have a truncated index that
  hides the newest media and even `_chat.txt` from normal tools — the viewer
  detects this and recovers the lost entries (in both modes)

## Run locally (server mode)

Place this repository folder next to your export zips, then from the folder
that contains them (any layout of subfolders is fine):

```bash
python3 whatsapp-archive-viewer/server.py
```

Opens http://127.0.0.1:8471.

## Repository layout

```
docs/               the deployable site (GitHub Pages serves this folder)
  index.html        markup
  css/app.css       styles
  js/util.js        shared helpers & constants
  js/chatparse.js   chat-text parser + message classifier
  js/zip.js         zip reader: central directory, zip64, damaged-index salvage
  js/session.js     data layer (server mode / fully-local mode)
  js/app.js         UI: rendering, scrolling, search, calendar, lightbox
server.py           local HTTP server (entry point)
archive.py          server-side domain logic (zip access, salvage, parsing)
tests/              stdlib unittest suite + synthetic export fixtures
```

Plain ES modules, no build step, no dependencies — what's in the repo is what
runs. (Consequence: opening `index.html` via `file://` won't work; serve it
over HTTP — `server.py`, any static server, or GitHub Pages.)

## Tests

```bash
python3 -m unittest discover tests
```

covers parsing/classification of every message kind, date-order detection,
zip64 handling, and recovery from truncated-index archives.

## Deploy the web version

The `docs/` folder is the entire site — static files, nothing to build. For
GitHub Pages:

1. Push this repo to GitHub **without any archives** — `.gitignore` here
   already excludes `*.zip`; double-check with `git status` before pushing.
2. Repo Settings → Pages → Source: *Deploy from a branch*, folder `/docs`.
3. Open the published URL and pick individual export **.zip files**, or a
   **whole folder** of them (drag & drop works for both — dropping a folder
   scans it recursively). When scanning a folder, zips that don't look like
   WhatsApp exports (by filename or by a quick index-only peek inside) are
   skipped with a note; individually picked files are always trusted.
   Everything — zip parsing, decompression, rendering — happens in the
   browser; DevTools' network tab will show zero uploads. Note: browsers
   label folder access "upload" in their permission dialog — nothing leaves
   the device.

Browser support: Chrome/Edge/Firefox and Safari 16.4+ (needs native
`DecompressionStream`).

## Known limits & assumptions

- iPhone-style exports (`[date] Name: message` + `_chat.txt`). Android's
  export format is not parsed yet.
- English export markers ("image omitted", "Missed voice call", …); other
  phone languages render those as plain text.
- Day-first dates are assumed when a chat is too short to auto-detect the
  order; 2-digit years are read as 20xx.
- Times are shown exactly as written in the export (no timezone conversion).
- `.opus` voice notes may not play in Safari; `.heic` photos may not render
  in Chrome (a download chip is offered instead).
- In web mode you re-pick the files each visit — by design, the page holds
  no file access once closed.
