#!/usr/bin/env python3
"""
WhatsApp Archive Viewer — read-only local server.

Serves the web app plus chats and media STRAIGHT OUT of the WhatsApp export
.zip files found next to this folder. Nothing is ever extracted to disk, and
archives are opened read-only. Domain logic lives in archive.py.

Run:  python3 server.py          (opens your browser)
      python3 server.py --no-browser
"""
import argparse
import hashlib
import json
import re
import sys
import threading
import webbrowser
import zipfile
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse, parse_qs, quote

from archive import get_zip, get_chat, get_media_bytes, MEDIA_MEM_LIMIT, MIME

HERE = Path(__file__).resolve().parent
DOCS = HERE / "docs"
ROOT = HERE.parent          # the folder that holds the export zips
PORT = 8471

STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
}

# ---------------------------------------------------------------- archives ---

def scan_archives():
    """Find export zips under ROOT (skipping the viewer folder itself)."""
    out = []
    for p in sorted(ROOT.rglob("*.zip")):
        rel = p.relative_to(ROOT)
        if any(part.startswith(".") or part == HERE.name for part in rel.parts):
            continue
        aid = hashlib.sha1(str(rel).encode()).hexdigest()[:12]
        chat = re.sub(r"^WhatsApp Chat (?:- |with )?", "", p.stem).strip()
        out.append({
            "id": aid,
            "chat": chat or p.stem,
            "folder": str(rel.parent) if str(rel.parent) != "." else "",
            "file": p.name,
            "size": p.stat().st_size,
            "_path": p,
        })
    return out

def archive_by_id(aid):
    for a in scan_archives():
        if a["id"] == aid:
            return a
    return None

