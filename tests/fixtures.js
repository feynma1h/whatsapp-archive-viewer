// Synthetic WhatsApp-shaped export zips, built byte by byte so the awkward
// cases can be reproduced exactly:
//
//   normal    — well-formed, every message kind represented
//   truncated — declares 4 entries but its central directory lists 1. The
//               orphans mirror real damaged exports: a deflated entry with a
//               data descriptor, a *stored* entry with one, and `_chat.txt`
//               written last so its descriptor sits flush against the start
//               of the central directory.
//   zip64     — sizes and offsets carried in zip64 records instead of the
//               32-bit fields.
//
// No archive of anyone's is involved: every byte here is fabricated.

import { deflateRawSync } from "node:zlib";

const LRM = "‎";
const enc = new TextEncoder();

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++){
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(bytes){
  let c = 0xFFFFFFFF;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* A growable byte sink with the little-endian writers the zip format needs. */
class Sink {
  constructor(){ this.parts = []; this.length = 0; }
  raw(bytes){ this.parts.push(bytes); this.length += bytes.length; return this; }
  u16(v){ const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); return this.raw(b); }
  u32(v){ const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return this.raw(b); }
  u64(v){ const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v), true); return this.raw(b); }
  bytes(){
    const out = new Uint8Array(this.length);
    let p = 0;
    for (const part of this.parts){ out.set(part, p); p += part.length; }
    return out;
  }
}

const MAX32 = 0xFFFFFFFF;

/**
 * Assemble a zip from entry specs.
 *
 * entry: {name, data, stored?, descriptor?, zip64?}
 * opts:  {cdEntries?  — how many entries the central directory lists
 *                       (fewer than given = a truncated index)
 *         declared?   — what the end-of-central-directory record claims}
 */
export function buildZip(entries, opts = {}){
  const body = new Sink(), cd = new Sink();
  let cdCount = 0;
  const keep = opts.cdEntries ?? entries.length;

  for (const e of entries){
    const data = typeof e.data === "string" ? enc.encode(e.data) : e.data;
    const comp = e.stored ? data : deflateRawSync(data);
    const name = enc.encode(e.name);
    const crc = crc32(data);
    const method = e.stored ? 0 : 8;
    // bit 3 = sizes follow the data in a descriptor; bit 11 = utf-8 names
    const flags = (e.descriptor ? 0x0008 : 0) | 0x0800;
    const hoff = body.length;

    // zip64 entries carry their sizes in an extra field, with the 32-bit
    // fields left at the sentinel
    const extra = new Sink();
    if (e.zip64) extra.u16(1).u16(16).u64(data.length).u64(comp.length);
    const extraBytes = extra.bytes();
    const lhSizes = e.descriptor ? [0, 0, 0]
                  : e.zip64      ? [crc, MAX32, MAX32]
                  :                [crc, comp.length, data.length];

    body.u32(0x04034B50).u16(45).u16(flags).u16(method).u16(0).u16(0)
        .u32(lhSizes[0]).u32(lhSizes[1]).u32(lhSizes[2])
        .u16(name.length).u16(extraBytes.length)
        .raw(name).raw(extraBytes).raw(comp);
    if (e.descriptor) body.u32(0x08074B50).u32(crc).u32(comp.length).u32(data.length);

    if (cdCount < keep){
      cd.u32(0x02014B50).u16(45).u16(45).u16(flags).u16(method).u16(0).u16(0)
        .u32(crc)
        .u32(e.zip64 ? MAX32 : comp.length).u32(e.zip64 ? MAX32 : data.length)
        .u16(name.length).u16(extraBytes.length).u16(0)
        .u16(0).u16(0).u32(0).u32(hoff)
        .raw(name).raw(extraBytes);
      cdCount++;
    }
  }

  const cdOff = body.length, cdBytes = cd.bytes();
  const declared = opts.declared ?? entries.length;
  const out = new Sink().raw(body.bytes()).raw(cdBytes);

  if (entries.some(e => e.zip64)){
    const z64 = out.length;
    out.u32(0x06064B50).u64(44).u16(45).u16(45).u32(0).u32(0)
       .u64(declared).u64(declared).u64(cdBytes.length).u64(cdOff);
    out.u32(0x07064B50).u32(0).u64(z64).u32(1);
    out.u32(0x06054B50).u16(0).u16(0).u16(0xFFFF).u16(0xFFFF)
       .u32(MAX32).u32(MAX32).u16(0);
  } else {
    out.u32(0x06054B50).u16(0).u16(0).u16(declared).u16(declared)
       .u32(cdBytes.length).u32(cdOff).u16(0);
  }
  return out.bytes();
}

