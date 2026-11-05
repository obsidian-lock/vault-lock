// Smoke test of the built files: main.js and app.js load the way Obsidian loads them, start,
// lock (with a passphrase) and stop; the core picks the lifeboat when it must, keeps the
// vault covered until something has locked it, and its ticks, watchdog and lifeboat backup
// do their job; signed server bundles are verified, staged, started and refused as they
// should be (with a key made here, never the real one). Plain Node, no dependencies, a few seconds. Run
// after `npm run build` and `node scripts/build-tests.mjs` (npm test does both); exits
// non-zero on the first failure.
//
// Obsidian is replaced by a small stub module. Its Component follows Obsidian's own order:
// load() runs onload() and then the children; unload() unloads the children first, then
// runs the registered cleanups, then onunload(). There is no network: requestUrl throws,
// except in the steps that put a small in-memory WebDAV server behind it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestJson = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const PLUGIN_DIR = ".obsidian/plugins/vault-lock";
const PASS = { passHash: "0".repeat(64), passSalt: "1".repeat(32) };
// A real passphrase ("right"), for unlocking the lifeboat.
const REAL_SALT = "2".repeat(32);
const REAL_PASS = { passSalt: REAL_SALT, passHash: crypto.pbkdf2Sync("right", Buffer.from(REAL_SALT, "hex"), 200_000, 32, "sha256").toString("hex") };
const DAV = "https://dav.test/";
const LOGIN = { webdavUrl: DAV, webdavUser: "d-0123456789abcdef", webdavPass: "ab".repeat(32) };
const MIN = 60_000;
// Server bundles are signed with this key; the test puts it into S.keys (UPDATE_PUBKEYS stays as built).
const TK = crypto.generateKeyPairSync("ed25519");
const TKEY = TK.publicKey.export({ format: "der", type: "spki" }).toString("hex");
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");

let step = "setup";
function check(ok, what) {
	if (!ok) throw new Error(what);
}
function within(p, ms, what) {
	let t;
	const limit = new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`${what}: not done in ${ms} ms`)), ms); });
	return Promise.race([p, limit]).finally(() => clearTimeout(t));
}

// ---- DOM: just enough for the lock screens and the cover -------------------------------

/** Every element the plugin created (createElement / createDiv / createEl), as plain records. */
let created = [];
/** Set when the cover was removed while no lock screen was up: the vault showed unlocked. */
let coverBlind = false;
/** Note titles the plugin put into the window title while something was locked or covered. */
let titleLeaks = [];
/** True while the test itself plays Obsidian setting a note title. */
let obsidianWrites = false;

const lockUp = () => byCls("vlb-overlay").some((e) => e.isConnected) || byId("vlb-lifeboat").some((e) => e.isConnected);
const hiding = () => lockUp() || byId("vlb-cover").some((e) => e.isConnected);

function el(tag, opts, track = false) {
	const o = typeof opts === "string" ? { cls: opts } : opts ?? {};
	const rec = { tag, id: "", cls: o.cls ?? "", text: o.text ?? "", title: "", value: "", disabled: false, style: {}, isConnected: false, removed: false };
	if (track) created.push(rec);
	const make = (t, x) => el(t, x, true);
	const proxy = new Proxy(rec, {
		get(r, k) {
			if (typeof k === "symbol" || k === "then") return undefined;
			if (k in r) return r[k];
			if (k === "contains") return () => false;
			if (k === "remove") return () => {
				if (r.id === "vlb-cover" && r.isConnected && !lockUp()) coverBlind = true;
				r.isConnected = false;
				r.removed = true;
			};
			if (k === "appendChild") return (c) => { c.isConnected = true; return c; };
			if (k === "createElement") return (t) => make(t);
			if (k === "createDiv") return (x) => { const c = make("div", x); c.isConnected = true; return c; };
			if (k === "createSpan") return (x) => { const c = make("span", x); c.isConnected = true; return c; };
			if (k === "createEl") return (t, x) => { const c = make(t, x); c.isConnected = true; return c; };
			return () => el("any"); // addClass, addEventListener, focus, setText, empty, ...
		},
		set(r, k, v) {
			if (k === "title" && tag === "document") {
				if (!obsidianWrites && v !== "Obsidian" && hiding()) titleLeaks.push(v);
				// A title change is a change in <head>: the title guards hear about it.
				for (const ob of observers) queueMicrotask(() => ob.cb([], ob));
			}
			r[k] = v;
			return true;
		},
	});
	return proxy;
}

globalThis.window = globalThis;
const observers = new Set();
globalThis.MutationObserver = class {
	constructor(cb) { this.cb = cb; }
	observe() { observers.add(this); }
	disconnect() { observers.delete(this); }
};

function freshDocument() {
	created = [];
	coverBlind = false;
	titleLeaks = [];
	observers.clear();
	const doc = el("document");
	doc.head = el("head");
	doc.body = el("body");
	doc.title = "Note - My vault - Obsidian";
	globalThis.document = doc;
	delete globalThis.__vaultLock;
	delete globalThis.__vaultLockStopping;
}

/** Obsidian puts a note's name into the title (it does so when a tab changes). */
async function obsidianSetsTitle(t) {
	obsidianWrites = true;
	document.title = t;
	obsidianWrites = false;
	await new Promise((r) => setTimeout(r, 0));
}

// ---- the "obsidian" module -------------------------------------------------------------

let netCalls = 0;
const cachedGets = []; // GETs the fake server saw without "Cache-Control: no-cache"
/** The in-memory WebDAV server, while a step has one. */
let server = null;

class Component {
	constructor() { this._loaded = false; this._children = []; this._events = []; }
	load() {
		if (this._loaded) return;
		this._loaded = true;
		const waits = [];
		const r = this.onload();
		if (r) waits.push(r);
		for (const c of this._children.slice()) { const x = c.load(); if (x) waits.push(x); }
		if (waits.length) return Promise.all(waits).then(() => {});
	}
	unload() {
		if (!this._loaded) return;
		this._loaded = false;
		while (this._children.length) this._children.pop().unload();
		while (this._events.length) this._events.pop()();
		this.onunload();
	}
	onload() {}
	onunload() {}
	addChild(c) { this._children.push(c); if (this._loaded) c.load(); return c; }
	removeChild(c) { const i = this._children.indexOf(c); if (i >= 0) { this._children.splice(i, 1); c.unload(); } return c; }
	register(fn) { this._events.push(fn); }
	registerEvent() { this.register(() => {}); }
	registerDomEvent() { this.register(() => {}); }
	registerInterval(id) { this.register(() => clearInterval(id)); return id; }
}

class Plugin extends Component {
	constructor(app, manifest) { super(); this.app = app; this.manifest = manifest; this.commands = []; this.tabs = []; }
	addCommand(c) { this.commands.push(c); return c; }
	addSettingTab(t) { this.tabs.push(t); }
	async loadData() {
		try { return JSON.parse(fs.readFileSync(path.join(this.app.vault.adapter.getBasePath(), PLUGIN_DIR, "data.json"), "utf8")); } catch { return null; }
	}
	async saveData(d) { fs.writeFileSync(path.join(this.app.vault.adapter.getBasePath(), PLUGIN_DIR, "data.json"), JSON.stringify(d)); }
}

function chain() {
	const p = new Proxy(function () {}, {
		get(_, k) {
			if (typeof k === "symbol" || k === "then") return undefined;
			if (k === "inputEl" || k === "buttonEl" || k === "toggleEl") return el("input");
			if (k.startsWith("add")) return (cb) => { if (typeof cb === "function") cb(chain()); return p; };
			return () => p; // setName, setDesc, setValue, onChange, onClick, ...
		},
	});
	return p;
}

