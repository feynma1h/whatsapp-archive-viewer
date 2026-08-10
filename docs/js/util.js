// Shared helpers and constants: formatting, escaping, palettes, mime types.

export const CHUNK = 200;
export const PALETTE = ["#53bdeb","#e542a3","#fb6533","#ffbc38","#8b7add","#27eba7","#f26aff","#00a884"];
export const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

export const $ = id => document.getElementById(id);

export const esc = s => s.replace(/[&<>"']/g,
  c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

export const fmtSize = n => n > 9e8 ? (n/1073741824).toFixed(1)+" GB"
  : n > 9e5 ? (n/1048576).toFixed(0)+" MB" : Math.max(1, n/1024|0)+" KB";

export const dayOf = ts => Math.floor(ts / 86400);

export function fmtTime(ts){
  const d = new Date(ts*1000);
  let h = d.getUTCHours(); const ap = h >= 12 ? "pm" : "am"; h = h % 12 || 12;
  return h + ":" + String(d.getUTCMinutes()).padStart(2,"0") + " " + ap;
}

export function fmtDay(ts){
  const d = new Date(ts*1000);
  return d.getUTCDate() + " " + MONTHS[d.getUTCMonth()] + " " + d.getUTCFullYear();
}

export function toast(msg){
  const t = $("toast"); t.textContent = msg; t.style.display = "block";
  clearTimeout(toast._t); toast._t = setTimeout(() => t.style.display = "none", 3500);
}

export async function api(path){
  const r = await fetch(path);
  if (!r.ok){
    let m = "request failed";
    try { m = (await r.json()).error || m } catch (e) {}
    throw new Error(m);
  }
  return r.json();
}

// exports carry no profile pictures, so avatars are neutral colored initials
export function avatarFor(name, el){
  let hash = 0; for (const c of name) hash = (hash*31 + c.codePointAt(0)) >>> 0;
  el.style.background = PALETTE[hash % PALETTE.length] + "55";
  el.textContent = name.replace(/[^\p{L}\p{N} ]/gu,"").trim().split(/\s+/)
                     .slice(0,2).map(w => w[0]||"").join("").toUpperCase() || "#";
}

export function linkify(escaped){
  return escaped.replace(/(https?:\/\/[^\s<]+[^\s<.,)\]!?])/g,
    '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

export function markify(escaped, q){
  if (!q) return escaped;
  const lower = escaped.toLowerCase(), ql = esc(q).toLowerCase();
  let out = "", pos = 0;
  while (true){
    const i = lower.indexOf(ql, pos);
    if (i === -1 || !ql){ out += escaped.slice(pos); break; }
    out += escaped.slice(pos, i) + "<mark>" + escaped.slice(i, i+ql.length) + "</mark>";
    pos = i + ql.length;
  }
  return out;
}

export const emojiOnly = t => {
  const s = t.replace(/[‍️\s\u{1f3fb}-\u{1f3ff}]/gu,"");
  return s && [...s].length <= 6 && /^\p{Extended_Pictographic}+$/u.test(s);
};

export const MIME = {
  jpg:"image/jpeg", jpeg:"image/jpeg", png:"image/png", webp:"image/webp",
  gif:"image/gif", heic:"image/heic", mp4:"video/mp4", mov:"video/quicktime",
  "3gp":"video/3gpp", opus:"audio/ogg", ogg:"audio/ogg", mp3:"audio/mpeg",
  m4a:"audio/mp4", aac:"audio/aac", wav:"audio/wav", pdf:"application/pdf",
  vcf:"text/vcard", txt:"text/plain",
};

export const extOf = name =>
  name.includes(".") ? name.slice(name.lastIndexOf(".")+1).toLowerCase() : "";
