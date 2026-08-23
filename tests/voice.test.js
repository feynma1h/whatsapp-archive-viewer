import { test } from "node:test";
import assert from "node:assert/strict";

import { bucketPeaks, barHeights, barCount, fmtClock, PEAK_BUCKETS } from "../docs/js/voice.js";

// A run of samples whose amplitude climbs from silence to full scale, so a
// correct measurement comes back as a ramp and a broken one does not.
const ramp = (n, from = 0, to = 1) =>
  Float32Array.from({length: n}, (_, i) => from + (to - from) * (i / (n - 1)));

const tone = (n, amplitude) =>
  Float32Array.from({length: n}, (_, i) => amplitude * Math.sin(i));

test("measures one bucket per slice of the recording", () => {
  const peaks = bucketPeaks(ramp(4096), 64);
  assert.equal(peaks.length, 64);
  assert.ok(peaks.every(v => v >= 0 && v <= 1));
  // rising input, rising buckets
  for (let i = 1; i < peaks.length; i++) assert.ok(peaks[i] > peaks[i - 1]);
});

test("scales the loudest bucket to full height", () => {
  const loud = bucketPeaks(tone(4096, 0.9), 32);
  const faint = bucketPeaks(tone(4096, 0.02), 32);
  assert.ok(Math.max(...loud) > 0.999);
  // a quiet recording still fills the bar area rather than drawing a flat line
  assert.ok(Math.max(...faint) > 0.999);
});

test("defaults to the resolution the player stores", () => {
  assert.equal(bucketPeaks(ramp(8192)).length, PEAK_BUCKETS);
});

test("survives silence, emptiness and more buckets than samples", () => {
  assert.deepEqual([...bucketPeaks(new Float32Array(500), 8)], new Array(8).fill(0));
  assert.deepEqual([...bucketPeaks(new Float32Array(0), 4)], [0, 0, 0, 0]);
  assert.deepEqual([...bucketPeaks(null, 3)], [0, 0, 0]);
  const sparse = bucketPeaks(Float32Array.of(1, 1, 1), 8);
  assert.equal(sparse.length, 8);
  assert.ok(sparse.every(v => v >= 0 && v <= 1));
});

test("pools buckets onto the bars actually drawn, keeping the loudest", () => {
  // values chosen to survive float32 exactly, so the assertion can be exact
  const peaks = Float32Array.of(0.125, 0.875, 0.25, 0.375, 1, 0.5);
  assert.deepEqual([...barHeights(peaks, 3)], [0.875, 0.375, 1]);
  // asking for more bars than buckets repeats rather than reading off the end
  const wide = barHeights(Float32Array.of(0.5, 1), 5);
  assert.equal(wide.length, 5);
  assert.ok(wide.every(v => v === 0.5 || v === 1));
});

test("pooling holds its shape as the bubble narrows", () => {
  const peaks = bucketPeaks(ramp(8192), PEAK_BUCKETS);
  for (const bars of [12, 30, 64]){
    const heights = barHeights(peaks, bars);
    assert.equal(heights.length, bars);
    // the tail of a rising recording stays the loudest at every width
    assert.ok(heights[bars - 1] > heights[0]);
    assert.ok(Math.max(...heights) > 0.999);
  }
});

test("pooling and bar counts refuse to produce nothing", () => {
  assert.equal(barHeights(Float32Array.of(1), 0).length, 0);
  assert.equal(barHeights(null, 4).length, 4);
  assert.ok(barCount(0) >= 8);          // a bubble mid-layout still has bars
  assert.ok(barCount(200) > barCount(100));
});

test("clock reads as minutes and seconds, and says so when it cannot", () => {
  assert.equal(fmtClock(0), "0:00");
  assert.equal(fmtClock(7), "0:07");
  assert.equal(fmtClock(61.4), "1:01");
  assert.equal(fmtClock(599.6), "10:00");
  // ogg streams report this until they have been played through
  assert.equal(fmtClock(Infinity), "--:--");
  assert.equal(fmtClock(NaN), "--:--");
  assert.equal(fmtClock(-1), "--:--");
});
