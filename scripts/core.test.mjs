// Tables for the core's pure parts: pick(), isBad(), cmpVersion(), core.json read/write.
// Run with: node scripts/build-tests.mjs && node --test scripts/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const T = require("./.build/testable.cjs");

const NOW = Date.parse("2026-11-05T12:00:00Z");
const H = 3_600_000;
const B = T.builtinCandidate("1.7.0");
const at = (ms) => new Date(ms).toISOString();
function server(version, more = {}) {
	return { id: "server:ab12cd34ef56", kind: "server", version, force: false, sha256: "ab12cd34ef56".padEnd(64, "0"), minCore: 1, file: "/x/app-ab12cd34ef56.js", verified: true, why: "", ...more };
}
function pick(more) {
	return T.pick({ safeMode: false, builtin: B, server: null, bad: {}, now: NOW, ...more });
}

test("pick: the precedence table", () => {
	const S = server("9.9.9");
	const rows = [
		["no server", {}, "builtin", "none"],
		["server 9.9.9 verified", { server: S }, "server", "waiting"],
		["server 9.9.9 running", { server: S, runningId: S.id }, "server", "active"],
		["server 1.7.0 (tie)", { server: server("1.7.0") }, "builtin", "superseded"],
		["server 1.6.9 unforced", { server: server("1.6.9") }, "builtin", "superseded"],
		["server 1.6.9 force", { server: server("1.6.9", { force: true }) }, "server", "waiting"],
		["server unverified", { server: server("9.9.9", { verified: false, why: "signature invalid" }) }, "builtin", "rejected"],
		["server minCore 2 (older core)", { server: server("9.9.9", { minCore: 2 }) }, "server", "waiting"],
		["server minCore 3 (= this core)", { server: server("9.9.9", { minCore: 3 }) }, "server", "waiting"],
		["server minCore 4", { server: server("9.9.9", { minCore: 4 }) }, "builtin", "rejected"],
		["server bad n=2 fresh", { server: S, bad: { [S.id]: { n: 2, at: at(NOW - H), why: "throw" } } }, "builtin", "bad"],
		["server bad n=2 aged 25 h", { server: S, bad: { [S.id]: { n: 2, at: at(NOW - 25 * H), why: "throw" } } }, "server", "waiting"],
		["server bad n=1", { server: S, bad: { [S.id]: { n: 1, at: at(NOW), why: "crash" } } }, "server", "waiting"],
		["builtin bad n=2, server ok", { server: server("1.6.9"), bad: { [B.id]: { n: 2, at: at(NOW), why: "crash" } } }, "server", "waiting"],
		["both bad", { server: S, bad: { [B.id]: { n: 2, at: at(NOW), why: "crash" }, [S.id]: { n: 3, at: at(NOW), why: "watchdog" } } }, "lifeboat", "bad"],
		["builtin bad, no server", { bad: { [B.id]: { n: 2, at: at(NOW), why: "crash" } } }, "lifeboat", "none"],
		["safeMode with everything fine", { safeMode: true, server: S }, "lifeboat", "superseded"],
		["safeMode, no server", { safeMode: true }, "lifeboat", "none"],
		["builtin bad n=1", { bad: { [B.id]: { n: 1, at: at(NOW), why: "crash" } } }, "builtin", "none"],
		["builtin bad n=2 aged 25 h", { bad: { [B.id]: { n: 2, at: at(NOW - 25 * H), why: "crash" } } }, "builtin", "none"],
	];
	for (const [name, input, choice, serverState] of rows) {
		const p = pick(input);
		assert.equal(p.choice, choice, `${name}: choice`);
		assert.equal(p.serverState, serverState, `${name}: serverState`);
	}
	assert.equal(pick({ server: server("9.9.9", { verified: false, why: "signature invalid" }) }).why, "signature invalid");
	assert.equal(pick({ server: server("9.9.9", { minCore: 4 }) }).why, "needs core ≥ 4");
	assert.equal(pick({ safeMode: true }).why, "safe mode");
});

test("isBad: n >= 2 and younger than 24 h", () => {
	const id = "builtin:1.7.0";
	assert.equal(T.isBad({}, id, NOW), false);
	assert.equal(T.isBad({ [id]: { n: 1, at: at(NOW), why: "crash" } }, id, NOW), false);
	assert.equal(T.isBad({ [id]: { n: 2, at: at(NOW), why: "crash" } }, id, NOW), true);
	assert.equal(T.isBad({ [id]: { n: 2, at: at(NOW - 23.9 * H), why: "crash" } }, id, NOW), true);
	assert.equal(T.isBad({ [id]: { n: 2, at: at(NOW - 24 * H), why: "crash" } }, id, NOW), false);
	assert.equal(T.isBad({ [id]: { n: 5, at: "not a date", why: "crash" } }, id, NOW), false);
});

