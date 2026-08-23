// Voice-note player: the waveform, its transport, and the peak extraction
// behind it. WhatsApp ships a precomputed waveform inside each message; an
// export carries only the audio file, so the shape has to be measured here.

import { ICON } from "./util.js";

/* Peaks are measured once at this resolution and pooled down to whatever
   number of bars the bubble's width allows, so a window resize never costs
   another decode. */
export const PEAK_BUCKETS = 256;

/* Decoding hands back the whole recording as float PCM — around 192KB per
   second of mono 48kHz audio. A voice note runs to minutes, not hours, so
   anything past this is something else in an audio container and is left to
   play without a waveform rather than risk the tab over it. */
const MAX_DECODE_BYTES = 12 * 1024 * 1024;

const BAR = 3, GAP = 2, MIN_BAR = 2;

/* ---- pure measurement (no DOM; exercised directly by the tests) ---- */

/* Root-mean-square per bucket, then scaled so the loudest bucket reaches
   full height. Peak-per-bucket would read as a solid block: speech clips the
   top of nearly every bucket, and the quiet stretches that give a waveform
   its shape would vanish. */
export function bucketPeaks(samples, buckets = PEAK_BUCKETS){
  const out = new Float32Array(buckets);
  if (!samples || !samples.length) return out;
  const per = samples.length / buckets;
  for (let b = 0; b < buckets; b++){
    const from = Math.floor(b * per);
    const to = Math.min(samples.length, Math.floor((b + 1) * per));
    let sum = 0;
    for (let i = from; i < to; i++) sum += samples[i] * samples[i];
    out[b] = to > from ? Math.sqrt(sum / (to - from)) : 0;
  }
  let max = 0;
  for (const v of out) if (v > max) max = v;
  if (max > 0) for (let i = 0; i < buckets; i++) out[i] /= max;
  return out;
}

/* Pool the stored buckets onto the bars actually being drawn. Loudest wins
   rather than the average: pooling by mean would flatten the waveform a
   little further every time the bubble got narrower. */
export function barHeights(peaks, bars){
  const out = new Float32Array(Math.max(0, bars));
  if (!peaks || !peaks.length || bars <= 0) return out;
  const per = peaks.length / bars;
  for (let b = 0; b < bars; b++){
    const from = Math.min(peaks.length - 1, Math.floor(b * per));
    const to = Math.max(from + 1, Math.min(peaks.length, Math.floor((b + 1) * per)));
    let max = 0;
    for (let i = from; i < to; i++) if (peaks[i] > max) max = peaks[i];
    out[b] = max;
  }
  return out;
}

export function fmtClock(seconds){
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const whole = Math.round(seconds);
  return Math.floor(whole / 60) + ":" + String(whole % 60).padStart(2, "0");
}

/* How many bars fit, given the width the bubble ended up with. */
export const barCount = width => Math.max(8, Math.floor((width + GAP) / (BAR + GAP)));

/* ---- markup ---- */

export function voiceHTML(enc){
  return `<div class="voice" data-v="${enc}">
      <button class="vPlay" type="button" aria-label="Play voice message">${ICON.play}</button>
      <div class="vWave" role="slider" tabindex="0" aria-label="Seek within voice message"
           aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><canvas></canvas></div>
      <span class="vTime">--:--</span>
      <audio preload="metadata" data-m="${enc}" onerror="mediaFail(this)"></audio>
    </div>`;
}

/* ---- measured shapes, kept by file name ----
   The name outlives both the object URL, which the session's cache may
   revoke at any time, and the element, which a re-render replaces. */
const measured = new Map();     // name -> {peaks: Float32Array|null, seconds: number}
const UNMEASURED = {peaks: null, seconds: NaN};

/* One decode at a time. Several voice notes commonly scroll into view at
   once, and each holds its whole decoded self in memory while it is
   measured; running them concurrently multiplies that for no gain. */
let queue = Promise.resolve();
function enqueue(work){
  const run = queue.then(work);
  queue = run.catch(() => {});   // one bad measurement must not stall the rest
}

let audioCtx = null;
function decoder(){
  if (audioCtx) return audioCtx;
  // An offline context decodes without claiming the output device, so
  // measuring a waveform never interrupts anything else that is playing.
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const Live = window.AudioContext || window.webkitAudioContext;
  if (Offline) audioCtx = new Offline(1, 1, 44100);
  else if (Live) audioCtx = new Live();
  return audioCtx;
}

