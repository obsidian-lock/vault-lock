// Table for the .vlenc format (src/shared/vlenc.ts): round trips, header fields, every way a
// file can be wrong, the name predicates, and the mtime trick the decrypt step relies on.
// Run with: node scripts/build-tests.mjs && node --test scripts/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const T = require("./.build/testable.cjs");

const KEY_HEX = crypto.randomBytes(32).toString("hex");
const KEY_ID = "0123456789abcdef";
const MTIME = 1_763_280_000_123;
const key = await T.importVaultKey(KEY_HEX);
const other = await T.importVaultKey(crypto.randomBytes(32).toString("hex"));
const magic = Buffer.from("VLENC1");

const equal = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const isOpError = (e) => e instanceof Error && e.name === "OperationError";
/** A copy with one byte flipped. */
function flipped(bytes, i) {
	const b = Buffer.from(bytes);
	b[i] ^= 1;
	return new Uint8Array(b);
}

test("format constants", () => {
	assert.equal(T.VLENC_MAGIC, "VLENC1");
	assert.equal(T.VLENC_HEADER, 35);
});

test("round trip: 0, 1, 1 000 000 bytes and 2 MB random", async () => {
	for (const plain of [new Uint8Array(0), new Uint8Array([7]), new Uint8Array(1_000_000).fill(65), new Uint8Array(crypto.randomBytes(2 * 1024 * 1024))]) {
		const enc = await T.encryptBytes(key, KEY_ID, plain, MTIME);
		assert.equal(enc.length, 35 + plain.length + 16, `size for ${plain.length} bytes`);
		const d = await T.decryptBytes(key, enc);
		assert.ok(equal(d.plain, plain), `bytes back for ${plain.length}`);
		assert.deepEqual(d.header, { keyId: KEY_ID, mtime: MTIME });
	}
	// Two encryptions of the same bytes differ (a fresh IV each time).
	const a = await T.encryptBytes(key, KEY_ID, new Uint8Array([1, 2, 3]), MTIME);
	const b = await T.encryptBytes(key, KEY_ID, new Uint8Array([1, 2, 3]), MTIME);
	assert.notEqual(Buffer.from(a).toString("hex"), Buffer.from(b).toString("hex"));
});

test("header fields read back: magic, version, key id, mtime (also 2^40)", async () => {
	const enc = await T.encryptBytes(key, KEY_ID, new Uint8Array([1]), MTIME);
	assert.ok(equal(enc.subarray(0, 6), magic));
	assert.equal(enc[6], 1);
	assert.equal(Buffer.from(enc.subarray(7, 15)).toString("hex"), KEY_ID);
	assert.equal(Buffer.from(enc.subarray(15, 23)).readBigUInt64BE(), BigInt(MTIME));
	assert.deepEqual(T.parseHeader(enc), { keyId: KEY_ID, mtime: MTIME });
	const big = await T.encryptBytes(key, KEY_ID, new Uint8Array([1]), 2 ** 40);
	assert.equal((await T.decryptBytes(key, big)).header.mtime, 2 ** 40);
	assert.equal(T.parseHeader(big).mtime, 2 ** 40);
	// A header copied from one file onto another is caught: the header is authenticated.
	const enc2 = await T.encryptBytes(key, "fedcba9876543210", new Uint8Array([1]), MTIME);
	const swapped = new Uint8Array(enc);
	swapped.set(enc2.subarray(7, 15), 7);
	await assert.rejects(T.decryptBytes(key, swapped), isOpError, "key id changed");
});

test("wrong key, flipped bytes, cut-off file → OperationError", async () => {
	const plain = new Uint8Array(crypto.randomBytes(300));
	const enc = await T.encryptBytes(key, KEY_ID, plain, MTIME);
	await assert.rejects(T.decryptBytes(other, enc), isOpError, "wrong key");
	await assert.rejects(T.decryptBytes(key, flipped(enc, 20)), isOpError, "flipped byte in the header (mtime)");
	await assert.rejects(T.decryptBytes(key, flipped(enc, 30)), isOpError, "flipped byte in the IV");
	await assert.rejects(T.decryptBytes(key, flipped(enc, 35 + 100)), isOpError, "flipped byte in the ciphertext");
	await assert.rejects(T.decryptBytes(key, flipped(enc, enc.length - 3)), isOpError, "flipped byte in the tag");
	await assert.rejects(T.decryptBytes(key, enc.subarray(0, enc.length - 1)), isOpError, "cut-off file");
	// The header still parses when only the body is wrong.
	assert.deepEqual(T.parseHeader(flipped(enc, 40)), { keyId: KEY_ID, mtime: MTIME });
});

