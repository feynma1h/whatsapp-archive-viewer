# Archive Viewer for WhatsApp Exports

Read your WhatsApp export `.zip` files in a familiar chat-style web UI —
**read-only, zero extraction, zero upload**.

> **Unofficial tool** — not affiliated with, endorsed by, or connected to
> WhatsApp or Meta. It only reads the export files WhatsApp already lets you
> save from your own chats.

WhatsApp chats — especially their photos and videos — quietly eat tens of
gigabytes of phone storage. The workflow this project exists for: export the
chats you want to keep, park the zips on a computer or external drive, check
they open here, and reclaim the space on your phone knowing the conversations
are still a double-click away.

Everything runs in the browser. Host `docs/` anywhere static (GitHub Pages
does nicely), open it, and pick or drop your export zips — the files never
leave your device, and there is no server, no build step and no dependency.

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
- Comfortable on any screen: phones get a chat-list ⇄ conversation flow
  with back navigation, tablets and desktops the split view
- **Repairs damaged exports**: some WhatsApp zips have a truncated index that
  hides the newest media and even `_chat.txt` from normal tools — the viewer
  detects this and recovers the lost entries

## Creating an export (iPhone)

1. In WhatsApp, open the chat and tap its **name** at the top.
2. Scroll to the bottom and tap **Export Chat**.
3. Choose **Attach Media** (photos, videos and voice notes included) or
   **Without Media** (text only — a small file).
4. Save the resulting `.zip`: AirDrop it to your computer, or *Save to Files*
   and copy it over later.
5. Open it with this viewer.

Before deleting anything from your phone, open the export here and skim it:
media WhatsApp shows as *"omitted"* placeholders was not included in the zip
and can't be recovered from it. Android's export format is not parsed yet.

## Repository layout

```
docs/               the deployable site (GitHub Pages serves this folder)
  index.html        markup
  css/app.css       styles
  js/util.js        shared helpers & constants
  js/chatparse.js   chat-text parser + message classifier
  js/zip.js         zip reader: central directory, zip64, damaged-index salvage
  js/session.js     data layer: opens an archive, serves messages and media
  js/app.js         UI: rendering, scrolling, search, calendar, lightbox
tests/fixtures.js   builds synthetic export zips (normal, damaged, zip64)
tests/*.test.js     the suite, run by node's own test runner
package.json        marks the repo as ES modules; no dependencies
```

Plain ES modules, no build step, no dependencies — what's in the repo is what
runs. (Consequence: opening `index.html` via `file://` won't work; serve it
over HTTP — any static server, or GitHub Pages.)

## Tests

```bash
node --test
```

Needs Node 20 or newer and nothing else. Covers classification of every
message kind, day-first vs month-first date detection, search, zip64, and
recovery from truncated-index archives — including the two cases that make a
damaged export unreadable: a `_chat.txt` whose data descriptor sits flush
against the central directory, and stored entries whose sizes are written
after their data.

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
- You re-pick the files each visit — by design, the page holds no file access
  once closed.
- On iPhone and iPad, tapping **Open** on a large export leaves you in the
  Files picker for a while — around a minute for 2 GB — before Safari comes
  back with the chat already loaded. Safari is copying the whole `.zip` into
  its own storage, which it must finish before a page may read a byte, and it
  keeps its own picker on screen throughout, so the page cannot report the
  wait or even be reached during it. Such an export also needs free space
  equal to its own size, and must be downloaded out of iCloud Drive first if
  it is not already on the device. Reading itself is unaffected by size: the
  archive is read in place, a slice at a time, and 3–5 GB exports open fine
  once handed over.

## License

[MIT](LICENSE)