/* Returns the measurement, UNMEASURED for a file this browser will never
   manage, or null for a miss worth retrying. */
async function measure(url){
  const ctx = decoder();
  if (!ctx) return UNMEASURED;
  let bytes;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    bytes = await res.arrayBuffer();
  } catch {
    // The session caps how much decompressed media it keeps, so a URL can be
    // revoked between being handed over and this work reaching the front of
    // the queue. Nothing is wrong with the file; leave it to be measured on
    // the next pass rather than recording a failure against it.
    return null;
  }
  if (bytes.byteLength > MAX_DECODE_BYTES) return UNMEASURED;
  try {
    const buffer = await ctx.decodeAudioData(bytes);
    return {peaks: bucketPeaks(buffer.getChannelData(0)), seconds: buffer.duration};
  } catch {
    // A browser that cannot decode Opus still plays it through the audio
    // element, and that will not change on a retry: the player carries on
    // without a waveform.
    return UNMEASURED;
  }
}

/* Called once the session has resolved this file's URL. */
export function primeWaveform(box, url){
  const name = box.dataset.v;
  if (measured.has(name)){ paint(box); return; }
  enqueue(() => measure(url).then(have => {
    if (have) measured.set(name, have);
    if (box.isConnected) paint(box);
  }));
}

/* ---- drawing ---- */

const colours = new WeakMap();
function coloursFor(wave){
  let c = colours.get(wave);
  if (!c){
    const s = getComputedStyle(wave);
    c = {on: s.getPropertyValue("--wave-on").trim() || "#00a884",
         off: s.getPropertyValue("--wave-off").trim() || "#8696a0"};
    colours.set(wave, c);
  }
  return c;
}

function render(box){
  const wave = box.querySelector(".vWave"), canvas = wave.querySelector("canvas");
  const width = wave.clientWidth, height = wave.clientHeight;
  if (!width || !height) return;

  const dpr = window.devicePixelRatio || 1;
  const pxW = Math.round(width * dpr), pxH = Math.round(height * dpr);
  if (canvas.width !== pxW || canvas.height !== pxH){ canvas.width = pxW; canvas.height = pxH; }

  const g = canvas.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, width, height);

  const {peaks} = measured.get(box.dataset.v) || UNMEASURED;
  const bars = barCount(width);
  // Before a measurement lands — and for audio this browser cannot decode —
  // every bar sits at the floor, which still fills left to right as it plays.
  const heights = peaks ? barHeights(peaks, bars) : new Float32Array(bars);
  const played = progressOf(box) * width;
  const {on, off} = coloursFor(wave);

  for (let i = 0; i < bars; i++){
    const x = i * (BAR + GAP);
    const h = Math.max(MIN_BAR, heights[i] * height);
    const y = (height - h) / 2;
    g.fillStyle = x + BAR / 2 <= played ? on : off;
    if (g.roundRect){
      g.beginPath();
      g.roundRect(x, y, BAR, h, BAR / 2);
      g.fill();
    } else {
      g.fillRect(x, y, BAR, h);
    }
  }
}

/* ---- transport ---- */

const audioOf = box => box.querySelector("audio");

/* Ogg streams often report an infinite duration until they have been played
   all the way through, so the decoded length is the one to trust when a
   measurement produced one. */
function lengthOf(box){
  const known = measured.get(box.dataset.v);
  if (known && Number.isFinite(known.seconds)) return known.seconds;
  const d = audioOf(box).duration;
  return Number.isFinite(d) ? d : NaN;
}
function progressOf(box){
  const total = lengthOf(box);
  return total > 0 ? Math.min(1, audioOf(box).currentTime / total) : 0;
}

/* Idle players show how long the note runs; a playing one counts up. */
function paint(box){
  const elapsed = audioOf(box).currentTime;
  const showElapsed = box.classList.contains("playing") || elapsed > 0;
  box.querySelector(".vTime").textContent = fmtClock(showElapsed ? elapsed : lengthOf(box));
  box.querySelector(".vWave").setAttribute("aria-valuenow", Math.round(progressOf(box) * 100));
  render(box);
}

let playingBox = null, frame = 0;
/* One advance of the playing player. Returns whether it is still going, so
   the animation loop knows to book another frame. */
