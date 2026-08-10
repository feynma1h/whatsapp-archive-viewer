"""
Domain logic for reading WhatsApp export zips: read-only zip access (with
recovery of entries orphaned by truncated central directories), chat-text
parsing/classification, and an in-memory media cache.

Nothing here writes to disk; archives are only ever opened read-only.
"""
import calendar
import re
import struct
import threading
import zipfile
import zlib
from array import array
from bisect import bisect_right
from collections import OrderedDict

# ------------------------------------------------------------------- zips ----
#
# Some WhatsApp exports have a TRUNCATED central directory (the index at the
# end of the zip): it declares N entries but contains fewer, so standard zip
# tools silently lose the tail of the archive — typically the newest media
# AND _chat.txt itself.  The entries are still physically present, so when we
# detect the mismatch we walk the orphaned region's local file headers and
# recover them.

class SalvagedInfo:
    """Duck-types the parts of ZipInfo the viewer uses."""
    salvaged = True

    def __init__(self, filename, data_offset, method, csize, usize, crc):
        self.filename = filename
        self.data_offset = data_offset
        self.compress_type = method
        self.compress_size = csize
        self.file_size = usize
        self.CRC = crc


def _find_sig(f, start, end, sig=b"PK\x03\x04"):
    pos, tail = start, b""
    while pos < end:
        f.seek(pos)
        chunk = f.read(min(8 << 20, end - pos))
        if not chunk:
            return None
        buf = tail + chunk
        k = buf.find(sig)
        if k != -1:
            return pos - len(tail) + k
        tail = buf[-3:]
        pos += len(chunk)
    return None


def _measure_deflate(f, off, limit):
    """Stream-decompress a raw deflate stream to learn its compressed /
    uncompressed sizes and CRC without keeping the output."""
    d = zlib.decompressobj(-15)
    f.seek(off)
    consumed = out_len = crc = 0
    while True:
        remaining = limit - (off + consumed)
        if remaining <= 0:
            return None
        chunk = f.read(min(4 << 20, remaining))
        if not chunk:
            return None
        out = d.decompress(chunk)
        crc = zlib.crc32(out, crc)
        out_len += len(out)
        consumed += len(chunk)
        if d.eof:
            consumed -= len(d.unused_data)
            return consumed, out_len, crc & 0xFFFFFFFF


def _walk_orphans(f, start, cd_start):
    off = _find_sig(f, start, cd_start)
    while off is not None and off + 30 < cd_start:
        f.seek(off)
        hdr = f.read(30)
        if hdr[:4] != b"PK\x03\x04":
            return
        flags, method = struct.unpack("<HH", hdr[6:10])
        crc, csize, usize = struct.unpack("<III", hdr[14:26])
        nlen, elen = struct.unpack("<HH", hdr[26:30])
        name = f.read(nlen).decode("utf-8", "replace")
        data_off = off + 30 + nlen + elen
        if method == 8 and (csize == 0 or (flags & 8)):
            measured = _measure_deflate(f, data_off, cd_start)
            if measured is None:
                return
            csize, usize, crc = measured
        elif method != 0 and method != 8:
            return
        yield SalvagedInfo(name, data_off, method, csize, usize, crc)
        off = _find_sig(f, data_off + max(csize, 1), cd_start)


class ZipHandle:
    def __init__(self, path):
        self.path = path
        self.zf = zipfile.ZipFile(path)          # read-only
        self.lock = threading.Lock()
        self.infos = {i.filename: i for i in self.zf.infolist()}
        self.salvaged = 0
        try:
            self._salvage()
        except Exception:
            pass          # a damaged archive still serves its indexed entries

    def _eocd(self):
        """Return (declared entry count, central directory offset)."""
        with open(self.path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - 131072))
            tail = f.read()
        i = tail.rfind(b"PK\x06\x06")            # zip64 end of central dir
        if i != -1 and len(tail) - i >= 56:
            declared = struct.unpack("<Q", tail[i + 32:i + 40])[0]
            cd_off = struct.unpack("<Q", tail[i + 48:i + 56])[0]
            return declared, cd_off
        i = tail.rfind(b"PK\x05\x06")
        if i != -1 and len(tail) - i >= 22:
            declared = struct.unpack("<H", tail[i + 10:i + 12])[0]
            cd_off = struct.unpack("<I", tail[i + 16:i + 20])[0]
            if declared != 0xFFFF and cd_off != 0xFFFFFFFF:
                return declared, cd_off
        return None, None

    def _salvage(self):
        declared, cd_off = self._eocd()
        if not declared or not cd_off or declared <= len(self.infos):
            return
        start = 0
        if self.infos:
            last = max(self.infos.values(), key=lambda i: i.header_offset)
            start = last.header_offset + last.compress_size
        with open(self.path, "rb") as f:
            for info in _walk_orphans(f, start, cd_off):
                if info.filename not in self.infos:
                    self.infos[info.filename] = info
                    self.salvaged += 1

    def read_entry(self, name):
        info = self.infos.get(name)
        if info is None:
            raise KeyError(name)
        if getattr(info, "salvaged", False):
            with self.lock:
                with open(self.path, "rb") as f:
                    f.seek(info.data_offset)
                    raw = f.read(info.compress_size)
            if info.compress_type == 8:
                return zlib.decompress(raw, -15)
            return raw
        with self.lock:
            return self.zf.read(name)


