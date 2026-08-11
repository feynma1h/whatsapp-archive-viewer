// UI: sidebar, chat rendering, scrolling, search, calendar, lightbox.
// Chat data flows exclusively through a session (see session.js), so the UI
// is identical in server mode and fully-client-side mode; the zip module is
// touched directly only to sniff files during folder ingestion.

import {
  $, CHUNK, PALETTE, esc, fmtSize, dayOf, fmtTime, fmtDay, toast,
  avatarFor, linkify, markify, emojiOnly, MONTHS, api,
} from "./util.js";
import { serverSession, localSession } from "./session.js";
import { LocalZip } from "./zip.js";

const state = {
  archives: [], current: null, session: null, meta: null, me: "",
  chunks: new Map(), byIndex: new Map(), loadingChunks: new Set(),
  query: "", results: [], rpos: -1, openToken: 0, serverMode: false,
};
const scroller = $("scroller"), msgsEl = $("msgs");

/* ========================== sidebar / modes ========================== */
async function initApp(){
  let server = null;
  try {
    const r = await fetch("/api/archives");
    if (r.ok) server = await r.json();
  } catch (e) {}
  state.serverMode = !!(server && server.archives);
  if (state.serverMode){
    state.archives = server.archives;
    $("emptyText").innerHTML = state.archives.length
      ? "Select a chat to start reading. Everything is read straight out of your export " +
        "<b>.zip</b> files — nothing is extracted and the archives are never modified."
      : "No export .zip files found. Put your WhatsApp export zips in the folder the " +
        "server scans (its path is printed in the terminal) and reload this page.";
    $("sideFoot").textContent = state.archives.length
      ? state.archives.length + " archive" + (state.archives.length>1?"s":"") + " found · served straight from the zips"
      : "No WhatsApp export .zip files found in this folder.";
    $("helpStep5").innerHTML = "Drop the <b>.zip</b> into the folder this server scans — " +
      "it appears in the sidebar after a refresh.";
  } else {
    $("emptyText").innerHTML = "WhatsApp filling up your phone? Export your chats, keep the " +
      "<b>.zip</b> files on a computer or drive, and read them here anytime — photos, videos and " +
      "voice notes included. Everything runs in your browser: <b>your files never leave this " +
      "device</b>, nothing is uploaded, and the archives are never modified.";
    $("pickBtn").style.display = "inline-block";
    $("pickFolderBtn").style.display = "inline-block";
    $("emptyNote").style.display = "block";
    $("addBtn").style.display = "block";
    $("addFolderBtn").style.display = "block";
    $("sideFoot").textContent = "No archives opened yet · everything stays on this device";
  }
  renderChatList();
  const want = location.hash.slice(1);
  const hit = state.archives.find(a => a.id === want);
  if (hit) openChat(hit);
}
function renderChatList(){
  // phones show the landing screen instead of an empty chat list
  $("app").classList.toggle("noArchives", !state.archives.length);
  const f = $("filter").value.trim().toLowerCase();
  const box = $("chats"); box.innerHTML = "";
  for (const a of state.archives){
    if (f && !a.chat.toLowerCase().includes(f)) continue;
    const el = document.createElement("div");
    el.className = "chat-item" + (state.current && state.current.id === a.id ? " active" : "");
    el.innerHTML = `<div class="avatar"></div>
      <div class="cmeta"><div class="cname"></div><div class="csub"></div></div>`;
    el.querySelector(".cname").textContent = a.chat;
    el.querySelector(".csub").textContent = (a.folder ? a.folder + " · " : "") + fmtSize(a.size);
    avatarFor(a.chat, el.querySelector(".avatar"));
    el.onclick = () => openChat(a);
    box.appendChild(el);
  }
}
$("filter").addEventListener("input", renderChatList);

/* ---- archive ingestion ----
   Individually picked files are trusted as-is. Folder scans are filtered:
   a zip is kept only if its filename matches WhatsApp's export naming OR its
   internal listing looks like an export (a cheap index-only read). */
const WA_NAME_RE = /^WhatsApp Chat( -| with)? /i;
const WA_MEDIA_RE = /^\d{8}-(PHOTO|VIDEO|AUDIO|STICKER|GIF|DOCUMENT)-/;
async function looksLikeExport(file){
  if (WA_NAME_RE.test(file.name)) return true;
  try {
    const names = await LocalZip.indexNames(file);
    return names.includes("_chat.txt") ||
           names.some(n => WA_MEDIA_RE.test(n)) ||
           names.some(n => /^WhatsApp Chat.*\.txt$/i.test(n));
  } catch (e) {
    return false;                       // not a readable zip at all
  }
}

