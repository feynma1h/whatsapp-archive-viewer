"""
Builds small synthetic WhatsApp-style export zips for tests:

  normal   — a well-formed export covering every message kind
  trunc    — declares 3 entries but its central directory only lists 1;
             the orphaned two (a descriptor-style photo and _chat.txt)
             mirror the real-world damaged exports WhatsApp can produce
  zip64    — entries written with zip64 extra fields
"""
import base64
import struct
import zipfile
import zlib
from pathlib import Path

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8"
    "z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
LRM = "‎"

NORMAL_CHAT = (
    f"[20/05/24, 10:00:00 AM] Testy: {LRM}Messages and calls are end-to-end encrypted.\n"
    f"[20/05/24, 10:01:00 AM] Alice: Hello there\n"
    f"[20/05/24, 10:01:30 AM] Bob: Hi! two lines follow\n"
    f"second line here\n"
    f"[20/05/24, 10:02:00 AM] Alice: {LRM}<attached: 00000004-PHOTO-2024-05-20-10-02-00.jpg>\n"
    f"[20/05/24, 10:03:00 AM] Bob: Caption here {LRM}<attached: 00000005-PHOTO-2024-05-20-10-03-00.jpg>\n"
    f"[20/05/24, 10:04:00 AM] Alice: {LRM}<attached: 00000006-STICKER-2024-05-20-10-04-00.webp>\n"
    f"[20/05/24, 10:05:00 AM] Bob: Check this {LRM}image omitted\n"
    f"[20/05/24, 10:06:00 AM] Alice: {LRM}Missed voice call\n"
    f"[20/05/24, 10:07:00 AM] Bob: This message was deleted.\n"
    f"[20/05/24, 10:08:00 AM] Alice: Edited msg {LRM}<This message was edited>\n"
    f"[20/05/24, 10:09:00 AM] Bob: 😂😂\n"
    f"[20/05/24, 10:10:00 AM] Alice: See https://example.com/page ok\n"
    f"[21/05/24, 9:00:00 AM] Bob: Next day message\n"
).replace("\n", "\r\n")

TRUNC_CHAT = (
    f"[20/05/24, 10:00:00 AM] Alice: photo A {LRM}<attached: 00000001-PHOTO-2024-05-20-10-00-00.jpg>\n"
    f"[20/05/24, 10:01:00 AM] Bob: photo B {LRM}<attached: 00000002-PHOTO-2024-05-20-10-01-00.jpg>\n"
    f"[20/05/24, 10:02:00 AM] Alice: The end\n"
)


def make_normal(dirpath: Path) -> Path:
    p = dirpath / "WhatsApp Chat - Testy.zip"
    with zipfile.ZipFile(p, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("00000004-PHOTO-2024-05-20-10-02-00.jpg", PNG)
        z.writestr("00000005-PHOTO-2024-05-20-10-03-00.jpg", PNG)
        z.writestr("00000006-STICKER-2024-05-20-10-04-00.webp", PNG)
        z.writestr("_chat.txt", NORMAL_CHAT.encode())
    return p


def _raw_deflate(data: bytes) -> bytes:
    c = zlib.compressobj(9, zlib.DEFLATED, -15)
    return c.compress(data) + c.flush()


def make_trunc(dirpath: Path) -> Path:
    """Handcrafted zip whose central directory is truncated after the first
    entry while the end-of-central-directory record still declares 3."""
    out = bytearray()
    cd = bytearray()

    def add(name, data, use_descriptor):
        nameb = name.encode()
        comp = _raw_deflate(data)
        crc = zlib.crc32(data) & 0xFFFFFFFF
        flags = 0x0808 if use_descriptor else 0x0800   # bit11 utf-8 (+bit3)
        hoff = len(out)
        lh = (0, 0, 0) if use_descriptor else (crc, len(comp), len(data))
        out.extend(struct.pack("<IHHHHHIIIHH", 0x04034B50, 20, flags, 8, 0, 0,
                               lh[0], lh[1], lh[2], len(nameb), 0))
        out.extend(nameb)
        out.extend(comp)
        if use_descriptor:
            out.extend(struct.pack("<IIII", 0x08074B50, crc, len(comp), len(data)))
        cd.extend(struct.pack("<IHHHHHHIIIHHHHHII", 0x02014B50, 20, 20, flags,
                              8, 0, 0, crc, len(comp), len(data),
                              len(nameb), 0, 0, 0, 0, 0, hoff))
        cd.extend(nameb)
        return len(cd)

    first_rec_end = add("00000001-PHOTO-2024-05-20-10-00-00.jpg", PNG, False)
    add("00000002-PHOTO-2024-05-20-10-01-00.jpg", PNG, True)
    add("_chat.txt", TRUNC_CHAT.encode(), False)

    cd_off = len(out)
    trunc_cd = cd[:first_rec_end]
    eocd = struct.pack("<IHHHHIIH", 0x06054B50, 0, 0, 3, 3,
                       len(trunc_cd), cd_off, 0)
    p = dirpath / "WhatsApp Chat - Trunc.zip"
    p.write_bytes(bytes(out) + bytes(trunc_cd) + eocd)
    return p


def make_zip64(dirpath: Path) -> Path:
    p = dirpath / "WhatsApp Chat - Big64.zip"
    chat = ("[20/05/24, 10:00:00 AM] Alice: zip64 works\n"
            "[20/05/24, 10:01:00 AM] Bob: indeed\n")
    with zipfile.ZipFile(p, "w", zipfile.ZIP_DEFLATED) as z:
        with z.open("_chat.txt", "w", force_zip64=True) as w:
            w.write(chat.encode())
        with z.open("00000001-PHOTO-2024-05-20-10-00-00.jpg", "w",
                    force_zip64=True) as w:
            w.write(PNG)
    return p
