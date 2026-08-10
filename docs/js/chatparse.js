// WhatsApp `_chat.txt` parsing: builds a compact per-message index over the
// raw text and classifies messages on demand (text / media / system / call /
// deleted), including WhatsApp's invisible LRM markers and the
// "caption ‎image omitted" form used when media wasn't included in an export.

const LRM_RE = /[\u200e\u200f]/g;
const ATTACH_RE = /<attached:\s*([^>]+?)\s*>/;
const OMIT_MARK_RE = /\u200e(image|video|audio|sticker|GIF|document|Contact card) omitted/i;
const OMITTED_RE = /^(?:image|video|audio|sticker|GIF|document|Contact card) omitted$/i;
const CALL_RE = /^(?:Missed voice call|Missed video call|Voice call|Video call|Call declined|No answer|Silenced call)\b/i;
const DELETED_RE = /^(?:This message was deleted\.?|You deleted this message\.?)$/;
const EDIT_MARK = "<This message was edited>";

const trimMarks = s => s.replace(LRM_RE, "").trim();

export { ATTACH_RE };

export function buildChatIndex(text, chatName){
  const RE = /^\u200e?\[(\d{1,2})[./](\d{1,2})[./](\d{2,4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?\]\s?/gm;

  // Detect day-first vs month-first from a sample: a first number > 12 proves
  // day-first, a second number > 12 proves month-first. Ambiguous (short)
  // chats default to day-first.
  let maxA = 0, maxB = 0, n = 0;
  for (const m of text.slice(0, 800000).matchAll(RE)){
    maxA = Math.max(maxA, +m[1]); maxB = Math.max(maxB, +m[2]);
    if (++n >= 5000) break;
  }
  const monthFirst = maxA <= 12 && maxB > 12;

  const starts = [], contents = [], ts = [], snd = [], days = [];
  const senders = [], senderCounts = [], sid = new Map();
  let m, prevTs = 0, prevDay = null;
  RE.lastIndex = 0;
  while ((m = RE.exec(text)) !== null){
    const a = +m[1], b = +m[2];
    let y = +m[3];
    const day = monthFirst ? b : a, mon = monthFirst ? a : b;
    if (y < 100) y += 2000;
    let h = +m[4];
    if (m[7]) h = h % 12 + (/p/i.test(m[7]) ? 12 : 0);
    let t = Date.UTC(y, mon-1, day, h, +m[5], +(m[6]||0)) / 1000;
    if (!Number.isFinite(t)) t = prevTs;
    prevTs = t;

    let lineEnd = text.indexOf("\n", RE.lastIndex);
    if (lineEnd === -1) lineEnd = text.length;
    const colon = text.indexOf(": ", RE.lastIndex);
    let sender = "", content = RE.lastIndex;
    if (colon !== -1 && colon < lineEnd){
      sender = trimMarks(text.slice(RE.lastIndex, colon));
      content = colon + 2;
    } else {
      // "[ts] Name:" with nothing after the colon = empty/unsupported message
      const line = text.slice(RE.lastIndex, lineEnd).trimEnd();
      if (line.endsWith(":") && line.length > 1 && line.length <= 60){
        sender = trimMarks(line.slice(0, -1));
        content = lineEnd;
      }
    }
    let si = sid.get(sender);
    if (si === undefined){
      si = senders.length;
      sid.set(sender, si); senders.push(sender); senderCounts.push(0);
    }
    senderCounts[si]++;
    const idx = starts.length;
    starts.push(m.index); contents.push(content); ts.push(t); snd.push(si);
    const d = Math.floor(t / 86400);
    if (d !== prevDay){ days.push([d, idx]); prevDay = d; }
  }

  let lower = null;
  const raw = i => text.slice(contents[i],
    i+1 < starts.length ? starts[i+1] : text.length).replace(/\n+$/, "");

  return {
    count: starts.length, senders, senderCounts, days, ts, chatName,
    first: ts[0] || 0, last: ts[ts.length-1] || 0,

    messageAt(i){
      let r = raw(i);
      const item = {i, ts: ts[i], s: snd[i]};
      const hadLrm = /^[\u200e\u200f]/.test(r);
      if (r.includes(EDIT_MARK)){
        r = r.replace("\u200e"+EDIT_MARK, "").replace(EDIT_MARK, "");
        item.e = 1;
      }
      const att = ATTACH_RE.exec(r);
      const omit = att ? null : OMIT_MARK_RE.exec(r);
      const clean = trimMarks(r.replace(ATTACH_RE, ""));
      if (att){
        item.k = 1; item.a = att[1];
        if (clean) item.t = clean;
      } else if (omit || OMITTED_RE.test(clean)){
        item.k = 1;
        item.mt = omit ? omit[1].toLowerCase() + " omitted" : clean;
        if (omit){
          const cap = trimMarks(r.replace(OMIT_MARK_RE, ""));
          if (cap) item.t = cap;
        }
      } else if (DELETED_RE.test(clean)){ item.k = 4; item.t = clean; }
      else if (CALL_RE.test(clean)){ item.k = 3; item.t = clean; }
      else if (hadLrm || !senders[snd[i]]){ item.k = 2; item.t = clean; }
      else { item.k = 0; item.t = clean; }
      return item;
    },

    search(q, limit = 500){
      if (lower === null) lower = text.toLowerCase();
      q = q.toLowerCase();
      const out = []; let pos = 0, truncated = false;
      while (true){
        pos = lower.indexOf(q, pos);
        if (pos === -1) break;
        let lo = 0, hi = starts.length - 1, idx = 0;
        while (lo <= hi){
          const mid = (lo+hi) >> 1;
          if (starts[mid] <= pos){ idx = mid; lo = mid+1; } else hi = mid-1;
        }
        if (pos < contents[idx]){ pos += Math.max(q.length, 1); continue; }
        if (out.length >= limit){ truncated = true; break; }
        const body = trimMarks(raw(idx).replace(ATTACH_RE, "")).replace(/\s+/g, " ");
        const l = body.toLowerCase().indexOf(q);
        let snip;
        if (l === -1) snip = body.slice(0, 90);
        else {
          const a = Math.max(0, l-45), b = Math.min(body.length, l+q.length+45);
          snip = (a ? "…" : "") + body.slice(a, b) + (b < body.length ? "…" : "");
        }
        out.push({i: idx, ts: ts[idx], s: snd[idx], snip});
        pos = idx+1 < starts.length ? starts[idx+1] : lower.length;
      }
      return {results: out, truncated};
    },
  };
}