async function ingest(entries, {sniff = false} = {}){
  entries = entries.filter(({file, rel}) =>
    /\.zip$/i.test(file.name) && !file.name.startsWith(".") &&
    !/(^|\/)__MACOSX(\/|$)/.test(rel || ""));
  entries.sort((a, b) =>
    ((a.rel || "") + "/" + a.file.name).localeCompare((b.rel || "") + "/" + b.file.name));
  let added = 0, skipped = 0, dupes = 0;
  for (const {file, rel} of entries){
    if (sniff && !(await looksLikeExport(file))){ skipped++; continue; }
    let h = 0; const key = file.name + "|" + file.size + "|" + file.lastModified;
    for (const c of key) h = (h*31 + c.codePointAt(0)) >>> 0;
    const id = "local-" + h.toString(36);
    if (state.archives.some(a => a.id === id)){ dupes++; continue; }
    state.archives.push({
      id, file, size: file.size, folder: rel || "",
      chat: file.name.replace(/\.zip$/i, "").replace(/^WhatsApp Chat (?:- |with )?/, "").trim() || file.name,
    });
    added++;
  }
  if (added){
    renderChatList();
    $("sideFoot").textContent = state.archives.length + " archive" +
      (state.archives.length>1?"s":"") + " opened · everything stays on this device";
    if (!state.current && state.archives.length === added) openChat(state.archives[0]);
  }
  if (skipped)
    toast(`Skipped ${skipped} zip${skipped>1?"s":""} that ${skipped>1?"don't":"doesn't"} look like WhatsApp exports`);
  else if (!added && dupes)
    toast("Those archives are already open");
  else if (!added && !entries.length)
    toast("Pick the WhatsApp export .zip files");
  return {added, skipped, dupes};
}
function addLocalArchives(files){
  return ingest([...files].map(f => ({file: f, rel: ""})));
}

/* folder drag-and-drop traversal (readEntries returns batches of ≤100) */
function readAllEntries(reader){
  return new Promise((resolve, reject) => {
    const all = [];
    const step = () => reader.readEntries(batch => {
      if (!batch.length) return resolve(all);
      all.push(...batch);
      step();
    }, reject);
    step();
  });
}
async function traverseEntry(entry, path, out){
  // path === null marks a top-level entry: a dropped folder's own name is
  // not part of the labels, mirroring how the folder input treats its root
  if (entry.isFile){
    const file = await new Promise((res, rej) => entry.file(res, rej));
    out.push({file, rel: path || ""});
  } else if (entry.isDirectory){
    const sub = path === null ? "" : (path ? path + "/" : "") + entry.name;
    for (const child of await readAllEntries(entry.createReader()))
      await traverseEntry(child, sub, out);
  }
}

$("pickBtn").onclick = $("addBtn").onclick = () => $("fileInput").click();
$("pickFolderBtn").onclick = $("addFolderBtn").onclick = () => $("folderInput").click();
$("fileInput").addEventListener("change", e => { addLocalArchives(e.target.files); e.target.value = ""; });
$("folderInput").addEventListener("change", e => {
  const entries = [...e.target.files].map(f => {
    const parts = (f.webkitRelativePath || "").split("/");
    return {file: f, rel: parts.slice(1, -1).join("/")};
  });
  ingest(entries, {sniff: true});
  e.target.value = "";
});
window.addEventListener("dragover", e => {
  if (state.serverMode) return;
  e.preventDefault(); $("dropOverlay").style.display = "flex";
});
window.addEventListener("dragleave", e => {
  if (e.relatedTarget === null) $("dropOverlay").style.display = "none";
});
window.addEventListener("drop", async e => {
  if (state.serverMode) return;
  e.preventDefault(); $("dropOverlay").style.display = "none";
  // grab entries synchronously — DataTransferItems are gone after an await
  const items = e.dataTransfer.items ? [...e.dataTransfer.items] : [];
  const entries = items.map(it => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean);
  const plainFiles = [...e.dataTransfer.files];
  if (!entries.length) return addLocalArchives(plainFiles);
  const hadFolder = entries.some(en => en.isDirectory);
  const out = [];
  for (const en of entries) await traverseEntry(en, null, out);
  ingest(out, {sniff: hadFolder});
});

/* ========================== me detection ========================== */
const norm = s => s.normalize("NFKD").replace(/[^\p{L}\p{N}]/gu,"").toLowerCase();
function pickMe(meta, aid){
  const saved = localStorage.getItem("me:" + aid);
  const names = meta.senders.map(x => x.n).filter(Boolean);
  if (saved !== null && (saved === "" || names.includes(saved))) return saved;
  const others = names.filter(n => norm(n) !== norm(meta.chat));
  if (names.length === 2 && others.length === 1) return others[0];
  const g = localStorage.getItem("me");
  if (g && names.includes(g)) return g;
  return "";
}

