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

test("pick: the table of spec C.1", () => {
	const S = server("9.9.9");
	const rows = [
		["no server", {}, "builtin", "none"],
		["server 9.9.9 verified", { server: S }, "server", "waiting"],
		["server 9.9.9 running", { server: S, runningId: S.id }, "server", "active"],
		["server 1.7.0 (tie)", { server: server("1.7.0") }, "builtin", "superseded"],
		["server 1.6.9 unforced", { server: server("1.6.9") }, "builtin", "superseded"],
		["server 1.6.9 force", { server: server("1.6.9", { force: true }) }, "server", "waiting"],
		["server unverified", { server: server("9.9.9", { verified: false, why: "signature invalid" }) }, "builtin", "rejected"],
		["server minCore 2", { server: server("9.9.9", { minCore: 2 }) }, "builtin", "rejected"],
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
	assert.equal(pick({ server: server("9.9.9", { minCore: 2 }) }).why, "needs core ≥ 2");
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
