import { test } from "node:test";
import assert from "node:assert/strict";

import { buildChatIndex } from "../docs/js/chatparse.js";
import { NORMAL_CHAT } from "./fixtures.js";

// The viewer normalises line endings and strips the byte-order mark before
// indexing; tests go through the same door.
const index = (text, name = "Testy") =>
  buildChatIndex(text.replace(/^﻿/, "").replace(/\r\n?/g, "\n"), name);

const chat = index(NORMAL_CHAT);
const kinds = { TEXT: 0, MEDIA: 1, SYSTEM: 2, CALL: 3, DELETED: 4 };

test("indexes every message and its participants", () => {
  assert.equal(chat.count, 13);
  assert.deepEqual(chat.senders, ["Testy", "Alice", "Bob"]);
  assert.equal(chat.first, Date.UTC(2024, 4, 20, 10, 0, 0) / 1000);
  assert.equal(chat.last, Date.UTC(2024, 4, 21, 9, 0, 0) / 1000);
});

test("groups messages by day", () => {
  assert.equal(chat.days.length, 2);          // 20 May and 21 May
  assert.equal(chat.days[0][1], 0);            // first message of day one
  assert.equal(chat.days[1][1], 12);           // first message of day two
});

test("classifies a system notice", () => {
  const m = chat.messageAt(0);
  assert.equal(m.k, kinds.SYSTEM);
  assert.match(m.t, /end-to-end encrypted/);
});

test("classifies plain text, including a multi-line body", () => {
  assert.equal(chat.messageAt(1).k, kinds.TEXT);
  assert.equal(chat.messageAt(1).t, "Hello there");
  assert.equal(chat.messageAt(2).t, "Hi! two lines follow\nsecond line here");
});

test("classifies attached media, with and without a caption", () => {
  const bare = chat.messageAt(3), captioned = chat.messageAt(4);
  assert.equal(bare.k, kinds.MEDIA);
  assert.equal(bare.a, "00000004-PHOTO-2024-05-20-10-02-00.jpg");
  assert.equal(bare.t, undefined);
  assert.equal(captioned.k, kinds.MEDIA);
  assert.equal(captioned.a, "00000005-PHOTO-2024-05-20-10-03-00.jpg");
  assert.equal(captioned.t, "Caption here");
});

test("classifies media left out of the export, keeping its caption", () => {
  const m = chat.messageAt(6);
  assert.equal(m.k, kinds.MEDIA);
  assert.equal(m.a, undefined);               // nothing to load from the zip
  assert.equal(m.mt, "image omitted");
  assert.equal(m.t, "Check this");
});

test("classifies calls and deleted messages", () => {
  assert.equal(chat.messageAt(7).k, kinds.CALL);
  assert.equal(chat.messageAt(8).k, kinds.DELETED);
});

test("marks an edited message without keeping its marker", () => {
  const m = chat.messageAt(9);
  assert.equal(m.e, 1);
  assert.equal(m.t, "Edited msg");
});

test("reads day-first dates when a day above twelve proves the order", () => {
  const c = index("[20/05/24, 10:00:00 AM] Alice: hi\n");
  assert.equal(c.ts[0], Date.UTC(2024, 4, 20, 10, 0, 0) / 1000);
});

test("reads month-first dates when a second number above twelve proves it", () => {
  const c = index("[05/20/24, 10:00:00 AM] Alice: hi\n" +
                  "[06/21/24, 10:00:00 AM] Bob: there\n");
  assert.equal(c.ts[0], Date.UTC(2024, 4, 20, 10, 0, 0) / 1000);
  assert.equal(c.ts[1], Date.UTC(2024, 5, 21, 10, 0, 0) / 1000);
});

test("assumes day-first when a chat is too short to tell", () => {
  const c = index("[05/06/24, 10:00:00 AM] Alice: hi\n");
  assert.equal(c.ts[0], Date.UTC(2024, 5, 5, 10, 0, 0) / 1000);
});

test("reads a four-digit year and a 24-hour clock", () => {
  const c = index("[20/05/2024, 21:30] Alice: hi\n");
  assert.equal(c.ts[0], Date.UTC(2024, 4, 20, 21, 30, 0) / 1000);
});

test("finds messages by text and snips around the hit", () => {
  const { results, truncated } = chat.search("two lines");
  assert.equal(truncated, false);
  assert.equal(results.length, 1);
  assert.equal(results[0].i, 2);
  assert.match(results[0].snip, /two lines follow/);
});

test("search ignores matches inside the timestamp headers", () => {
  assert.equal(chat.search("10:01:00").results.length, 0);
});

test("search caps its results and says so", () => {
  const many = Array.from({length: 12}, (_, i) =>
    `[20/05/24, 10:00:00 AM] Alice: needle ${i}`).join("\n") + "\n";
  const { results, truncated } = index(many).search("needle", 5);
  assert.equal(results.length, 5);
  assert.equal(truncated, true);
});
