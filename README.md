# Archive Viewer for WhatsApp Exports

Read your WhatsApp export `.zip` files in a familiar chat-style web UI —
**read-only, zero extraction, and (in the web version) zero upload**.

> **Unofficial tool** — not affiliated with, endorsed by, or connected to
> WhatsApp or Meta. It only reads the export files WhatsApp already lets you
> save from your own chats.

WhatsApp chats — especially their photos and videos — quietly eat tens of
gigabytes of phone storage. The workflow this project exists for: export the
chats you want to keep, park the zips on a computer or external drive, check
they open here, and reclaim the space on your phone knowing the conversations
are still a double-click away.

Works in two modes with the same single page:

| | Local server mode | Web (static) mode |
|---|---|---|
| How | `python3 server.py` next to your archives | Host `docs/` anywhere static (GitHub Pages) |
| Archive discovery | scans a folder for `.zip` files (its parent, or `--root`) | you pick/drop files or folders from your device |
| Data flow | localhost only | **files never leave the browser** |
| Needs | Python 3 (stdlib only) | a modern browser, nothing else |

## Features

- WhatsApp-style bubbles, day separators, group sender colours, "you" on the
  right (auto-detected, changeable, remembered)
- Photos, videos, GIFs, stickers, voice notes, documents and contact cards,
  decompressed straight out of the zip on demand; full-screen lightbox
- Search (Enter = older, Shift+Enter = newer), calendar jump with
  message-days highlighted, jump-to-latest, and a floating date chip while
  scrolling
- Smooth reading in huge chats: messages load in pages, media loads lazily
  (videos get first-frame thumbnails), and scroll position is held steady
  while media streams in
- **Repairs damaged exports**: some WhatsApp zips have a truncated index that
  hides the newest media and even `_chat.txt` from normal tools — the viewer
  detects this and recovers the lost entries (in both modes)

## Creating an export (iPhone)

1. In WhatsApp, open the chat and tap its **name** at the top.
2. Scroll to the bottom and tap **Export Chat**.
3. Choose **Attach Media** (photos, videos and voice notes included) or
   **Without Media** (text only — a small file).
4. Save the resulting `.zip`: AirDrop it to your computer, or *Save to Files*
   and copy it over later.
5. Open it with this viewer — either mode.

Before deleting anything from your phone, open the export here and skim it:
media WhatsApp shows as *"omitted"* placeholders was not included in the zip
and can't be recovered from it. Android's export format is not parsed yet.

## Run locally (server mode)

Place this repository folder next to your export zips, then from the folder
that contains them (any layout of subfolders is fine):

```bash
python3 whatsapp-archive-viewer/server.py
```

Or run it from anywhere and point it at the folder holding your exports:

```bash
python3 server.py --root ~/path/to/your/exports
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

## License

[MIT](LICENSE)