/* ========================== open chat ========================== */
async function openChat(a){
  const token = ++state.openToken;
  state.current = a; renderChatList();
  location.hash = a.id;
  $("app").classList.add("chatOpen");
  $("empty").style.display = "none";
  $("chatview").classList.add("on");
  closeSearch(true);
  closeCal();
  stickBottom = false; anchorIdx = null;
  $("dateFloat").classList.remove("on");
  $("spinText").textContent = "Opening chat…";
  $("spin").classList.add("on");
  state.chunks.clear(); state.byIndex.clear(); state.loadingChunks.clear();
  msgsEl.innerHTML = "";
  try{
    if (state.session) state.session.close();
    const progress = msg => { if (token === state.openToken) $("spinText").textContent = msg; };
    let session;
    if (state.serverMode){
      const meta = await api(`/api/chat/${a.id}/meta`);
      session = serverSession(a, meta);
    } else {
      session = await localSession(a, progress);
    }
    if (token !== state.openToken) return;
    state.session = session;
    state.meta = session.meta;
    state.me = pickMe(session.meta, a.id);
    renderHeader(a, session.meta);
    const lastChunk = Math.max(0, Math.ceil(session.meta.count / CHUNK) - 1);
    await loadChunkSeq([lastChunk, lastChunk - 1], token);
    if (token !== state.openToken) return;
    stickBottom = true;
    pinBottom();
    await fillViewport(token);
    pinBottom();
  }catch(e){
    if (token === state.openToken) toast("Could not open chat: " + e.message);
  }finally{
    if (token === state.openToken) $("spin").classList.remove("on");
  }
}
function renderHeader(a, meta){
  $("hName").textContent = a.chat;
  avatarFor(a.chat, $("hAvatar"));
  const parts = meta.senders.filter(s => s.n).length;
  $("hSub").textContent =
    meta.count.toLocaleString() + " messages · " +
    meta.mediaCount.toLocaleString() + " media" +
    (parts > 2 ? " · " + parts + " participants" : "") +
    " · " + fmtDay(meta.first) + " – " + fmtDay(meta.last) +
    (meta.recovered ? " · ⚠︎ " + meta.recovered + " entries recovered from damaged zip index" : "");
  const sel = $("meSelect");
  sel.innerHTML = '<option value="">You: not set</option>' +
    meta.senders.filter(s => s.n).map(s =>
      `<option value="${esc(s.n)}"${s.n === state.me ? " selected" : ""}>You: ${esc(s.n)}</option>`).join("");
}
$("meSelect").addEventListener("change", e => {
  state.me = e.target.value;
  localStorage.setItem("me:" + state.current.id, state.me);
  if (state.me) localStorage.setItem("me", state.me);
  rerenderAll();
});

/* ---- leaving a chat ----
   Reached from the header back button (phones) or the browser's own
   back/forward — openChat pushes the chat id onto the hash, so history
   already distinguishes list and chat. */
function closeChat(){
  state.openToken++;                     // cancels any open still in flight
  if (state.session){ state.session.close(); state.session = null; }
  state.current = null; state.meta = null;
  state.chunks.clear(); state.byIndex.clear(); state.loadingChunks.clear();
  msgsEl.innerHTML = "";
  closeSearch(true); closeCal();
  stickBottom = false; anchorIdx = null;
  $("dateFloat").classList.remove("on");
  $("toBottom").classList.remove("on");
  $("spin").classList.remove("on");
  $("chatview").classList.remove("on");
  $("empty").style.display = "";
  $("app").classList.remove("chatOpen");
  renderChatList();
}
$("btnBack").onclick = () => {
  closeChat();
  // swap this entry for a hash-less one so back doesn't re-open the chat
  history.replaceState(null, "", location.pathname + location.search);
};
window.addEventListener("hashchange", () => {
  const id = location.hash.slice(1);
  if (state.current && state.current.id === id) return;
  const hit = state.archives.find(a => a.id === id);
  if (hit) openChat(hit);
  else if (state.current) closeChat();
});