test("cmpVersion", () => {
	assert.equal(T.cmpVersion("1.10.0", "1.9.9"), 1);
	assert.equal(T.cmpVersion("1.9.9", "1.10.0"), -1);
	assert.equal(T.cmpVersion("2.0.0-beta", "2.0.0"), 0);
	assert.equal(T.cmpVersion("1.7", "1.7.0"), 0);
	assert.equal(T.cmpVersion("1.7.0-dev", "1.7.0"), 0);
});

test("parseCoreConfig: safeMode only when true; watchdog clamped to 10..10080, else 120", () => {
	assert.deepEqual(T.parseCoreConfig(undefined), { safeMode: false, watchdogMinutes: 120 });
	assert.deepEqual(T.parseCoreConfig({ safeMode: "yes", watchdogMinutes: "30" }), { safeMode: false, watchdogMinutes: 120 });
	assert.deepEqual(T.parseCoreConfig({ safeMode: true, watchdogMinutes: 5 }), { safeMode: true, watchdogMinutes: 10 });
	assert.deepEqual(T.parseCoreConfig({ watchdogMinutes: 99999 }), { safeMode: false, watchdogMinutes: 10080 });
	assert.deepEqual(T.parseCoreConfig({ watchdogMinutes: 45 }), { safeMode: false, watchdogMinutes: 45 });
	assert.deepEqual(T.parseCoreConfig({ watchdogMinutes: NaN }), { safeMode: false, watchdogMinutes: 120 });
	assert.deepEqual(T.parseCoreConfig([true]), { safeMode: false, watchdogMinutes: 120 });
});

