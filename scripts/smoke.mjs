// Smoke test of the built files: main.js and app.js load the way Obsidian loads them, start,
// lock (with a passphrase) and stop, with no network. Plain Node, no dependencies, a few
// seconds. Run after `npm run build`; exits non-zero on the first failure.
//
// Obsidian is replaced by a small stub module. Its Component follows Obsidian's own order:
// load() runs onload() and then the children; unload() unloads the children first, then
// runs the registered cleanups, then onunload().

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestJson = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const PLUGIN_DIR = ".obsidian/plugins/vault-lock";
const PASS = { passHash: "0".repeat(64), passSalt: "1".repeat(32) };

let step = "setup";
function check(ok, what) {
	if (!ok) throw new Error(what);
}
function within(p, ms, what) {
	let t;
	const limit = new Promise((_, reject) => { t = setTimeout(() => reject(new Error(`${what}: not done in ${ms} ms`)), ms); });
	return Promise.race([p, limit]).finally(() => clearTimeout(t));
}

// ---- DOM: just enough for the lock screen and the cover -------------------------------

/** Every element the plugin created (createElement / createDiv / createEl), as plain records. */
let created = [];
/** Set when the cover was removed while no lock screen was up: the vault showed unlocked. */
let coverBlind = false;

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
				if (r.id === "vlb-cover" && !byCls("vlb-overlay").some((e) => e.isConnected)) coverBlind = true;
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
			r[k] = v;
			// A title change is a change in <head>: the lock screen's title guard hears about it.
			if (k === "title" && tag === "document") for (const ob of observers) queueMicrotask(() => ob.cb([], ob));
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
	observers.clear();
	const doc = el("document");
	doc.head = el("head");
	doc.body = el("body");
	doc.title = "Note - My vault - Obsidian";
	globalThis.document = doc;
	delete globalThis.__vaultLock;
	delete globalThis.__vaultLockStopping;
}

// ---- the "obsidian" module -------------------------------------------------------------

let netCalls = 0;

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
	requestUrl: async () => { netCalls++; throw new Error("no network in the smoke test"); },
};

function stubRequire(id) {
	return id === "obsidian" ? obsidian : require(id);
}

/** Evaluate a built file the way Obsidian evaluates main.js. */
function evaluate(file) {
	const full = path.join(root, file);
	check(fs.existsSync(full), `${file} is missing: run npm run build first`);
	const m = { exports: {} };
	new Function("module", "exports", "require", fs.readFileSync(full, "utf8"))(m, m.exports, stubRequire);
	return m.exports;
}

const vaults = [];
function makeVault(data) {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "vlb-smoke-"));
	vaults.push(base);
	fs.mkdirSync(path.join(base, PLUGIN_DIR), { recursive: true });
	fs.mkdirSync(path.join(base, "Private"));
	fs.writeFileSync(path.join(base, "Private", "Secret.md"), "secret");
	fs.writeFileSync(path.join(base, "Note.md"), "note");
	if (data) fs.writeFileSync(path.join(base, PLUGIN_DIR, "data.json"), JSON.stringify(data));
	const app = {
		vault: { adapter: new FileSystemAdapter(base), configDir: ".obsidian", on: () => ({}) },
		workspace: { onLayoutReady: () => {}, on: () => ({}), iterateAllLeaves: () => {} }, // layout never ready: no backup, no dialog
		keymap: { pushScope() {}, popScope() {} },
		setting: { close() {} },
	};
	return { base, app };
}