_zips = OrderedDict()
_zips_lock = threading.Lock()

def get_zip(aid, path):
    with _zips_lock:
        zh = _zips.get(aid)
        if zh:
            _zips.move_to_end(aid)
            return zh
    zh = ZipHandle(path)
    with _zips_lock:
        _zips[aid] = zh
        while len(_zips) > 4:
            _, old = _zips.popitem(last=False)
            try:
                old.zf.close()
            except Exception:
                pass
    return zh

# ------------------------------------------------------------- chat parsing --

LRM = "‎"
LINE_RE = re.compile(
    r"^‎?\[(\d{1,2})[./](\d{1,2})[./](\d{2,4}),?\s+"
    r"(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?\]\s?",
    re.M,
)
ATTACH_RE = re.compile(r"<attached:\s*([^>]+?)\s*>")
OMITTED_RE = re.compile(
    r"^(?:image|video|audio|sticker|GIF|document|Contact card) omitted$", re.I)
# the same marker with WhatsApp's invisible LRM prefix, possibly after a
# caption on the same line ("This is finished ‎image omitted")
OMIT_MARK_RE = re.compile(
    r"‎(image|video|audio|sticker|GIF|document|Contact card) omitted", re.I)
CALL_RE = re.compile(
    r"^(?:Missed voice call|Missed video call|Voice call|Video call|"
    r"Call declined|No answer|Silenced call)\b", re.I)
EDIT_MARK = "<This message was edited>"
DELETED_RE = re.compile(
    r"^(?:This message was deleted\.?|You deleted this message\.?)$")


class ChatIndex:
    """Parsed view of one _chat.txt, kept in memory. The raw text is stored
    once; per-message we keep only offsets + timestamp + sender index."""

    def __init__(self, text, chat_name):
        self.text = text
        self.lower = None                       # built lazily for search
        self.chat = chat_name
        self.starts = array("q")                # offset of message start
        self.contents = array("q")              # offset where body begins
        self.ts = array("q")                    # epoch seconds (as-if-UTC)
        self.snd = array("i")                   # index into self.senders
        self.senders = []
        self.sender_counts = []
        self._sender_ids = {}
        self.days = []                          # [dayEpoch, firstMsgIndex]
        self._build()

    def _sender(self, name):
        i = self._sender_ids.get(name)
        if i is None:
            i = len(self.senders)
            self._sender_ids[name] = i
            self.senders.append(name)
            self.sender_counts.append(0)
        self.sender_counts[i] += 1
        return i

    def _build(self):
        text = self.text
        matches = list(LINE_RE.finditer(text))

        # Detect day-first vs month-first from a sample.
        max_a = max_b = 0
        for m in matches[:5000]:
            max_a = max(max_a, int(m.group(1)))
            max_b = max(max_b, int(m.group(2)))
        month_first = max_a <= 12 < max_b

        prev_ts = 0
        prev_day = None
        for m in matches:
            a, b, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
            day, mon = (b, a) if month_first else (a, b)
            if y < 100:
                y += 2000
            h = int(m.group(4))
            ap = m.group(7)
            if ap:
                h = h % 12 + (12 if ap.lower() == "pm" else 0)
            try:
                t = calendar.timegm((y, mon, day, h, int(m.group(5)),
                                     int(m.group(6) or 0), 0, 0, 0))
            except Exception:
                t = prev_ts
            prev_ts = t

            line_end = text.find("\n", m.end())
            if line_end == -1:
                line_end = len(text)
            colon = text.find(": ", m.end(), line_end)
            if colon == -1:
                # A line like "[ts] Name:" with nothing after the colon
                # (empty / unsupported message).
                line = text[m.end():line_end].rstrip()
                if line.endswith(":") and 1 < len(line) <= 60:
                    sender = line[:-1].strip(LRM + "‏ ").strip()
                    content = line_end
                else:
                    sender, content = "", m.end()
            else:
                sender = text[m.end():colon].strip(LRM + "‏ ").strip()
                content = colon + 2

            i = len(self.starts)
            self.starts.append(m.start())
            self.contents.append(content)
            self.ts.append(t)
            self.snd.append(self._sender(sender))
            d = t // 86400
            if d != prev_day:
                self.days.append([int(d), i])
                prev_day = d

    def __len__(self):
        return len(self.starts)

    def raw(self, i):
        end = self.starts[i + 1] if i + 1 < len(self.starts) else len(self.text)
        return self.text[self.contents[i]:end].rstrip("\n")

    def message(self, i):
        raw = self.raw(i)
        item = {"i": i, "ts": self.ts[i], "s": self.snd[i]}
        had_lrm = raw.startswith(LRM) or raw.startswith("‏")

        if EDIT_MARK in raw:
            raw = raw.replace(LRM + EDIT_MARK, "").replace(EDIT_MARK, "")
            item["e"] = 1

        att = ATTACH_RE.search(raw)
        omit = None if att else OMIT_MARK_RE.search(raw)
        clean = ATTACH_RE.sub("", raw).replace(LRM, "").replace("‏", "").strip()

        if att:
            item["k"] = 1
            item["a"] = att.group(1)
            if clean:
                item["t"] = clean
        elif omit or OMITTED_RE.match(clean):
            item["k"] = 1
            item["mt"] = (omit.group(1).lower() + " omitted") if omit else clean
            if omit:                     # anything else on the line is a caption
                caption = OMIT_MARK_RE.sub("", raw)
                caption = caption.replace(LRM, "").replace("‏", "").strip()
                if caption:
                    item["t"] = caption
        elif DELETED_RE.match(clean):
            item["k"] = 4
            item["t"] = clean
        elif CALL_RE.match(clean):
            item["k"] = 3
            item["t"] = clean
        elif had_lrm or not self.senders[self.snd[i]]:
            item["k"] = 2                # system notice
            item["t"] = clean
        else:
            item["k"] = 0
            item["t"] = clean
        return item

    def search(self, q, limit=500):
        if self.lower is None:
            self.lower = self.text.lower()
        q = q.lower()
        out, pos, truncated = [], 0, False
        n = len(self.starts)
        while True:
            pos = self.lower.find(q, pos)
            if pos == -1:
                break
            idx = bisect_right(self.starts, pos) - 1
            if idx < 0 or pos < self.contents[idx]:
                pos += len(q)            # hit inside a timestamp/sender header
                continue
            if len(out) >= limit:
                truncated = True
                break
            body = ATTACH_RE.sub("", self.raw(idx)).replace(LRM, "")
            body = " ".join(body.split())
            lo = body.lower().find(q)
            if lo == -1:
                snip = body[:90]
            else:
                a, b = max(0, lo - 45), min(len(body), lo + len(q) + 45)
                snip = (("…" if a else "") + body[a:b]
                        + ("…" if b < len(body) else ""))
            out.append({
                "i": idx, "ts": self.ts[idx], "s": self.snd[idx], "snip": snip,
            })
            pos = self.starts[idx + 1] if idx + 1 < n else len(self.text)
        return out, truncated