/* ==================== chunk loading & rendering ==================== */
function chunkCount(){ return Math.max(1, Math.ceil(state.meta.count / CHUNK)); }
function loadedRange(){
  const keys = [...state.chunks.keys()];
  return keys.length ? [Math.min(...keys), Math.max(...keys)] : [null, null];
}
async function loadChunkSeq(list, token){
  for (const c of list) await loadChunk(c, token);
}
async function loadChunk(c, token){
  if (!state.meta || c < 0 || c >= chunkCount()) return;
  if (state.chunks.has(c) || state.loadingChunks.has(c)) return;
  state.loadingChunks.add(c);
  try{
    const items = await state.session.messages(c*CHUNK, CHUNK);
    if (token !== state.openToken || state.chunks.has(c)) return;
    for (const m of items) state.byIndex.set(m.i, m);
    const el = document.createElement("div");
    el.dataset.c = c;
    el.innerHTML = chunkHTML(c, items);
    insertChunk(c, el);
  } finally { state.loadingChunks.delete(c); }
}
function insertChunk(c, el){
  let before = null;
  for (const child of msgsEl.children){
    if (+child.dataset.c > c){ before = child; break; }
  }
  const above = before !== null || msgsEl.children.length === 0;
  const st = scroller.scrollTop, h0 = scroller.scrollHeight;
  msgsEl.insertBefore(el, before);
  state.chunks.set(c, el);
  watchMedia(el);
  if (state.chunks.has(c + 1)) fixBoundary(c + 1);
  if (above && msgsEl.children.length > 1){
    markAuto();
    scroller.scrollTop = st + (scroller.scrollHeight - h0);
  }
}
function fixBoundary(c){
  const el = state.chunks.get(c), prev = state.byIndex.get(c*CHUNK - 1), cur = state.byIndex.get(c*CHUNK);
  if (!el || !prev || !cur) return;
  const first = el.firstElementChild;
  if (first && first.classList.contains("day") && dayOf(prev.ts) === dayOf(cur.ts)){
    first.remove();
    const row = el.firstElementChild;
    if (row && row.classList.contains("row") && grouped(prev, cur)){
      row.classList.add("cont");
      const s = row.querySelector(".sender"); if (s) s.remove();
    }
  }
}
function grouped(prev, cur){
  return prev && cur && prev.s === cur.s && prev.k !== 2 && cur.k !== 2 &&
         dayOf(prev.ts) === dayOf(cur.ts) && (cur.ts - prev.ts) < 420;
}
function chunkHTML(c, items){
  let html = "";
  for (const m of items){
    const prev = state.byIndex.get(m.i - 1);
    if (!prev || dayOf(prev.ts) !== dayOf(m.ts))
      html += `<div class="day"><span>${fmtDay(m.ts)}</span></div>` + msgHTML(m, null);
    else
      html += msgHTML(m, prev);
  }
  return html;
}
function msgHTML(m, prev){
  const sender = state.meta.senders[m.s] ? state.meta.senders[m.s].n : "";
  if (m.k === 2)
    return `<div class="sys" data-i="${m.i}"><span>${linkify(esc(m.t || ""))}</span></div>`;

  const mine = state.me && sender === state.me;
  const cont = grouped(prev, m);
  const groupChat = state.meta.senders.filter(s => s.n).length > 2;
  const showName = !mine && groupChat && !cont && sender;
  const color = PALETTE[m.s % PALETTE.length];
  const meta = `<span class="meta">${m.e ? "<i>edited</i> · " : ""}${fmtTime(m.ts)}</span>`;
  let body = "", extraCls = "";

  if (m.k === 4){
    extraCls = " deleted";
    body = `<div class="btext">🚫 ${esc(m.t)}${meta}</div>`;
  } else if (m.k === 3){
    const ic = /video/i.test(m.t) ? "📹" : "📞";
    body = `<div class="call"><span class="ic">${ic}</span>${esc(m.t)}${meta}</div>`;
  } else if (m.k === 1){
    body = mediaHTML(m, meta);
    if (body === null) return stickerHTML(m, cont, mine, showName, color, sender);
  } else {
    const jumbo = emojiOnly(m.t) ? " jumbo" : "";
    let t = esc(m.t);
    t = state.query ? markify(t, state.query) : linkify(t);
    body = `<div class="btext${jumbo}">${t}${meta}</div>`;
  }
  return `<div class="row${mine ? " out" : ""}${cont ? " cont" : ""}" data-i="${m.i}">
    <div class="bubble${extraCls}">
      ${showName ? `<div class="sender" style="color:${color}">${esc(sender)}</div>` : ""}
      ${body}</div></div>`;
}
function mediaHTML(m, meta){
  const cap = m.t ? `<div class="btext caption">${state.query ? markify(esc(m.t), state.query) : linkify(esc(m.t))}</div>` : "";
  if (!m.a){   // media omitted from the export; any text is its caption
    return `<div class="missing">🚫 ${esc(m.mt || "media omitted")} <small>(not included in this export)</small></div>
            ${cap}<div class="btext">${meta}</div>`;
  }
  const name = m.a, enc = encodeURIComponent(name);
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")+1).toLowerCase() : "";
  const isSticker = name.includes("-STICKER-") || ext === "webp";
  if (isSticker) return null;  // rendered without a bubble
  const isGif = name.includes("-GIF-");

  if (isGif)
    return `<div class="mediaBox"><video class="gifv" autoplay muted loop playsinline
        data-m="${enc}" onerror="mediaFail(this)"></video></div>${cap}<div class="btext">${meta}</div>`;
  if (["jpg","jpeg","png","gif","heic"].includes(ext))
    return `<div class="mediaBox"><img class="photo" data-m="${enc}"
        onclick="openLightbox('${enc}',${m.i})" onerror="mediaFail(this)"
        alt=""></div>${cap}<div class="btext">${meta}</div>`;
  if (["mp4","mov","3gp"].includes(ext))
    return `<div class="mediaBox"><video class="vid" controls preload="metadata" playsinline
        data-m="${enc}" onerror="mediaFail(this)"></video></div>${cap}<div class="btext">${meta}</div>`;
  if (["opus","ogg","mp3","m4a","aac","wav"].includes(ext))
    return `<div>🎤<audio controls preload="none" data-m="${enc}"
        onerror="mediaFail(this)"></audio></div>${cap}<div class="btext">${meta}</div>`;
  if (ext === "vcf")
    return `<div class="filechip"><span class="fic">👤</span><div>
        <div class="fname">${esc(name.replace(/\.vcf$/i,""))}</div>
        <a onclick="return saveDoc('${enc}')">Save contact file</a></div></div>${cap}<div class="btext">${meta}</div>`;
  return `<div class="filechip"><span class="fic">📄</span><div>
      <div class="fname">${esc(name)}</div>
      <a onclick="return openDoc('${enc}')">Open</a> &nbsp;
      <a onclick="return saveDoc('${enc}')">Download</a></div></div>${cap}<div class="btext">${meta}</div>`;
}
function stickerHTML(m, cont, mine, showName, color, sender){
  const enc = encodeURIComponent(m.a);
  return `<div class="row${mine ? " out" : ""}${cont ? " cont" : ""}" data-i="${m.i}">
    <div class="bubble stickerwrap">
      ${showName ? `<div class="sender" style="color:${color}">${esc(sender)}</div>` : ""}
      <img class="sticker" data-m="${enc}"
           onclick="openLightbox('${enc}',${m.i})" onerror="mediaFail(this)">
      <div class="btext"><span class="meta">${fmtTime(m.ts)}</span></div></div></div>`;
}