const manifest = { id: "vault-lock", name: "Vault Lock", version: manifestJson.version, dir: PLUGIN_DIR };
const byId = (id) => created.filter((e) => e.id === id);
const byCls = (cls) => created.filter((e) => e.cls === cls);
const macrotask = () => new Promise((r) => setTimeout(r, 0));
/** A stand-in for the previous copy's last backup run, ended by the test. */
function gate() {
	let release;
	const p = new Promise((r) => { release = r; });
	return { p, release };
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
		const { app } = makeVault(null);
		// A reload from 1.6.x: wait until its last backup run is over before doing anything.
		const old = gate();
		globalThis.__vaultLockStopping = old.p;
		const p = new VaultLockPlugin(app, manifest);
		const loading = p.load();
		await macrotask();
		await macrotask();
		check(p.supervisor.current === null && p.commands.length === 0, "started before the 1.6.x copy had stopped");
		old.release();
		await within(loading, 10_000, "onload");
		check(p.supervisor.running?.kind === "builtin", "the built-in app is not running");
		check(p.supervisor.running.id === "builtin:" + manifest.version, "wrong running id " + p.supervisor.running.id);
		check(p.supervisor.current && p.supervisor.current.locked() === false, "locked without a passphrase");
		check(byId("vlb-cover").length === 0, "a cover was made without a passphrase");
		check(byCls("vlb-overlay").length === 0, "a lock screen was shown without a passphrase");
		check(document.title === "Note - My vault - Obsidian", "window title changed without a passphrase");
		check(created.some((e) => e.tag === "style" && !e.removed), "the styles were not injected");
		check(p.commands.map((c) => c.id).join() === "lock,change-passphrase", "commands: " + p.commands.map((c) => c.id));
		check(p.tabs.length === 1, "no setting tab");
		p.tabs[0].display();
		p.unload();
		const stopping = globalThis.__vaultLock?.stopping;
		check(stopping instanceof Promise, "unload left no stopping promise for the next copy");
		check(globalThis.__vaultLockStopping instanceof Promise, "unload left no promise for 1.6.x");
		await within(stopping, 5_000, "stopping");
		await new Promise((r) => setTimeout(r, 0));
		check(!globalThis.__vaultLock.stopping, "the stopping promise was not cleared");
		check(!globalThis.__vaultLock.cover, "a cover was left behind without a passphrase");
		check(created.filter((e) => e.tag === "style").every((e) => e.removed), "the injected styles were not removed");
	}

	// 3. With a passphrase: locked at start, private folder hidden, cover up then down; unload leaves a cover.
	step = "3 start with a passphrase";
	freshDocument();
	{
		const { base, app } = makeVault(PASS);
		const p = new VaultLockPlugin(app, manifest);
		await within(p.load(), 10_000, "onload");
		await new Promise((r) => setTimeout(r, 0));
		const cur = p.supervisor.current;
		check(cur && cur.locked() === true, "not locked at start");
		check(fs.existsSync(path.join(base, ".Private", "Secret.md")) && !fs.existsSync(path.join(base, "Private")), "the private folder was not hidden");
		check(byCls("vlb-overlay").some((e) => e.isConnected), "no lock screen");
		const covers = byId("vlb-cover");
		check(covers.length === 1 && covers[0].removed, "the cover was not made and then removed");
		check(!coverBlind, "the cover came down before the lock screen was up");
		check(document.title === "Obsidian", "window title not hidden");
		check(cur.lockScreen && cur.backup && cur.backup.control && cur.privateFolder, "test handles missing");
		check(cur.host.settings === p.settings, "the app does not share the core's settings object");
		p.unload();
		check(byCls("vlb-overlay").every((e) => !e.isConnected), "the lock screen stayed after unload");
		const left = globalThis.__vaultLock?.cover;
		check(left && left.el.isConnected, "unload left no cover over the locked vault");
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
		prev.release();
		await within(loading, 10_000, "onload after reload");
		check(byId("vlb-cover").length === before, "the reload made a second cover instead of taking the old one");
		check(!left.el.isConnected && !globalThis.__vaultLock.cover, "the taken-over cover was not removed");
		check(!coverBlind, "the reload took the cover down before the lock screen was up");
		check(p2.supervisor.current.locked() === true, "not locked after reload");
		p2.unload();
		const left2 = globalThis.__vaultLock?.cover;
		check(left2, "no cover left after the second unload");
		clearTimeout(left2.timer); // it removes itself after 5 s
		await within(globalThis.__vaultLock.stopping ?? Promise.resolve(), 5_000, "stopping");
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
		await within(a.stop(), 5_000, "app stop");
		check(a.stop() === a.stop(), "stop() does not return the same promise");
		a.unload();
		check(beats === 0, "heartbeat without a backup run");
	}

	// 7. Nothing touched the network.
	step = "7 no network";
	check(netCalls === 0, `requestUrl was called ${netCalls} times`);
}

const guard = setTimeout(() => { console.error(`smoke test FAILED at ${step}: timed out`); process.exit(1); }, 20_000);
function cleanUp() {
	for (const v of vaults) fs.rmSync(v, { recursive: true, force: true });
}
main().then(() => {
	clearTimeout(guard);
	cleanUp();
	console.log("smoke test passed");
	process.exit(0);
}, (e) => {
	console.error(`smoke test FAILED at ${step}:`, e?.stack ?? e);
	cleanUp();
	process.exit(1);
});
