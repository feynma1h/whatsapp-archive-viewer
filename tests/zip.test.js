import { test } from "node:test";
import assert from "node:assert/strict";

import { LocalZip } from "../docs/js/zip.js";
import {
  normalZip, truncatedZip, zip64Zip, asFile, PNG, TRUNCATED_CHAT, NORMAL_CHAT,
} from "./fixtures.js";

const open = async bytes => {
  const zip = new LocalZip(asFile(bytes));
  await zip.init();
  return zip;
};
const bytesOf = async (zip, name) =>
  new Uint8Array(await (await zip.entryBlob(name)).arrayBuffer());

test("reads a well-formed archive without salvaging", async () => {
  const zip = await open(normalZip());
  assert.equal(zip.entries.size, 4);
  assert.equal(zip.declared, 4);
  assert.equal(zip.salvaged, 0);
  assert.deepEqual(await bytesOf(zip, "00000004-PHOTO-2024-05-20-10-02-00.jpg"), PNG);
  assert.equal(await (await zip.entryBlob("_chat.txt")).text(), NORMAL_CHAT);
});

test("lists entry names without decompressing", async () => {
  const names = await LocalZip.indexNames(asFile(normalZip()));
  assert.equal(names.length, 4);
  assert.ok(names.includes("_chat.txt"));
});

test("rejects a file that is not a zip", async () => {
  const zip = new LocalZip(asFile(new Uint8Array(200)));
  await assert.rejects(() => zip.parseIndex(), /not a zip archive/);
});

test("reads sizes and offsets from zip64 records", async () => {
  const zip = await open(zip64Zip());
  assert.equal(zip.entries.size, 2);
  assert.equal(zip.declared, 2);
  assert.deepEqual(await bytesOf(zip, "00000001-PHOTO-2024-05-20-10-00-00.jpg"), PNG);
  assert.equal(await (await zip.entryBlob("_chat.txt")).text(), TRUNCATED_CHAT);
});

test("a truncated central directory hides all but the first entry", async () => {
  const zip = new LocalZip(asFile(truncatedZip()));
  await zip.parseIndex();                       // index only, no salvage
  assert.equal(zip.entries.size, 1);
  assert.equal(zip.declared, 4);
});

test("salvage recovers every orphaned entry", async () => {
  const zip = await open(truncatedZip());
  assert.equal(zip.entries.size, 4);
  assert.equal(zip.salvaged, 3);
});

// The conversation is the last entry, so its data descriptor ends flush
// against the central directory. Missing that position loses the chat text
// while still recovering the media, and the archive is then rejected for
// having no conversation in it at all.
test("salvage recovers a chat file whose descriptor abuts the index", async () => {
  const zip = await open(truncatedZip());
  assert.ok(zip.entries.has("_chat.txt"));
  assert.equal(await (await zip.entryBlob("_chat.txt")).text(), TRUNCATED_CHAT);
});

// Deferred sizes are not exclusive to deflated entries: a stored one keeps a
// compressed size of zero and reads back empty unless its descriptor is read.
test("salvage reads deferred sizes for stored entries", async () => {
  const zip = await open(truncatedZip());
  const stored = zip.entries.get("00000003-PHOTO-2024-05-20-10-02-00.jpg");
  assert.equal(stored.method, 0);
  assert.equal(stored.csize, PNG.length);
  assert.deepEqual(await bytesOf(zip, stored.name), PNG);
});

test("salvage reads deferred sizes for deflated entries", async () => {
  const zip = await open(truncatedZip());
  assert.deepEqual(await bytesOf(zip, "00000002-PHOTO-2024-05-20-10-01-00.jpg"), PNG);
});

test("salvage reports progress while it walks the archive", async () => {
  const seen = [];
  const zip = new LocalZip(asFile(truncatedZip()));
  await zip.init(m => seen.push(m));
  assert.ok(seen.some(m => /recovering/i.test(m)),
            `expected a recovery message, got ${JSON.stringify(seen)}`);
});
