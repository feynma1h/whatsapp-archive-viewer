// Read-only zip reader over a browser File/Blob: parses the central
// directory (with zip64 support) and decompresses entries on demand via the
// native DecompressionStream — nothing is uploaded or fully loaded.
//
// Some WhatsApp exports declare more entries than their (truncated) central
// directory actually contains; the orphaned entries — typically the newest
// media plus `_chat.txt` itself — are still physically present, so salvage()
// walks the raw local file headers to recover them.

const td = new TextDecoder();

export class LocalZip {
  constructor(file){
    this.file = file;
    this.entries = new Map();
    this.salvaged = 0;
  }

  async bytes(off, len){
    return await this.file.slice(off, Math.min(off + len, this.file.size)).arrayBuffer();
  }

  /** Cheap peek at a zip's entry names (index only — no salvage, no
   *  decompression). Used to decide whether a zip looks like an export. */
  static async indexNames(file){
    const z = new LocalZip(file);
    await z.parseIndex();
    return [...z.entries.keys()];
  }

  async init(progress){
    progress && progress("Reading archive index…");
    await this.parseIndex();
    if (this.declared > this.entries.size){
      progress && progress("Archive index is damaged — recovering lost entries…");
      try { await this.salvage(progress); } catch (err) { /* keep what we have */ }
    }
  }

  async parseIndex(){
    const size = this.file.size;
    const tlen = Math.min(size, 131072), tbase = size - tlen;
    const tail = await this.bytes(tbase, tlen);
    const tv = new DataView(tail);
    let e = -1;
    for (let i = tail.byteLength - 22; i >= 0; i--)
      if (tv.getUint32(i, true) === 0x06054b50){ e = i; break; }
    if (e < 0) throw new Error("this file is not a zip archive");
    let count = tv.getUint16(e+10, true);
    let cdSize = tv.getUint32(e+12, true);
    let cdOff = tv.getUint32(e+16, true);
    if (e >= 20 && tv.getUint32(e-20, true) === 0x07064b50){          // zip64 locator
      const z64off = Number(tv.getBigUint64(e-12, true));
      const z = new DataView(await this.bytes(z64off, 56));
      if (z.getUint32(0, true) === 0x06064b50){
        count = Number(z.getBigUint64(32, true));
        cdSize = Number(z.getBigUint64(40, true));
        cdOff = Number(z.getBigUint64(48, true));
      }
    }
    this.cdOff = cdOff;

    const cd = await this.bytes(cdOff, cdSize + 64);
    const dv = new DataView(cd);
    let p = 0;
    while (p + 46 <= cd.byteLength && dv.getUint32(p, true) === 0x02014b50){
      const method = dv.getUint16(p+10, true);
      const crc = dv.getUint32(p+16, true);
      let csize = dv.getUint32(p+20, true), usize = dv.getUint32(p+24, true);
      const nlen = dv.getUint16(p+28, true);
      const elen = dv.getUint16(p+30, true);
      const clen = dv.getUint16(p+32, true);
      let hoff = dv.getUint32(p+42, true);
      const name = td.decode(new Uint8Array(cd, p+46, nlen));
      let q = p + 46 + nlen;
      const qe = q + elen;
      while (q + 4 <= qe){                                            // zip64 extra field
        const id = dv.getUint16(q, true), sz = dv.getUint16(q+2, true);
        if (id === 1){
          let r = q + 4;
          if (usize === 0xFFFFFFFF){ usize = Number(dv.getBigUint64(r, true)); r += 8; }
          if (csize === 0xFFFFFFFF){ csize = Number(dv.getBigUint64(r, true)); r += 8; }
          if (hoff === 0xFFFFFFFF){ hoff = Number(dv.getBigUint64(r, true)); r += 8; }
        }
        q += 4 + sz;
      }
      this.entries.set(name, {name, method, csize, usize, crc, hoff});
      p += 46 + nlen + elen + clen;
    }
    this.declared = count;
  }