/* media hydration: the src (and, in local mode, the decompression work) is
   only resolved when the element nears the viewport */
const hydrator = new IntersectionObserver(ents => {
  for (const en of ents)
    if (en.isIntersecting){ hydrate(en.target); hydrator.unobserve(en.target); }
}, {root: scroller, rootMargin: "700px 0px"});
function hydrate(el){
  const name = decodeURIComponent(el.dataset.m);
  const session = state.session;
  session.mediaURL(name).then(u => {
    if (!el.isConnected || state.session !== session) return;
    if (el.tagName === "VIDEO" && el.classList.contains("vid")){
      // "#t=0.1" forces a seek so the browser decodes and paints the first
      // frame as a thumbnail ("#t=0" is spec'd as the default position, so
      // some engines skip the seek and paint nothing). On the first play,
      // snap back so playback still starts from the true beginning.
      el.src = u + "#t=0.1";
      el.addEventListener("play", () => {
        if (el.currentTime > 0 && el.currentTime < 0.3) el.currentTime = 0;
      }, {once: true});
    } else {
      el.src = u;
    }
  }).catch(() => mediaFail(el));
}
function openDoc(enc){
  state.session.mediaURL(decodeURIComponent(enc)).then(u => window.open(u, "_blank", "noopener"));
  return false;
}
function saveDoc(enc){
  const name = decodeURIComponent(enc);
  state.session.downloadURL(name).then(({url, download}) => {
    const a = document.createElement("a");
    a.href = url; a.rel = "noopener";
    if (download) a.download = download;
    document.body.appendChild(a); a.click(); a.remove();
  });
  return false;
}
function mediaFail(el){
  const enc = el.dataset.m || "";
  const wrap = document.createElement("div");
  wrap.className = "missing";
  wrap.innerHTML = `⚠️ Can't preview this file` +
    (enc ? ` · <a onclick="return saveDoc('${enc}')">download original</a>` : "");
  (el.closest(".mediaBox") || el).replaceWith(wrap);
}
function rerenderAll(){
  const anchor = firstVisibleIndex();
  for (const [c, el] of state.chunks){
    const items = [];
    for (let i = c*CHUNK; i < Math.min((c+1)*CHUNK, state.meta.count); i++)
      if (state.byIndex.has(i)) items.push(state.byIndex.get(i));
    el.innerHTML = chunkHTML(c, items);
    watchMedia(el);
  }
  const [lo] = loadedRange();
  for (const c of [...state.chunks.keys()].sort((a,b)=>a-b)) if (c > lo) fixBoundary(c);
  if (anchor !== null) scrollToMsg(anchor, false);
}
function firstVisibleIndex(){
  const top = scroller.getBoundingClientRect().top;
  for (const chunk of msgsEl.children)
    for (const row of chunk.children){
      if (!row.dataset.i) continue;
      if (row.getBoundingClientRect().bottom >= top) return +row.dataset.i;
    }
  return null;
}