test("core.json: missing, damaged or foreign → defaults; partial → merged field by field; writes are atomic", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vlb-core-"));
	try {
		const file = path.join(dir, T.CORE_FILE);
		const d = T.defaults();
		assert.deepEqual(T.readCoreState(dir), d, "missing file");
		for (const bad of ["{", "[]", "null", '"x"', '{"v": 2, "config": {"safeMode": true}}', '{"config": {"safeMode": true}}']) {
			fs.writeFileSync(file, bad);
			assert.deepEqual(T.readCoreState(dir), d, `content ${bad}`);
		}
		fs.writeFileSync(file, JSON.stringify({ v: 1, config: { safeMode: true }, future: { x: 1 }, bad: { "builtin:1.7.0": { n: 2, at: NOW }, odd: "x" }, starting: { id: "" } }));
		const s = T.readCoreState(dir);
		assert.deepEqual(s.config, { safeMode: true, watchdogMinutes: 120 });
		assert.deepEqual(s.future, { x: 1 }, "unknown fields are kept");
		assert.deepEqual(s.bad, { "builtin:1.7.0": { n: 2, at: at(NOW), why: "" } });
		assert.equal(s.starting, null);
		assert.deepEqual(s.lastAcceptedAt, { app: "", core: "" });
		s.starting = { id: "builtin:1.7.0", at: at(NOW) };
		T.writeCoreState(dir, s);
		assert.equal(fs.existsSync(file + ".tmp"), false, "core.json.tmp left behind");
		const back = T.readCoreState(dir);
		assert.deepEqual(back.starting, s.starting);
		assert.deepEqual(back.future, { x: 1 });
		assert.deepEqual(T.readCoreState(""), d, "no plugin folder → defaults");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// ---- server rows: the staged bundle on disk (loadStaged) and its evaluation (evaluateApp) ----

import crypto from "node:crypto";

const KP = crypto.generateKeyPairSync("ed25519");
const KEY = KP.publicKey.export({ format: "der", type: "spki" }).toString("hex");
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
function stageFiles(dir, code, more = {}) {
	const bytes = Buffer.from(code);
	const p = Buffer.from(JSON.stringify({ v: 1, kind: "app", version: "9.9.9", sha256: sha(bytes), size: bytes.length, force: false, minCore: 1, at: "2026-11-05T12:00:00Z", ...more }));
	const b = path.join(dir, T.BUNDLES);
	fs.mkdirSync(b, { recursive: true });
	fs.writeFileSync(path.join(b, T.STAGED_MANIFEST), JSON.stringify({ payload: p.toString("base64"), sig: crypto.sign(null, p, KP.privateKey).toString("base64") }));
	fs.writeFileSync(path.join(b, T.bundleName(sha(bytes))), bytes);
	return { file: path.join(b, T.bundleName(sha(bytes))), sha12: sha(bytes).slice(0, 12) };
}

test("loadStaged: nothing staged → null; verified only when manifest and bundle both check out", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vlb-staged-"));
	try {
		assert.equal(T.loadStaged(dir, [KEY]), null, "no bundles folder");
		assert.equal(T.loadStaged("", [KEY]), null, "no plugin folder");
		const code = "module.exports = { API: 1, createApp() { return {}; } };\n";
		const { file, sha12 } = stageFiles(dir, code);
		const S = T.loadStaged(dir, [KEY]);
		assert.equal(S.verified, true, S.why);
		assert.equal(S.id, "server:" + sha12);
		assert.equal(S.version, "9.9.9");
		assert.equal(S.at, "2026-11-05T12:00:00Z");
		assert.equal(S.code, code, "the verified bytes come with it");
		assert.equal(T.loadStaged(dir, [crypto.generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("hex")]).verified, false, "another key");
		// One byte of the bundle changed on disk: never verified, no code.
		const b = fs.readFileSync(file);
		b[3] ^= 1;
		fs.writeFileSync(file, b);
		const bad = T.loadStaged(dir, [KEY]);
		assert.equal(bad.verified, false);
		assert.equal(bad.code, undefined);
		assert.match(bad.why, /sha256/);
		fs.writeFileSync(file, Buffer.concat([Buffer.from(code), Buffer.from("x")]));
		assert.match(T.loadStaged(dir, [KEY]).why, /size/);
		fs.rmSync(file);
		assert.match(T.loadStaged(dir, [KEY]).why, /missing/);
		// The manifest damaged on disk.
		stageFiles(dir, code);
		const mf = path.join(dir, T.BUNDLES, T.STAGED_MANIFEST);
		const env = JSON.parse(fs.readFileSync(mf, "utf8"));
		const pb = Buffer.from(env.payload, "base64");
		pb[pb.length - 5] ^= 1;
		fs.writeFileSync(mf, JSON.stringify({ payload: pb.toString("base64"), sig: env.sig }));
		const m = T.loadStaged(dir, [KEY]);
		assert.equal(m.verified, false);
		assert.match(m.why, /^manifest: signature invalid/);
		fs.writeFileSync(mf, "{");
		assert.match(T.loadStaged(dir, [KEY]).why, /^manifest: /);
		// A core manifest staged as an app is never a candidate.
		stageFiles(dir, code, { kind: "core" });
		assert.match(T.loadStaged(dir, [KEY]).why, /core bundle/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("evaluateApp: the module shape of the contract, with the given require", () => {
	const mod = T.evaluateApp("const o = require('obsidian'); module.exports = { API: 2, createApp: () => o };", (id) => (id === "obsidian" ? { stub: true } : require(id)));
	assert.deepEqual(mod.createApp(), { stub: true });
	// A 1.9.x app.js (API 1) never runs on this core (F.1).
	assert.throws(() => T.evaluateApp("module.exports = { API: 1, createApp() {} };", require), /API 1/);
	assert.throws(() => T.evaluateApp("module.exports = { API: 3, createApp() {} };", require), /API 3/);
	assert.throws(() => T.evaluateApp("module.exports = { API: 2 };", require), /createApp/);
	assert.throws(() => T.evaluateApp("module.exports = {", require), SyntaxError);
	assert.throws(() => T.evaluateApp("throw new Error('top level')", require), /top level/);
});

// ---- G.4: code older than 1.9.0 is refused in both slots (it would move the private notes' server copies to _trash/) ----

test("server app 1.8.0 force → builtin, rejected (loadStaged refuses it, pick shows why)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vlb-old-"));
	try {
		const code = "module.exports = { API: 1, createApp() { return {}; } };\n";
		stageFiles(dir, code, { version: "1.8.0", force: true });
		const S = T.loadStaged(dir, [KEY]);
		assert.equal(S.verified, false);
		assert.equal(S.code, undefined, "no code comes with it");
		assert.match(S.why, /older than 1\.9\.0/);
		const p = T.pick({ safeMode: false, builtin: T.builtinCandidate("1.9.0"), server: S, bad: {}, now: NOW });
		assert.equal(p.choice, "builtin");
		assert.equal(p.serverState, "rejected");
		assert.match(p.why, /older than 1\.9\.0/);
		// The floor itself, and the first version above it.
		assert.equal(T.MIN_APP_VERSION, "1.9.0");
		stageFiles(dir, code, { version: "1.9.0" });
		assert.equal(T.loadStaged(dir, [KEY]).verified, true, "1.9.0 passes");
		stageFiles(dir, code, { version: "1.8.99", force: true });
		assert.equal(T.loadStaged(dir, [KEY]).verified, false, "1.8.99 is still older");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// The updater needs "obsidian" (requestUrl): scripts/.build/updater.cjs resolves it to this object.
globalThis.window = globalThis;
const slots = new Map(); // server path → { status, body }
const gets = [];
globalThis.__vlbObsidian = {
	requestUrl: async ({ url, method }) => {
		const sp = url.slice("https://vault.test/".length).split("/").map(decodeURIComponent).join("/");
		gets.push(`${method} ${sp}`);
		const r = slots.get(sp);
		const body = Buffer.from(r?.body ?? "");
		return { status: r?.status ?? 404, headers: {}, text: body.toString("utf8"), arrayBuffer: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) };
	},
};
const U = require("./.build/updater.cjs");
function signed(kind, version, bytes, more = {}) {
	const p = Buffer.from(JSON.stringify({ v: 1, kind, version, sha256: sha(bytes), size: bytes.length, force: false, minCore: 1, at: "2026-11-05T12:00:00Z", ...more }));
	return JSON.stringify({ payload: p.toString("base64"), sig: crypto.sign(null, p, KP.privateKey).toString("base64") });
}

test("core slot 1.8.0 → refused, main.js unchanged, lastAcceptedAt.core unchanged; app slot 1.8.0 → nothing downloaded", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vlb-slot-"));
	try {
		const mainJs = Buffer.from("module.exports = { default: class { onload() {} } }; // the installed main.js\n");
		fs.writeFileSync(path.join(dir, "main.js"), mainJs);
		fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ id: "vault-lock", version: "1.9.0" }));
		const st = T.defaults();
		st.lastAcceptedAt.core = "2026-11-01T00:00:00Z";
		const up = new U.Updater({ pluginDir: () => dir, auth: () => ({ base: "https://vault.test/", user: "u", pass: "p" }), keys: () => [KEY], req: require, state: () => st, save: () => {}, alive: () => true });

		const oldCore = Buffer.from("module.exports = { default: class { onload() {} } }; // 1.8.0\n");
		slots.set("_control/update/core/manifest.json", { status: 200, body: signed("core", "1.8.0", oldCore) });
		slots.set("_control/update/core/main.js", { status: 200, body: oldCore });
		await up.pollCoreSlot(true);
		assert.match(st.updateError, /^core: older than 1\.9\.0/);
		assert.ok(fs.readFileSync(path.join(dir, "main.js")).equals(mainJs), "main.js unchanged");
		assert.equal(fs.existsSync(path.join(dir, "main.js.prev")), false, "no copy aside");
		assert.equal(st.lastAcceptedAt.core, "2026-11-01T00:00:00Z", "lastAcceptedAt.core unchanged");
		assert.equal(st.coreInstalled, null);
		assert.ok(!gets.includes("GET _control/update/core/main.js"), "main.js was not downloaded");

		const oldApp = Buffer.from("module.exports = { API: 1, createApp() {} }; // 1.8.0\n");
		slots.set("_control/update/app/manifest.json", { status: 200, body: signed("app", "1.8.0", oldApp, { force: true }) });
		slots.set("_control/update/app/app.js", { status: 200, body: oldApp });
		await up.pollAppSlot(true);
		assert.match(st.updateError, /app: older than 1\.9\.0/);
		assert.equal(fs.existsSync(path.join(dir, T.BUNDLES)), false, "nothing staged");
		assert.equal(st.staged, null);
		assert.equal(st.lastAcceptedAt.app, "");
		assert.ok(!gets.includes("GET _control/update/app/app.js"), "app.js was not downloaded");

		// A current one in each slot goes through as before (the floor is the only change).
		gets.length = 0;
		slots.set("_control/update/app/manifest.json", { status: 200, body: signed("app", "1.9.0", oldApp, { minCore: 2 }) });
		await up.pollAppSlot(true);
		assert.equal(st.staged?.version, "1.9.0", st.updateError);
		assert.ok(gets.includes("GET _control/update/app/app.js"));
		slots.set("_control/update/core/manifest.json", { status: 200, body: signed("core", "1.9.0", oldCore, { minCore: 2 }) });
		await up.pollCoreSlot(true);
		assert.equal(st.coreInstalled?.version, "1.9.0", st.updateError);
		assert.ok(fs.readFileSync(path.join(dir, "main.js")).equals(oldCore), "the 1.9.0 core was installed");
		assert.equal(st.updateError, null);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