test("not a .vlenc: too short, a plain note, wrong magic or version → NotVlenc", async () => {
	const isNot = (e) => e instanceof T.NotVlenc;
	assert.throws(() => T.parseHeader(new Uint8Array(50)), isNot, "50 bytes");
	await assert.rejects(T.decryptBytes(key, new Uint8Array(50)), isNot, "50 bytes");
	const md = new Uint8Array(Buffer.from("# A note\n\nWith some text in it, long enough to hold a header and a tag.\n"));
	assert.throws(() => T.parseHeader(md), isNot, "plain .md");
	await assert.rejects(T.decryptBytes(key, md), isNot, "plain .md");
	const enc = await T.encryptBytes(key, KEY_ID, new Uint8Array([1]), MTIME);
	assert.throws(() => T.parseHeader(flipped(enc, 0)), isNot, "magic changed");
	assert.throws(() => T.parseHeader(flipped(enc, 6)), isNot, "version changed");
	assert.ok(T.NotVlenc.prototype instanceof Error);
});

test("name predicates", () => {
	const rows = [
		["Secret.md", false, false, false],
		["Secret.md.vlenc", true, false, false],
		["a.jpg.vlenc", true, false, false],
		["Secret.md.vlenc.tmp", false, true, false],
		["Secret.md.vlenc.vlenc", true, false, false],
		["foo.vlenc", true, false, false],
		["Secret.md.undecryptable-2026-11-16_103000.vlenc", true, false, true],
		["Secret.md.undecryptable-2026-11-16_103000-2.vlenc", true, false, true],
		["Secret.md.undecryptable-2026-11-16_103000.vlenc.tmp", false, true, false],
		["undecryptable-2026-11-16_103000.vlenc", true, false, false],
		["Secret.md.undecryptable-today.vlenc", true, false, false],
		[".vlenc", true, false, false],
		["vlenc", false, false, false],
	];
	for (const [name, v, t, a] of rows) {
		assert.equal(T.isVlencName(name), v, `isVlencName(${name})`);
		assert.equal(T.isTmpName(name), t, `isTmpName(${name})`);
		assert.equal(T.isAsideName(name), a, `isAsideName(${name})`);
	}
});

test("importVaultKey: 64 hex only; encryptBytes: 16-hex key id only", async () => {
	await assert.rejects(T.importVaultKey(KEY_HEX.slice(1)), /64 hex/, "63 hex");
	await assert.rejects(T.importVaultKey(KEY_HEX.toUpperCase()), /64 hex/, "upper case");
	await assert.rejects(T.importVaultKey(KEY_HEX + "00"), /64 hex/, "66 hex");
	await assert.rejects(T.encryptBytes(key, "0123", new Uint8Array(1), MTIME), /16 hex/);
	await assert.rejects(T.encryptBytes(key, KEY_ID, new Uint8Array(1), 1.5), /mtime/);
	const k = await T.importVaultKey(KEY_HEX);
	assert.equal(k.extractable, false);
	assert.deepEqual([...k.usages].sort(), ["decrypt", "encrypt"]);
});

test("D3: utimes with (m + 0.25) / 1000 reads back as m under floor and round", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vlb-vlenc-"));
	try {
		const f = path.join(dir, "x.md.vlenc.tmp");
		fs.writeFileSync(f, "x");
		for (const m of [MTIME, 1_700_000_000_000, 1_763_280_000_999, 946_684_800_000]) {
			await fs.promises.utimes(f, new Date(), (m + 0.25) / 1000);
			const st = fs.statSync(f);
			assert.equal(Math.floor(st.mtimeMs), m, `floor for ${m}`);
			assert.equal(Math.round(st.mtimeMs), m, `round for ${m}`);
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("fault(): a no-op in a build without the fault stops", async () => {
	globalThis.__vlbFault = "enc:before-tmp";
	try {
		await T.fault("enc:before-tmp"); // resolves at once: __VLB_FAULT__ is "" here
	} finally {
		delete globalThis.__vlbFault;
	}
});