/* ========================== scrolling ========================== */
let stickBottom = false, autoScrollUntil = 0;
let anchorIdx = null, anchorCenter = true, anchorUntil = 0;
function markAuto(){ autoScrollUntil = performance.now() + 250; }
function pinBottom(){
  markAuto();
  scroller.scrollTop = scroller.scrollHeight;
}
// Re-assert the view target whenever layout shifts (lazy media growing in):
// pinned mode holds the newest message, anchor mode holds a jumped-to message.
function holdView(){
  if (stickBottom){ pinBottom(); return; }
  if (anchorIdx === null || performance.now() > anchorUntil) return;
  const r = msgsEl.querySelector(`[data-i="${anchorIdx}"]`);
  if (r){ markAuto(); r.scrollIntoView({block: anchorCenter ? "center" : "start"}); }
}
new ResizeObserver(holdView).observe(msgsEl);
window.addEventListener("resize", holdView);
// media growing in is the main layout-shifter: images fire "load", videos fire
// "loadedmetadata" when they learn their real height (capture — no bubbling)
for (const ev of ["load", "loadedmetadata"])
  msgsEl.addEventListener(ev, holdView, true);

// Free-scroll stability: when lazy media ABOVE the viewport grows in, shift
// scrollTop by the same amount so what's on screen doesn't move.
const mediaSizes = new WeakMap();
const mediaRO = new ResizeObserver(entries => {
  let delta = 0;
  const top = scroller.getBoundingClientRect().top;
  for (const en of entries){
    const h = en.borderBoxSize && en.borderBoxSize[0]
      ? en.borderBoxSize[0].blockSize : en.contentRect.height;
    if (!mediaSizes.has(en.target)){ mediaSizes.set(en.target, h); continue; }
    const d = h - mediaSizes.get(en.target);
    mediaSizes.set(en.target, h);
    if (d && en.target.getBoundingClientRect().bottom < top + 2) delta += d;
  }
  if (delta && !stickBottom && anchorIdx === null){
    markAuto();
    scroller.scrollTop += delta;
  }
});
function watchMedia(chunkEl){
  chunkEl.querySelectorAll("img,video,audio").forEach(m => {
    mediaRO.observe(m);
    if (m.dataset.m && !m.src) hydrator.observe(m);
  });
}

/* floating date pill: shows the date of the topmost visible message while
   the user scrolls, then fades out — like WhatsApp's hovering date chip.
   Driven by direct user input (wheel/touch/scrollbar), so programmatic pins
   and jumps never flash it. */
let pillTimer = null, pillLastCompute = 0;
let userScrollUntil = 0, scrollbarDrag = false;
function updateDatePill(){
  const now = performance.now();
  if (now - pillLastCompute > 80){                   // throttle the DOM walk
    pillLastCompute = now;
    const idx = firstVisibleIndex();
    const m = idx !== null ? state.byIndex.get(idx) : null;
    if (m) $("dateFloatPill").textContent = fmtDay(m.ts);
  }
  $("dateFloat").classList.add("on");
  clearTimeout(pillTimer);
  pillTimer = setTimeout(() => $("dateFloat").classList.remove("on"), 1200);
}