# ------------------------------------------------------------------ server ---

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "WAViewer/1.0"

    def log_message(self, *a):            # keep the console quiet
        pass

    # -- helpers --
    def _json(self, obj, code=200):
        body = json.dumps(obj, separators=(",", ":")).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _err(self, code, msg):
        self._json({"error": msg}, code)

    def _static(self, rel):
        base = DOCS.resolve()
        p = (base / rel).resolve()
        inside = str(p).startswith(str(base) + "/") or p == base
        if not inside or not p.is_file():
            return self._err(404, "not found")
        body = p.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type",
                         STATIC_TYPES.get(p.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    # -- routing --
    def do_HEAD(self):
        # Minimal HEAD: report existence without a body.
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        try:
            u = urlparse(self.path)
            parts = [unquote(p) for p in u.path.split("/") if p]
            q = parse_qs(u.query)

            if not parts:
                return self._static("index.html")
            if parts[0] == "favicon.ico":
                self.send_response(204)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            if parts[0] in ("css", "js"):
                return self._static("/".join(parts))
            if parts[0] != "api":
                return self._err(404, "not found")

            if parts[1:] == ["archives"]:
                return self._archives()

            if len(parts) >= 4 and parts[1] == "chat":
                archive = archive_by_id(parts[2])
                if not archive:
                    return self._err(404, "unknown archive")
                if parts[3] == "meta":
                    return self._meta(archive)
                if parts[3] == "messages":
                    return self._messages(archive, q)
                if parts[3] == "search":
                    return self._search(archive, q)
                if parts[3] == "media" and len(parts) >= 5:
                    return self._media(archive, "/".join(parts[4:]), q)
            return self._err(404, "not found")
        except BrokenPipeError:
            pass
        except ConnectionResetError:
            pass
        except Exception as e:
            try:
                self._err(500, f"{type(e).__name__}: {e}")
            except Exception:
                pass

    def _archives(self):
        items = []
        for a in scan_archives():
            items.append({k: v for k, v in a.items() if not k.startswith("_")})
        self._json({"archives": items})

    def _meta(self, archive):
        ci = get_chat(archive)
        zh = get_zip(archive["id"], archive["_path"])
        senders = [{"n": n, "c": c}
                   for n, c in zip(ci.senders, ci.sender_counts)]
        self._json({
            "chat": archive["chat"],
            "folder": archive["folder"],
            "count": len(ci),
            "senders": senders,
            "mediaCount": max(0, len(zh.infos) - 1),
            "recovered": zh.salvaged,
            "days": ci.days,
            "first": ci.ts[0] if len(ci) else 0,
            "last": ci.ts[-1] if len(ci) else 0,
        })

    def _messages(self, archive, q):
        ci = get_chat(archive)
        start = max(0, int(q.get("start", ["0"])[0]))
        count = min(500, max(1, int(q.get("count", ["200"])[0])))
        end = min(len(ci), start + count)
        items = [ci.message(i) for i in range(start, end)]
        self._json({"start": start, "total": len(ci), "items": items})

    def _search(self, archive, q):
        ci = get_chat(archive)
        query = q.get("q", [""])[0].strip()
        if not query:
            return self._json({"results": [], "truncated": False})
        results, truncated = ci.search(query)
        self._json({"results": results, "truncated": truncated})

    def _media(self, archive, name, q):
        zh = get_zip(archive["id"], archive["_path"])
        info = zh.infos.get(name)
        if info is None:
            return self._err(404, "media not in archive")

        ext = "." + name.rsplit(".", 1)[-1].lower() if "." in name else ""
        ctype = MIME.get(ext, "application/octet-stream")
        etag = f'"{archive["id"]}-{info.CRC}-{info.file_size}"'

        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        dl = q.get("dl", ["0"])[0] == "1"
        disp = None
        if dl:
            safe = name.encode("ascii", "ignore").decode() or "file"
            disp = f"attachment; filename=\"{safe}\"; filename*=UTF-8''{quote(name)}"

        # Huge entries: stream sequentially without buffering in RAM.
        if info.file_size > MEDIA_MEM_LIMIT:
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(info.file_size))
            if disp:
                self.send_header("Content-Disposition", disp)
            self.end_headers()
            if getattr(info, "salvaged", False):
                with open(archive["_path"], "rb") as f:
                    f.seek(info.data_offset)
                    d = zlib.decompressobj(-15) if info.compress_type == 8 else None
                    left = info.compress_size
                    while left > 0:
                        chunk = f.read(min(1 << 16, left))
                        if not chunk:
                            break
                        left -= len(chunk)
                        self.wfile.write(d.decompress(chunk) if d else chunk)
                    if d:
                        self.wfile.write(d.flush())
            else:
                with zipfile.ZipFile(archive["_path"]) as z, z.open(name) as f:
                    while True:
                        chunk = f.read(1 << 16)
                        if not chunk:
                            break
                        self.wfile.write(chunk)
            return

        buf = get_media_bytes(archive["id"], archive["_path"], name)
        total = len(buf)
        lo, hi = 0, total - 1
        rng = self.headers.get("Range")
        code = 200
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)$", rng.strip())
            if m and (m.group(1) or m.group(2)):
                if m.group(1):
                    lo = int(m.group(1))
                    hi = int(m.group(2)) if m.group(2) else total - 1
                else:                     # suffix range: last N bytes
                    lo = max(0, total - int(m.group(2)))
                    hi = total - 1
                hi = min(hi, total - 1)
                if lo > hi or lo >= total:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{total}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                code = 206

        body = buf[lo:hi + 1]
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("ETag", etag)
        self.send_header("Cache-Control", "public, max-age=604800")
        if code == 206:
            self.send_header("Content-Range", f"bytes {lo}-{hi}/{total}")
        if disp:
            self.send_header("Content-Disposition", disp)
        self.end_headers()
        self.wfile.write(body)


class QuietServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, client_address):
        # Browsers constantly abort media requests (video preload, scrolling
        # away) — those resets are normal, not worth a traceback.
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionResetError, BrokenPipeError,
                            ConnectionAbortedError, TimeoutError)):
            return
        super().handle_error(request, client_address)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=PORT)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    try:
        srv = QuietServer(("127.0.0.1", args.port), Handler)
    except OSError:
        print(f"Port {args.port} is busy — is the viewer already running? "
              f"(try: python3 server.py --port {args.port + 1})")
        sys.exit(1)

    url = f"http://127.0.0.1:{args.port}"
    print(f"WhatsApp Archive Viewer → {url}   (Ctrl+C to stop)")
    print(f"Reading archives from: {ROOT}  — read-only, nothing is extracted.")
    if not args.no_browser:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")

if __name__ == "__main__":
    main()