class FileSystemAdapter {
	constructor(base) { this.base = base; }
	getBasePath() { return this.base; }
	getFullPath(p) { return path.join(this.base, p); }
	async exists(p) { return fs.existsSync(this.getFullPath(p)); }
	async stat(p) {
		try {
			const s = fs.statSync(this.getFullPath(p));
			return { type: s.isDirectory() ? "folder" : "file", mtime: Math.floor(s.mtimeMs), ctime: Math.floor(s.ctimeMs), size: s.size };
		} catch { return null; }
	}
	async list(p) {
		const out = { files: [], folders: [] };
		for (const d of fs.readdirSync(this.getFullPath(p), { withFileTypes: true })) {
			const rel = p && p !== "/" ? p + "/" + d.name : d.name;
			(d.isDirectory() ? out.folders : out.files).push(rel);
		}
		return out;
	}
	async read(p) { return fs.readFileSync(this.getFullPath(p), "utf8"); }
	async write(p, data) { fs.writeFileSync(this.getFullPath(p), data); }
	async readBinary(p) { const b = fs.readFileSync(this.getFullPath(p)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
	async writeBinary(p, data) { fs.writeFileSync(this.getFullPath(p), Buffer.from(data)); }
	async mkdir(p) { fs.mkdirSync(this.getFullPath(p), { recursive: true }); }
	async rename(a, b) { fs.renameSync(this.getFullPath(a), this.getFullPath(b)); }
	async remove(p) { fs.rmSync(this.getFullPath(p)); }
}

const obsidian = {
	Component,
	Plugin,
	PluginSettingTab: class { constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = el("div"); } },
	Modal: class {
		constructor(app) { this.app = app; this.titleEl = el("div"); this.contentEl = el("div"); }
		open() { this.onOpen?.(); }
		close() { this.onClose?.(); }
	},
	Notice: class { constructor() {} },
	Setting: class { constructor() { return chain(); } },
	Scope: class {},
	Platform: { isWin: false, isDesktop: true },
	FileSystemAdapter,
	TAbstractFile: class {},
	TFile: class {},
	TFolder: class {},
	requestUrl: async (req) => {
		if (server) return server.request(req);
		netCalls++;
		throw new Error("no network in the smoke test");
	},
};

/** A WebDAV folder in memory: GET, PUT, MKCOL; refuse(method, path) can answer with an error
 *  status; hold(method, path) can return a promise the answer waits for. */
function fakeServer(files = {}) {
	const s = {
		files: new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])),
		dirs: new Set(),
		log: [],
		refuse: () => 0,
		hold: () => null,
		/** drop(method, path) true: no answer at all (requestUrl throws, as when offline). */
		drop: () => false,
		async request({ url, method, body, headers }) {
			check(url.startsWith(DAV), "request to an unexpected server: " + url);
			const p = url.slice(DAV.length).split("/").map(decodeURIComponent).join("/").replace(/\/$/, "");
			s.log.push(`${method} ${p}`);
			if (method === "GET" && headers?.["Cache-Control"] !== "no-cache") cachedGets.push(p); // Chromium could answer it from its disk cache
			const wait = s.hold(method, p);
			if (wait) await wait;
			if (s.drop(method, p)) throw new Error("net::ERR_CONNECTION_RESET (test)");
			const no = s.refuse(method, p);
			if (no) return res(no);
			if (method === "PROPFIND") return p === "" || s.dirs.has(p) ? res(207) : res(404);
			if (method === "GET") return s.files.has(p) ? res(200, s.files.get(p)) : res(404);
			if (method === "PUT") { s.files.set(p, typeof body === "string" ? Buffer.from(body) : Buffer.from(body)); return res(201); }
			if (method === "MKCOL") { if (s.dirs.has(p)) return res(405); s.dirs.add(p); return res(201); }
			return res(405);
		},
		json(p) { return JSON.parse(s.files.get(p).toString("utf8")); },
		sent(method, p) { return s.log.includes(`${method} ${p}`); },
	};
	return s;
}
function res(status, buf = Buffer.alloc(0)) {
	return { status, headers: {}, text: buf.toString("utf8"), arrayBuffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), get json() { return JSON.parse(buf.toString("utf8")); } };
}

function stubRequire(id) {
	return id === "obsidian" ? obsidian : require(id);
}

/** Evaluate a built file the way Obsidian evaluates main.js. */
function evaluate(file) {
	const full = path.join(root, file);
	check(fs.existsSync(full), `${file} is missing: run npm run build and node scripts/build-tests.mjs first`);
	const m = { exports: {} };
	new Function("module", "exports", "require", fs.readFileSync(full, "utf8"))(m, m.exports, stubRequire);
	return m.exports;
}

const vaults = [];
function makeVault(data, coreJson) {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "vlb-smoke-"));
	vaults.push(base);
	fs.mkdirSync(path.join(base, PLUGIN_DIR), { recursive: true });
	fs.mkdirSync(path.join(base, "Private"));
	fs.writeFileSync(path.join(base, "Private", "Secret.md"), "secret");
	fs.writeFileSync(path.join(base, "Note.md"), "note");
	if (data) fs.writeFileSync(path.join(base, PLUGIN_DIR, "data.json"), JSON.stringify(data));
	if (coreJson) fs.writeFileSync(path.join(base, PLUGIN_DIR, "core.json"), JSON.stringify(coreJson));
	const app = {
		vault: { adapter: new FileSystemAdapter(base), configDir: ".obsidian", on: () => ({}) },
		workspace: { onLayoutReady: () => {}, on: () => ({}), iterateAllLeaves: () => {} }, // layout never ready: no backup, no dialog, no ticks
		keymap: keymap(),
		setting: { close() {} },
	};
	return { base, app };
}
/** Obsidian's keymap as far as scopes go: the top one gets the keys first; an empty one stops
 *  Obsidian's hotkeys (Ctrl+N, Ctrl+W, ...); pop takes a scope out wherever it is. */
function keymap() {
	return {
		scopes: [],
		pushScope(s) { if (this.scopes[this.scopes.length - 1] !== s) this.scopes.push(s); },
		popScope(s) { const i = this.scopes.indexOf(s); if (i >= 0) this.scopes.splice(i, 1); },
	};
}
const coreState = (base) => JSON.parse(fs.readFileSync(path.join(base, PLUGIN_DIR, "core.json"), "utf8"));

const manifest = { id: "vault-lock", name: "Vault Lock", version: manifestJson.version, dir: PLUGIN_DIR };
const BUILTIN = "builtin:" + manifest.version;
const byId = (id) => created.filter((e) => e.id === id);
const byCls = (cls) => created.filter((e) => e.cls === cls);
const macrotask = () => new Promise((r) => setTimeout(r, 0));
const iso = (t = Date.now()) => new Date(t).toISOString();
/** A stand-in for the previous copy's last backup run, ended by the test. */
function gate() {
	let release;
	const p = new Promise((r) => { release = r; });
	return { p, release };
}

/** A fresh document and vault, the plugin loaded from file (main.js or a test build).
 *  opts.keys: signing keys for server bundles; opts.before(base): runs before onload. */
async function startPlugin(Cls, data, coreJson, opts = {}) {
	freshDocument();
	const { base, app } = makeVault(data, coreJson);
	if (opts.before) opts.before(base);
	const p = new Cls(app, manifest);
	if (opts.keys) p.supervisor.keys = opts.keys;
	await within(p.load(), 10_000, "onload");
	await macrotask();
	return { p, S: p.supervisor, base, app };
}

/** Unload, wait for the stop, and clear a cover left behind (it would remove itself after 5 s). */
async function stopPlugin(p) {
	p.unload();
	const left = globalThis.__vaultLock?.cover;
	if (left) clearTimeout(left.timer);
	await within(globalThis.__vaultLock?.stopping ?? Promise.resolve(), 5_000, "stopping");
	return left;
}

// ---- signed server bundles, as server/vlb makes them -------------------------------------

/** vlb's time format: seconds, Z. Each publish gets a later one, like vlb's per-slot clock. */
let atClock = Date.parse("2026-11-05T12:00:00Z");
const vlbTime = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
function nextAt() { atClock += 1000; return vlbTime(atClock); }
function envelope(payload, key = TK.privateKey) {
	const bytes = Buffer.from(JSON.stringify(payload));
	return JSON.stringify({ payload: bytes.toString("base64"), sig: crypto.sign(null, bytes, key).toString("base64") });
}
function payloadFor(slot, bytes, more = {}) {
	return { v: 1, kind: slot, version: "9.9.9", sha256: sha256(bytes), size: bytes.length, force: false, minCore: 1, at: nextAt(), ...more };
}
/** Into a slot of the fake server: the file first, then its signed manifest (vlb's order). */
function publish(srv, slot, bytes, more = {}) {
	const p = payloadFor(slot, bytes, more);
	srv.files.set(`_control/update/${slot}/${slot === "app" ? "app.js" : "main.js"}`, Buffer.from(bytes));
	srv.files.set(`_control/update/${slot}/manifest.json`, Buffer.from(envelope(p)));
	return p;
}
/** Staged in the vault, as the updater leaves it (for the start-time checks). */
function stageLocal(base, bytes, more = {}) {
	const p = payloadFor("app", bytes, more);
	const dir = path.join(base, PLUGIN_DIR, "bundles");
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `app-${p.sha256.slice(0, 12)}.js`);
	fs.writeFileSync(file, bytes);
	fs.writeFileSync(path.join(dir, "manifest.json"), envelope(p));
	return { p, file };
}
const bundleFiles = (base) => {
	const dir = path.join(base, PLUGIN_DIR, "bundles");
	return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
};
/** Same size as bytes, other content, and it leaves a mark if it is ever evaluated. */
function evilTwin(bytes, mark) {
	const b = Buffer.alloc(bytes.length, 32);
	Buffer.from(`globalThis.${mark} = true;`).copy(b);
	return b;
}

function noLeaks() {
	check(!coverBlind, "the cover came down while nothing was locked");
	check(titleLeaks.length === 0, "a note title showed while locked or covered: " + JSON.stringify(titleLeaks));
}