let scrollBusy = false;
scroller.addEventListener("scroll", async () => {
  if (!state.meta) return;
  const dist = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
  // only user-driven scrolling may change follow-bottom / release the anchor
  if (performance.now() >= autoScrollUntil){ stickBottom = dist < 60; anchorIdx = null; }
  if (scrollbarDrag || performance.now() < userScrollUntil){
    userScrollUntil = performance.now() + 400;   // touch momentum renews the window
    updateDatePill();
  }
  $("toBottom").classList.toggle("on", dist > 900);
  if (scrollBusy) return;
  scrollBusy = true;
  try{
    const token = state.openToken;
    const [lo, hi] = loadedRange();
    if (lo === null) return;
    if (scroller.scrollTop < 900) await loadChunk(lo - 1, token);
    if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 900)
      await loadChunk(hi + 1, token);
    prune();
  } finally { scrollBusy = false; }
});
// user input breaks follow-bottom / jump-anchoring INSTANTLY so the view
// never fights the user
scroller.addEventListener("wheel", e => {
  if (e.deltaY < 0){ stickBottom = false; anchorIdx = null; }
  userScrollUntil = performance.now() + 400;   // macOS momentum keeps firing wheel
}, {passive: true});
scroller.addEventListener("touchstart", () => { anchorIdx = null; }, {passive: true});
scroller.addEventListener("touchmove", () => {
  userScrollUntil = performance.now() + 400;
}, {passive: true});
scroller.addEventListener("mousedown", e => {
  if (e.clientX >= scroller.getBoundingClientRect().right - 20){   // scrollbar grab
    stickBottom = false; anchorIdx = null;
    scrollbarDrag = true;
  }
});
window.addEventListener("mouseup", () => {
  if (scrollbarDrag){ scrollbarDrag = false; userScrollUntil = performance.now() + 400; }
});
async function fillViewport(token){
  for (let guard = 0; guard < 30; guard++){
    if (token !== state.openToken) return;
    const [lo] = loadedRange();
    if (lo === null || lo === 0) return;
    if (scroller.scrollHeight > scroller.clientHeight + 200) return;
    await loadChunk(lo - 1, token);
  }
}
function prune(){
  while (state.chunks.size > 14){
    const [lo, hi] = loadedRange();
    const anchor = firstVisibleIndex();
    if (anchor === null) return;
    const ca = Math.floor(anchor / CHUNK);
    const c = (ca - lo >= hi - ca) ? lo : hi;
    const el = state.chunks.get(c);
    const above = c < ca;
    const h = el.offsetHeight;
    el.remove(); state.chunks.delete(c);
    for (let i = c*CHUNK; i < (c+1)*CHUNK; i++) state.byIndex.delete(i);
    if (above){ markAuto(); scroller.scrollTop -= h; }
  }
}
$("toBottom").onclick = async () => {
  await jumpTo(state.meta.count - 1, false);
  anchorIdx = null;                 // follow-bottom takes over from the anchor
  stickBottom = true;
  pinBottom();
};

/* ========================== jumping ========================== */
async function jumpTo(i, flash = true){
  const token = state.openToken;
  stickBottom = false;      // a deliberate jump leaves follow-bottom mode
  i = Math.max(0, Math.min(i, state.meta.count - 1));
  const c = Math.floor(i / CHUNK);
  if (!state.chunks.has(c)){
    msgsEl.innerHTML = "";
    state.chunks.clear(); state.byIndex.clear();
    await loadChunkSeq([c, c - 1, c + 1], token);
  } else {
    await loadChunkSeq([c - 1, c + 1], token);
  }
  if (token !== state.openToken) return;
  scrollToMsg(i, true, flash);
}
function scrollToMsg(i, center = true, flash = false){
  const row = msgsEl.querySelector(`[data-i="${i}"]`);
  if (!row) return;
  markAuto();
  row.scrollIntoView({block: center ? "center" : "start"});
  if (flash){ row.classList.remove("hl"); void row.offsetWidth; row.classList.add("hl"); }
  // hold this row in place while nearby media loads shift the layout
  anchorIdx = i; anchorCenter = center;
  anchorUntil = performance.now() + 4000;
}

/* ---- in-app calendar: opens under the 📅 button, highlights days with
   messages ---- */
const calState = {y: 0, m: 0};
function openCal(){
  const last = new Date(state.meta.last * 1000);
  calState.y = last.getUTCFullYear();
  calState.m = last.getUTCMonth();
  renderCal();
  $("calPanel").classList.add("on");
}
function closeCal(){ $("calPanel").classList.remove("on"); }
function renderCal(){
  const {y, m} = calState;
  const first = new Date(state.meta.first * 1000), last = new Date(state.meta.last * 1000);
  const key = y * 12 + m;
  $("calPrev").disabled = key <= first.getUTCFullYear() * 12 + first.getUTCMonth();
  $("calNext").disabled = key >= last.getUTCFullYear() * 12 + last.getUTCMonth();
  $("calTitle").textContent = MONTHS[m] + " " + y;
  const byDay = new Map(state.meta.days);
  const firstDow = new Date(Date.UTC(y, m, 1)).getUTCDay();
  const ndays = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  let html = ["S","M","T","W","T","F","S"].map(d => `<div class="dow">${d}</div>`).join("");
  for (let i = 0; i < firstDow; i++) html += '<div class="blank"></div>';
  for (let d = 1; d <= ndays; d++){
    const idx = byDay.get(Math.floor(Date.UTC(y, m, d) / 86400000));
    html += idx === undefined
      ? `<button disabled>${d}</button>`
      : `<button class="has" data-idx="${idx}">${d}</button>`;
  }
  $("calGrid").innerHTML = html;
}
$("calGrid").addEventListener("click", e => {
  const b = e.target.closest("button[data-idx]");
  if (!b) return;
  closeCal();
  jumpTo(+b.dataset.idx);
});
$("calPrev").onclick = () => { if (--calState.m < 0){ calState.m = 11; calState.y--; } renderCal(); };
$("calNext").onclick = () => { if (++calState.m > 11){ calState.m = 0; calState.y++; } renderCal(); };
$("btnCal").onclick = () => {
  if ($("calPanel").classList.contains("on")) closeCal();
  else if (state.meta) openCal();
};
document.addEventListener("click", e => {
  if (!e.target.closest("#calPanel") && !e.target.closest("#btnCal")) closeCal();
});