export const PNG = new Uint8Array([
  0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A,0x00,0x00,0x00,0x0D,0x49,0x48,0x44,0x52,
  0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x01,0x08,0x06,0x00,0x00,0x00,0x1F,0x15,0xC4,
  0x89,0x00,0x00,0x00,0x0A,0x49,0x44,0x41,0x54,0x78,0x9C,0x63,0x00,0x01,0x00,0x00,
  0x05,0x00,0x01,0x0D,0x0A,0x2D,0xB4,0x00,0x00,0x00,0x00,0x49,0x45,0x4E,0x44,0xAE,
  0x42,0x60,0x82]);

/* Covers every message kind the classifier distinguishes. */
export const NORMAL_CHAT = [
  `[20/05/24, 10:00:00 AM] Testy: ${LRM}Messages and calls are end-to-end encrypted.`,
  `[20/05/24, 10:01:00 AM] Alice: Hello there`,
  `[20/05/24, 10:01:30 AM] Bob: Hi! two lines follow`,
  `second line here`,
  `[20/05/24, 10:02:00 AM] Alice: ${LRM}<attached: 00000004-PHOTO-2024-05-20-10-02-00.jpg>`,
  `[20/05/24, 10:03:00 AM] Bob: Caption here ${LRM}<attached: 00000005-PHOTO-2024-05-20-10-03-00.jpg>`,
  `[20/05/24, 10:04:00 AM] Alice: ${LRM}<attached: 00000006-STICKER-2024-05-20-10-04-00.webp>`,
  `[20/05/24, 10:05:00 AM] Bob: Check this ${LRM}image omitted`,
  `[20/05/24, 10:06:00 AM] Alice: ${LRM}Missed voice call`,
  `[20/05/24, 10:07:00 AM] Bob: This message was deleted.`,
  `[20/05/24, 10:08:00 AM] Alice: Edited msg ${LRM}<This message was edited>`,
  `[20/05/24, 10:09:00 AM] Bob: 😂😂`,
  `[20/05/24, 10:10:00 AM] Alice: See https://example.com/page ok`,
  `[21/05/24, 9:00:00 AM] Bob: Next day message`,
].join("\r\n") + "\r\n";

export const TRUNCATED_CHAT = [
  `[20/05/24, 10:00:00 AM] Alice: photo A ${LRM}<attached: 00000001-PHOTO-2024-05-20-10-00-00.jpg>`,
  `[20/05/24, 10:01:00 AM] Bob: photo B ${LRM}<attached: 00000002-PHOTO-2024-05-20-10-01-00.jpg>`,
  `[20/05/24, 10:02:00 AM] Alice: photo C ${LRM}<attached: 00000003-PHOTO-2024-05-20-10-02-00.jpg>`,
  `[20/05/24, 10:03:00 AM] Bob: The end`,
].join("\r\n") + "\r\n";

export const normalZip = () => buildZip([
  {name: "00000004-PHOTO-2024-05-20-10-02-00.jpg", data: PNG},
  {name: "00000005-PHOTO-2024-05-20-10-03-00.jpg", data: PNG},
  {name: "00000006-STICKER-2024-05-20-10-04-00.webp", data: PNG},
  {name: "_chat.txt", data: NORMAL_CHAT},
]);

// `_chat.txt` goes last, as WhatsApp writes it, so its data descriptor ends
// flush against the central directory — the position that used to be missed.
export const truncatedZip = () => buildZip([
  {name: "00000001-PHOTO-2024-05-20-10-00-00.jpg", data: PNG},
  {name: "00000002-PHOTO-2024-05-20-10-01-00.jpg", data: PNG, descriptor: true},
  {name: "00000003-PHOTO-2024-05-20-10-02-00.jpg", data: PNG, stored: true, descriptor: true},
  {name: "_chat.txt", data: TRUNCATED_CHAT, descriptor: true},
], {cdEntries: 1});

export const zip64Zip = () => buildZip([
  {name: "00000001-PHOTO-2024-05-20-10-00-00.jpg", data: PNG, zip64: true},
  {name: "_chat.txt", data: TRUNCATED_CHAT, zip64: true},
]);

export const asFile = (bytes, name = "WhatsApp Chat - Test.zip") =>
  new File([bytes], name, {type: "application/zip"});
