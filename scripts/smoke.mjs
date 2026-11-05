// Smoke test of the built files: main.js and app.js load the way Obsidian loads them, start,
// lock (with a passphrase) and stop; the core picks the lifeboat when it must, keeps the
// vault covered until something has locked it, and its ticks, watchdog and lifeboat backup
// do what spec sections C, D and G say. Plain Node, no dependencies, a few seconds. Run
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
		async request({ url, method, body }) {
			check(url.startsWith(DAV), "request to an unexpected server: " + url);
			const p = url.slice(DAV.length).split("/").map(decodeURIComponent).join("/").replace(/\/$/, "");
			s.log.push(`${method} ${p}`);
			const wait = s.hold(method, p);
			if (wait) await wait;
			const no = s.refuse(method, p);
			if (no) return res(no);
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
		keymap: { pushScope() {}, popScope() {} },
		setting: { close() {} },
	};
	return { base, app };
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

/** A fresh document and vault, the plugin loaded from file (main.js or a test build). */
async function startPlugin(Cls, data, coreJson) {
	freshDocument();
	const { base, app } = makeVault(data, coreJson);
	const p = new Cls(app, manifest);
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
		await obsidianSetsTitle("Third - My vault - Obsidian");
		check(document.title === "Obsidian", "the cover let a note title through");
		prev.release();
		await within(loading, 10_000, "onload after reload");
		check(byId("vlb-cover").length === before, "the reload made a second cover instead of taking the old one");
		check(!left.el.isConnected && !globalThis.__vaultLock.cover, "the taken-over cover was not removed");
		check(p2.supervisor.current.locked() === true, "not locked after reload");
		await macrotask();
		noLeaks();
		const left2 = await stopPlugin(p2);
		check(left2, "no cover left after the second unload");
		noLeaks();
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

	// 7. Nothing touched the network outside the steps with a server.
	step = "7 no network";
	check(netCalls === 0, `requestUrl was called ${netCalls} times`);
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
