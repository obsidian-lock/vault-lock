// File recovery's snapshots of private notes (F.6, src/app/fileRecovery.ts): only rows whose path
// is under the private folder go, plus the exact paths and folders asked for (where notes moved
// into the folder came from); anything unexpected (no IndexedDB, no database, no store, no
// index, an open that throws) gives null, never a throw, and touches nothing. The module is
// bundled here on its own (into scripts/.build/) and runs against the small in-memory IndexedDB
// of scripts/fake-idb.mjs, which follows the browser's rules (auto-commit, an aborted upgrade
// creates nothing).
// Run with: node --test scripts/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { backupsDb, fakeIDB, withIDB } from "./fake-idb.mjs";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "scripts/.build/fileRecovery.cjs");
await esbuild.build({
	absWorkingDir: root,
	entryPoints: ["src/app/fileRecovery.ts"],
	outfile: out,
	bundle: true,
	format: "cjs",
	platform: "node",
	target: "es2020",
	logLevel: "warning",
	plugins: [{
		name: "obsidian-stub",
		setup(b) {
			b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "stub" }));
			b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "module.exports = {};", loader: "js" }));
		},
	}],
});
const { deleteFileRecoveryRows } = require(out);

const APP = { appId: "0a1b2c3d4e5f" };
const DB = APP.appId + "-backup";
/** File recovery's rows: snapshots of private notes and of notes that only look like them. */
function backups() {
	return backupsDb([
		"Private/Secret.md", "Private/Secret.md", "Private/Sub/Deep.md", "Private/Ünïcode ✓.md",
		"Private.md", "PrivateNotes/Plan.md", "Private0/a.md", "Notes/Private/x.md", "Welcome.md", ".Private/Old.md",
	]);
}
const left = (dbs) => [...dbs[DB].stores.backups.rows.values()].map((v) => v.path).sort();

test("no IndexedDB (Node, a test): null, no throw", async () => {
	await withIDB(null, async () => {
		assert.equal(await deleteFileRecoveryRows(APP, ["Private/"]), null);
	});
});

test("only the snapshots under Private/ are deleted", async () => {
	const dbs = { [DB]: backups() };
	const { factory, log } = fakeIDB(dbs);
	const n = await withIDB(factory, () => deleteFileRecoveryRows(APP, ["Private/"]));
	assert.equal(n, 4, "two snapshots of Secret.md, Sub/Deep.md and the unicode name");
	assert.deepEqual(left(dbs), [".Private/Old.md", "Notes/Private/x.md", "Private.md", "Private0/a.md", "PrivateNotes/Plan.md", "Welcome.md"]);
	assert.deepEqual(log.opened, [DB], "the database is <appId>-backup");
	assert.ok(log.closed >= 1, "the database was not closed");
	assert.equal(log.transactions.at(-1).state, "committed");
	// A second run finds nothing more.
	const again = await withIDB(fakeIDB(dbs).factory, () => deleteFileRecoveryRows(APP, ["Private/"]));
	assert.equal(again, 0);
});

test("no such database: null, and none is created", async () => {
	const dbs = {};
	const { factory, log } = fakeIDB(dbs);
	assert.equal(await withIDB(factory, () => deleteFileRecoveryRows(APP, ["Private/"])), null);
	assert.deepEqual(log.opened, [DB]);
	assert.ok(!(DB in dbs), "the open created a database");
});

test("no store, or no path index (Obsidian changed): null, nothing deleted", async () => {
	for (const def of [{ stores: { other: { indexes: { path: "path" }, rows: new Map([[1, { path: "Private/a.md" }]]) } } }, (() => { const d = backups(); d.stores.backups.indexes = { ts: "ts" }; return d; })()]) {
		const dbs = { [DB]: def };
		const before = JSON.stringify([...Object.values(def.stores)].map((s) => [...s.rows.keys()]));
		const { factory, log } = fakeIDB(dbs);
		assert.equal(await withIDB(factory, () => deleteFileRecoveryRows(APP, ["Private/"])), null);
		assert.equal(JSON.stringify([...Object.values(def.stores)].map((s) => [...s.rows.keys()])), before, "rows changed");
		assert.ok(log.closed >= 1, "the database was not closed");
	}
});

test("an open that throws, or no appId: null, no throw", async () => {
	const dbs = { [DB]: backups() };
	assert.equal(await withIDB(fakeIDB(dbs, { openThrows: true }).factory, () => deleteFileRecoveryRows(APP, ["Private/"])), null);
	assert.equal(await withIDB(fakeIDB(dbs).factory, () => deleteFileRecoveryRows({}, ["Private/"])), null);
	assert.equal(left(dbs).length, 10, "rows changed");
	assert.deepEqual(Object.keys(dbs), [DB], "a database was created");
});

test("moved notes: exact old paths and folders (a key ending in /) go with the private rows; neighbours stay", async () => {
	const dbs = { [DB]: backupsDb(["Private/Secret.md", "Diary.md", "Diary.md", "Diary.md.bak", "Drafts/Plan.md", "Drafts/Sub/Deep.md", "Drafts2/x.md", "Welcome.md", ".Private/Old.md"]) };
	const { factory, log } = fakeIDB(dbs);
	// "Drafts/Plan.md" and "Private/Sub/" are covered by their folder keys: each row goes (and counts) once.
	const n = await withIDB(factory, () => deleteFileRecoveryRows(APP, ["Private/", ".Private/", "Diary.md", "Drafts/", "Drafts/Plan.md", "Private/Sub/", "Gone.md", "Private/", ""]));
	assert.equal(n, 6, "Secret, two Diary snapshots, Drafts/Plan, Drafts/Sub/Deep, .Private/Old");
	assert.deepEqual(left(dbs), ["Diary.md.bak", "Drafts2/x.md", "Welcome.md"]);
	assert.equal(log.transactions.length, 1, "one transaction for every key");
	assert.equal(log.transactions[0].state, "committed");
	// No keys at all: nothing is opened.
	assert.equal(await withIDB(fakeIDB(dbs).factory, () => deleteFileRecoveryRows(APP, [])), null);
});
