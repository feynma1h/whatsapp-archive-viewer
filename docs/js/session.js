// Data layer. A "session" is one opened chat, with a uniform interface the
// UI renders against, in either of two modes:
//   - serverSession: the local Python server scans a folder and serves
//     messages/media over its HTTP API
//   - localSession:  a File the user picked, read entirely in the browser
//     (zip parse + decompression client-side; media as object URLs)

import { api, MIME, extOf } from "./util.js";
import { LocalZip } from "./zip.js";
import { buildChatIndex } from "./chatparse.js";

export function serverSession(archive, meta){
  const base = `/api/chat/${archive.id}`;
  return {
    meta,
    async messages(start, count){
      return (await api(`${base}/messages?start=${start}&count=${count}`)).items;
    },
    async search(q){ return api(`${base}/search?q=${encodeURIComponent(q)}`); },
    async mediaURL(name){ return `${base}/media/${encodeURIComponent(name)}`; },
    async downloadURL(name){ return {url: `${base}/media/${encodeURIComponent(name)}?dl=1`}; },
    close(){},
  };
}

const localOpen = new Map();          // archive id -> {zip, index, urls, urlBytes}
// Decompressed media is held as object URLs. Phones and tablets get a much
// smaller budget: a mobile browser discards a tab that leans on memory, and
// re-reading a photo from the zip costs milliseconds.
const URL_CACHE_BYTES =
  matchMedia("(pointer:coarse)").matches ? 120 * 1024 * 1024 : 500 * 1024 * 1024;

export async function localSession(archive, progress){
  let box = localOpen.get(archive.id);
  if (!box){
    const zip = new LocalZip(archive.file);
    await zip.init(progress);
    let txtName = "_chat.txt";
    if (!zip.entries.has(txtName)){
      txtName = [...zip.entries.keys()].find(n => n.toLowerCase().endsWith(".txt"));
      if (!txtName) throw new Error("this export has no chat text file — it only contains media");
    }
    progress && progress("Reading messages…");
    let text = await (await zip.entryBlob(txtName, "text/plain")).text();
    text = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    progress && progress("Indexing messages…");
    const index = buildChatIndex(text, archive.chat);
    box = {zip, index, urls: new Map(), urlBytes: 0};
    localOpen.set(archive.id, box);
    for (const [oldId, old] of localOpen){
      if (localOpen.size <= 2) break;
      if (oldId !== archive.id){
        old.urls.forEach(u => URL.revokeObjectURL(u.url));
        localOpen.delete(oldId);
      }
    }
  }
  const {zip, index} = box;
  const meta = {
    chat: archive.chat, count: index.count,
    senders: index.senders.map((n, i) => ({n, c: index.senderCounts[i]})),
    mediaCount: Math.max(0, zip.entries.size - 1),
    recovered: zip.salvaged, days: index.days,
    first: index.first, last: index.last,
  };
  async function mediaURL(name){
    const hit = box.urls.get(name);
    if (hit){ box.urls.delete(name); box.urls.set(name, hit); return hit.url; }
    const blob = await zip.entryBlob(name, MIME[extOf(name)] || "application/octet-stream");
    const url = URL.createObjectURL(blob);
    box.urls.set(name, {url, size: blob.size});
    box.urlBytes += blob.size;
    while (box.urlBytes > URL_CACHE_BYTES && box.urls.size > 1){
      const [n0, u0] = box.urls.entries().next().value;
      URL.revokeObjectURL(u0.url);
      box.urls.delete(n0);
      box.urlBytes -= u0.size;
    }
    return url;
  }
  return {
    meta,
    async messages(start, count){
      const end = Math.min(index.count, start + count);
      const items = [];
      for (let i = start; i < end; i++) items.push(index.messageAt(i));
      return items;
    },
    async search(q){ return index.search(q); },
    mediaURL,
    async downloadURL(name){ return {url: await mediaURL(name), download: name}; },
    close(){},
  };
}