  async salvage(progress){
    let start = 0;
    for (const en of this.entries.values())
      start = Math.max(start, en.hoff + (en.csize || 0));
    const span = Math.max(1, this.cdOff - start);
    let off = await this.findSig(start, this.cdOff);
    while (off !== null && off + 30 < this.cdOff){
      // recovery walks the whole archive, so on a multi-gigabyte export this
      // is a long job — say so rather than sitting on a silent spinner
      progress && progress("Recovering lost entries… " +
        Math.min(99, Math.floor((off - start) / span * 100)) + "%");
      const hdr = new DataView(await this.bytes(off, 30));
      if (hdr.getUint32(0, true) !== 0x04034b50) return;
      const flags = hdr.getUint16(6, true), method = hdr.getUint16(8, true);
      const crc = hdr.getUint32(14, true);
      let csize = hdr.getUint32(18, true), usize = hdr.getUint32(22, true);
      const nlen = hdr.getUint16(26, true), elen = hdr.getUint16(28, true);
      const name = td.decode(new Uint8Array(await this.bytes(off+30, nlen)));
      const dataOff = off + 30 + nlen + elen;
      // "sizes written later" applies to stored entries too, not just deflated
      // ones — without this their csize stays 0 and they read back empty
      const deferred = (flags & 8) !== 0;
      if ((method === 8 && (csize === 0 || deferred)) || (method === 0 && deferred)){
        const d = await this.findDescriptor(dataOff, this.cdOff);
        if (!d) return;
        csize = d.csize; usize = d.usize;
      } else if (method !== 0 && method !== 8) return;
      if (!this.entries.has(name)){
        this.entries.set(name, {name, method, csize, usize, crc, dataOff});
        this.salvaged++;
      }
      off = await this.findSig(dataOff + Math.max(csize, 1), this.cdOff);
    }
  }

  // Usually called with `start` already sitting on the next header, so it
  // opens with a small read and only widens if the signature isn't right
  // there — reading 8MB to look at four bytes is most of the cost of walking
  // a large archive.
  async findSig(start, end){
    const MAX = 8 << 20;
    let tail = new Uint8Array(0), pos = start, ch = 65536;
    while (pos < end){
      const chunk = new Uint8Array(await this.bytes(pos, Math.min(ch, end - pos)));
      if (!chunk.length) return null;
      ch = Math.min(MAX, ch * 4);
      const buf = new Uint8Array(tail.length + chunk.length);
      buf.set(tail); buf.set(chunk, tail.length);
      // hop between 0x50 bytes with the engine's own search rather than
      // testing every offset in JS — the scan covers the whole archive
      for (let i = buf.indexOf(0x50); i >= 0 && i + 4 <= buf.length;
           i = buf.indexOf(0x50, i + 1))
        if (buf[i+1] === 0x4b && buf[i+2] === 3 && buf[i+3] === 4)
          return pos - tail.length + i;
      tail = buf.slice(-3);
      pos += chunk.length;
    }
    return null;
  }

  // A data descriptor's csize field points exactly back to the entry's data
  // start — a self-validating way to find where a "sizes written later"
  // entry ends without decompressing it.
  //
  // Signed descriptors are looked for first, in their own pass: they carry a
  // marker the engine can search for natively, which is far cheaper than
  // inspecting every offset, and they are what real exports write. The
  // unsigned form has no marker, so it only gets the exhaustive pass if the
  // cheap one comes up empty.
  async findDescriptor(dataOff, limit){
    const CH = 8 << 20, OVER = 28;

    for (let base = dataOff; base < limit; base += CH - OVER){
      const u = new Uint8Array(await this.bytes(base, Math.min(CH, limit - base)));
      const dv = new DataView(u.buffer);
      for (let i = u.indexOf(0x50); i >= 0 && i + 16 <= u.length;
           i = u.indexOf(0x50, i + 1)){
        if (dv.getUint32(i, true) !== 0x08074b50) continue;
        const dist = base + i - dataOff;
        if (dv.getUint32(i+8, true) === dist && await this.validNext(base + i + 16))
          return {csize: dist, usize: dv.getUint32(i+12, true)};
      }
    }

    for (let base = dataOff; base < limit; base += CH - OVER){
      const u = new Uint8Array(await this.bytes(base, Math.min(CH, limit - base)));
      const dv = new DataView(u.buffer);
      const n = u.length - 12;
      for (let i = 0; i < n; i++){
        const dist = base + i - dataOff;
        // one-byte check first: the full read only happens on a real candidate
        if (dist <= 0 || u[i+4] !== (dist & 0xff)) continue;
        if (dv.getUint32(i+4, true) === dist && await this.validNext(base + i + 12))
          return {csize: dist, usize: dv.getUint32(i+8, true)};
      }
    }
    return null;
  }

  async validNext(pos){
    if (pos === this.cdOff) return true;
    if (pos > this.cdOff) return false;
    const v = new DataView(await this.bytes(pos, 4));
    const sig = v.getUint32(0, true);
    return sig === 0x04034b50 || sig === 0x02014b50;
  }

  async entryBlob(name, type){
    const en = this.entries.get(name);
    if (!en) throw new Error("not in archive");
    let dataOff = en.dataOff;
    if (dataOff === undefined){
      const h = new DataView(await this.bytes(en.hoff, 30));
      dataOff = en.hoff + 30 + h.getUint16(26, true) + h.getUint16(28, true);
    }
    const comp = this.file.slice(dataOff, dataOff + en.csize);
    if (en.method === 0) return comp.slice(0, comp.size, type || "");
    const stream = comp.stream().pipeThrough(new DecompressionStream("deflate-raw"));
    const blob = await new Response(stream).blob();
    return blob.slice(0, blob.size, type || "");
  }
}