async function main() {
	// 1. main.js evaluates and exports a plugin class.
	step = "1 main.js evaluates";
	const core = evaluate("main.js");
	const VaultLockPlugin = core.default;
	check(typeof VaultLockPlugin === "function", "main.js has no default export");
	check(typeof VaultLockPlugin.prototype.onload === "function", "the plugin class has no onload");

	// 2. No passphrase: the built-in app runs, no cover, no network; unload hands over.
	step = "2 start without a passphrase";
	freshDocument();
	{
		const { base, app } = makeVault(null);
		// A reload from 1.6.x: wait until its last backup run is over before doing anything.
		const old = gate();
		globalThis.__vaultLockStopping = old.p;
		const p = new VaultLockPlugin(app, manifest);
		const loading = p.load();
		await macrotask();
		await macrotask();
		check(p.supervisor.current === null && p.commands.length === 0, "started before the 1.6.x copy had stopped");
		check(!fs.existsSync(path.join(base, PLUGIN_DIR, "core.json")), "core.json written before the previous copy had stopped");
		old.release();
		await within(loading, 10_000, "onload");
		check(p.supervisor.running?.kind === "builtin", "the built-in app is not running");
		check(p.supervisor.running.id === BUILTIN, "wrong running id " + p.supervisor.running.id);
		check(p.supervisor.current && p.supervisor.current.locked() === false, "locked without a passphrase");
		check(byId("vlb-cover").length === 0, "a cover was made without a passphrase");
		check(byCls("vlb-overlay").length === 0, "a lock screen was shown without a passphrase");
		check(document.title === "Note - My vault - Obsidian", "window title changed without a passphrase");
		check(created.some((e) => e.tag === "style" && !e.removed), "the styles were not injected");
		check(p.commands.map((c) => c.id).join() === "lock,change-passphrase", "commands: " + p.commands.map((c) => c.id));
		check(p.tabs.length === 1, "no setting tab");
		p.tabs[0].display();
		// core.json: the start is recorded until it proves good (90 s) or ends cleanly.
		check(coreState(base).starting?.id === BUILTIN, "core.json does not record the start: " + JSON.stringify(coreState(base).starting));
		// A tick without a server login: no request at all, nothing switched.
		await within(p.supervisor.tick(), 5_000, "tick");
		check(p.supervisor.running?.id === BUILTIN && p.supervisor.pending === null, "the tick changed the running app");
		check(coreState(base).lastUpdateCheck, "the tick did not write core.json");
		const status = p.supervisor.coreStatus();
		check(status.running === "builtin" && status.runningId === BUILTIN && status.server === null && status.coreVersion === 1, "coreStatus: " + JSON.stringify(status));
		p.unload();
		check(coreState(base).starting === null, "a clean unload left core.json starting set (the next start would count a crash)");
		const stopping = globalThis.__vaultLock?.stopping;
		check(stopping instanceof Promise, "unload left no stopping promise for the next copy");
		check(globalThis.__vaultLockStopping instanceof Promise, "unload left no promise for 1.6.x");
		await within(stopping, 5_000, "stopping");
		await macrotask();
		check(!globalThis.__vaultLock.stopping, "the stopping promise was not cleared");
		check(!globalThis.__vaultLock.cover, "a cover was left behind without a passphrase");
		check(created.filter((e) => e.tag === "style").every((e) => e.removed), "the injected styles were not removed");
	}

	// 2b. Nothing is written to core.json before it was read: it would be replaced by defaults.
	step = "2b core.json kept until read";
	freshDocument();
	{
		const seeded = { v: 1, bad: { [BUILTIN]: { n: 2, at: iso(), why: "crash" } } };
		const { base, app } = makeVault(null, seeded);
		const p = new VaultLockPlugin(app, manifest);
		p.supervisor.save();
		check(JSON.stringify(coreState(base)) === JSON.stringify(seeded), "core.json was overwritten before it was read");
	}

	// 2c. Disabled while the app is still starting: not its fault, nothing marked bad, nothing left running.
	step = "2c unload during start";
	freshDocument();
	{
		const { base, app } = makeVault(PASS);
		const p = new VaultLockPlugin(app, manifest);
		const loading = p.load();
		for (let i = 0; i < 10_000 && !p.supervisor.inflight; i++) await Promise.resolve();
		check(p.supervisor.inflight, "never saw the app starting");
		await stopPlugin(p);
		await within(loading, 5_000, "onload");
		const st = coreState(base);
		check(!st.bad[BUILTIN] && st.starting === null, "an app stopped while starting was blamed: " + JSON.stringify(st));
		check(p.supervisor.current === null && p.supervisor.running === null, "an app runs after unload");
		check(byCls("vlb-overlay").every((e) => !e.isConnected), "a lock screen was left after unload");
	}

	// 3. With a passphrase: locked at start, private folder hidden, cover up then down; unload leaves a cover.
	step = "3 start with a passphrase";
	freshDocument();
	{
		const { base, app } = makeVault(PASS);
		const p = new VaultLockPlugin(app, manifest);
		await within(p.load(), 10_000, "onload");
		await macrotask();
		const cur = p.supervisor.current;
		check(cur && cur.locked() === true, "not locked at start");
		check(fs.existsSync(path.join(base, ".Private", "Secret.md")) && !fs.existsSync(path.join(base, "Private")), "the private folder was not hidden");
		check(byCls("vlb-overlay").some((e) => e.isConnected), "no lock screen");
		const covers = byId("vlb-cover");
		check(covers.length === 1 && covers[0].removed, "the cover was not made and then removed");
		check(app.keymap.scopes.length === 1, "keymap scopes after start: " + app.keymap.scopes.length + " (want the lock screen's only)");
		check(document.title === "Obsidian", "window title not hidden");
		check(cur.lockScreen && cur.backup && cur.backup.control && cur.privateFolder, "test handles missing");
		check(cur.host.settings === p.settings, "the app does not share the core's settings object");
		// Obsidian renames the window after a note while locked: the lock screen keeps "Obsidian".
		await obsidianSetsTitle("Other - My vault - Obsidian");
		check(document.title === "Obsidian", "the lock screen let a note title through");
		noLeaks();
		p.unload();
		check(byCls("vlb-overlay").every((e) => !e.isConnected), "the lock screen stayed after unload");
		const left = globalThis.__vaultLock?.cover;
		check(left && left.el.isConnected, "unload left no cover over the locked vault");
		// Obsidian's hotkeys run before the cover's key swallow: the cover holds an empty scope.
		check(app.keymap.scopes.length === 1, "the left cover does not stop Obsidian's hotkeys (keymap scopes: " + app.keymap.scopes.length + ")");
		noLeaks();
		await within(globalThis.__vaultLock.stopping ?? Promise.resolve(), 5_000, "stopping");

		// 3b. A reload: the next copy takes the cover over and takes it down once it has locked.
		step = "3b reload takes the cover over";
		const before = byId("vlb-cover").length;
		// The previous copy is still finishing a backup run: the new one waits, under its cover.
		const prev = gate();
		globalThis.__vaultLock = { ...globalThis.__vaultLock, stopping: prev.p };
		const p2 = new VaultLockPlugin(app, manifest);
		const loading = p2.load();
		await macrotask();
		await macrotask();
		check(p2.supervisor.current === null && p2.commands.length === 0, "the reload started before the previous copy had stopped");
		check(left.el.isConnected, "the cover came down while waiting for the previous copy");
		check(app.keymap.scopes.length === 1, "Obsidian's hotkeys work under the taken-over cover (keymap scopes: " + app.keymap.scopes.length + ")");
		await obsidianSetsTitle("Third - My vault - Obsidian");
		check(document.title === "Obsidian", "the cover let a note title through");
		prev.release();
		await within(loading, 10_000, "onload after reload");
		check(byId("vlb-cover").length === before, "the reload made a second cover instead of taking the old one");
		check(!left.el.isConnected && !globalThis.__vaultLock.cover, "the taken-over cover was not removed");
		check(p2.supervisor.current.locked() === true, "not locked after reload");
		check(app.keymap.scopes.length === 1, "keymap scopes after the reload: " + app.keymap.scopes.length + " (the taken-over cover's scope was kept?)");
		await macrotask();
		noLeaks();

		// 3c. A real disable: the left cover goes by itself after 5 s and gives Obsidian its hotkeys back.
		step = "3c disable: the left cover goes";
		const timers = [];
		const realSetTimeout = globalThis.setTimeout;
		globalThis.setTimeout = (fn, ms, ...a) => { const id = realSetTimeout(fn, ms, ...a); timers.push({ fn, id }); return id; };
		let left2;
		try { p2.unload(); left2 = globalThis.__vaultLock?.cover; } finally { globalThis.setTimeout = realSetTimeout; }
		check(left2 && left2.el.isConnected, "no cover left after the second unload");
		check(app.keymap.scopes.length === 1, "the left cover does not stop Obsidian's hotkeys (keymap scopes: " + app.keymap.scopes.length + ")");
		noLeaks();
		await within(globalThis.__vaultLock.stopping ?? Promise.resolve(), 5_000, "stopping");
		const t = timers.find((x) => x.id === left2.timer);
		check(t, "the left cover has no timer");
		clearTimeout(t.id);
		t.fn(); // the 5 s are up (this shows the vault: a disable unlocks, by design)
		check(!left2.el.isConnected && !globalThis.__vaultLock.cover, "the left cover did not go");
		check(app.keymap.scopes.length === 0, "the left cover went but left Obsidian's hotkeys off (keymap scopes: " + app.keymap.scopes.length + ")");
	}

	// 4. Safe mode remembered in core.json: the lifeboat runs, locked, with no network.
	step = "4 safe mode → lifeboat";
	{
		const { p, S, base } = await startPlugin(VaultLockPlugin, REAL_PASS, { v: 1, config: { safeMode: true } });
		check(S.running?.kind === "lifeboat" && S.running.id === "lifeboat", "not the lifeboat: " + JSON.stringify(S.running));
		check(S.current.locked() === true, "the lifeboat did not lock");
		check(byId("vlb-lifeboat").some((e) => e.isConnected), "no lifeboat lock screen");
		check(fs.existsSync(path.join(base, ".Private", "Secret.md")) && !fs.existsSync(path.join(base, "Private")), "the lifeboat did not hide the private folder");
		check(byId("vlb-cover").length === 1 && byId("vlb-cover")[0].removed, "the cover was not made and then removed");
		check(!coreState(base).starting, "the lifeboat recorded a start (it is never marked bad)");
		check(document.title === "Obsidian", "title not hidden by the lifeboat");
		await obsidianSetsTitle("Other - My vault - Obsidian");
		check(document.title === "Obsidian", "the lifeboat let a note title through");
		noLeaks();
		const lb = S.current;
		check(await lb.tryUnlock("wrong") === false && lb.locked(), "the lifeboat opened with a wrong passphrase");
		check(await lb.tryUnlock("right") === true && !lb.locked(), "the lifeboat did not open with the right passphrase");
		check(byId("vlb-lifeboat").every((e) => !e.isConnected), "the lifeboat lock screen stayed after unlock");
		check(fs.existsSync(path.join(base, "Private", "Secret.md")), "the private folder did not come back on unlock");
		check(document.title === "Other - My vault - Obsidian", "unlock did not give the title back: " + document.title);
		await lb.lock();
		check(lb.locked() && byId("vlb-lifeboat").some((e) => e.isConnected), "the lock command did not lock the lifeboat");
		check(fs.existsSync(path.join(base, ".Private", "Secret.md")), "the lock command did not hide the private folder");
		const left = await stopPlugin(p);
		check(left && left.el.isConnected, "unloading the locked lifeboat left no cover");
		noLeaks();
	}

	// 5. The built-in marked bad (twice in 24 h): the lifeboat runs.
	step = "5 built-in bad → lifeboat";
	{
		const { p, S } = await startPlugin(VaultLockPlugin, null, { v: 1, bad: { [BUILTIN]: { n: 2, at: iso(), why: "crash" } } });
		check(S.running?.kind === "lifeboat", "the bad built-in was started: " + JSON.stringify(S.running));
		check(S.current.locked() === false, "the lifeboat locked without a passphrase");
		await stopPlugin(p);
	}

	// 5b. Crash loop: a start still recorded at the next start counts once; twice → lifeboat.
	step = "5b crash accounting";
	{
		const { p, S, base } = await startPlugin(VaultLockPlugin, PASS, { v: 1, starting: { id: BUILTIN, at: iso() } });
		const bad = coreState(base).bad[BUILTIN];
		check(bad?.n === 1 && bad.why === "crash", "the crashed start was not counted: " + JSON.stringify(bad));
		check(S.running?.id === BUILTIN, "one crash already skipped the built-in");
		// 90 s later (the timer, called here directly): a good start clears its crash count.
		S.markGood(BUILTIN);
		const good = coreState(base);
		check(!good.bad[BUILTIN] && good.lastGood?.id === BUILTIN && good.starting === null, "a good start did not clear the record: " + JSON.stringify(good));
		await stopPlugin(p);
		good.bad[BUILTIN] = bad;
		fs.writeFileSync(path.join(base, PLUGIN_DIR, "core.json"), JSON.stringify(good));
		// Obsidian killed again within 90 s of start: no clean unload, the start is still recorded.
		const again = coreState(base);
		again.starting = { id: BUILTIN, at: iso() };
		const { p: p2, S: S2, base: base2 } = await startPlugin(VaultLockPlugin, PASS, again);
		check(coreState(base2).bad[BUILTIN]?.n === 2, "the second crash was not counted");
		check(S2.running?.kind === "lifeboat" && S2.current.locked(), "two crashes did not lead to the locked lifeboat");
		noLeaks();
		await stopPlugin(p2);
	}

	// 6. app.js alone: the module shape the server bundle has, started and stopped with a stub host.
	step = "6 app.js";
	freshDocument();
	{
		const mod = evaluate("app.js");
		check(mod.API === 1, "app.js API is " + mod.API);
		check(typeof mod.createApp === "function", "app.js has no createApp");
		const { app } = makeVault(null);
		let beats = 0;
		const host = {
			api: 1,
			app,
			manifest,
			settings: {
				passHash: "", passSalt: "", passCopied: "", idleMinutes: 5, lockOnBlur: false, privateFolder: "Private",
				webdavUrl: "", webdavUser: "", webdavPass: "", reconcileMinutes: 10, excludes: ".trash/\n.obsidian/workspace",
				doneCommands: [], commandLog: {},
			},
			running: { id: "server:000000000000", kind: "server", version: "0.0.0" },
			saveSettings: async () => {},
			heartbeat: () => { beats++; },
			coreStatus: () => ({}),
			isAborted: () => false,
		};
		const a = mod.createApp(host);
		for (const k of ["start", "stop", "locked", "lock", "changePassphrase", "renderSettings"]) check(typeof a[k] === "function", "app has no " + k);
		a.load(); // the core adds it as a child first
		await within(a.start(), 10_000, "app start");
		check(a.locked() === false, "app locked without a passphrase");
		a.renderSettings(el("div"));
		check(beats === 0, "heartbeat without a backup run");
		// A reconcile against a server: heartbeat once it finished and status.json was taken (D.1).
		Object.assign(host.settings, LOGIN);
		server = fakeServer();
		a.backup.onPaired(false);
		await within(a.backup.queue, 5_000, "reconcile");
		check(server.files.get("Note.md")?.toString() === "note" && server.files.has("_manifest.json"), "the app did not back up: " + server.log);
		const st = server.json("_control/status.json");
		check(st.lastReconcile?.uploaded === 2 && "core" in st, "status.json: " + JSON.stringify(st).slice(0, 200));
		check(beats === 1, `${beats} heartbeats after one finished reconcile`);
		// A run the server refuses: reported, but no heartbeat.
		server.refuse = (m, f) => (m === "PUT" && !f.startsWith("_control/") ? 507 : 0);
		fs.appendFileSync(path.join(app.vault.adapter.getBasePath(), "Note.md"), " changed");
		a.backup.requestReconcile("test");
		await within(a.backup.queue, 5_000, "reconcile");
		check(/507/.test(server.json("_control/status.json").lastError ?? ""), "the refused run was not reported");
		check(beats === 1, "heartbeat from a failed reconcile");
		server = null;
		await within(a.stop(), 5_000, "app stop");
		check(a.stop() === a.stop(), "stop() does not return the same promise");
		a.unload();
	}

	// 8. Fail closed: a built-in that throws, or starts without locking, is marked bad; the
	// lifeboat locks; the cover never comes down over an unlocked vault.
	for (const [fault, why] of [["throw-start", "throw"], ["never-lock", "unlocked"]]) {
		step = `8 built-in fault ${fault}`;
		const Faulty = evaluate(`scripts/.build/main-${fault}.js`).default;
		const { p, S, base } = await startPlugin(Faulty, PASS);
		const bad = coreState(base).bad[BUILTIN];
		check(bad?.n === 2 && bad.why === why, `${fault}: built-in not marked bad (${why}): ` + JSON.stringify(bad));
		check(S.running?.kind === "lifeboat" && S.current.locked(), `${fault}: the locked lifeboat does not run`);
		check(coreState(base).starting === null, `${fault}: the failed start is still recorded`);
		noLeaks();
		await stopPlugin(p);
	}
	step = "8 never-lock without a passphrase";
	{
		const Faulty = evaluate("scripts/.build/main-never-lock.js").default;
		const { p, S } = await startPlugin(Faulty, null);
		check(S.running?.id === BUILTIN, "without a passphrase an unlocked start is fine, but it was refused");
		await stopPlugin(p);
	}

	// 9. Core ticks against a server: config.json "core" (safe mode, watchdog minutes), then the watchdog.
	step = "9 safe mode from config.json";
	{
		const { p, S, base } = await startPlugin(VaultLockPlugin, { ...PASS, ...LOGIN });
		server = fakeServer({ "_control/config.json": JSON.stringify({ idleMinutes: 5, core: { safeMode: true, watchdogMinutes: 5 } }) });
		const coversBefore = byId("vlb-cover").length;
		await within(S.tick(), 5_000, "tick");
		check(S.state.config.safeMode === true && S.state.config.watchdogMinutes === 10, "config not read: " + JSON.stringify(S.state.config));
		check(coreState(base).config.safeMode === true, "safe mode not kept in core.json for the next start");
		check(S.running?.kind === "lifeboat" && S.current.locked(), "safe mode did not switch to the locked lifeboat at once");
		// The built-in started fine and was replaced within its first 90 s: not a crash at the next start.
		check(coreState(base).starting === null, "a switch away left core.json starting set: " + JSON.stringify(coreState(base).starting));
		check(byId("vlb-cover").length === coversBefore + 1 && byId("vlb-cover").every((e) => e.removed), "the switch did not cover the window");
		check(p.app.keymap.scopes.length === 1, "keymap scopes after the switch: " + p.app.keymap.scopes.length + " (want the lifeboat's only)");
		noLeaks();
		server.files.set("_control/config.json", Buffer.from(JSON.stringify({ core: { safeMode: false } })));
		await within(S.tick(), 5_000, "tick");
		check(S.running?.id === BUILTIN && S.current.locked(), "safe mode off did not bring the locked built-in back");
		check(S.state.config.watchdogMinutes === 120, "watchdog minutes not back to 120");
		noLeaks();
		server.files.set("_control/config.json", Buffer.from(JSON.stringify({ core: { watchdogMinutes: 30 } })));
		await within(S.tick(), 5_000, "tick");
		check(S.state.config.watchdogMinutes === 30, "watchdog minutes not taken");
		// Server trouble keeps the last values; only an explicit 404 means defaults.
		server.files.set("_control/config.json", Buffer.from(JSON.stringify({ core: { safeMode: true } })));
		server.refuse = (m, f) => (f === "_control/config.json" ? 500 : 0);
		await within(S.tick(), 5_000, "tick");
		check(S.running?.id === BUILTIN && !S.state.config.safeMode && S.state.config.watchdogMinutes === 30, "a 500 from the server changed the core settings");
		server.refuse = () => 0;
		server.files.set("_control/config.json", Buffer.from("{ half written"));
		await within(S.tick(), 5_000, "tick");
		check(S.running?.id === BUILTIN && !S.state.config.safeMode && S.state.config.watchdogMinutes === 30, "an unreadable config.json changed the core settings");
		server.files.delete("_control/config.json");
		await within(S.tick(), 5_000, "tick");
		check(S.state.config.watchdogMinutes === 120 && !S.state.config.safeMode, "a 404 did not mean defaults");

		step = "9b watchdog";
		const probes = () => server.log.filter((l) => l === "PUT _control/core-probe.json").length;
		// Fresh heartbeat: no probe at all.
		S.lastHeartbeat = Date.now();
		await within(S.tick(), 5_000, "tick");
		check(probes() === 0 && S.lastProbeOkAt === null, "probed although the backup is fresh");
		// Stale: the first good probe only notes the time.
		S.lastHeartbeat = Date.now() - 3 * 60 * MIN;
		await within(S.tick(), 5_000, "tick");
		check(probes() === 1 && S.lastProbeOkAt !== null, "a stale backup was not probed");
		const probe = server.json("_control/core-probe.json");
		check(probe.core === 1 && !Number.isNaN(Date.parse(probe.at)), "probe body: " + JSON.stringify(probe));
		check(S.running?.id === BUILTIN && !S.state.bad[BUILTIN], "blamed the app after one probe");
		// A second good probe less than 9 minutes later: still not blamed.
		await within(S.tick(), 5_000, "tick");
		check(S.running?.id === BUILTIN && !S.state.bad[BUILTIN], "blamed the app with two probes less than 9 minutes apart");
		// The server refuses writes (frozen folder): never the app's fault.
		server.refuse = (m, f) => (m === "PUT" && f === "_control/core-probe.json" ? 403 : 0);
		S.lastProbeOkAt = Date.now() - 10 * MIN;
		await within(S.tick(), 5_000, "tick");
		check(S.lastProbeOkAt === null && !S.state.bad[BUILTIN] && S.running?.id === BUILTIN, "blamed the app while the server refused writes");
		check(S.lastProbe && S.lastProbe.ok === false, "lastProbe does not show the refused probe");
		server.refuse = () => 0;
		// A heartbeat after the first probe: the app is working again (stale by now with a 10 min threshold).
		server.files.set("_control/config.json", Buffer.from(JSON.stringify({ core: { watchdogMinutes: 10 } })));
		p.settings.reconcileMinutes = 1;
		S.lastProbeOkAt = Date.now() - 12 * MIN;
		S.lastHeartbeat = Date.now() - 11 * MIN;
		await within(S.tick(), 5_000, "tick");
		check(S.state.config.watchdogMinutes === 10 && !S.state.bad[BUILTIN], "blamed an app that backed up after the first probe");
		// Asleep for 8 hours right after the first probe: the app had no time to back up, so the
		// probe after the sleep counts as the first one again.
		S.lastHeartbeat = Date.now() - 3 * 60 * MIN;
		S.lastProbeOkAt = null;
		await within(S.tick(), 5_000, "tick");
		check(S.lastProbeOkAt !== null, "no first probe");
		S.lastProbeOkAt -= 8 * 60 * MIN;
		S.lastHeartbeat -= 8 * 60 * MIN;
		await within(S.tick(), 5_000, "tick");
		check(S.running?.id === BUILTIN && !S.state.bad[BUILTIN], "blamed the app for the hours the computer slept");
		check(Date.now() - S.lastProbeOkAt < MIN, "the probe after the sleep did not count as the first one");
		// Two good probes 10 minutes apart and still no backup: sick, bad, switched at once.
		S.lastHeartbeat = Date.now() - 3 * 60 * MIN;
		S.lastProbeOkAt = null;
		await within(S.tick(), 5_000, "tick");
		S.lastProbeOkAt = Date.now() - 10 * MIN;
		await within(S.tick(), 5_000, "tick");
		const bad = S.state.bad[BUILTIN];
		check(bad?.n === 2 && bad.why === "watchdog", "the watchdog did not mark the app bad: " + JSON.stringify(bad));
		check(S.state.sick === null, "sick not cleared once the replacement runs (C.3)");
		check(S.running?.kind === "lifeboat" && S.current.locked(), "the sick app was not replaced by the locked lifeboat at once");
		check(coreState(base).bad[BUILTIN]?.why === "watchdog", "core.json does not have the watchdog's verdict");
		noLeaks();
		// The lifeboat stale too: restarted in place, never marked bad.
		const lb = S.current;
		S.lastHeartbeat = Date.now() - 3 * 60 * MIN;
		await within(S.tick(), 5_000, "tick");
		S.lastProbeOkAt = Date.now() - 10 * MIN;
		await within(S.tick(), 5_000, "tick");
		check(S.running?.kind === "lifeboat" && S.current !== lb && S.current.locked(), "a stale lifeboat was not restarted");
		check(!S.state.bad.lifeboat, "the lifeboat was marked bad");
		check(!server.log.some((l) => /^(MOVE|DELETE) /.test(l)), "something was moved or deleted: " + server.log.filter((l) => /^(MOVE|DELETE) /.test(l)));
		noLeaks();
		server = null;
		await stopPlugin(p);
	}

	// 9c. Activation (C.6): a waiting choice is switched to only once the vault is locked.
	step = "9c activation at the next lock";
	{
		const { p, S } = await startPlugin(VaultLockPlugin, PASS);
		const cur = S.current;
		S.pending = { choice: "lifeboat", serverState: "none", why: "test" };
		cur.lockScreen.locked = false; // as if unlocked by the user
		S.activationTick();
		await macrotask();
		check(S.switching === null && S.current === cur, "switched while the vault was unlocked");
		cur.lockScreen.locked = true;
		S.activationTick();
		check(S.switching, "no switch once locked");
		await within(S.switching, 5_000, "switch");
		check(S.running?.kind === "lifeboat" && S.pending === null && S.current.locked(), "the waiting choice did not become active");
		// A late heartbeat from the stopped app does not count; the running one's does.
		S.lastHeartbeat = 5;
		cur.host.heartbeat();
		check(S.lastHeartbeat === 5, "a stopped app's heartbeat counted");
		S.current.host.heartbeat();
		check(S.lastHeartbeat > 5, "the running app's heartbeat did not count");
		noLeaks();
		await stopPlugin(p);
	}

	// 9d. The right passphrase typed just as a switch starts: the app being stopped must not
	// open the private folder under the next app's lock screen.
	step = "9d unlock during a switch";
	{
		const { p, S, base } = await startPlugin(VaultLockPlugin, REAL_PASS);
		const unlocking = S.current.lockScreen.tryUnlock("right"); // the hash takes a moment
		const switching = S.switchTo("lifeboat", "test");
		check(await unlocking === false, "a stopping app accepted the passphrase");
		await within(switching, 5_000, "switch");
		check(fs.existsSync(path.join(base, ".Private", "Secret.md")) && !fs.existsSync(path.join(base, "Private")), "the private folder was opened under the new lock screen");
		check(S.running?.kind === "lifeboat" && S.current.locked(), "the lifeboat is not locked");
		noLeaks();
		await stopPlugin(p);
	}

	// 9e. Unloaded (a BRAT update) while a switch waits for the old app's last upload: the next
	// copy must wait for it too, or two copies write the index at once (C.5, E).
	step = "9e unload during a switch";
	{
		const { p, S } = await startPlugin(VaultLockPlugin, { ...PASS, ...LOGIN });
		server = fakeServer();
		const held = gate();
		let holding = false;
		server.hold = (m, f) => (m === "PUT" && f === "Note.md" ? (holding = true, held.p) : null);
		const old = S.current;
		old.backup.onPaired(false);
		for (let i = 0; i < 100 && !holding; i++) await macrotask();
		check(holding, "the upload never reached the server");
		const switching = S.switchTo("lifeboat", "test");
		await macrotask();
		p.unload();
		const left = globalThis.__vaultLock?.cover;
		if (left) clearTimeout(left.timer);
		const stopping = globalThis.__vaultLock?.stopping;
		let done = false;
		void stopping.then(() => { done = true; });
		await macrotask();
		check(!done && !old.host.isAborted(), "the unload did not wait for the app the switch was stopping");
		held.release();
		await within(stopping, 5_000, "stopping");
		await within(switching, 5_000, "switch");
		check(old.host.isAborted(), "the old app can still send after the unload");
		check(S.current === null && S.running === null, "an app runs after unload");
		server = null;
	}

	// 9f. A core tick still waiting for the server when the plugin unloads: it must not write
	// this copy's core.json over the one the next copy has written meanwhile.
	step = "9f tick in flight at unload";
	{
		const { p, S, base } = await startPlugin(VaultLockPlugin, { ...PASS, ...LOGIN });
		server = fakeServer();
		const held = gate();
		server.hold = (m, f) => (m === "GET" && f === "_control/config.json" ? held.p : null);
		const ticking = S.tick();
		await macrotask();
		await stopPlugin(p);
		const next = coreState(base);
		next.starting = { id: BUILTIN, at: iso() }; // the next copy is starting
		fs.writeFileSync(path.join(base, PLUGIN_DIR, "core.json"), JSON.stringify(next));
		held.release();
		await within(ticking, 5_000, "tick");
		check(coreState(base).starting?.id === BUILTIN, "the unloaded copy's tick overwrote core.json");
		server = null;
	}

	// 10. The lifeboat's backup: uploads new and changed files into the same index the full
	// app uses; never moves, deletes or trashes; reports in status.json; heartbeats.
	step = "10 lifeboat backup";
	{
		const { p, S, base } = await startPlugin(VaultLockPlugin, { ...PASS, ...LOGIN }, { v: 1, config: { safeMode: true } });
		check(S.running?.kind === "lifeboat", "no lifeboat");
		fs.writeFileSync(path.join(base, "Bad.md"), "the server refuses this one");
		const big = path.join(base, "Big.bin");
		fs.closeSync(fs.openSync(big, "w"));
		fs.truncateSync(big, 101 * 1024 * 1024); // sparse: over the 100 MB limit
		const note = fs.statSync(path.join(base, "Note.md"));
		server = fakeServer({ "_manifest.json": JSON.stringify({ "Gone.md": { m: 1, s: 1 }, "Note.md": { m: Math.floor(note.mtimeMs), s: note.size } }) });
		server.refuse = (m, f) => (m === "PUT" && f === "Bad.md" ? 400 : 0);
		const beat = S.lastHeartbeat = Date.now() - 60 * MIN;
		await within(S.current.run(), 5_000, "lifeboat run");
		check(server.files.get("Private/Secret.md")?.toString() === "secret", "the private note was not uploaded under its visible name");
		check(![...server.files.keys()].some((k) => k.startsWith(".Private") || k.startsWith(PLUGIN_DIR)), "uploaded what must never go: " + [...server.files.keys()]);
		check(!server.sent("PUT", "Note.md"), "re-uploaded an unchanged file");
		const index = server.json("_manifest.json");
		const sec = fs.statSync(path.join(base, ".Private", "Secret.md"));
		check(index["Private/Secret.md"]?.m === Math.floor(sec.mtimeMs) && index["Private/Secret.md"].s === 6, "index entry: " + JSON.stringify(index["Private/Secret.md"]));
		check(index["Gone.md"] && index["Note.md"], "the lifeboat removed index entries: " + Object.keys(index));
		check(!index["Bad.md"] && !index["Big.bin"], "index lists files that were not uploaded");
		check(!server.log.some((l) => /^(MOVE|DELETE|PROPPATCH|COPY) /.test(l)), "the lifeboat moved or deleted: " + server.log);
		const st = server.json("_control/status.json");
		check(st.lifeboat === true && st.locked === true && st.core?.running === "lifeboat" && st.core.runningId === "lifeboat", "status.json: " + JSON.stringify(st).slice(0, 300));
		check(st.lastReconcile?.uploaded === 1 && st.lastReconcile.trashed === 0, "lastReconcile: " + JSON.stringify(st.lastReconcile));
		check(st.lastReconcile.failed.length === 1 && st.lastReconcile.failed[0].startsWith("Bad.md") && st.lastReconcile.skipped.join() === "Big.bin", "failed/skipped: " + JSON.stringify(st.lastReconcile));
		check(/Bad\.md/.test(st.lastError ?? ""), "lastError: " + st.lastError);
		check(S.lastHeartbeat > beat, "the lifeboat run did not heartbeat");
		// Nothing changed: nothing uploaded, the index is not rewritten.
		const puts = server.log.length;
		await within(S.current.run(), 5_000, "lifeboat run");
		check(!server.log.slice(puts).some((l) => l === "PUT _manifest.json" || l === "PUT Private/Secret.md"), "a second run re-uploaded: " + server.log.slice(puts));
		// The server refuses writes: the run stops, says so in status.json, and does not heartbeat.
		server.refuse = (m, f) => (m === "PUT" && !f.startsWith("_control/") ? 403 : 0);
		fs.appendFileSync(path.join(base, "Note.md"), " changed");
		const beat2 = S.lastHeartbeat = Date.now() - 60 * MIN;
		await within(S.current.run(), 5_000, "lifeboat run");
		check(/403/.test(server.json("_control/status.json").lastError ?? ""), "a refused upload was not reported");
		check(S.lastHeartbeat === beat2, "heartbeat although nothing could be uploaded");
		server = null;
		await stopPlugin(p);
	}

	// 11. Server bundles (C.7): verified, staged, started; everything wrong is refused and
	// leaves what is staged alone. No passphrase here, so a new pick is switched to at once.
	step = "11 server bundle: stage and start";
	const appJs = fs.readFileSync(path.join(root, "app.js"));
	const variant = (n) => Buffer.concat([appJs, Buffer.from(`\n// variant ${n}\n`)]);
	{
		const { p, S, base } = await startPlugin(VaultLockPlugin, { ...LOGIN }, null, { keys: [TKEY] });
		check(S.running?.id === BUILTIN && S.coreStatus().server === null, "not the built-in at start, or a server section without a bundle");
		server = fakeServer();
		const MF = "_control/update/app/manifest.json";
		const gets = () => server.log.filter((l) => l === "GET _control/update/app/app.js").length;
		const P1 = publish(server, "app", appJs);
		const s1 = P1.sha256.slice(0, 12);
		await within(S.tick(), 5_000, "tick");
		let st = coreState(base);
		check(bundleFiles(base).join() === `app-${s1}.js,manifest.json`, "bundles/ after staging: " + bundleFiles(base));
		check(fs.readFileSync(path.join(base, PLUGIN_DIR, "bundles", "manifest.json"), "utf8") === server.files.get(MF).toString(), "bundles/manifest.json is not the envelope as received");
		check(st.staged?.sha256 === P1.sha256 && st.staged.version === "9.9.9" && st.lastAcceptedAt.app === P1.at && st.updateError === null, "core.json after staging: " + JSON.stringify(st));
		check(S.running?.kind === "server" && S.running.id === "server:" + s1 && S.running.version === "9.9.9", "the staged bundle was not started (no passphrase: at once): " + JSON.stringify(S.running));
		check(S.current.host.running.kind === "server" && S.current.backup && S.current.lockScreen, "the running app is not the server bundle");
		let cs = S.coreStatus();
		check(cs.running === "server" && cs.server?.state === "active" && cs.server.sha12 === s1 && cs.server.at === P1.at && cs.server.force === false, "coreStatus: " + JSON.stringify(cs.server));
		await within(S.tick(), 5_000, "tick");
		check(gets() === 1 && coreState(base).updateError === null, "the same bundle was fetched again");

		step = "11b refused: signature, key, replay, minCore, kind, size, sha256";
		const unchanged = (what) => {
			check(bundleFiles(base).join() === `app-${s1}.js,manifest.json` && coreState(base).staged?.sha256 === P1.sha256, `${what}: the staged bundle changed: ` + bundleFiles(base));
			check(S.running?.id === "server:" + s1, `${what}: the running app changed`);
		};
		const env = JSON.parse(server.files.get(MF).toString());
		const sig = Buffer.from(env.sig, "base64");
		sig[5] ^= 1;
		server.files.set(MF, Buffer.from(JSON.stringify({ payload: env.payload, sig: sig.toString("base64") })));
		await within(S.tick(), 5_000, "tick");
		check(/^app: signature/.test(coreState(base).updateError ?? ""), "tampered signature: " + coreState(base).updateError);
		unchanged("tampered signature");
		const other = crypto.generateKeyPairSync("ed25519").privateKey;
		server.files.set(MF, Buffer.from(envelope(payloadFor("app", variant(2)), other)));
		server.files.set("_control/update/app/app.js", variant(2));
		await within(S.tick(), 5_000, "tick");
		check(/^app: signature invalid/.test(coreState(base).updateError ?? "") && gets() === 1, "another key: " + coreState(base).updateError);
		unchanged("another key");
		publish(server, "app", variant(2), { at: vlbTime(Date.parse(P1.at) - 60_000) });
		await within(S.tick(), 5_000, "tick");
		check(/replay/.test(coreState(base).updateError ?? "") && gets() === 1, "an older manifest was taken: " + coreState(base).updateError);
		unchanged("replay");
		publish(server, "app", variant(2), { minCore: 2 });
		await within(S.tick(), 5_000, "tick");
		check(coreState(base).updateError === "app: needs core ≥ 2" && gets() === 1, "minCore 2: " + coreState(base).updateError);
		unchanged("minCore");
		publish(server, "app", variant(2), { kind: "core" });
		await within(S.tick(), 5_000, "tick");
		check(/core manifest/.test(coreState(base).updateError ?? ""), "a core manifest in the app slot: " + coreState(base).updateError);
		unchanged("kind core");
		publish(server, "app", variant(2));
		server.files.set("_control/update/app/app.js", variant(2).subarray(0, variant(2).length - 100));
		await within(S.tick(), 5_000, "tick");
		check(/size/.test(coreState(base).updateError ?? ""), "truncated app.js: " + coreState(base).updateError);
		unchanged("truncated");
		check(!bundleFiles(base).some((f) => f.endsWith(".part") || f.endsWith(".tmp")), "leftovers in bundles/");
		// Bytes that are not the signed ones are never evaluated, nor written.
		publish(server, "app", variant(3));
		server.files.set("_control/update/app/app.js", evilTwin(variant(3), "__vlbRan"));
		await within(S.tick(), 5_000, "tick");
		check(/sha256/.test(coreState(base).updateError ?? "") && globalThis.__vlbRan === undefined, "unsigned bytes: " + coreState(base).updateError);
		unchanged("sha256");

		step = "11c a new bundle replaces the old; at most one previous file";
		const P2 = publish(server, "app", variant(2));
		const s2 = P2.sha256.slice(0, 12);
		await within(S.tick(), 5_000, "tick");
		check(bundleFiles(base).join() === [`app-${s1}.js`, `app-${s2}.js`, "manifest.json"].sort().join(), "bundles/ with a previous: " + bundleFiles(base));
		check(S.running?.id === "server:" + s2 && coreState(base).previousSha12 === s1 && coreState(base).updateError === null, "the newer bundle is not running: " + JSON.stringify(S.running));
		const P3 = publish(server, "app", variant(3));
		const s3 = P3.sha256.slice(0, 12);
		await within(S.tick(), 5_000, "tick");
		check(bundleFiles(base).join() === [`app-${s2}.js`, `app-${s3}.js`, "manifest.json"].sort().join(), "more than one previous file kept: " + bundleFiles(base));
		check(S.running?.id === "server:" + s3 && coreState(base).previousSha12 === s2, "bundle 3 not running");

		step = "11d the same bytes signed again (vlb bundle publish V --force)";
		const n = gets();
		// Published again as an older version: the built-in wins now (superseded) ...
		const R1 = publish(server, "app", variant(3), { version: "1.0.0" });
		await within(S.tick(), 5_000, "tick");
		st = coreState(base);
		check(st.staged?.version === "1.0.0" && st.lastAcceptedAt.app === R1.at && gets() === n, "a re-signed manifest for the same bytes was not taken: " + JSON.stringify(st.staged));
		check(S.running?.id === BUILTIN && S.coreStatus().server?.state === "superseded", "an older unforced version still runs: " + JSON.stringify(S.running));
		// ... and forced: it runs again, without fetching anything.
		const R2 = publish(server, "app", variant(3), { version: "1.0.0", force: true });
		await within(S.tick(), 5_000, "tick");
		st = coreState(base);
		check(st.staged?.force === true && st.lastAcceptedAt.app === R2.at && gets() === n, "the forced re-publish was not taken: " + JSON.stringify(st.staged));
		check(S.running?.id === "server:" + s3 && S.running.version === "1.0.0" && S.coreStatus().server?.force === true, "the forced rollback does not run: " + JSON.stringify(S.running));
		// The older envelope again (a replay of R1): ignored.
		server.files.set(MF, Buffer.from(envelope({ ...payloadFor("app", variant(3), { version: "1.0.0" }), at: R1.at })));
		await within(S.tick(), 5_000, "tick");
		check(coreState(base).staged?.force === true && S.running?.version === "1.0.0", "a replayed envelope for the same bytes undid the rollback");

		step = "11e a damaged local file is fetched again";
		const R3 = publish(server, "app", variant(3), { version: "1.0.0", force: true });
		const R3env = server.files.get(MF);
		await within(S.tick(), 5_000, "tick");
		const f3 = path.join(base, PLUGIN_DIR, "bundles", `app-${s3}.js`);
		fs.writeFileSync(f3, evilTwin(variant(3), "__vlbRan"));
		// The older unforced envelope for the same bytes is no excuse to fetch: it would undo the rollback.
		server.files.set(MF, Buffer.from(envelope({ ...payloadFor("app", variant(3), { version: "1.0.0" }), at: R1.at })));
		await within(S.tick(), 5_000, "tick");
		st = coreState(base);
		check(/replay/.test(st.updateError ?? "") && st.staged?.force === true && st.staged.at === R3.at && gets() === n, "an older envelope for the same bytes was taken while the file was damaged: " + JSON.stringify(st));
		server.files.set(MF, R3env);
		await within(S.tick(), 5_000, "tick");
		check(sha256(fs.readFileSync(f3)) === R3.sha256 && gets() === n + 1, "the damaged bundle file was not fetched again");
		check(globalThis.__vlbRan === undefined && S.running?.id === "server:" + s3, "a damaged bundle file was evaluated or changed what runs");
		// core.json forgot the last accepted at: the staged manifest on disk still sets the floor.
		S.state.lastAcceptedAt.app = "";
		publish(server, "app", variant(2), { at: vlbTime(Date.parse(R3.at) - 1000) });
		await within(S.tick(), 5_000, "tick");
		st = coreState(base);
		check(/replay/.test(st.updateError ?? "") && st.staged?.sha256 === R3.sha256 && gets() === n + 1, "an older manifest was taken after core.json lost lastAcceptedAt: " + JSON.stringify(st));

		step = "11f unpublish only with a working login";
		server.files.delete(MF);
		server.files.delete("_control/update/app/app.js");
		server.refuse = (m, f) => (f === "_control/config.json" ? 401 : 0);
		await within(S.tick(), 5_000, "tick");
		check(bundleFiles(base).includes("manifest.json") && coreState(base).staged, "a 404 while the login fails removed the staged bundle");
		server.refuse = () => 0;
		await within(S.tick(), 5_000, "tick");
		st = coreState(base);
		check(bundleFiles(base).length === 0 && st.staged === null && st.previousSha12 === null && st.updateError === null, "unpublish left: " + bundleFiles(base) + " " + JSON.stringify(st.staged));
		check(S.running?.id === BUILTIN && S.coreStatus().server === null, "the built-in did not come back after the unpublish");

		step = "11g no answer from the server";
		server.drop = () => true;
		await within(S.tick(), 5_000, "tick");
		check(/^app: HTTP 0/.test(coreState(base).updateError ?? "") && S.running?.id === BUILTIN, "offline: " + coreState(base).updateError);
		server = null;
		noLeaks();
		await stopPlugin(p);
	}

	// 12. With a passphrase: a staged bundle waits for the next lock; one that throws or does
	// not lock is marked bad and the built-in takes over, locked; nothing shows meanwhile.
	step = "12 server bundle waits for the lock";
	{
		const { p, S, base } = await startPlugin(VaultLockPlugin, { ...PASS, ...LOGIN }, null, { keys: [TKEY] });
		server = fakeServer();
		const P1 = publish(server, "app", appJs);
		await within(S.tick(), 5_000, "tick");
		const builtin = S.current;
		builtin.lockScreen.locked = false; // unlocked by the user
		await within(S.tick(), 5_000, "tick");
		let cs = S.coreStatus();
		check(S.running?.id === BUILTIN && S.pending?.choice === "server" && cs.pending === "server" && cs.server?.state === "waiting", "not waiting for the lock: " + JSON.stringify(cs.server));
		S.activationTick();
		check(!S.switching, "switched while unlocked");
		builtin.lockScreen.locked = true;
		S.activationTick();
		await within(S.switching ?? Promise.resolve(), 5_000, "switch");
		check(S.running?.id === "server:" + P1.sha256.slice(0, 12) && S.current.locked() && S.pending === null, "the server bundle did not take over locked: " + JSON.stringify(S.running));
		check(S.coreStatus().server?.state === "active", "not active");
		noLeaks();
		for (const [fault, why] of [["throw-start", "throw"], ["never-lock", "unlocked"]]) {
			step = `12 server bundle fault ${fault}`;
			const bytes = fs.readFileSync(path.join(root, `scripts/.build/app-${fault}.js`));
			const P = publish(server, "app", bytes, { force: true });
			const id = "server:" + P.sha256.slice(0, 12);
			await within(S.tick(), 5_000, "tick");
			check(S.pending?.choice === "server", `${fault}: not waiting`);
			S.activationTick();
			await within(S.switching ?? Promise.resolve(), 5_000, "switch");
			const bad = coreState(base).bad[id];
			check(bad?.n === 2 && bad.why === why, `${fault}: not marked bad (${why}): ` + JSON.stringify(bad));
			check(S.running?.id === BUILTIN && S.current.locked(), `${fault}: the built-in did not take over locked: ` + JSON.stringify(S.running));
			check(S.coreStatus().server?.state === "bad", `${fault}: server state ` + S.coreStatus().server?.state);
			noLeaks();
		}
		server = null;
		await stopPlugin(p);
	}

	// 13. Re-verified at every start (F.2): a staged bundle runs from the start; changed on disk,
	// or signed by a key the plugin does not know, it is never evaluated.
	step = "13 staged bundle re-verified at start";
	{
		const code = variant(13);
		let staged;
		const { p, S, base, app } = await startPlugin(VaultLockPlugin, PASS, null, { keys: [TKEY], before: (b) => { staged = stageLocal(b, code); } });
		check(S.running?.kind === "server" && S.running.version === "9.9.9" && S.current.locked(), "a staged bundle did not run from the start: " + JSON.stringify(S.running));
		check(coreState(base).starting?.id === "server:" + staged.p.sha256.slice(0, 12), "the server start is not recorded");
		await stopPlugin(p);
		const restart = async (keys) => {
			freshDocument();
			const q = new VaultLockPlugin(app, manifest);
			if (keys) q.supervisor.keys = keys;
			await within(q.load(), 10_000, "onload");
			await macrotask();
			return q;
		};
		fs.writeFileSync(staged.file, evilTwin(code, "__vlbRan"));
		let q = await restart([TKEY]);
		check(globalThis.__vlbRan === undefined, "a bundle changed on disk was evaluated");
		let cs = q.supervisor.coreStatus();
		check(q.supervisor.running?.id === BUILTIN && q.supervisor.current.locked() && cs.server?.state === "rejected" && /sha256/.test(cs.server.why), "changed on disk: " + JSON.stringify(cs.server));
		// A switch ordered to "server" (a pick made before the file changed) re-checks too: the
		// built-in starts again, nothing is evaluated, and the bundle is not blamed for it.
		await within(q.supervisor.switchTo("server", "test"), 5_000, "switch");
		check(globalThis.__vlbRan === undefined && q.supervisor.running?.id === BUILTIN && q.supervisor.current.locked(), "a forced switch evaluated or started a changed bundle");
		check(!Object.keys(coreState(base).bad).some((k) => k.startsWith("server:")), "an unverified bundle was marked bad instead of skipped: " + JSON.stringify(coreState(base).bad));
		noLeaks();
		await stopPlugin(q);
		fs.writeFileSync(staged.file, code);
		q = await restart(null); // only the key built into main.js
		cs = q.supervisor.coreStatus();
		check(q.supervisor.running?.id === BUILTIN && cs.server?.state === "rejected" && /signature/.test(cs.server.why), "a bundle signed with an unknown key: " + JSON.stringify(cs.server));
		await stopPlugin(q);
	}

	// 14. Core bundles (H): main.js replaced only by one that is signed, compiles and loads.
	step = "14 core bundle";
	{
		const mainJs = fs.readFileSync(path.join(root, "main.js"));
		const dir = (b) => path.join(b, PLUGIN_DIR);
		const { p, S, base } = await startPlugin(VaultLockPlugin, { ...LOGIN }, null, {
			keys: [TKEY],
			before: (b) => {
				fs.writeFileSync(path.join(dir(b), "main.js"), mainJs);
				fs.writeFileSync(path.join(dir(b), "manifest.json"), JSON.stringify(manifestJson, null, "\t"));
			},
		});
		server = fakeServer();
		const mainNow = () => fs.readFileSync(path.join(dir(base), "main.js"));
		const fetches = () => server.log.filter((l) => l === "GET _control/update/core/main.js").length;
		const C0 = publish(server, "core", mainJs, { version: "1.7.0" });
		await within(S.tick(), 5_000, "tick");
		let st = coreState(base);
		check(st.coreInstalled?.sha12 === C0.sha256.slice(0, 12) && fetches() === 0 && !fs.existsSync(path.join(dir(base), "main.js.prev")), "the installed main.js was not recognised: " + JSON.stringify(st.coreInstalled));
		const newMain = Buffer.concat([mainJs, Buffer.from("\n// core 1.7.1\n")]);
		const C1 = publish(server, "core", newMain, { version: "1.7.1" });
		await within(S.tick(), 5_000, "tick");
		st = coreState(base);
		check(mainNow().equals(newMain) && fs.readFileSync(path.join(dir(base), "main.js.prev")).equals(mainJs), "main.js not replaced (or main.js.prev not the old one)");
		check(JSON.parse(fs.readFileSync(path.join(dir(base), "manifest.json"), "utf8")).version === "1.7.1", "manifest.json version not patched");
		check(st.coreInstalled?.version === "1.7.1" && st.lastAcceptedAt.core === C1.at && st.updateError === null, "core.json after install: " + JSON.stringify(st));
		check(!fs.existsSync(path.join(dir(base), "main.js.part")) && S.running?.id === BUILTIN, "main.js.part left, or the running app changed");
		// manifest.json's version lost after the install (a failed patch): put right at the next tick.
		fs.writeFileSync(path.join(dir(base), "manifest.json"), JSON.stringify({ ...manifestJson, version: "1.7.0" }, null, "\t"));
		await within(S.tick(), 5_000, "tick");
		check(JSON.parse(fs.readFileSync(path.join(dir(base), "manifest.json"), "utf8")).version === "1.7.1" && coreState(base).updateError === null && fetches() === 1, "manifest.json version not put right after the install");
		// BRAT put its own main.js back since: the same manifest is never applied a second time.
		fs.writeFileSync(path.join(dir(base), "main.js"), mainJs);
		await within(S.tick(), 5_000, "tick");
		check(mainNow().equals(mainJs) && /applied before/.test(coreState(base).updateError ?? ""), "a core bundle was applied twice: " + coreState(base).updateError);
		fs.writeFileSync(path.join(dir(base), "main.js"), newMain);
		const refused = async (bytes, re, what, more = {}) => {
			publish(server, "core", bytes, { version: "1.7.2", ...more });
			await within(S.tick(), 5_000, "tick");
			check(re.test(coreState(base).updateError ?? ""), `${what}: ` + coreState(base).updateError);
			check(mainNow().equals(newMain) && !fs.existsSync(path.join(dir(base), "main.js.part")), `${what}: main.js was touched`);
		};
		await refused(Buffer.from("module.exports = {\n"), /^core: does not compile/, "syntax error");
		await refused(Buffer.from("throw new Error('top level');\n"), /^core: does not load/, "top level throws");
		await refused(Buffer.from("module.exports = { default: 5 };\n"), /^core: does not load/, "no plugin class");
		const good = Buffer.concat([mainJs, Buffer.from("\n// core 1.7.3\n")]);
		// Signed for the app slot, put in the core slot: refused before anything is fetched.
		const f0 = fetches();
		await refused(good, /core slot holds an app manifest/, "kind app", { kind: "app" });
		check(fetches() === f0, "main.js was fetched for an app manifest in the core slot");
		publish(server, "core", good, { version: "1.7.3" });
		server.files.set("_control/update/core/main.js", evilTwin(good, "__vlbCoreRan"));
		await within(S.tick(), 5_000, "tick");
		check(/^core: sha256/.test(coreState(base).updateError ?? "") && globalThis.__vlbCoreRan === undefined && mainNow().equals(newMain), "unsigned main.js bytes: " + coreState(base).updateError);
		await refused(good, /^core: manifest older/, "replay", { at: vlbTime(Date.parse(C1.at) - 1000) });
		server.files.delete("_control/update/core/manifest.json");
		await within(S.tick(), 5_000, "tick");
		check(coreState(base).updateError === null, "a 404 in the core slot did not clear its error");
		server = null;
		await stopPlugin(p);
	}

	// 15. One file never holds up the backup: smallest first, and a file whose upload gets no
	// answer while the server does answer is counted as failed; the run goes on. Without an
	// answer from the server either, the run stops (as before). Full app, then the lifeboat.
	step = "15 one slow file, full app";
	freshDocument();
	{
		const mod = evaluate("app.js");
		const { app } = makeVault(null);
		const vb = app.vault.adapter.getBasePath();
		fs.writeFileSync(path.join(vb, "Mid.bin"), Buffer.alloc(5_000, 1));
		fs.writeFileSync(path.join(vb, "Big.bin"), Buffer.alloc(9_000, 2));
		let beats = 0;
		const host = {
			api: 1, app, manifest,
			settings: { passHash: "", passSalt: "", passCopied: "", idleMinutes: 5, lockOnBlur: false, privateFolder: "Private", reconcileMinutes: 10, excludes: "", doneCommands: [], commandLog: {}, ...LOGIN },
			running: { id: "server:000000000000", kind: "server", version: "0.0.0" },
			saveSettings: async () => {}, heartbeat: () => { beats++; }, coreStatus: () => ({}), isAborted: () => false,
		};
		const a = mod.createApp(host);
		a.load();
		await within(a.start(), 10_000, "app start");
		server = fakeServer();
		server.drop = (m, f) => m === "PUT" && f === "Mid.bin";
		a.backup.onPaired(false);
		await within(a.backup.queue, 5_000, "reconcile");
		const puts = server.log.filter((l) => l.startsWith("PUT ") && !l.includes("_control") && !l.includes("_manifest"));
		check(puts.join() === "PUT Note.md,PUT Private/Secret.md,PUT Mid.bin,PUT Big.bin", "not smallest first: " + puts);
		check(server.files.has("Big.bin") && !server.files.has("Mid.bin") && server.sent("PROPFIND", ""), "a file without an answer stopped the run: " + server.log);
		const st = server.json("_control/status.json");
		check(st.lastReconcile?.failed.length === 1 && st.lastReconcile.failed[0].startsWith("Mid.bin") && st.lastReconcile.uploaded === 3, "lastReconcile: " + JSON.stringify(st.lastReconcile));
		check(beats === 1, `${beats} heartbeats`);
		// The server gone too: the run stops at that file, nothing after it, no heartbeat.
		server.drop = (m, f) => (m === "PUT" && f === "Mid.bin") || m === "PROPFIND";
		fs.appendFileSync(path.join(vb, "Big.bin"), "more");
		a.backup.requestReconcile("test");
		await within(a.backup.queue, 5_000, "reconcile");
		check(server.files.get("Big.bin").length === 9_000 && beats === 1, "the run went on although the server did not answer");
		server = null;
		await within(a.stop(), 5_000, "app stop");
		a.unload();
	}
	step = "15b one slow file, lifeboat";
	{
		const { p, S, base } = await startPlugin(VaultLockPlugin, { ...LOGIN }, { v: 1, config: { safeMode: true } });
		check(S.running?.kind === "lifeboat", "no lifeboat");
		fs.writeFileSync(path.join(base, "Mid.bin"), Buffer.alloc(5_000, 1));
		fs.writeFileSync(path.join(base, "Big.bin"), Buffer.alloc(9_000, 2));
		server = fakeServer();
		server.drop = (m, f) => m === "PUT" && f === "Mid.bin";
		const beat = S.lastHeartbeat = 1;
		await within(S.current.run(), 5_000, "lifeboat run");
		const puts = server.log.filter((l) => l.startsWith("PUT ") && !l.includes("_control") && !l.includes("_manifest"));
		check(puts.join() === "PUT Note.md,PUT Private/Secret.md,PUT Mid.bin,PUT Big.bin", "lifeboat not smallest first: " + puts);
		check(server.files.has("Big.bin") && !server.files.has("Mid.bin"), "lifeboat: a file without an answer stopped the run");
		check(server.json("_control/status.json").lastReconcile.failed[0].startsWith("Mid.bin") && S.lastHeartbeat > beat, "lifeboat: Mid.bin not reported, or no heartbeat");
		server.drop = (m, f) => (m === "PUT" && f === "Mid.bin") || m === "MKCOL";
		fs.appendFileSync(path.join(base, "Big.bin"), "more");
		const beat2 = S.lastHeartbeat = 1;
		await within(S.current.run(), 5_000, "lifeboat run");
		check(server.files.get("Big.bin").length === 9_000 && S.lastHeartbeat === beat2, "lifeboat: the run went on although the server did not answer");
		server = null;
		await stopPlugin(p);
	}

	// 7. Nothing touched the network outside the steps with a server.
	step = "7 no network";
	check(netCalls === 0, `requestUrl was called ${netCalls} times`);
	check(cachedGets.length === 0, "GET without Cache-Control: no-cache: " + [...new Set(cachedGets)].join(", "));
}

const guard = setTimeout(() => { console.error(`smoke test FAILED at ${step}: timed out`); process.exit(1); }, 30_000);
function cleanUp() {
	for (const v of vaults) fs.rmSync(v, { recursive: true, force: true });
}
const started = Date.now();
main().then(() => {
	clearTimeout(guard);
	cleanUp();
	console.log(`smoke test passed (${((Date.now() - started) / 1000).toFixed(1)} s)`);
	process.exit(0);
}, (e) => {
	console.error(`smoke test FAILED at ${step}:`, e?.stack ?? e);
	cleanUp();
	process.exit(1);
});