function tick(){
  if (!playingBox) return false;
  // A re-render (a search, or switching which participant is "you") replaces
  // these elements; without this the detached audio would play on unseen.
  if (!playingBox.isConnected){ stop(); return false; }
  paint(playingBox);
  return true;
}
function follow(){
  frame = tick() ? requestAnimationFrame(follow) : 0;
}
function setIcon(box, playing){
  const button = box.querySelector(".vPlay");
  button.innerHTML = playing ? ICON.pause : ICON.play;
  button.setAttribute("aria-label", playing ? "Pause voice message" : "Play voice message");
}
function stop(){
  if (!playingBox) return;
  const box = playingBox;
  playingBox = null;
  if (frame){ cancelAnimationFrame(frame); frame = 0; }
  audioOf(box).pause();
  box.classList.remove("playing");
  if (box.isConnected){ setIcon(box, false); paint(box); }
}
function toggle(box){
  if (playingBox === box){ stop(); return; }
  if (playingBox) stop();                 // one at a time, the way WhatsApp plays them
  audioOf(box).play().then(() => {
    playingBox = box;
    box.classList.add("playing");
    setIcon(box, true);
    if (!frame) frame = requestAnimationFrame(follow);
  }).catch(() => {});
}

function seekTo(box, ratio){
  const total = lengthOf(box);
  if (!(total > 0)) return;
  audioOf(box).currentTime = Math.max(0, Math.min(total, ratio * total));
  paint(box);
}
const ratioAt = (wave, clientX) => {
  const r = wave.getBoundingClientRect();
  return r.width > 0 ? Math.max(0, Math.min(1, (clientX - r.left) / r.width)) : 0;
};

/* ---- wiring ----
   Delegated from the message list, so the players a re-render throws away
   cost nothing to replace and leave no listener holding a dead element. */
export function bindVoice(msgsEl){
  msgsEl.addEventListener("click", e => {
    const button = e.target.closest(".vPlay");
    if (button) toggle(button.closest(".voice"));
  });

  msgsEl.addEventListener("pointerdown", e => {
    const wave = e.target.closest(".vWave");
    if (!wave) return;
    e.preventDefault();
    const box = wave.closest(".voice");
    wave.setPointerCapture(e.pointerId);
    seekTo(box, ratioAt(wave, e.clientX));
    const drag = ev => seekTo(box, ratioAt(wave, ev.clientX));
    const end = () => {
      wave.removeEventListener("pointermove", drag);
      wave.removeEventListener("pointerup", end);
      wave.removeEventListener("pointercancel", end);
    };
    wave.addEventListener("pointermove", drag);
    wave.addEventListener("pointerup", end);
    wave.addEventListener("pointercancel", end);
  });

  msgsEl.addEventListener("keydown", e => {
    const wave = e.target.closest(".vWave");
    if (!wave) return;
    const box = wave.closest(".voice");
    const step = e.key === "ArrowRight" ? 5 : e.key === "ArrowLeft" ? -5 : 0;
    const total = lengthOf(box);
    if (step && total > 0){
      e.preventDefault();
      seekTo(box, (audioOf(box).currentTime + step) / total);
    } else if (e.key === " " || e.key === "Enter"){
      e.preventDefault();
      toggle(box);
    }
  });

  // neither event bubbles, so both are caught on the way down
  msgsEl.addEventListener("ended", e => {
    const box = e.target.closest(".voice");
    if (!box) return;
    stop();
    audioOf(box).currentTime = 0;
    paint(box);
  }, true);
  msgsEl.addEventListener("loadedmetadata", e => {
    const box = e.target.closest(".voice");
    if (box) paint(box);
  }, true);

  /* A hidden tab keeps playing audio but is granted no animation frames, so
     timeupdate — which still fires there — carries the clock in the meantime
     and is where a player detached mid-playback gets caught. */
  msgsEl.addEventListener("timeupdate", e => {
    if (playingBox && e.target === audioOf(playingBox)) tick();
  }, true);

  // Bubble width follows the viewport, so a resize changes the bar count.
  // Repainting from the one window event avoids observing players
  // individually, which would keep every discarded one alive.
  let pending = 0;
  window.addEventListener("resize", () => {
    cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => msgsEl.querySelectorAll(".voice").forEach(paint));
  });
}

/* First paint for freshly rendered players, before any audio has loaded. */
export function paintVoice(chunkEl){
  chunkEl.querySelectorAll(".voice").forEach(paint);
}