/* ========================== search ========================== */
$("btnSearch").onclick = () => {
  const bar = $("searchbar");
  bar.classList.toggle("on");
  if (bar.classList.contains("on")) $("q").focus(); else closeSearch();
};
$("qClose").onclick = () => closeSearch();
function closeSearch(silent){
  $("searchbar").classList.remove("on");
  $("q").value = ""; $("qCount").textContent = "";
  state.results = []; state.rpos = -1;
  if (state.query){ state.query = ""; if (!silent && state.meta) rerenderAll(); }
}
let qTimer = null;
$("q").addEventListener("input", () => {
  clearTimeout(qTimer);
  qTimer = setTimeout(doSearch, 350);
});
$("q").addEventListener("keydown", e => {
  if (e.key === "Enter"){ e.preventDefault(); e.shiftKey ? stepResult(1) : stepResult(-1); }
  if (e.key === "Escape") closeSearch();
});
async function doSearch(){
  const q = $("q").value.trim();
  if (!state.meta) return;
  if (!q){ state.query = ""; state.results = []; $("qCount").textContent = ""; rerenderAll(); return; }
  try{
    const d = await state.session.search(q);
    state.query = q; state.results = d.results;
    state.rpos = d.results.length - 1;               // newest first, like WhatsApp
    $("qCount").textContent = d.results.length
      ? (d.results.length + (d.truncated ? "+" : "") + " found") : "No results";
    rerenderAll();
    if (d.results.length) gotoResult();
  }catch(e){ toast("Search failed: " + e.message); }
}
function stepResult(dir){          // dir -1 = older, +1 = newer
  if (!state.results.length) return;
  state.rpos = Math.max(0, Math.min(state.results.length - 1, state.rpos + dir));
  gotoResult();
}
function gotoResult(){
  const r = state.results[state.rpos];
  $("qCount").textContent = (state.rpos + 1) + " / " + state.results.length;
  jumpTo(r.i);
}
$("qPrev").onclick = () => stepResult(-1);
$("qNext").onclick = () => stepResult(1);
// touch keyboards have no Shift+Enter — the ↑/↓ buttons step through results
if (matchMedia("(pointer:coarse)").matches)
  $("q").placeholder = "Search within chat…";

/* ========================== lightbox ========================== */
let lbName = null;
function openLightbox(enc, idx){
  const name = decodeURIComponent(enc);
  lbName = name;
  const m = state.byIndex.get(idx);
  const sender = m && state.meta.senders[m.s] ? state.meta.senders[m.s].n : "";
  $("lbInfo").textContent = (sender ? sender + " · " : "") + (m ? fmtDay(m.ts) + ", " + fmtTime(m.ts) : name);
  const body = $("lbBody"); body.innerHTML = "";
  $("lightbox").classList.add("on");
  state.session.mediaURL(name).then(u => {
    if (!$("lightbox").classList.contains("on") || lbName !== name) return;
    let el;
    if (/\.(mp4|mov|3gp)$/.test(name.toLowerCase())){
      el = document.createElement("video");
      el.controls = true; el.autoplay = true; el.playsInline = true;
    } else {
      el = document.createElement("img");
    }
    el.src = u;
    body.appendChild(el);
  });
}
$("lbDl").onclick = () => { if (lbName) saveDoc(encodeURIComponent(lbName)); };
function closeLightbox(){
  $("lightbox").classList.remove("on");
  $("lbBody").innerHTML = "";
  lbName = null;
}
$("lbClose").onclick = closeLightbox;
$("lightbox").addEventListener("click", e => {
  if (e.target === $("lightbox") || e.target === $("lbBody")) closeLightbox();
});
/* ---- "how to export" help panel ---- */
$("helpLink").onclick = () => $("helpOverlay").classList.add("on");
$("helpClose").onclick = () => $("helpOverlay").classList.remove("on");
$("helpOverlay").addEventListener("click", e => {
  if (e.target === $("helpOverlay")) $("helpOverlay").classList.remove("on");
});

document.addEventListener("keydown", e => {
  if (e.key === "Escape"){
    if ($("helpOverlay").classList.contains("on")) $("helpOverlay").classList.remove("on");
    else if ($("lightbox").classList.contains("on")) closeLightbox();
    else if ($("calPanel").classList.contains("on")) closeCal();
    else if ($("searchbar").classList.contains("on")) closeSearch();
  }
});

/* globals for the inline handlers used in rendered message HTML */
Object.assign(window, {openLightbox, openDoc, saveDoc, mediaFail});

initApp();
