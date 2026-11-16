// Smoke test of the built files: main.js and app.js load the way Obsidian loads them, start,
// lock (with a passphrase) and stop; the core picks the lifeboat when it must, keeps the
// vault covered until something has locked it, and its ticks, watchdog and lifeboat backup
// do their job; signed server bundles are verified, staged, started and refused as they
// should be (with a key made here, never the real one). Since 1.9.0 also the encryption of
// the private folder (cases 16-24c): the key from the server, the backup gate while locked,
// the stray merge, a stop at every step of a file's transformation, the pair rule, the kill
// switch, the lifeboat, the quit task, the deferred restore and one pass at a time. Plain
// Node, no dependencies, about a minute (one case waits out the 30 s rename retry). Run
// after `npm run build` and `node scripts/build-tests.mjs` (npm test does both); exits
// non-zero on the first failure.
//
// Obsidian is replaced by a small stub module. Its Component follows Obsidian's own order:
// load() runs onload() and then the children; unload() unloads the children first, then
// runs the registered cleanups, then onunload(). There is no network: requestUrl throws,
// except in the steps that put a small in-memory WebDAV server behind it. The plugin gets
// its own view of Node's fs (fsShim), so a case can watch, slow down or fail its file
// operations; the test's own fs calls go straight to disk. Platform.isWin is the real one,
// so on Windows the hidden attribute is set and cleared for real.

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, what) {
	const end = Date.now() + ms;
	while (!pred()) {
		if (Date.now() > end) throw new Error(`${what}: not seen in ${ms} ms`);
		await sleep(10);
	}
}

/** Every console.log line, for the fault stops ("[VLB] fault stop STEP"). Still printed. */
const consoleLines = [];
const realLog = console.log;
console.log = (...a) => {
	consoleLines.push(a.map((x) => (typeof x === "string" ? x : String(x))).join(" "));
	realLog(...a);
};

// ---- hooks into the plugin's file operations --------------------------------------------

/** fs(name, args, isAsync) and adapter(name, args): return a delay in ms, or throw to fail the
 *  call. folderRenamed(direction): after the vault's private folder was renamed ("show": back
 *  to Private/, "hide": to .Private/), by the adapter or by fs. log: [name, path] of every call. */
const hooks = { fs: null, adapter: null, folderRenamed: null, log: null };
function resetHooks() {
	hooks.fs = hooks.adapter = hooks.folderRenamed = hooks.log = null;
	saveFail.data = saveFail.bak = 0;
}
/** A path as the plugin gave it to fs, with "/" and without Windows' \\?\ prefix. */
const norm = (p) => String(p).replace(/^\\\\\?\\/, "").split("\\").join("/");
const isDelay = (r) => typeof r === "number" && r > 0;
function busyWait(ms) { const end = Date.now() + ms; while (Date.now() < end) { /* a sync call can only be slowed this way */ } }
function folderRename(a, b) {
	const from = path.posix.basename(norm(a)), to = path.posix.basename(norm(b));
	if (from === ".Private" && to === "Private") return "show";
	if (from === "Private" && to === ".Private") return "hide";
	return null;
}
function hookedFs(real, isAsync, promisesShim) {
	return new Proxy(real, {
		get(t, k) {
			if (k === "promises" && promisesShim) return promisesShim;
			const v = Reflect.get(t, k);
			if (typeof k !== "string" || typeof v !== "function" || /^[A-Z]/.test(k)) return v;
			const d = Reflect.getOwnPropertyDescriptor(t, k);
			if (d && d.configurable === false && d.writable === false) return v;
			const call = (a) => {
				const r = v.apply(t, a);
				if (/^rename/.test(k) && hooks.folderRenamed && folderRename(a[0], a[1])) {
					const dir = folderRename(a[0], a[1]);
					if (isAsync && r && typeof r.then === "function") return r.then((x) => { hooks.folderRenamed?.(dir); return x; });
					hooks.folderRenamed(dir);
				}
				return r;
			};
			const w = function (...a) {
				hooks.log?.push([k, ...a.filter((x) => typeof x === "string").map(norm)]);
				if (isAsync) {
					let r;
					try { r = hooks.fs?.(k, a, true); } catch (e) { return Promise.reject(e); }
					return isDelay(r) ? sleep(r).then(() => call(a)) : call(a);
				}
				const r = hooks.fs?.(k, a, false);
				if (isDelay(r)) busyWait(r);
				return call(a);
			};
			Object.assign(w, v); // realpathSync.native and the like
			return w;
		},
	});
}
const fsPromisesShim = hookedFs(fs.promises, true, null);
const fsShim = hookedFs(fs, false, fsPromisesShim);
/** saveData (data.json) / adapter.write of data.bak.json fail this many times while the settings hold a vault key. */
const saveFail = { data: 0, bak: 0 };

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
			if (k === "setText") return (t) => { r.text = String(t ?? ""); }; // the lock screen's error and progress line
			return () => el("any"); // addClass, addEventListener, focus, empty, ...
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
	resetHooks();
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
	addRibbonIcon(icon, title, callback) { (this.ribbon ??= []).push({ icon, title, callback }); return el("div"); }
	addSettingTab(t) { this.tabs.push(t); }
	async loadData() {
		try { return JSON.parse(fs.readFileSync(path.join(this.app.vault.adapter.getBasePath(), PLUGIN_DIR, "data.json"), "utf8")); } catch { return null; }
	}
	async saveData(d) {
		if (saveFail.data > 0 && d?.vaultKey) { saveFail.data--; throw new Error("EACCES: data.json cannot be written (test)"); }
		fs.writeFileSync(path.join(this.app.vault.adapter.getBasePath(), PLUGIN_DIR, "data.json"), JSON.stringify(d));
	}
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