_chats = OrderedDict()
_chats_lock = threading.Lock()

def get_chat(archive):
    aid = archive["id"]
    with _chats_lock:
        ci = _chats.get(aid)
        if ci:
            _chats.move_to_end(aid)
            return ci
    zh = get_zip(aid, archive["_path"])
    txt_name = "_chat.txt"
    if txt_name not in zh.infos:
        txts = [n for n in zh.infos if n.lower().endswith(".txt")]
        if not txts:
            raise FileNotFoundError(
                "this export has no chat text file — it only contains media")
        txt_name = txts[0]
    data = zh.read_entry(txt_name)
    text = data.decode("utf-8-sig", "replace").replace("\r\n", "\n").replace("\r", "\n")
    ci = ChatIndex(text, archive["chat"])
    with _chats_lock:
        _chats[aid] = ci
        while len(_chats) > 3:
            _chats.popitem(last=False)
    return ci

# ------------------------------------------------------------- media cache ---

MEDIA_MEM_LIMIT = 300 * 1024 * 1024      # decompress-to-RAM cap per file
CACHE_TOTAL = 500 * 1024 * 1024          # total LRU budget

_media = OrderedDict()                   # (aid, name) -> bytes
_media_size = 0
_media_lock = threading.Lock()

def get_media_bytes(aid, path, name):
    global _media_size
    key = (aid, name)
    with _media_lock:
        buf = _media.get(key)
        if buf is not None:
            _media.move_to_end(key)
            return buf
    zh = get_zip(aid, path)
    buf = zh.read_entry(name)
    with _media_lock:
        if key not in _media:
            _media[key] = buf
            _media_size += len(buf)
            while _media_size > CACHE_TOTAL and len(_media) > 1:
                _, old = _media.popitem(last=False)
                _media_size -= len(old)
    return buf

MIME = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".webp": "image/webp", ".gif": "image/gif", ".heic": "image/heic",
    ".mp4": "video/mp4", ".mov": "video/quicktime", ".3gp": "video/3gpp",
    ".opus": "audio/ogg", ".ogg": "audio/ogg", ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4", ".aac": "audio/aac", ".wav": "audio/wav",
    ".pdf": "application/pdf", ".vcf": "text/vcard",
    ".txt": "text/plain; charset=utf-8",
}
