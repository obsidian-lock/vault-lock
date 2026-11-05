// Table for verifyManifest() and checkBundle(): a key pair made here, envelopes
// built here the way server/vlb builds them. Run with: node scripts/build-tests.mjs && node --test scripts/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const T = require("./.build/testable.cjs");

function keyPair() {
	const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
	return { priv: privateKey, hex: publicKey.export({ format: "der", type: "spki" }).toString("hex") };
}
const K = keyPair();
const OTHER = keyPair();
const BUNDLE = Buffer.from("module.exports = { API: 1, createApp() {} };\n");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

function payload(more = {}) {
	return { v: 1, kind: "app", version: "9.9.9", sha256: sha(BUNDLE), size: BUNDLE.length, force: false, minCore: 1, at: "2026-11-05T12:00:00Z", note: "ci", ...more };
}
/** Like vlb: compact JSON, signed bytes = the payload bytes; mutate(payloadBytes, sigBytes) may change either. */
function envelope(p, { key = K.priv, raw, mutate } = {}) {
	const bytes = Buffer.from(raw ?? JSON.stringify(p));
	const sig = crypto.sign(null, bytes, key);
	if (mutate) mutate(bytes, sig);
	return JSON.stringify({ payload: bytes.toString("base64"), sig: sig.toString("base64") });
}
const refuses = (text, keys, re, what) => assert.throws(() => T.verifyManifest(text, keys), (e) => e instanceof T.VerifyError && re.test(e.message), what);

test("verifyManifest: a valid envelope gives its payload", () => {
	const p = T.verifyManifest(envelope(payload()), [K.hex]);
	assert.deepEqual(p, payload());
	// Formatting of the envelope does not matter: the signature covers the payload bytes.
	const pretty = JSON.stringify(JSON.parse(envelope(payload())), null, 2);
	assert.equal(T.verifyManifest(pretty, [K.hex]).version, "9.9.9");
});

test("verifyManifest: signature and key", () => {
	refuses(envelope(payload(), { mutate: (b) => { b[b.length - 3] ^= 1; } }), [K.hex], /signature invalid/, "flipped payload byte");
	refuses(envelope(payload(), { mutate: (_, s) => { s[10] ^= 1; } }), [K.hex], /signature invalid/, "flipped sig byte");
	refuses(envelope(payload()), [OTHER.hex], /signature invalid/, "wrong key");
	refuses(envelope(payload()), [], /signature invalid/, "no keys");
	refuses(envelope(payload(), { key: OTHER.priv }), [K.hex], /signature invalid/, "signed by another key");
	const env = JSON.parse(envelope(payload()));
	const short = Buffer.from(env.sig, "base64").subarray(0, 63).toString("base64");
	refuses(JSON.stringify({ payload: env.payload, sig: short }), [K.hex], /64 bytes/, "sig of 63 bytes");
	// Two keys (a rotation): only the second is right → ok. A broken key in the list is skipped.
	assert.equal(T.verifyManifest(envelope(payload()), [OTHER.hex, K.hex]).version, "9.9.9");
	assert.equal(T.verifyManifest(envelope(payload()), ["zz", "3000", K.hex]).version, "9.9.9");
	// A non-Ed25519 key never verifies anything.
	const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ format: "der", type: "spki" }).toString("hex");
	refuses(envelope(payload()), [rsa], /signature invalid/, "RSA key");
});

test("verifyManifest: envelope shape and sizes", () => {
	refuses("{", [K.hex], /not JSON/, "not JSON");
	refuses("[]", [K.hex], /envelope/, "array");
	refuses(JSON.stringify({ payload: "eA==" }), [K.hex], /envelope/, "no sig");
	refuses(JSON.stringify({ payload: "e!A==", sig: "AAAA" }), [K.hex], /base64/, "not base64");
	refuses(" ".repeat(4097), [K.hex], /too big/, "manifest over 4096 bytes");
	refuses(envelope(payload({ note: "x".repeat(2100) })), [K.hex], /payload too big/, "payload over 2048 bytes");
});

test("verifyManifest: payload rules (each signed correctly, each refused)", () => {
	const rows = [
		[{ v: 2 }, /v is not 1/],
		[{ kind: "theme" }, /kind/],
		[{ version: "1.7" }, /version/],
		[{ version: "1.7.0-beta" }, /version/],
		[{ sha256: "AB".repeat(32) }, /sha256/],
		[{ sha256: "ab" }, /sha256/],
		[{ size: 0 }, /size/],
		[{ size: 3 * 1024 * 1024 }, /size/],
		[{ size: 1.5 }, /size/],
		[{ size: "10" }, /size/],
		[{ force: "yes" }, /force/],
		[{ minCore: 0 }, /minCore/],
		[{ minCore: 1.5 }, /minCore/],
		[{ at: undefined }, /payload at/],
		[{ at: "yesterday" }, /payload at/],
		[{ note: 5 }, /note/],
	];
	for (const [more, re] of rows) refuses(envelope(payload(more)), [K.hex], re, JSON.stringify(more));
	refuses(envelope(null, { raw: "not json" }), [K.hex], /payload is not JSON/, "payload not JSON");
	refuses(envelope(null, { raw: "[1]" }), [K.hex], /not an object/, "payload array");
});

test("verifyManifest: defaults for force and minCore; note optional", () => {
	const p = payload();
	delete p.force;
	delete p.minCore;
	delete p.note;
	const out = T.verifyManifest(envelope(p), [K.hex]);
	assert.equal(out.force, false);
	assert.equal(out.minCore, 1);
	assert.equal("note" in out, false);
	assert.equal(T.verifyManifest(envelope(payload({ kind: "core", force: true, minCore: 3 })), [K.hex]).minCore, 3);
});

test("checkBundle: size and sha256", () => {
	const p = T.verifyManifest(envelope(payload()), [K.hex]);
	T.checkBundle(new Uint8Array(BUNDLE), p);
	const changed = Buffer.from(BUNDLE);
	changed[0] ^= 1;
	assert.throws(() => T.checkBundle(new Uint8Array(changed), p), (e) => e instanceof T.VerifyError && /sha256/.test(e.message), "one byte changed");
	assert.throws(() => T.checkBundle(new Uint8Array(BUNDLE.subarray(0, BUNDLE.length - 1)), p), (e) => e instanceof T.VerifyError && /size/.test(e.message), "one byte short");
	assert.throws(() => T.checkBundle(new Uint8Array(Buffer.concat([BUNDLE, Buffer.from(" ")])), p), /size/, "one byte more");
	assert.equal(T.sha256Hex(new Uint8Array(BUNDLE)), sha(BUNDLE));
});