/** Obsidian's adapter over a real folder. Every call goes through hooks.adapter / hooks.log. */
class FileSystemAdapter {
	constructor(base) { this.base = base; }
	getBasePath() { return this.base; }
	getFullPath(p) { return path.join(this.base, p); }
	async hook(name, ...a) {
		hooks.log?.push(["adapter." + name, ...a.filter((x) => typeof x === "string")]);
		const r = hooks.adapter?.(name, a);
		if (isDelay(r)) await sleep(r);
	}
	async exists(p) { await this.hook("exists", p); return fs.existsSync(this.getFullPath(p)); }
	async stat(p) {
		await this.hook("stat", p);
		try {
			const s = fs.statSync(this.getFullPath(p));
			return { type: s.isDirectory() ? "folder" : "file", mtime: Math.floor(s.mtimeMs), ctime: Math.floor(s.ctimeMs), size: s.size };
		} catch { return null; }
	}
	async list(p) {
		await this.hook("list", p);
		const out = { files: [], folders: [] };
		for (const d of fs.readdirSync(this.getFullPath(p), { withFileTypes: true })) {
			const rel = p && p !== "/" ? p + "/" + d.name : d.name;
			(d.isDirectory() ? out.folders : out.files).push(rel);
		}
		return out;
	}
	async read(p) { await this.hook("read", p); return fs.readFileSync(this.getFullPath(p), "utf8"); }
	async write(p, data, opts) {
		await this.hook("write", p);
		if (saveFail.bak > 0 && p.endsWith("data.bak.json") && /"vaultKey":\{/.test(data)) { saveFail.bak--; throw new Error("EACCES: data.bak.json cannot be written (test)"); }
		fs.writeFileSync(this.getFullPath(p), data);
		if (opts?.mtime) fs.utimesSync(this.getFullPath(p), new Date(), opts.mtime / 1000);
	}
	async readBinary(p) { await this.hook("readBinary", p); const b = fs.readFileSync(this.getFullPath(p)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }
	async writeBinary(p, data, opts) {
		await this.hook("writeBinary", p);
		fs.writeFileSync(this.getFullPath(p), Buffer.from(data));
		// DataWriteOptions.mtime, as Obsidian honours it (a restore keeps the server copy's time).
		if (opts?.mtime) fs.utimesSync(this.getFullPath(p), new Date(), opts.mtime / 1000);
	}
	async mkdir(p) { await this.hook("mkdir", p); fs.mkdirSync(this.getFullPath(p), { recursive: true }); }
	async rename(a, b) {
		await this.hook("rename", a, b);
		fs.renameSync(this.getFullPath(a), this.getFullPath(b));
		const dir = folderRename(a, b);
		if (dir) hooks.folderRenamed?.(dir);
	}
	async remove(p) { await this.hook("remove", p); fs.rmSync(this.getFullPath(p)); }
	/** Not recursive: fails on a folder that is not empty, as Obsidian's does. */
	async rmdir(p, recursive) {
		await this.hook("rmdir", p);
		if (recursive) fs.rmSync(this.getFullPath(p), { recursive: true });
		else fs.rmdirSync(this.getFullPath(p));
	}
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
	// The real platform: on the Windows runners attrib.exe and the hidden-file rules are exercised for real.
	Platform: { isWin: process.platform === "win32", isDesktop: true },
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
		/** [path, body] of every PUT, in order. */
		bodies: [],
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
			if (method === "PUT") { const b = Buffer.from(body); s.bodies.push([p, b]); s.files.set(p, b); return res(201); }
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
	if (id === "obsidian") return obsidian;
	if (id === "fs" || id === "node:fs") return fsShim;
	if (id === "fs/promises" || id === "node:fs/promises") return fsPromisesShim;
	return require(id);
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
	return { base, app: makeApp(base) };
}
/** Obsidian's app over a vault folder. workspace.on keeps the callbacks in handlers (the quit task). */
function makeApp(base) {
	const handlers = {};
	return {
		handlers,
		vault: { adapter: new FileSystemAdapter(base), configDir: ".obsidian", on: () => ({}) },
		workspace: {
			onLayoutReady: () => {}, // layout never ready: no backup, no dialog, no ticks
			on: (name, cb) => { (handlers[name] ??= []).push(cb); return {}; },
			iterateAllLeaves: () => {},
		},
		keymap: keymap(),
		setting: { close() {} },
	};
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

/** Dotted versions compared segment by segment (src/shared/version.ts). */
function cmpV(a, b) {
	const pa = a.split("-")[0].split(".").map((x) => parseInt(x, 10) || 0), pb = b.split("-")[0].split(".").map((x) => parseInt(x, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0) ? 1 : -1;
	return 0;
}
// Obsidian hands the plugin manifest.json's version. The core refuses plugin code older than
// 1.9.0 and 11d needs a server bundle that ties with the built-in, so until manifest.json is
// bumped to 1.9.0 (the release step) the stub hands the plugin 1.9.0.
const manifest = { id: "vault-lock", name: "Vault Lock", version: cmpV(manifestJson.version, "1.9.0") < 0 ? "1.9.0" : manifestJson.version, dir: PLUGIN_DIR };
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

// ---- 1.9.0: the private folder's encryption -----------------------------------------------

/** Vault keys as vlb makes them (D.1): the id is the computer's id, the key 64 hex. */
const KEY = { id: "0123456789abcdef", key: crypto.randomBytes(32).toString("hex") };
const KEY2 = { id: "fedcba9876543210", key: crypto.randomBytes(32).toString("hex") };
const KEY_FILE = "_control/vault-key.json";
const keyJson = (k = KEY) => JSON.stringify({ v: 1, id: k.id, key: k.key, at: "2026-11-16T10:00:00Z" });
const sameKey = (a, k) => !!a && a.id === k.id && a.key === k.key;
/** Locked at start with the key already in data.json; ENC is paired too, ENC_LOCAL never makes a request. */
const ENC_LOCAL = { ...REAL_PASS, vaultKey: { id: KEY.id, key: KEY.key } };
const ENC = { ...ENC_LOCAL, ...LOGIN };
const H_DIR = ".Private";
const V_DIR = "Private";
const MAGIC = Buffer.from("VLENC1");
const ASIDE_RE = /\.undecryptable-\d{4}-\d{2}-\d{2}_\d{6}(-\d+)?\.vlenc$/;

/** The .vlenc format of C.1, written here from the spec: "VLENC1", 0x01, 8-byte key id, 8-byte
 *  mtime (ms, big-endian), 12-byte IV, AES-256-GCM ciphertext + tag; the 35 header bytes are the AAD. */
async function aesKey(hex) {
	return globalThis.crypto.subtle.importKey("raw", Buffer.from(hex, "hex"), "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function vlencEncrypt(k, plain, mtime) {
	const header = Buffer.alloc(35);
	MAGIC.copy(header, 0);
	header[6] = 1;
	Buffer.from(k.id, "hex").copy(header, 7);
	header.writeBigUInt64BE(BigInt(mtime), 15);
	crypto.randomFillSync(header, 23, 12);
	const ct = await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv: header.subarray(23, 35), additionalData: header }, await aesKey(k.key), Buffer.from(plain));
	return Buffer.concat([header, Buffer.from(ct)]);
}
async function vlencDecrypt(k, bytes) {
	check(bytes.length >= 51 && bytes.subarray(0, 6).equals(MAGIC) && bytes[6] === 1, "not a VLENC1 file (C.1)");
	const header = bytes.subarray(0, 35);
	const plain = await globalThis.crypto.subtle.decrypt({ name: "AES-GCM", iv: header.subarray(23, 35), additionalData: header }, await aesKey(k.key), bytes.subarray(35));
	return { plain: Buffer.from(plain), keyId: header.subarray(7, 15).toString("hex"), mtime: Number(header.readBigUInt64BE(15)) };
}
/** What the plugin's .vlenc holds, read with KEY. */
async function decryptFile(file, k = KEY) {
	return vlencDecrypt(k, fs.readFileSync(file));
}
function hasMagic(file) {
	try {
		const b = Buffer.alloc(6);
		const fd = fs.openSync(file, "r");
		try { fs.readSync(fd, b, 0, 6, 0); } finally { fs.closeSync(fd); }
		return b.equals(MAGIC);
	} catch { return false; }
}
const sha1 = (b) => crypto.createHash("sha1").update(b).digest("hex");
/** Every file under dir, as "a/b.md", sorted; [] when dir is not there. */
function listFiles(dir) {
	const out = [];
	const walk = (d, rel) => {
		let ents;
		try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
		for (const e of ents) {
			const r = rel ? rel + "/" + e.name : e.name;
			if (e.isDirectory()) walk(path.join(d, e.name), r);
			else out.push(r);
		}
	};
	walk(dir, "");
	return out.sort();
}
/** rel -> { sha1, mtime } (mtime as the stub adapter reports it: whole ms, floored). */
function snap(dir) {
	const m = {};
	for (const r of listFiles(dir)) {
		const f = path.join(dir, r);
		m[r] = { sha1: sha1(fs.readFileSync(f)), mtime: Math.floor(fs.statSync(f).mtimeMs) };
	}
	return m;
}
function sameSnap(got, want, what) {
	const keys = [...new Set([...Object.keys(got), ...Object.keys(want)])].sort();
	const bad = keys.filter((k) => JSON.stringify(got[k]) !== JSON.stringify(want[k]));
	check(bad.length === 0, `${what}: ` + bad.slice(0, 5).map((k) => `${k} is ${JSON.stringify(got[k] ?? "missing")}, was ${JSON.stringify(want[k] ?? "missing")}`).join("; "));
}
/** What .Private holds: plaintext, .vlenc with the magic, temp files, asides (the disk_private of H.2). */
function disk(base) {
	const H = path.join(base, H_DIR);
	const d = { plain: 0, vlenc: 0, tmp: 0, aside: 0, names: listFiles(H) };
	for (const r of d.names) {
		if (r.endsWith(".vlenc.tmp")) d.tmp++;
		else if (ASIDE_RE.test(r)) d.aside++;
		else if (r.endsWith(".vlenc") && hasMagic(path.join(H, r))) d.vlenc++;
		else d.plain++;
	}
	return d;
}
const dstr = (d) => `plain=${d.plain} vlenc=${d.vlenc} tmp=${d.tmp} aside=${d.aside} [${d.names.join(", ")}]`;
/** After finishLock(): each rel is H/rel.vlenc with the magic and no H/rel; no temp file anywhere.
 *  strays: a Private/ beside .Private/ is expected (made while locked). */
function encryptedOnDisk(base, rels, what, strays = false) {
	const H = path.join(base, H_DIR);
	check(strays || !fs.existsSync(path.join(base, V_DIR)), `${what}: ${V_DIR}/ is still there`);
	for (const r of rels) {
		check(hasMagic(path.join(H, r + ".vlenc")), `${what}: ${H_DIR}/${r}.vlenc missing or without the magic: ` + dstr(disk(base)));
		check(!fs.existsSync(path.join(H, r)), `${what}: ${H_DIR}/${r} is still readable on disk`);
	}
	check(disk(base).tmp === 0, `${what}: a temp file was left: ` + dstr(disk(base)));
}
/** n private files of different sizes (some in a subfolder), random content. */
function addPrivate(base, n, prefix = "f") {
	fs.mkdirSync(path.join(base, V_DIR, "Sub"), { recursive: true });
	for (let i = 1; i <= n; i++) {
		const rel = (i % 3 === 0 ? "Sub/" : "") + `${prefix}${String(i).padStart(2, "0")}.md`;
		fs.writeFileSync(path.join(base, V_DIR, rel), crypto.randomBytes(200 + i * 97));
	}
}
const readData = (base, f = "data.json") => JSON.parse(fs.readFileSync(path.join(base, PLUGIN_DIR, f), "utf8"));
/** The text the lock screen shows in its error line (progress while unlocking, or why it failed). */
const errText = () => byCls("vlb-error").at(-1)?.text ?? "";
const overlayUp = () => byCls("vlb-overlay").some((e) => e.isConnected);
/** Every text the private folder sent to its progress callback ("Unlocking… n of N"). */
function recordProgress(pf) {
	const seen = [];
	let inner = pf.progress ?? null;
	Object.defineProperty(pf, "progress", {
		configurable: true,
		enumerable: true,
		get: () => (inner ? (t) => { seen.push(t); return inner(t); } : null),
		set: (fn) => { inner = fn; },
	});
	return seen;
}
/** The highest n of an "Unlocking… n of N" seen so far, or -1. */
function unlockingN(seen) {
	let n = -1;
	for (const t of [...seen, errText()]) {
		const m = /Unlocking\D*(\d+) of (\d+)/.exec(t ?? "");
		if (m) n = Math.max(n, +m[1]);
	}
	return n;
}
/** Vault events as Obsidian sends them to the backup (its handlers, called directly: the layout is never ready here). */
function events(cur) {
	const b = cur.backup;
	check(typeof b.onChange === "function" && typeof b.onDelete === "function" && typeof b.onRename === "function", "the backup has no onChange/onDelete/onRename");
	const file = (p) => Object.assign(new obsidian.TFile(), { path: p });
	const folder = (p) => Object.assign(new obsidian.TFolder(), { path: p });
	return {
		create: (p) => b.onChange(p),
		modify: (p) => b.onChange(p),
		delete: (p, isFolder = false) => b.onDelete(isFolder ? folder(p) : file(p)),
		rename: (p, old) => b.onRename(file(p), old),
	};
}
/** Obsidian closing: every quit task is run (Tasks.add(fn) collects fn()) and waited for. */
async function quit(app) {
	const pending = [];
	const tasks = { add: (fn) => { pending.push((async () => { await fn(); })()); } };
	for (const h of app.handlers.quit ?? []) h(tasks);
	check(pending.length > 0, "no quit task was added");
	await Promise.all(pending);
}
async function reconcile(cur, why = "test") {
	cur.backup.requestReconcile(why);
	await within(cur.backup.queue, 15_000, "reconcile");
}
async function unlockApp(cur, what = "unlock") {
	const ok = await within((cur.lockScreen ?? cur).tryUnlock("right"), 60_000, what);
	check(ok === true, `${what}: the right passphrase was refused`);
	check(!cur.locked(), `${what}: still locked (${errText()})`);
}
/** A new process on the same vault: a fresh document and window (no chain, no cover), a new app object. */
async function restartOn(base, Cls, opts = {}) {
	freshDocument();
	const app = makeApp(base);
	const p = new Cls(app, manifest);
	if (opts.keys) p.supervisor.keys = opts.keys;
	await within(p.load(), 10_000, "onload");
	await macrotask();
	return { p, S: p.supervisor, app, base };
}
/** The PUTs and MOVEs that touched the private folder on the server, from log index i on. */
const privateWrites = (srv, i = 0) => srv.log.slice(i).filter((l) => /^(PUT|MOVE|DELETE|COPY) /.test(l) && /(^| |\/)Private\//.test(l) && !l.startsWith("PUT _trash/"));

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
		check(p.ribbon?.length === 1 && p.ribbon[0].icon === "lock", "no lock button in the ribbon");
		check(p.tabs.length === 1, "no setting tab");
		p.tabs[0].display();
		// core.json: the start is recorded until it proves good (90 s) or ends cleanly.
		check(coreState(base).starting?.id === BUILTIN, "core.json does not record the start: " + JSON.stringify(coreState(base).starting));
		// A tick without a server login: no request at all, nothing switched.
		await within(p.supervisor.tick(), 5_000, "tick");
		check(p.supervisor.running?.id === BUILTIN && p.supervisor.pending === null, "the tick changed the running app");
		check(coreState(base).lastUpdateCheck, "the tick did not write core.json");
		const status = p.supervisor.coreStatus();
		check(status.running === "builtin" && status.runningId === BUILTIN && status.server === null && status.coreVersion === 2, "coreStatus: " + JSON.stringify(status));
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
				doneCommands: [], commandLog: {}, vaultKey: null, encrypt: true, restoreDeferred: [],
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
		check(probe.core === 2 && !Number.isNaN(Date.parse(probe.at)), "probe body: " + JSON.stringify(probe));
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
	// app uses; never moves, deletes or trashes; reports in status.json; heartbeats. Since
	// 1.9.0 nothing under the private folder while it is hidden (B6; no key here: it stays
	// readable on disk, hidden only).
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
		check(!server.files.has("Private/Secret.md") && !server.log.some((l) => l.includes("Private")), "the lifeboat touched the private folder on the server while it is hidden: " + server.log.filter((l) => l.includes("Private")));
		check(![...server.files.keys()].some((k) => k.startsWith(".Private") || k.startsWith(PLUGIN_DIR)), "uploaded what must never go: " + [...server.files.keys()]);
		check(!server.sent("PUT", "Note.md"), "re-uploaded an unchanged file");
		const index = server.json("_manifest.json");
		check(fs.existsSync(path.join(base, ".Private", "Secret.md")) && !index["Private/Secret.md"], "index entry: " + JSON.stringify(index["Private/Secret.md"]));
		check(index["Gone.md"] && index["Note.md"], "the lifeboat removed index entries: " + Object.keys(index));
		check(!index["Bad.md"] && !index["Big.bin"], "index lists files that were not uploaded");
		check(!server.log.some((l) => /^(MOVE|DELETE|PROPPATCH|COPY) /.test(l)), "the lifeboat moved or deleted: " + server.log);
		const st = server.json("_control/status.json");
		check(st.lifeboat === true && st.locked === true && st.core?.running === "lifeboat" && st.core.runningId === "lifeboat", "status.json: " + JSON.stringify(st).slice(0, 300));
		check(st.lastReconcile?.uploaded === 0 && st.lastReconcile.trashed === 0, "lastReconcile: " + JSON.stringify(st.lastReconcile));
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
		publish(server, "app", variant(2), { minCore: 3 });
		await within(S.tick(), 5_000, "tick");
		check(coreState(base).updateError === "app: needs core ≥ 3" && gets() === 1, "minCore 3: " + coreState(base).updateError);
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
		// Published again as the built-in's own version (a tie; anything below 1.9.0 is refused
		// outright since 1.9.0): the built-in wins now (superseded) ...
		const TIE = manifest.version;
		const R1 = publish(server, "app", variant(3), { version: TIE });
		await within(S.tick(), 5_000, "tick");
		st = coreState(base);
		check(st.staged?.version === TIE && st.lastAcceptedAt.app === R1.at && gets() === n, "a re-signed manifest for the same bytes was not taken: " + JSON.stringify(st.staged));
		check(S.running?.id === BUILTIN && S.coreStatus().server?.state === "superseded", "an older unforced version still runs: " + JSON.stringify(S.running));
		// ... and forced: it runs again, without fetching anything.
		const R2 = publish(server, "app", variant(3), { version: TIE, force: true });
		await within(S.tick(), 5_000, "tick");
		st = coreState(base);
		check(st.staged?.force === true && st.lastAcceptedAt.app === R2.at && gets() === n, "the forced re-publish was not taken: " + JSON.stringify(st.staged));
		check(S.running?.id === "server:" + s3 && S.running.version === TIE && S.coreStatus().server?.force === true, "the forced rollback does not run: " + JSON.stringify(S.running));
		// The older envelope again (a replay of R1): ignored.
		server.files.set(MF, Buffer.from(envelope({ ...payloadFor("app", variant(3), { version: TIE }), at: R1.at })));
		await within(S.tick(), 5_000, "tick");
		check(coreState(base).staged?.force === true && S.running?.version === TIE, "a replayed envelope for the same bytes undid the rollback");

		step = "11e a damaged local file is fetched again";
		const R3 = publish(server, "app", variant(3), { version: TIE, force: true });
		const R3env = server.files.get(MF);
		await within(S.tick(), 5_000, "tick");
		const f3 = path.join(base, PLUGIN_DIR, "bundles", `app-${s3}.js`);
		fs.writeFileSync(f3, evilTwin(variant(3), "__vlbRan"));
		// The older unforced envelope for the same bytes is no excuse to fetch: it would undo the rollback.
		server.files.set(MF, Buffer.from(envelope({ ...payloadFor("app", variant(3), { version: TIE }), at: R1.at })));
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
		// Labels at or above 1.9.0: the core refuses older core bundles (G.4; case 22).
		const C0 = publish(server, "core", mainJs, { version: "1.9.0" });
		await within(S.tick(), 5_000, "tick");
		let st = coreState(base);
		check(st.coreInstalled?.sha12 === C0.sha256.slice(0, 12) && fetches() === 0 && !fs.existsSync(path.join(dir(base), "main.js.prev")), "the installed main.js was not recognised: " + JSON.stringify(st.coreInstalled));
		const newMain = Buffer.concat([mainJs, Buffer.from("\n// core 1.9.1\n")]);
		const C1 = publish(server, "core", newMain, { version: "1.9.1" });
		await within(S.tick(), 5_000, "tick");
		st = coreState(base);
		check(mainNow().equals(newMain) && fs.readFileSync(path.join(dir(base), "main.js.prev")).equals(mainJs), "main.js not replaced (or main.js.prev not the old one)");
		check(JSON.parse(fs.readFileSync(path.join(dir(base), "manifest.json"), "utf8")).version === "1.9.1", "manifest.json version not patched");
		check(st.coreInstalled?.version === "1.9.1" && st.lastAcceptedAt.core === C1.at && st.updateError === null, "core.json after install: " + JSON.stringify(st));
		check(!fs.existsSync(path.join(dir(base), "main.js.part")) && S.running?.id === BUILTIN, "main.js.part left, or the running app changed");
		// manifest.json's version lost after the install (a failed patch): put right at the next tick.
		fs.writeFileSync(path.join(dir(base), "manifest.json"), JSON.stringify({ ...manifestJson, version: "1.9.0" }, null, "\t"));
		await within(S.tick(), 5_000, "tick");
		check(JSON.parse(fs.readFileSync(path.join(dir(base), "manifest.json"), "utf8")).version === "1.9.1" && coreState(base).updateError === null && fetches() === 1, "manifest.json version not put right after the install");
		// BRAT put its own main.js back since: the same manifest is never applied a second time.
		fs.writeFileSync(path.join(dir(base), "main.js"), mainJs);
		await within(S.tick(), 5_000, "tick");
		check(mainNow().equals(mainJs) && /applied before/.test(coreState(base).updateError ?? ""), "a core bundle was applied twice: " + coreState(base).updateError);
		fs.writeFileSync(path.join(dir(base), "main.js"), newMain);
		const refused = async (bytes, re, what, more = {}) => {
			publish(server, "core", bytes, { version: "1.9.2", ...more });
			await within(S.tick(), 5_000, "tick");
			check(re.test(coreState(base).updateError ?? ""), `${what}: ` + coreState(base).updateError);
			check(mainNow().equals(newMain) && !fs.existsSync(path.join(dir(base), "main.js.part")), `${what}: main.js was touched`);
		};
		await refused(Buffer.from("module.exports = {\n"), /^core: does not compile/, "syntax error");
		await refused(Buffer.from("throw new Error('top level');\n"), /^core: does not load/, "top level throws");
		await refused(Buffer.from("module.exports = { default: 5 };\n"), /^core: does not load/, "no plugin class");
		const good = Buffer.concat([mainJs, Buffer.from("\n// core 1.9.3\n")]);
		// Signed for the app slot, put in the core slot: refused before anything is fetched.
		const f0 = fetches();
		await refused(good, /core slot holds an app manifest/, "kind app", { kind: "app" });
		check(fetches() === f0, "main.js was fetched for an app manifest in the core slot");
		publish(server, "core", good, { version: "1.9.3" });
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
			settings: { passHash: "", passSalt: "", passCopied: "", idleMinutes: 5, lockOnBlur: false, privateFolder: "Private", reconcileMinutes: 10, excludes: "", doneCommands: [], commandLog: {}, vaultKey: null, encrypt: true, restoreDeferred: [], ...LOGIN },
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

	// 16. The key comes from the server at the first reconcile, is saved in data.json and
	// data.bak.json, and the hidden folder is encrypted at once (C.1 format); the unlock gives
	// every byte and mtime back.
	step = "16 key and round trip";
	{
		let orig;
		const { p, S, base, app } = await startPlugin(VaultLockPlugin, { ...REAL_PASS, ...LOGIN }, null, { before: (b) => { orig = snap(path.join(b, V_DIR)); } });
		const cur = S.current, pf = cur.privateFolder;
		check(typeof cur.finishLock === "function" && typeof pf.finishLock === "function" && typeof pf.stats === "function", "the app has no finishLock(), or its private folder no finishLock()/stats()");
		check(cur.locked() && fs.existsSync(path.join(base, H_DIR, "Secret.md")), "not locked and hidden at start");
		check(p.settings.vaultKey === null && p.settings.encrypt === true && Array.isArray(p.settings.restoreDeferred), "settings before the key: " + JSON.stringify({ vaultKey: p.settings.vaultKey, encrypt: p.settings.encrypt, restoreDeferred: p.settings.restoreDeferred }));
		check(pf.encryptionReady() === false, "ready to encrypt without a key");
		// The start's own pass ends first (no key: hide only), so what encrypts below is the key's arrival.
		await within(cur.finishLock(), 20_000, "finishLock");
		const d0 = disk(base);
		check(d0.plain === 1 && d0.vlenc === 0, "encrypted without a key: " + dstr(d0));
		server = fakeServer({ [KEY_FILE]: keyJson() });
		let keyAt = 0;
		server.hold = (m, f) => { if (m === "GET" && f === KEY_FILE && !keyAt) keyAt = Date.now(); return null; };
		cur.backup.onPaired(false);
		await within(cur.backup.queue, 15_000, "reconcile");
		check(sameKey(p.settings.vaultKey, KEY), "settings.vaultKey after the first reconcile: " + JSON.stringify(p.settings.vaultKey));
		check(sameKey(readData(base).vaultKey, KEY) && sameKey(readData(base, "data.bak.json").vaultKey, KEY), "the key is not in both data.json and data.bak.json");
		check(cur.backup.control.keyState === "ok" && pf.keyDurable === true && pf.encryptionReady() === true, `keyState ${cur.backup.control.keyState}, keyDurable ${pf.keyDurable}`);
		// requestEncrypt(): encrypted now, without the 5 s pause and without anyone calling finishLock().
		await waitFor(() => { const d = disk(base); return d.vlenc === 1 && d.plain === 0 && d.tmp === 0; }, 10_000, "the hidden folder encrypted once the key arrived");
		const took = Date.now() - keyAt;
		check(keyAt > 0 && took < 4_000, `encrypted ${took} ms after the key was fetched: the pass waited for the pause`);
		await within(cur.finishLock(), 20_000, "finishLock");
		encryptedOnDisk(base, ["Secret.md"], "after the key arrived (requestEncrypt)");
		const d = await decryptFile(path.join(base, H_DIR, "Secret.md.vlenc"));
		check(d.plain.toString() === "secret" && d.keyId === KEY.id && d.mtime === orig["Secret.md"].mtime, "the .vlenc does not hold the note in the C.1 format: " + JSON.stringify({ plain: d.plain.toString(), keyId: d.keyId, mtime: d.mtime, want: orig["Secret.md"].mtime }));
		await reconcile(cur);
		const enc = server.json("_control/status.json").encryption;
		check(enc && enc.on === true && enc.keyId === KEY.id && enc.keyDurable === true && enc.keyState === "ok" && enc.files === 1 && enc.plain === 0, "status.json encryption: " + JSON.stringify(enc));
		check(Array.isArray(enc.failed) && enc.failed.length === 0 && Array.isArray(enc.tooBig) && enc.undecryptable === 0 && Array.isArray(enc.restoreDeferred) && enc.restoreDeferred.length === 0, "status.json encryption: " + JSON.stringify(enc));
		check(![...server.files.keys()].some((k) => k.includes(".vlenc") || k.startsWith(H_DIR) || k.startsWith(V_DIR + "/")), "sent to the server while locked: " + [...server.files.keys()]);
		await unlockApp(cur);
		check(!fs.existsSync(path.join(base, H_DIR)), "the hidden folder is still there after the unlock");
		sameSnap(snap(path.join(base, V_DIR)), orig, "after the unlock");
		check((await app.vault.adapter.stat(V_DIR + "/Secret.md")).mtime === orig["Secret.md"].mtime, "adapter.stat().mtime changed by the round trip");
		await within(cur.backup.queue, 15_000, "reconcile after the unlock");
		check(server.files.get(V_DIR + "/Secret.md")?.toString() === "secret", "the note was not backed up after the unlock");
		await stopPlugin(p);
		server = null;
	}

	// 17. While locked the backup does nothing under Private/ on the server (B5-B7): a populated
	// index (1.8.0 uploaded the notes) keeps its keys, nothing is trashed, a stray made beside
	// .Private/ is never uploaded, no .vlenc ever reaches the server.
	step = "17 backup gate while locked";
	{
		let idx;
		const { p, S, base } = await startPlugin(VaultLockPlugin, ENC, null, { before: (b) => {
			fs.mkdirSync(path.join(b, V_DIR, "Sub"));
			fs.writeFileSync(path.join(b, V_DIR, "Sub", "Deep.md"), "deep");
			const e = (rel) => { const s = fs.statSync(path.join(b, rel)); return { m: Math.floor(s.mtimeMs), s: s.size }; };
			idx = { "Note.md": e("Note.md"), "Private/Secret.md": e("Private/Secret.md"), "Private/Sub/Deep.md": e("Private/Sub/Deep.md") };
		} });
		const cur = S.current;
		server = fakeServer({ "_manifest.json": JSON.stringify(idx), "Note.md": "note", "Private/Secret.md": "secret", "Private/Sub/Deep.md": "deep" });
		// A link clicked while locked makes the note again, beside .Private/.
		fs.mkdirSync(path.join(base, V_DIR));
		fs.writeFileSync(path.join(base, V_DIR, "New.md"), "made while locked");
		const ev = events(cur);
		cur.backup.onPaired(false);
		await within(cur.backup.queue, 15_000, "reconcile");
		// Obsidian reports the lock's rename as deletes of every private file; such a job may run
		// only after the encryption, when the plaintext under .Private/ is gone (trash()'s own gate).
		ev.create("Private/New.md");
		await within(cur.finishLock(), 20_000, "finishLock");
		encryptedOnDisk(base, ["Secret.md", "Sub/Deep.md"], "locked with a key", true);
		ev.delete("Private/Secret.md");
		ev.delete("Private/Sub/Deep.md");
		ev.delete("Private/Sub", true);
		await within(cur.backup.queue, 15_000, "the delete events");
		await sleep(2_300); // the stray's change event fires after its 2 s debounce
		await reconcile(cur);
		check(privateWrites(server).length === 0, "the locked backup wrote under Private/ on the server: " + privateWrites(server));
		const idx2 = server.json("_manifest.json");
		const priv = (ix) => JSON.stringify(Object.entries(ix).filter(([k]) => k.startsWith(V_DIR + "/")).sort());
		check(priv(idx2) === priv(idx), "the index's private keys changed while locked: " + priv(idx2));
		const lr = server.json("_control/status.json").lastReconcile;
		check(lr?.trashed === 0, "trashed while locked: " + JSON.stringify(lr));
		check(!server.sent("PUT", "Private/New.md"), "the stray made while locked was uploaded");
		check(![...server.files.keys()].some((k) => k.includes(".vlenc") || k.startsWith(H_DIR)), "a .vlenc or the hidden name reached the server: " + [...server.files.keys()]);
		check(server.files.get("Private/Secret.md").toString() === "secret", "the server's readable copy changed");
		await stopPlugin(p);
		server = null;
	}

	// 18. The renamed-note rule (B6's exception): a note saved right before the lock is uploaded
	// from the plaintext under .Private/ during the pause, before it is encrypted.
	step = "18 renamed-note rule";
	{
		const { p, S, base } = await startPlugin(VaultLockPlugin, ENC);
		const cur = S.current;
		server = fakeServer();
		cur.backup.onPaired(false);
		await within(cur.backup.queue, 15_000, "reconcile");
		await within(cur.finishLock(), 20_000, "finishLock");
		await unlockApp(cur);
		await within(cur.backup.queue, 15_000, "reconcile after the unlock");
		check(server.files.get("Private/Secret.md")?.toString() === "secret", "not backed up after the unlock");
		const vlenc = path.join(base, H_DIR, "Secret.md.vlenc");
		const sawVlenc = [];
		server.hold = (m, f) => { if (m === "PUT" && f === "Private/Secret.md") sawVlenc.push(fs.existsSync(vlenc)); return null; };
		const typed = "typed a second before the lock";
		fs.writeFileSync(path.join(base, V_DIR, "Secret.md"), typed);
		events(cur).modify("Private/Secret.md");
		await within(cur.lock(), 10_000, "lock");
		check(fs.existsSync(path.join(base, H_DIR, "Secret.md")) && !fs.existsSync(vlenc), "encrypted at once: no pause for the last edit's upload");
		await waitFor(() => sawVlenc.length > 0, 4_500, "the last edit's upload");
		check(sawVlenc[0] === false, "the last edit was uploaded only after the note was encrypted");
		check(server.files.get("Private/Secret.md").toString() === typed, "the server did not get the last edit: " + server.files.get("Private/Secret.md"));
		await within(cur.finishLock(), 20_000, "finishLock");
		encryptedOnDisk(base, ["Secret.md"], "after the pause");
		check(disk(base).plain === 0, "plaintext left: " + dstr(disk(base)));
		check(![...server.files.keys()].some((k) => k.includes(".vlenc") || k.startsWith(H_DIR)), "a .vlenc or the hidden name reached the server");
		await stopPlugin(p);
		server = null;
	}

	// 19. Strays made while locked (a link clicked) are moved into the private folder at the
	// unlock, before the decrypt (C.9): beside the real note one gets "(created while locked)";
	// nothing of them reaches the server while locked; Obsidian's delete events send nothing.
	step = "19 stray merge";
	{
		let idx;
		const { p, S, base } = await startPlugin(VaultLockPlugin, ENC, null, { before: (b) => {
			const s = fs.statSync(path.join(b, V_DIR, "Secret.md"));
			idx = { "Private/Secret.md": { m: Math.floor(s.mtimeMs), s: s.size } };
		} });
		const cur = S.current;
		await within(cur.finishLock(), 20_000, "finishLock");
		encryptedOnDisk(base, ["Secret.md"], "locked");
		server = fakeServer({ "_manifest.json": JSON.stringify(idx), "Private/Secret.md": "secret" });
		fs.mkdirSync(path.join(base, V_DIR));
		fs.writeFileSync(path.join(base, V_DIR, "Secret.md"), "");
		fs.writeFileSync(path.join(base, V_DIR, "Other.md"), "other");
		const ev = events(cur);
		// Obsidian sees each stray go when the merge moves it into the dot folder (as a delete, or
		// as a rename to the hidden name: neither may send anything), and the emptied folder go.
		let strayMoves = 0;
		hooks.adapter = (name, a) => {
			if (name === "rename" && a[0].startsWith(V_DIR + "/") && a[1].startsWith(H_DIR + "/")) {
				strayMoves++;
				queueMicrotask(() => (a[0].endsWith("Other.md") ? ev.rename(a[1], a[0]) : ev.delete(a[0])));
			}
			if (name === "rmdir" && a[0] === V_DIR) queueMicrotask(() => ev.delete(V_DIR, true));
		};
		cur.backup.onPaired(false);
		ev.create("Private/Secret.md");
		ev.create("Private/Other.md");
		await within(cur.backup.queue, 15_000, "reconcile");
		await sleep(2_300);
		await within(cur.backup.queue, 15_000, "the strays' change events");
		check(privateWrites(server).length === 0, "something under Private/ was sent while locked: " + privateWrites(server));
		await unlockApp(cur);
		check(strayMoves === 2, `${strayMoves} stray(s) moved with adapter.rename (C.9), want 2`);
		const V = path.join(base, V_DIR);
		check(fs.readFileSync(path.join(V, "Secret.md"), "utf8") === "secret", "the real note was not decrypted intact: " + listFiles(V));
		check(fs.existsSync(path.join(V, "Secret (created while locked).md")) && fs.readFileSync(path.join(V, "Secret (created while locked).md"), "utf8") === "", "the stray beside the real note was not kept as 'Secret (created while locked).md': " + listFiles(V));
		check(fs.readFileSync(path.join(V, "Other.md"), "utf8") === "other", "the other stray is not back: " + listFiles(V));
		check(!fs.existsSync(path.join(base, H_DIR)) && !listFiles(V).some((r) => r.includes(".vlenc")), "left after the unlock: " + listFiles(V));
		await within(cur.backup.queue, 15_000, "reconcile after the unlock");
		await sleep(50);
		await within(cur.backup.queue, 15_000, "the delete events");
		check(!server.log.some((l) => /^(MOVE|DELETE) /.test(l)), "the delete events moved or deleted on the server: " + server.log.filter((l) => /^(MOVE|DELETE) /.test(l)));
		check(!server.bodies.some(([f]) => f === "Private/Secret.md"), "Private/Secret.md was PUT (the readable server copy is the one to keep)");
		check(server.files.get("Private/Secret.md").toString() === "secret", "the server's copy of the real note changed");
		await stopPlugin(p);
		server = null;
	}

	// 20. A crash at every step of a file's transformation (C.3, C.4, C.9): the fault build
	// hangs there (the disk is what a power cut would leave), the instance is abandoned like a
	// dead process, and the release build on the same vault finishes the job: every file
	// encrypted, then every byte and mtime back at the unlock.
	{
		const Faults = evaluate("scripts/.build/main-faults.js").default;
		// The smallest file (Secret.md) goes first; what the disk holds for it while the pass hangs.
		const ROW = {
			"enc:before-tmp": ["x"], "enc:after-tmp": ["x", "tmp"], "enc:after-verify": ["x", "tmp"], "enc:after-rename": ["x", "vlenc"],
			"dec:before-tmp": ["vlenc"], "dec:after-tmp": ["vlenc", "tmp"], "dec:after-verify": ["vlenc", "tmp"],
			"dec:after-rename": ["x", "vlenc"], "dec:after-unlink": ["x"],
		};
		for (const stop of [...Object.keys(ROW), "merge:after-move"]) {
			step = `20 fault stop ${stop}`;
			const dec = stop.startsWith("dec:"), merge = stop.startsWith("merge:");
			let orig;
			const { S, base } = await startPlugin(Faults, ENC_LOCAL, null, { before: (b) => {
				fs.mkdirSync(path.join(b, V_DIR, "Sub"));
				fs.writeFileSync(path.join(b, V_DIR, "Sub", "Deep.md"), "deeper than the secret");
				fs.writeFileSync(path.join(b, V_DIR, "Pic.bin"), crypto.randomBytes(3000));
				orig = snap(path.join(b, V_DIR));
			} });
			const cur = S.current;
			check(cur && cur.locked(), "the fault build did not start locked");
			const line = "[VLB] fault stop " + stop;
			consoleLines.length = 0;
			if (dec || merge) {
				await within(cur.finishLock(), 20_000, "finishLock");
				encryptedOnDisk(base, Object.keys(orig), "before the unlock");
				if (merge) {
					fs.mkdirSync(path.join(base, V_DIR));
					fs.writeFileSync(path.join(base, V_DIR, "Stray1.md"), "made while locked, one");
					fs.writeFileSync(path.join(base, V_DIR, "Stray2.md"), "made while locked, two");
					Object.assign(orig, snap(path.join(base, V_DIR)));
				}
				globalThis.__vlbFault = stop;
				void cur.lockScreen.tryUnlock("right"); // hangs at the stop
			} else {
				globalThis.__vlbFault = stop;
				void cur.finishLock(); // ends the pause; the pass then hangs at the stop
			}
			await waitFor(() => consoleLines.includes(line), 20_000, `the console line "${line}"`);
			await sleep(50);
			const H = path.join(base, H_DIR);
			const has = (rel) => fs.existsSync(path.join(H, rel));
			if (merge) {
				const inH = ["Stray1.md", "Stray2.md"].filter((n) => has(n));
				const inV = ["Stray1.md", "Stray2.md"].filter((n) => fs.existsSync(path.join(base, V_DIR, n)));
				check(inH.length === 1 && inV.length === 1, `hung after the first move: strays in ${H_DIR} [${inH}], in ${V_DIR} [${inV}]`);
			} else {
				const state = [has("Secret.md") && "x", has("Secret.md.vlenc") && "vlenc", has("Secret.md.vlenc.tmp") && "tmp"].filter(Boolean);
				check(state.join() === ROW[stop].join(), `hung at ${stop}: Secret.md is [${state}], want [${ROW[stop]}] (C.3/C.4)`);
				for (const rel of ["Sub/Deep.md", "Pic.bin"]) {
					const ok = dec ? has(rel + ".vlenc") && !has(rel) : has(rel) && !has(rel + ".vlenc");
					check(ok && !has(rel + ".vlenc.tmp"), `hung at ${stop}: ${rel} was touched before the smallest file was done: ` + dstr(disk(base)));
				}
				check(!fs.existsSync(path.join(base, V_DIR)), `hung at ${stop}: the folder was renamed back`);
			}
			// Abandoned as a crashed process would be: its timers and chain do not exist in the next one.
			const pf = cur.privateFolder;
			check(typeof pf.__testAbandon === "function", "the private folder has no __testAbandon() test hook");
			pf.__testAbandon();
			if (globalThis.__vaultLock) delete globalThis.__vaultLock.pf;
			delete globalThis.__vlbFault;
			const q = await restartOn(base, VaultLockPlugin);
			const c2 = q.S.current;
			check(c2 && c2.locked() && q.S.running?.id === BUILTIN, "the release build did not start locked: " + JSON.stringify(q.S.running));
			await within(c2.finishLock(), 20_000, "finishLock after the restart");
			const d = disk(base);
			check(d.plain === 0 && d.tmp === 0 && d.aside === 0 && d.vlenc === Object.keys(orig).length, `after ${stop} and a restart: ` + dstr(d));
			await unlockApp(c2);
			check(!fs.existsSync(H), "the hidden folder is still there after the unlock");
			sameSnap(snap(path.join(base, V_DIR)), orig, `after ${stop}, a restart and the unlock`);
			await stopPlugin(q.p);
		}
	}

	// 21. Pair rule, asides and names (C.5, B4, B14): nothing readable is ever replaced or deleted.
	step = "21 pair rule, asides, names";
	{
		const T = Date.parse("2026-11-01T09:00:00Z");
		const report = crypto.randomBytes(1024), userVlenc = crypto.randomBytes(5 * 1024), orphan = crypto.randomBytes(100);
		const encA = await vlencEncrypt(KEY, "alpha", T);
		const encB = await vlencEncrypt(KEY, "bravo, the older text", T);
		const encW = await vlencEncrypt(KEY2, "whiskey", T); // another computer's key (G.3)
		const encY = await vlencEncrypt(KEY2, "yankee, under the old key", T);
		const { p, S, base } = await startPlugin(VaultLockPlugin, ENC_LOCAL, null, { before: (b) => {
			// Locked by an earlier run: .Private/ on disk with leftovers of every kind.
			fs.renameSync(path.join(b, V_DIR), path.join(b, H_DIR));
			const w = (rel, data) => fs.writeFileSync(path.join(b, H_DIR, rel), data);
			w("A.md", "alpha"); w("A.md.vlenc", encA); // x + x.vlenc, the same
			w("B.md", "bravo, the newer text"); w("B.md.vlenc", encB); // x + x.vlenc, different
			w("Y.md", "yankee"); w("Y.md.vlenc", encY); // x + x.vlenc of another key: the pair rule's aside (C.5)
			w("W.md.vlenc", encW); // alone: moved aside at the unlock (C.4 D0)
			w("Orphan.md.vlenc.tmp", orphan); // a temp file without its source
			w("foo.vlenc", "not ours, only the name"); // a plain file named *.vlenc
			w("report.md", report); w("report.md.vlenc", userVlenc); // our name taken by the user's file
		} });
		const cur = S.current, pf = cur.privateFolder;
		const H = path.join(base, H_DIR);
		await within(cur.finishLock(), 20_000, "finishLock");
		const dec = async (rel) => (await decryptFile(path.join(H, rel))).plain;
		const names = () => listFiles(H).join(", ");
		check(!fs.existsSync(path.join(H, "Secret.md")) && (await dec("Secret.md.vlenc")).toString() === "secret", "Secret.md not encrypted: " + names());
		check(!fs.existsSync(path.join(H, "A.md")) && (await dec("A.md.vlenc")).toString() === "alpha" && !listFiles(H).some((r) => r.startsWith("A (")), "identical pair: " + names());
		check(!fs.existsSync(path.join(H, "B.md")) && (await dec("B.md.vlenc")).toString() === "bravo, the newer text", "different pair: the newer note is not the one encrypted: " + names());
		const recB = listFiles(H).filter((r) => /^B \(recovered [^)]+\)\.md(\.vlenc)?$/.test(r));
		check(recB.length === 1, "different pair: no single 'B (recovered …).md': " + names());
		const recBytes = recB[0].endsWith(".vlenc") ? await dec(recB[0]) : fs.readFileSync(path.join(H, recB[0]));
		check(recBytes.toString() === "bravo, the older text", "the recovered sibling does not hold the older text");
		check(sha1(fs.readFileSync(path.join(H, "W.md.vlenc"))) === sha1(encW), "a .vlenc of another key was changed at the lock");
		const asideY = listFiles(H).filter((r) => /^Y\.md\.undecryptable-\d{4}-\d{2}-\d{2}_\d{6}(-\d+)?\.vlenc$/.test(r));
		check(asideY.length === 1 && sha1(fs.readFileSync(path.join(H, asideY[0]))) === sha1(encY), "pair with another key's .vlenc: not moved aside unchanged: " + names());
		check(!fs.existsSync(path.join(H, "Y.md")) && (await dec("Y.md.vlenc")).toString() === "yankee" && !listFiles(H).some((r) => r.startsWith("Y (")), "pair with another key's .vlenc: Y.md not encrypted under its own name: " + names());
		check(pf.stats().undecryptable === 1, "undecryptable after the lock: " + pf.stats().undecryptable);
		check(fs.existsSync(path.join(H, "Orphan.md.vlenc.tmp")) && sha1(fs.readFileSync(path.join(H, "Orphan.md.vlenc.tmp"))) === sha1(orphan), "the orphan temp file was not kept as it was");
		check(pf.stats().failed.some((f) => f.includes("Orphan.md") && /orphan/i.test(f)), "the orphan temp file is not reported: " + JSON.stringify(pf.stats().failed));
		check(!fs.existsSync(path.join(H, "foo.vlenc")) && (await dec("foo.vlenc.vlenc")).toString() === "not ours, only the name", "a plain *.vlenc was not encrypted to *.vlenc.vlenc: " + names());
		check(!fs.existsSync(path.join(H, "report.md")) && (await dec("report.md.vlenc")).equals(report), "report.md is not encrypted under its own name (defer rule): " + names());
		check((await dec("report.md.vlenc.vlenc")).equals(userVlenc), "the user's report.md.vlenc was not encrypted to report.md.vlenc.vlenc: " + names());
		check(disk(base).tmp === 1, "temp files left besides the orphan: " + names());
		await unlockApp(cur);
		const V = path.join(base, V_DIR);
		const txt = (rel) => fs.readFileSync(path.join(V, rel), "utf8");
		check(txt("Secret.md") === "secret" && txt("A.md") === "alpha" && txt("B.md") === "bravo, the newer text" && txt("Y.md") === "yankee", "notes after the unlock: " + listFiles(V));
		check(fs.existsSync(path.join(V, asideY[0])) && sha1(fs.readFileSync(path.join(V, asideY[0]))) === sha1(encY), "the aside made at the lock is gone or changed after the unlock: " + listFiles(V));
		const recV = listFiles(V).filter((r) => /^B \(recovered [^)]+\)\.md$/.test(r));
		check(recV.length === 1 && txt(recV[0]) === "bravo, the older text", "the recovered sibling is not there after the unlock: " + listFiles(V));
		const asides = listFiles(V).filter((r) => /^W\.md\.undecryptable-\d{4}-\d{2}-\d{2}_\d{6}(-\d+)?\.vlenc$/.test(r));
		check(asides.length === 1 && sha1(fs.readFileSync(path.join(V, asides[0]))) === sha1(encW), "the undecryptable file was not moved aside unchanged: " + listFiles(V));
		check(!fs.existsSync(path.join(V, "W.md")) && !fs.existsSync(path.join(V, "W.md.vlenc")), "W.md: " + listFiles(V));
		check(pf.stats().undecryptable === 1, "undecryptable: " + pf.stats().undecryptable);
		check(sha1(fs.readFileSync(path.join(V, "Orphan.md.vlenc.tmp"))) === sha1(orphan), "the orphan temp file is gone or changed after the unlock");
		check(fs.readFileSync(path.join(V, "foo.vlenc"), "utf8") === "not ours, only the name" && !fs.existsSync(path.join(V, "foo.vlenc.vlenc")), "foo.vlenc after the unlock: " + listFiles(V));
		check(fs.readFileSync(path.join(V, "report.md")).equals(report) && fs.readFileSync(path.join(V, "report.md.vlenc")).equals(userVlenc) && !fs.existsSync(path.join(V, "report.md.vlenc.vlenc")), "report.md / the user's report.md.vlenc after the unlock: " + listFiles(V));
		check(!listFiles(V).some((r) => !ASIDE_RE.test(r) && hasMagic(path.join(V, r))), "encrypted files left after the unlock: " + listFiles(V));
		await stopPlugin(p);
	}
	step = "21b aside + stray; a leftover .vlenc beside a visible note";
	{
		let idx;
		const encOld = await vlencEncrypt(KEY2, "secret", Date.parse("2026-11-01T09:00:00Z"));
		const aside = "Secret.md.undecryptable-2026-11-01_120000.vlenc";
		const { p, S, base } = await startPlugin(VaultLockPlugin, ENC, null, { before: (b) => {
			const s = fs.statSync(path.join(b, V_DIR, "Secret.md"));
			idx = { "Private/Secret.md": { m: Math.floor(s.mtimeMs), s: s.size } };
			fs.renameSync(path.join(b, V_DIR), path.join(b, H_DIR));
			fs.rmSync(path.join(b, H_DIR, "Secret.md"));
			fs.writeFileSync(path.join(b, H_DIR, aside), encOld);
		} });
		const cur = S.current;
		await within(cur.finishLock(), 20_000, "finishLock");
		server = fakeServer({ "_manifest.json": JSON.stringify(idx), "Private/Secret.md": "secret" });
		fs.mkdirSync(path.join(base, V_DIR));
		fs.writeFileSync(path.join(base, V_DIR, "Secret.md"), ""); // an empty stray, as a link click makes it
		const ev = events(cur);
		cur.backup.onPaired(false);
		ev.create("Private/Secret.md");
		await within(cur.backup.queue, 15_000, "reconcile");
		await sleep(2_300);
		await within(cur.backup.queue, 15_000, "the stray's change event");
		check(privateWrites(server).length === 0, "sent while locked: " + privateWrites(server));
		await unlockApp(cur);
		const V = path.join(base, V_DIR);
		check(fs.existsSync(path.join(V, "Secret (created while locked).md")) && !fs.existsSync(path.join(V, "Secret.md")) && fs.existsSync(path.join(V, aside)), "aside + stray after the unlock: " + listFiles(V));
		await within(cur.backup.queue, 15_000, "reconcile after the unlock");
		check(!server.bodies.some(([f]) => f === "Private/Secret.md") && !server.log.some((l) => /^(MOVE|DELETE) Private\/Secret\.md/.test(l)), "the readable server copy was overwritten or trashed: " + server.log.filter((l) => l.includes("Private/Secret.md")));
		check(server.files.get("Private/Secret.md").toString() === "secret" && server.json("_manifest.json")["Private/Secret.md"], "the server's readable copy or its index key is gone");
		// Unlocked, a note with a leftover .vlenc beside it: never uploaded, reported (B5).
		fs.writeFileSync(path.join(V, "Left.md"), "left");
		fs.writeFileSync(path.join(V, "Left.md.vlenc"), await vlencEncrypt(KEY, "left", Date.now()));
		await reconcile(cur);
		check(!server.sent("PUT", "Private/Left.md") && !server.sent("PUT", "Private/Left.md.vlenc"), "a note with an encrypted copy beside it was uploaded");
		const failed = server.json("_control/status.json").lastReconcile?.failed ?? [];
		check(failed.some((f) => f.startsWith("Private/Left.md")), "not listed in failed: " + JSON.stringify(failed));
		await stopPlugin(p);
		server = null;
	}

	// 22. Limits and switches: over 100 MB, no key, the kill switch, a different key on the
	// server, plugin code below 1.9.0, a key that cannot be saved.
	step = "22 over 100 MB";
	{
		const { p, S, base } = await startPlugin(VaultLockPlugin, ENC_LOCAL, null, { before: (b) => {
			const big = path.join(b, V_DIR, "Big.bin");
			fs.closeSync(fs.openSync(big, "w"));
			fs.truncateSync(big, 101 * 1024 * 1024); // sparse
		} });
		const cur = S.current;
		await within(cur.finishLock(), 20_000, "finishLock");
		encryptedOnDisk(base, ["Secret.md"], "beside a big file");
		const big = path.join(base, H_DIR, "Big.bin");
		check(fs.existsSync(big) && fs.statSync(big).size === 101 * 1024 * 1024 && !fs.existsSync(big + ".vlenc") && !fs.existsSync(big + ".vlenc.tmp"), "the big file is not hidden as it was: " + dstr(disk(base)));
		const st = cur.privateFolder.stats();
		check(st.tooBig.some((x) => x.includes("Big.bin")) && st.files === 1, "stats: " + JSON.stringify(st));
		await stopPlugin(p);
		try { fs.rmSync(path.join(base, H_DIR, "Big.bin"), { force: true }); } catch { /* removed with the vault at the end */ }
	}
	step = "22 no key: hidden only";
	{
		const { p, S, base } = await startPlugin(VaultLockPlugin, REAL_PASS, null, { before: (b) => { fs.writeFileSync(path.join(b, V_DIR, "Two.md"), "two"); } });
		const cur = S.current;
		await within(cur.finishLock(), 20_000, "finishLock");
		const st = cur.privateFolder.stats();
		check(st.plain === 2 && st.files === 0 && st.keyId === null && st.on === true, "stats without a key: " + JSON.stringify(st));
		const d = disk(base);
		check(d.plain === 2 && d.vlenc === 0 && d.tmp === 0 && !fs.existsSync(path.join(base, V_DIR)), "without a key: " + dstr(d));
		await stopPlugin(p);
	}
	step = "22 kill switch (config.json encrypt)";
	{
		const { p, S, base } = await startPlugin(VaultLockPlugin, ENC);
		const cur = S.current;
		await within(cur.finishLock(), 20_000, "finishLock");
		encryptedOnDisk(base, ["Secret.md"], "locked");
		server = fakeServer({ "_control/config.json": JSON.stringify({ encrypt: false }), [KEY_FILE]: keyJson() });
		cur.backup.onPaired(false);
		await within(cur.backup.queue, 15_000, "reconcile");
		check(p.settings.encrypt === false && readData(base).encrypt === false, "encrypt:false was not applied and saved");
		check(server.json("_control/status.json").encryption?.on === false, "status.json encryption.on");
		await unlockApp(cur, "unlock with encrypt off");
		check(fs.readFileSync(path.join(base, V_DIR, "Secret.md"), "utf8") === "secret", "encrypt off: the unlock did not decrypt");
		await within(cur.backup.queue, 15_000, "reconcile after the unlock");
		await within(cur.lock(), 10_000, "lock");
		await within(cur.finishLock(), 20_000, "finishLock");
		let d = disk(base);
		check(d.plain === 1 && d.vlenc === 0 && fs.readFileSync(path.join(base, H_DIR, "Secret.md"), "utf8") === "secret", "encrypt off: the lock did more than hide: " + dstr(d));
		server.files.set("_control/config.json", Buffer.from(JSON.stringify({ encrypt: true })));
		let cfgAt = 0;
		server.hold = (m, f) => { if (m === "GET" && f === "_control/config.json" && !cfgAt) cfgAt = Date.now(); return null; };
		await reconcile(cur);
		server.hold = () => null;
		check(p.settings.encrypt === true, "encrypt:true was not applied");
		// Encrypted now (requestEncrypt), not at the next lock and not after a pause.
		await waitFor(() => { const x = disk(base); return x.vlenc === 1 && x.plain === 0 && x.tmp === 0; }, 10_000, "the hidden folder encrypted once encrypt was on again");
		check(cfgAt > 0 && Date.now() - cfgAt < 4_000, `encrypted ${Date.now() - cfgAt} ms after encrypt:true was read: the pass waited for the pause`);
		await within(cur.finishLock(), 20_000, "finishLock");
		encryptedOnDisk(base, ["Secret.md"], "encrypt on again while hidden (requestEncrypt)");

		step = "22 a different key on the server";
		server.files.set(KEY_FILE, Buffer.from(keyJson(KEY2)));
		await reconcile(cur);
		const c = cur.backup.control;
		check(c.keyState === "mismatch" && c.serverKeyId === KEY2.id && sameKey(p.settings.vaultKey, KEY) && sameKey(readData(base).vaultKey, KEY), `mismatch: keyState ${c.keyState}, serverKeyId ${c.serverKeyId}, vaultKey ${JSON.stringify(p.settings.vaultKey)}`);
		const enc = server.json("_control/status.json").encryption;
		check(enc?.keyState === "mismatch" && enc.serverKeyId === KEY2.id && enc.keyId === KEY.id, "status.json encryption: " + JSON.stringify(enc));
		await unlockApp(cur, "unlock after a mismatch");
		check(fs.readFileSync(path.join(base, V_DIR, "Secret.md"), "utf8") === "secret" && !listFiles(path.join(base, V_DIR)).some((r) => r.includes(".vlenc")), "not decrypted with the computer's own key: " + listFiles(path.join(base, V_DIR)));
		await within(cur.backup.queue, 15_000, "reconcile after the unlock");
		await stopPlugin(p);
		server = null;
	}
	step = "22 plugin code below 1.9.0 is refused";
	{
		const mainJs = fs.readFileSync(path.join(root, "main.js"));
		const old = variant(22);
		const { p, S, base } = await startPlugin(VaultLockPlugin, { ...LOGIN }, null, {
			keys: [TKEY],
			before: (b) => {
				stageLocal(b, old, { version: "1.8.0", force: true }); // published --force by an old vlb, still staged
				fs.writeFileSync(path.join(b, PLUGIN_DIR, "main.js"), mainJs);
				fs.writeFileSync(path.join(b, PLUGIN_DIR, "manifest.json"), JSON.stringify(manifestJson, null, "\t"));
			},
		});
		let cs = S.coreStatus();
		check(S.running?.id === BUILTIN && cs.server?.state === "rejected" && /older than 1\.9\.0/.test(cs.server.why), "a staged 1.8.0 --force bundle: " + JSON.stringify({ running: S.running, server: cs.server }));
		server = fakeServer();
		const staged = bundleFiles(base).join();
		const before = coreState(base).lastAcceptedAt;
		publish(server, "app", variant(23), { version: "1.8.0", force: true });
		publish(server, "core", Buffer.concat([mainJs, Buffer.from("\n// core 1.8.0\n")]), { version: "1.8.0" });
		await within(S.tick(), 5_000, "tick");
		const st = coreState(base);
		check(/app: older than 1\.9\.0/.test(st.updateError ?? "") && /core: older than 1\.9\.0/.test(st.updateError ?? ""), "updateError: " + st.updateError);
		check(bundleFiles(base).join() === staged && st.lastAcceptedAt.app === before.app && st.lastAcceptedAt.core === before.core, "something old was taken: " + JSON.stringify({ files: bundleFiles(base), at: st.lastAcceptedAt }));
		check(fs.readFileSync(path.join(base, PLUGIN_DIR, "main.js")).equals(mainJs) && !fs.existsSync(path.join(base, PLUGIN_DIR, "main.js.prev")), "main.js was touched by a 1.8.0 core bundle");
		check(!server.sent("GET", "_control/update/app/app.js") && !server.sent("GET", "_control/update/core/main.js"), "old plugin code was downloaded");
		cs = S.coreStatus();
		check(S.running?.id === BUILTIN && cs.server?.state === "rejected", "after the tick: " + JSON.stringify({ running: S.running, server: cs.server }));
		await stopPlugin(p);
		server = null;
	}
	for (const which of ["data", "bak"]) {
		step = `22 the key arrives and ${which === "data" ? "data.json" : "data.bak.json"} cannot be written`;
		const { p, S, base } = await startPlugin(VaultLockPlugin, { ...REAL_PASS, ...LOGIN });
		const cur = S.current, pf = cur.privateFolder;
		server = fakeServer({ [KEY_FILE]: keyJson() });
		saveFail[which] = 1;
		cur.backup.onPaired(false);
		await within(cur.backup.queue, 15_000, "reconcile");
		check(saveFail[which] === 0, "the strict save of the key was never tried");
		check(cur.backup.control.keyState === "unsaved" && p.settings.vaultKey === null && !pf.encryptionReady(), `after the failed save: keyState ${cur.backup.control.keyState}, vaultKey ${JSON.stringify(p.settings.vaultKey)}`);
		await within(cur.finishLock(), 20_000, "finishLock");
		let d = disk(base);
		check(d.plain === 1 && d.vlenc === 0, "encrypted with a key that is not saved: " + dstr(d));
		const enc = server.json("_control/status.json").encryption;
		check(enc?.keyState === "unsaved" && enc.keyId === null, "status.json encryption: " + JSON.stringify(enc));
		await reconcile(cur);
		check(cur.backup.control.keyState === "ok" && sameKey(p.settings.vaultKey, KEY) && pf.keyDurable === true, "the next reconcile did not save the key: " + cur.backup.control.keyState);
		check(sameKey(readData(base).vaultKey, KEY) && sameKey(readData(base, "data.bak.json").vaultKey, KEY), "the key is not in both settings files");
		await within(cur.finishLock(), 20_000, "finishLock");
		encryptedOnDisk(base, ["Secret.md"], "once the key is saved");
		await stopPlugin(p);
		server = null;
	}

	// 22b. A pending choice is never switched to in the middle of a decrypt: locked() is false
	// while unlocking (E.4); it switches at the next lock.
	step = "22b no switch mid-decrypt";
	{
		const { p, S, base } = await startPlugin(VaultLockPlugin, ENC_LOCAL, null, { before: (b) => addPrivate(b, 30) });
		const cur = S.current;
		await within(cur.finishLock(), 20_000, "finishLock");
		check(disk(base).vlenc === 31, "not all encrypted: " + dstr(disk(base)));
		S.pending = { choice: "lifeboat", serverState: "none", why: "test" };
		// The folder's rename back takes 2 s.
		hooks.adapter = (name, a) => (name === "rename" && folderRename(a[0], a[1]) === "show" ? 2_000 : 0);
		hooks.fs = (name, a) => (/^rename/.test(name) && folderRename(a[0], a[1]) === "show" ? 2_000 : 0);
		let switched = "", ticksWhileUnlocking = 0, lockedWhileUnlocking = 0;
		const unlocking = cur.lockScreen.tryUnlock("right");
		await waitFor(() => cur.lockScreen.unlocking === true, 10_000, "unlocking");
		const timer = setInterval(() => {
			if (cur.lockScreen.unlocking) {
				ticksWhileUnlocking++;
				if (cur.locked()) lockedWhileUnlocking++;
			}
			S.activationTick();
			if (S.switching || S.current !== cur || S.running?.id !== BUILTIN) switched ||= JSON.stringify(S.running);
		}, 100);
		let ok;
		try { ok = await within(unlocking, 30_000, "unlock"); } finally { clearInterval(timer); }
		resetHooks();
		check(ticksWhileUnlocking >= 5 && lockedWhileUnlocking === 0, `locked() was true in ${lockedWhileUnlocking} of ${ticksWhileUnlocking} ticks during the decrypt (E.4: false while unlocking)`);
		check(!switched, "switched in the middle of the decrypt: " + switched);
		check(ok === true && !cur.locked() && fs.existsSync(path.join(base, V_DIR)), "the slow unlock did not finish: " + errText());
		S.activationTick();
		check(!S.switching && S.current === cur, "switched while unlocked");
		await within(cur.lock(), 10_000, "lock");
		S.activationTick();
		check(S.switching, "no switch at the next lock");
		await within(S.switching, 10_000, "switch");
		check(S.running?.kind === "lifeboat" && S.current.locked(), "the waiting choice did not become active: " + JSON.stringify(S.running));
		await stopPlugin(p);
	}

	// 22c. The kill switch reaches the lifeboat through the core tick (it has no control channel).
	step = "22c kill switch under the lifeboat";
	{
		const { p, S, base } = await startPlugin(VaultLockPlugin, ENC, { v: 1, config: { safeMode: true } });
		server = fakeServer({ "_control/config.json": JSON.stringify({ core: { safeMode: true }, encrypt: false }) });
		const lb = S.current;
		check(S.running?.kind === "lifeboat" && lb.locked() && typeof lb.finishLock === "function", "not the locked lifeboat");
		await within(lb.finishLock(), 20_000, "finishLock");
		encryptedOnDisk(base, ["Secret.md"], "the lifeboat with a key in data.json");
		await within(S.tick(), 5_000, "tick");
		check(p.settings.encrypt === false && readData(base).encrypt === false, "the core tick did not apply and save encrypt:false");
		check(S.current === lb, "the tick replaced the lifeboat");
		await unlockApp(lb, "lifeboat unlock with encrypt off");
		check(fs.readFileSync(path.join(base, V_DIR, "Secret.md"), "utf8") === "secret", "the lifeboat's unlock did not decrypt");
		await within(lb.lock(), 10_000, "lifeboat lock");
		await within(lb.finishLock(), 20_000, "finishLock");
		const d = disk(base);
		check(d.plain === 1 && d.vlenc === 0, "encrypt off: the lifeboat's lock did more than hide: " + dstr(d));
		await stopPlugin(p);
		server = null;
	}

	// 23. The lifeboat with a key in data.json: locks and encrypts; its backup sends nothing
	// under Private/ while hidden and never a .vlenc; unlock decrypts; status.json has encryption.
	step = "23 lifeboat";
	{
		let orig;
		const { p, S, base } = await startPlugin(VaultLockPlugin, ENC, { v: 1, config: { safeMode: true } }, { before: (b) => { orig = snap(path.join(b, V_DIR)); } });
		server = fakeServer();
		const lb = S.current;
		check(S.running?.kind === "lifeboat" && lb.locked(), "not the locked lifeboat");
		await within(lb.finishLock(), 20_000, "finishLock");
		encryptedOnDisk(base, ["Secret.md"], "the lifeboat's lock");
		await within(lb.run(), 10_000, "lifeboat run");
		check(!server.log.some((l) => l.includes("Private")) && ![...server.files.keys()].some((k) => k.includes(".vlenc")), "the lifeboat sent something of the private folder while hidden: " + server.log.filter((l) => l.includes("Private") || l.includes(".vlenc")));
		const st = server.json("_control/status.json");
		const enc = st.encryption;
		check(st.lifeboat === true && enc && enc.on === true && enc.keyId === KEY.id && enc.keyState === "ok" && enc.files === 1 && enc.plain === 0 && Array.isArray(enc.restoreDeferred), "lifeboat status.json: " + JSON.stringify({ lifeboat: st.lifeboat, encryption: enc }));
		await unlockApp(lb, "lifeboat unlock");
		check(!fs.existsSync(path.join(base, H_DIR)), "the hidden folder is still there after the lifeboat's unlock");
		sameSnap(snap(path.join(base, V_DIR)), orig, "after the lifeboat's unlock");
		await within(lb.run(), 10_000, "lifeboat run");
		check(server.files.get("Private/Secret.md")?.toString() === "secret" && ![...server.files.keys()].some((k) => k.includes(".vlenc")), "the lifeboat did not back up the private note once unlocked");
		await stopPlugin(p);
		server = null;
	}

	// 24. Quit, restore, stop.
	step = "24 quit while unlocked";
	{
		const { p, S, base, app } = await startPlugin(VaultLockPlugin, ENC_LOCAL, null, { before: (b) => {
			fs.writeFileSync(path.join(b, V_DIR, "Two.md"), "two");
			fs.writeFileSync(path.join(b, V_DIR, "Three.bin"), crypto.randomBytes(5000));
		} });
		const cur = S.current;
		await within(cur.finishLock(), 20_000, "finishLock");
		await unlockApp(cur);
		const t0 = Date.now();
		await within(quit(app), 20_000, "the quit task");
		const ms = Date.now() - t0;
		const d = disk(base);
		check(cur.locked() && !fs.existsSync(path.join(base, V_DIR)) && d.plain === 0 && d.tmp === 0 && d.vlenc === 3, "after the quit task: " + dstr(d));
		check(ms < 4_000, `the quit task took ${ms} ms for 3 files: the 5 s pause was not skipped`);
		await stopPlugin(p);
	}

	// The deferred restore (B8): server copies newer than the local Secret.md and Sub/Deep.md, one
	// older than the local Mine.md; restore-all sent while locked.
	const T0 = Date.parse("2026-11-10T08:00:00Z"), DAY = 86_400_000;
	const SRV = { "Secret.md": "secret, the server's newer copy", "Sub/Deep.md": "deep, the server's newer copy", "Mine.md": "mine, the server's older copy" };
	const LOC = { "Secret.md": "secret", "Sub/Deep.md": "deep, local and older", "Mine.md": "mine, local and newer" };
	async function restoreSetup(id) {
		let note;
		const r = await startPlugin(VaultLockPlugin, ENC, null, { before: (b) => {
			fs.mkdirSync(path.join(b, V_DIR, "Sub"));
			for (const [rel, t] of [["Secret.md", T0], ["Sub/Deep.md", T0], ["Mine.md", T0 + 2 * DAY]]) {
				fs.writeFileSync(path.join(b, V_DIR, rel), LOC[rel]);
				fs.utimesSync(path.join(b, V_DIR, rel), new Date(t), new Date(t));
			}
			const s = fs.statSync(path.join(b, "Note.md"));
			note = { m: Math.floor(s.mtimeMs), s: s.size };
		} });
		const idx = { "Note.md": note };
		const files = { "Note.md": "note", "_control/commands.json": JSON.stringify([{ id, cmd: "restore-all" }]) };
		for (const rel of Object.keys(SRV)) {
			idx["Private/" + rel] = { m: T0 + DAY, s: Buffer.byteLength(SRV[rel]) };
			files["Private/" + rel] = SRV[rel];
		}
		server = fakeServer({ ...files, "_manifest.json": JSON.stringify(idx) });
		const cur = r.S.current;
		await within(cur.finishLock(), 20_000, "finishLock");
		encryptedOnDisk(r.base, Object.keys(LOC), "locked");
		const hidden = snap(path.join(r.base, H_DIR));
		cur.backup.onPaired(false);
		await within(cur.backup.queue, 15_000, "reconcile");
		const log = r.p.settings.commandLog[id];
		check(log?.ok === true && /deferred/.test(log.detail ?? ""), "restore-all while locked: " + JSON.stringify(log));
		check(r.p.settings.restoreDeferred.some((d) => d.id === id && d.cmd === "restore-all"), "settings.restoreDeferred: " + JSON.stringify(r.p.settings.restoreDeferred));
		check((readData(r.base).restoreDeferred ?? []).some((d) => d.id === id), "the deferred restore is not in data.json");
		sameSnap(snap(path.join(r.base, H_DIR)), hidden, "the restore wrote under .Private/");
		check((server.json("_control/status.json").encryption?.restoreDeferred ?? []).join() === id, "status.json encryption.restoreDeferred: " + JSON.stringify(server.json("_control/status.json").encryption));
		check(privateWrites(server).length === 0, "sent under Private/ while locked: " + privateWrites(server));
		const ev = events(cur);
		// At the unlock Obsidian reports every file of the folder that reappears as created.
		hooks.folderRenamed = (dir) => { if (dir === "show") for (const rel of listFiles(path.join(r.base, V_DIR))) ev.create("Private/" + rel); };
		return { ...r, cur };
	}
	step = "24 restore-all while locked, then the unlock";
	{
		const { p, base, cur } = await restoreSetup("ra-1");
		const m0 = server.log.length;
		await unlockApp(cur);
		await within(cur.backup.queue, 15_000, "the reconcile after the unlock");
		await sleep(2_300); // the create events' 2 s debounce
		await within(cur.backup.queue, 15_000, "the create events");
		const after = server.log.slice(m0);
		check(!after.includes("PUT Private/Secret.md") && !after.includes("PUT Private/Sub/Deep.md"), "an older local note was PUT over the newer server copy: " + privateWrites(server, m0));
		const gS = after.indexOf("GET Private/Secret.md"), gD = after.indexOf("GET Private/Sub/Deep.md"), pM = after.indexOf("PUT Private/Mine.md");
		check(gS >= 0 && gD >= 0 && pM > Math.max(gS, gD) && after.filter((l) => l === "PUT Private/Mine.md").length === 1, "the deferred restore did not run before Mine.md was uploaded (once): " + after.filter((l) => l.includes("Private/")));
		const txt = (rel) => fs.readFileSync(path.join(base, V_DIR, rel), "utf8");
		check(txt("Secret.md") === SRV["Secret.md"] && txt("Sub/Deep.md") === SRV["Sub/Deep.md"] && txt("Mine.md") === LOC["Mine.md"], "after the deferred restore: " + JSON.stringify(Object.keys(LOC).map(txt)));
		for (const rel of ["Secret.md", "Sub/Deep.md"]) {
			const re = new RegExp("^_trash/[^/]+/Private/" + rel.replace(/[./]/g, (c) => "\\" + c) + "$");
			check(server.bodies.some(([f, b]) => re.test(f) && b.toString() === LOC[rel]), `the old local ${rel} was not parked under _trash/`);
		}
		check(p.settings.restoreDeferred.length === 0 && (readData(base).restoreDeferred ?? []).length === 0, "restoreDeferred not cleared: " + JSON.stringify(p.settings.restoreDeferred));
		check(/deferred private files/.test(p.settings.commandLog["ra-1"]?.detail ?? ""), "commandLog detail: " + p.settings.commandLog["ra-1"]?.detail);
		check(server.files.get("Private/Secret.md").toString() === SRV["Secret.md"] && server.files.get("Private/Mine.md").toString() === LOC["Mine.md"], "server copies after the deferred restore");
		await stopPlugin(p);
		server = null;
	}
	step = "24 a deferred restore that fails once";
	{
		const { p, base, cur } = await restoreSetup("ra-2");
		let fail = 1;
		server.refuse = (m, f) => (m === "GET" && f.startsWith("Private/") && fail-- > 0 ? 500 : 0);
		const m0 = server.log.length;
		await unlockApp(cur);
		await within(cur.backup.queue, 15_000, "the reconcile after the unlock");
		check(fail <= 0, "the deferred restore did not run after the unlock");
		check(p.settings.restoreDeferred.some((d) => d.id === "ra-2") && (readData(base).restoreDeferred ?? []).some((d) => d.id === "ra-2"), "a failed deferred run dropped the record");
		await sleep(2_300);
		await within(cur.backup.queue, 15_000, "the create events");
		check(privateWrites(server, m0).length === 0, "sent under Private/ while the deferred restore was pending: " + privateWrites(server, m0));
		await reconcile(cur);
		const txt = (rel) => fs.readFileSync(path.join(base, V_DIR, rel), "utf8");
		check(p.settings.restoreDeferred.length === 0 && txt("Secret.md") === SRV["Secret.md"] && txt("Mine.md") === LOC["Mine.md"], "the next reconcile did not finish the deferred restore");
		check(server.files.get("Private/Mine.md").toString() === LOC["Mine.md"] && server.files.get("Private/Secret.md").toString() === SRV["Secret.md"], "server copies after the retried restore");
		await stopPlugin(p);
		server = null;
	}
	step = "24 a locked restore-all that fails after deferring";
	{
		const { p, S, base } = await startPlugin(VaultLockPlugin, ENC);
		const cur = S.current;
		await within(cur.finishLock(), 20_000, "finishLock");
		const idx = { "Private/Secret.md": { m: T0 + DAY, s: Buffer.byteLength(SRV["Secret.md"]) }, "Zed.md": { m: T0, s: 3 } };
		server = fakeServer({ "_manifest.json": JSON.stringify(idx), "Private/Secret.md": SRV["Secret.md"], "Zed.md": "zed", "_control/commands.json": JSON.stringify([{ id: "ra-3", cmd: "restore-all" }]) });
		server.refuse = (m, f) => (m === "GET" && f === "Zed.md" ? 500 : 0); // the GET after the deferred private file
		cur.backup.onPaired(false);
		await within(cur.backup.queue, 15_000, "reconcile");
		const saved = readData(base);
		check(p.settings.commandLog["ra-3"]?.ok === false && saved.commandLog?.["ra-3"]?.ok === false && saved.doneCommands?.includes("ra-3"), "the failed restore-all is not marked done with ok: false: " + JSON.stringify(saved.commandLog?.["ra-3"]));
		check((saved.restoreDeferred ?? []).some((d) => d.id === "ra-3"), "the deferred part is not in data.json with it: " + JSON.stringify(saved.restoreDeferred));
		await stopPlugin(p);
		server = null;
	}
	step = "24 restore-all while locked, no .Private/ yet";
	{
		const T1 = Date.parse("2026-11-12T08:00:00Z");
		const { p, S, base } = await startPlugin(VaultLockPlugin, ENC, null, { before: (b) => fs.rmSync(path.join(b, V_DIR), { recursive: true }) });
		const cur = S.current;
		check(cur.locked() && !fs.existsSync(path.join(base, H_DIR)) && !fs.existsSync(path.join(base, V_DIR)), "not a locked vault without a private folder");
		const idx = { "Private/Secret.md": { m: T1, s: Buffer.byteLength(SRV["Secret.md"]) }, "Private/Sub/Deep.md": { m: T1, s: Buffer.byteLength(SRV["Sub/Deep.md"]) } };
		server = fakeServer({ "_manifest.json": JSON.stringify(idx), "Private/Secret.md": SRV["Secret.md"], "Private/Sub/Deep.md": SRV["Sub/Deep.md"], "_control/commands.json": JSON.stringify([{ id: "ra-4", cmd: "restore-all" }]) });
		cur.backup.onPaired(false);
		await within(cur.backup.queue, 15_000, "reconcile");
		check(p.settings.commandLog["ra-4"]?.ok === true, "restore-all: " + JSON.stringify(p.settings.commandLog["ra-4"]));
		await within(cur.finishLock(), 20_000, "finishLock");
		encryptedOnDisk(base, ["Secret.md", "Sub/Deep.md"], "restored while locked without .Private/: hidden and encrypted");
		const d = await decryptFile(path.join(base, H_DIR, "Secret.md.vlenc"));
		check(d.plain.toString() === SRV["Secret.md"] && d.mtime === T1, "the restored note was not encrypted with the server copy's time: " + JSON.stringify({ mtime: d.mtime, want: T1 }));
		check(privateWrites(server).length === 0, "sent under Private/: " + privateWrites(server));
		await stopPlugin(p);
		server = null;
	}
	step = "24 stop during an encrypt";
	{
		let orig;
		const { p, S, base } = await startPlugin(VaultLockPlugin, ENC_LOCAL, null, { before: (b) => { addPrivate(b, 12); orig = snap(path.join(b, V_DIR)); } });
		const cur = S.current;
		// Each file's rename into place takes a moment, so the stop comes in the middle of the pass.
		hooks.fs = (name, a, isAsync) => (isAsync && name === "rename" && norm(a[0]).endsWith(".vlenc.tmp") ? 150 : 0);
		void cur.finishLock();
		await waitFor(() => disk(base).vlenc >= 1, 10_000, "the pass to start");
		await stopPlugin(p);
		resetHooks();
		const d = disk(base);
		check(d.tmp === 0 && d.plain > 0, "after a stop in the middle of the pass: " + dstr(d));
		for (const rel of Object.keys(orig)) {
			const x = fs.existsSync(path.join(base, H_DIR, rel)), v = fs.existsSync(path.join(base, H_DIR, rel + ".vlenc"));
			check(x !== v, `${rel}: ${x ? "both forms" : "neither form"} after the stop`);
		}
		const q = await restartOn(base, VaultLockPlugin);
		await within(q.S.current.finishLock(), 20_000, "finishLock after the restart");
		const d2 = disk(base);
		check(d2.plain === 0 && d2.tmp === 0 && d2.vlenc === Object.keys(orig).length, "the next instance did not finish: " + dstr(d2));
		await unlockApp(q.S.current);
		sameSnap(snap(path.join(base, V_DIR)), orig, "after the stop, a restart and the unlock");
		await stopPlugin(q.p);
	}

	// 24b. One pass at a time (B12): requests during a pass queue one follow-up at most; a stop
	// ends the pass at its file boundary whatever the network does, and a second PrivateFolder
	// on the same vault (the next copy of the plugin) waits for it on the window's chain.
	step = "24b single-flight";
	{
		let orig;
		const { p, S, base, app } = await startPlugin(VaultLockPlugin, ENC, null, { before: (b) => { addPrivate(b, 30); orig = snap(path.join(b, V_DIR)); } });
		const cur = S.current, pf = cur.privateFolder;
		check(typeof pf.__passes === "number" && typeof pf.__fireRetry === "function" && typeof pf.requestEncrypt === "function", "the private folder has no __passes / __fireRetry() / requestEncrypt()");
		const live = new Set();
		let maxLive = 0;
		hooks.fs = (name, a, isAsync) => {
			const f = typeof a[0] === "string" ? norm(a[0]) : "";
			if (!f.endsWith(".vlenc.tmp")) return 0;
			if (/^(open|writeFile)/.test(name)) { live.add(f); maxLive = Math.max(maxLive, live.size); }
			if (/^(rename|unlink)/.test(name)) { live.delete(f); if (isAsync && name === "rename") return 30; }
			return 0;
		};
		void cur.finishLock(); // the start's pass runs now
		await waitFor(() => disk(base).vlenc >= 1, 10_000, "the pass to start");
		pf.requestEncrypt();
		pf.requestEncrypt();
		pf.__fireRetry();
		await within(cur.finishLock(), 30_000, "finishLock");
		await sleep(50);
		check(maxLive === 1, `${maxLive} files were being transformed at the same time`);
		check(pf.__passes === 2, `${pf.__passes} passes ran (want the running one and exactly one follow-up)`);
		const d = disk(base);
		check(d.plain === 0 && d.tmp === 0 && d.vlenc === 31, "after the passes: " + dstr(d));
		resetHooks();
		await unlockApp(cur);
		sameSnap(snap(path.join(base, V_DIR)), orig, "after the unlock");

		step = "24b stop during a pass; a second PrivateFolder waits";
		server = fakeServer();
		const held = gate();
		let holding = false;
		server.hold = (m) => (m === "PUT" ? ((holding = true), held.p) : null); // no PUT is answered
		cur.backup.onPaired(false);
		await waitFor(() => holding, 10_000, "a PUT that gets no answer");
		const ops = [];
		hooks.log = ops;
		hooks.fs = (name, a, isAsync) => (isAsync && name === "rename" && typeof a[0] === "string" && norm(a[0]).endsWith(".vlenc.tmp") ? 150 : 0);
		await within(cur.lock(), 10_000, "lock");
		void cur.finishLock();
		await waitFor(() => disk(base).vlenc >= 1, 10_000, "the pass to start");
		const chain = globalThis.__vaultLock?.pf?.[app.vault.adapter.getBasePath()];
		check(chain && typeof chain.then === "function", "no per-vault chain at window.__vaultLock.pf[<vault base path>]");
		let passEnded = -1, finished = false;
		void chain.then(() => { passEnded = ops.length; }, () => { passEnded = ops.length; });
		// A stray beside .Private/ gives the second instance's hide() work of its own under Private/.
		fs.mkdirSync(path.join(base, V_DIR));
		fs.writeFileSync(path.join(base, V_DIR, "Late.md"), "late");
		const mark = ops.length;
		const fin = cur.stop().then(() => { finished = true; });
		const pf2 = new pf.constructor(app, () => p.settings);
		const hid2 = pf2.hide();
		await within(hid2, 15_000, "the second instance's hide()");
		check(passEnded >= 0, "the second instance's hide() finished before the first instance's pass");
		const visible = ([, f]) => f === V_DIR || f.startsWith(V_DIR + "/") || /(^|\/)Private(\/|$)/.test(f);
		const first2 = ops.findIndex((o, i) => i >= mark && visible(o));
		check(first2 >= 0 && first2 >= passEnded, `the second instance worked (${JSON.stringify(ops[first2])}) before the first instance's pass ended (op ${first2} < ${passEnded})`);
		check(!ops.slice(passEnded).some(([, f]) => f.endsWith(".vlenc.tmp")), "the first instance's pass went on after its stop: " + JSON.stringify(ops.slice(passEnded).filter(([, f]) => f.endsWith(".vlenc.tmp"))));
		check(!finished, "stop() resolved although a PUT is still unanswered (the test needs it held)");
		const d2 = disk(base);
		check(d2.tmp === 0 && fs.existsSync(path.join(base, H_DIR, "Late.md")) && !fs.existsSync(path.join(base, V_DIR)), "after the stop and the second hide(): " + dstr(d2));
		// The file in progress was finished, not cut off: every note is in exactly one form.
		for (const rel of Object.keys(orig)) {
			const x = fs.existsSync(path.join(base, H_DIR, rel)), v = fs.existsSync(path.join(base, H_DIR, rel + ".vlenc"));
			check(x !== v, `${rel}: ${x ? "both forms" : "neither form"} after the stop`);
		}
		held.release();
		await within(fin, 15_000, "stop() once the PUT is answered");
		await within(pf2.dispose(), 10_000, "the second instance's dispose()");
		resetHooks();
		await stopPlugin(p);
		server = null;
		orig["Late.md"] = snap(path.join(base, H_DIR))["Late.md"];
		const q = await restartOn(base, VaultLockPlugin);
		await within(q.S.current.finishLock(), 20_000, "finishLock after the restart");
		const d3 = disk(base);
		check(d3.plain === 0 && d3.tmp === 0 && d3.vlenc === Object.keys(orig).length, "the next instance did not finish: " + dstr(d3));
		await unlockApp(q.S.current);
		sameSnap(snap(path.join(base, V_DIR)), orig, "after the stop, a restart and the unlock");
		await stopPlugin(q.p);
	}

	// 24c. A lock (or Obsidian closing) during an unlock wins (B15): the show() stops before
	// the rename, the window stays locked, the queued hide() encrypts again what was decrypted.
	// A rename that keeps failing leaves the window locked too, and the next attempt unlocks.
	step = "24c lock during an unlock";
	{
		let orig;
		const { p, S, base, app } = await startPlugin(VaultLockPlugin, ENC_LOCAL, null, { before: (b) => { addPrivate(b, 30); orig = snap(path.join(b, V_DIR)); } });
		const cur = S.current, pf = cur.privateFolder;
		const seen = recordProgress(pf);
		await within(cur.finishLock(), 20_000, "finishLock");
		check(disk(base).vlenc === 31, "not all encrypted: " + dstr(disk(base)));
		const slow = () => {
			hooks.fs = (name, a, isAsync) => (isAsync && /^rename/.test(name) ? 100 : 0);
			hooks.adapter = (name) => (name === "rename" ? 100 : 0);
		};
		const lockedStill = (what) => {
			check(cur.lockScreen.locked === true && cur.locked() === true && overlayUp(), `${what}: the window is not locked (locked ${cur.lockScreen.locked}, overlay ${overlayUp()})`);
			check(fs.existsSync(path.join(base, H_DIR)) && !fs.existsSync(path.join(base, V_DIR)), `${what}: the folder was renamed back`);
		};
		for (const how of ["lock()", "the quit task"]) {
			step = `24c ${how} during an unlock`;
			slow();
			seen.length = 0;
			const unlocking = cur.lockScreen.tryUnlock("right");
			await waitFor(() => unlockingN(seen) >= 1, 20_000, '"Unlocking… n of N" with n ≥ 1');
			const locking = how === "lock()" ? cur.lock() : quit(app);
			check(await within(unlocking, 20_000, "the unlock") === true, "the right passphrase was answered as wrong");
			lockedStill(`${how} during the unlock`);
			await within(locking, 20_000, how);
			resetHooks();
			await within(cur.finishLock(), 20_000, "finishLock");
			const d = disk(base);
			check(d.plain === 0 && d.tmp === 0 && d.vlenc === 31, `after ${how} during the unlock: ` + dstr(d));
			lockedStill(`after ${how}`);
		}
		step = "24c the rename back keeps failing";
		const until = performance.now() + 40_000;
		const eperm = () => Object.assign(new Error("EPERM: operation not permitted, rename (test: held by another program)"), { code: "EPERM" });
		hooks.adapter = (name, a) => { if (name === "rename" && folderRename(a[0], a[1]) === "show" && performance.now() < until) throw eperm(); return 0; };
		hooks.fs = (name, a) => { if (/^rename/.test(name) && folderRename(a[0], a[1]) === "show" && performance.now() < until) throw eperm(); return 0; };
		const t0 = Date.now();
		check(await within(cur.lockScreen.tryUnlock("right"), 60_000, "the unlock whose rename fails") === true, "the right passphrase was answered as wrong");
		console.log(`[smoke] the failing rename was given up after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
		lockedStill("a rename that keeps failing");
		check(errText() && !/^Unlocking/.test(errText()), "no error text after the failed unlock: " + JSON.stringify(errText()));
		resetHooks();
		await within(cur.finishLock(), 20_000, "finishLock");
		const d = disk(base);
		check(d.plain === 0 && d.tmp === 0 && d.vlenc === 31, "after the failed unlock: " + dstr(d));
		step = "24c the next attempt unlocks";
		await unlockApp(cur);
		sameSnap(snap(path.join(base, V_DIR)), orig, "after the unlock");
		await stopPlugin(p);
	}

	// 7. Nothing touched the network outside the steps with a server.
	step = "7 no network";
	check(netCalls === 0, `requestUrl was called ${netCalls} times`);
	check(cachedGets.length === 0, "GET without Cache-Control: no-cache: " + [...new Set(cachedGets)].join(", "));
}

const guard = setTimeout(() => { console.error(`smoke test FAILED at ${step}: timed out`); process.exit(1); }, 300_000);
function cleanUp() {
	for (const v of vaults) {
		try { fs.rmSync(v, { recursive: true, force: true }); } catch (e) { console.warn("could not remove", v, e.message); }
	}
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
