// Shared helpers and constants: formatting, escaping, palettes, mime types.

export const CHUNK = 200;
export const PALETTE = ["#53bdeb","#e542a3","#fb6533","#ffbc38","#8b7add","#27eba7","#f26aff","#00a884"];
export const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

export const $ = id => document.getElementById(id);

/* Inline icons rather than emoji: a glyph's look is up to the platform's
   font, so the same character lands as a flat outline on one machine and a
   full-colour cartoon on the next. These carry their own size and inherit
   the surrounding text colour; .icn in the stylesheet sets the stroke. */
const icon = (size, paths) =>
  `<svg class="icn" viewBox="0 0 24 24" width="${size}" height="${size}">${paths}</svg>`;

export const ICON = {
  call:    icon(17, '<path d="M8.4 4.3l2.1 3.6-1.9 2a10 10 0 0 0 5.5 5.5l2-1.9 3.6 2.1v3.1c0 .9-.8 1.6-1.7 1.5A16 16 0 0 1 3.8 5.9c-.1-.9.6-1.7 1.5-1.7z"/>'),
  video:   icon(17, '<rect x="3" y="6.5" width="12.5" height="11" rx="2.5"/><path d="M15.5 10.8l5.2-3v8.4l-5.2-3z"/>'),
  blocked: icon(17, '<circle cx="12" cy="12" r="8.2"/><path d="M6.2 6.2l11.6 11.6"/>'),
  warn:    icon(17, '<path d="M12 4.2l9 15.6H3z"/><path d="M12 10.2v4.1"/><circle cx="12" cy="17" r=".9" fill="currentColor" stroke="none"/>'),
  mic:     icon(17, '<rect x="9.4" y="2.8" width="5.2" height="10.4" rx="2.6"/><path d="M6 11.2a6 6 0 0 0 12 0M12 17.2v3.5"/>'),
  person:  icon(24, '<circle cx="12" cy="8" r="3.6"/><path d="M4.8 20.2c0-3.7 3.2-5.6 7.2-5.6s7.2 1.9 7.2 5.6"/>'),
  doc:     icon(24, '<path d="M6.5 3h7.2l4.8 4.8V21H6.5z"/><path d="M13.7 3v4.8h4.8M9.5 12.5h5M9.5 16h5"/>'),
};

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
