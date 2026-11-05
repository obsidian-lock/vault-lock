import * as fs from "fs";
import * as path from "path";
import { requestUrl, RequestUrlResponse } from "obsidian";
import { CORE_VERSION } from "../shared/constants";
import { DavAuth, davHeaders, davUrl, DavError, errMsg, withTimeout } from "../shared/dav";
import { CONTROL } from "../shared/vaultfiles";
import type { CoreState } from "./health";
import { BUNDLES, bundleName, loadStaged, STAGED_MANIFEST } from "./loader";
import { checkBundle, sha256Hex, UpdatePayload, verifyManifest } from "./verify";

/**
 * Plugin code from the server, checked every core tick. Two slots in this
 * computer's folder, each a signed manifest.json and one file:
 * - app: _control/update/app/{manifest.json, app.js}. A new, verified app.js is staged in
 *   bundles/ (at most the current and one previous file); the supervisor then picks it or not
 *   (loader.pick) and starts it at the next lock. An explicit 404 (while the login works)
 *   removes what is staged: the built-in comes back at the next lock.
 * - core: _control/update/core/{manifest.json, main.js}. A new, verified main.js that compiles
 *   and loads replaces main.js (the old one kept as main.js.prev); it runs from the next start.
 * Nothing here evaluates a byte that has not passed verifyManifest() and checkBundle(). A
 * manifest older than the last one accepted for its slot is refused (replay). Errors never
 * touch what is staged or installed; they go to core.json updateError (vlb status shows it).
 */

const SLOT = { app: `${CONTROL}/update/app`, core: `${CONTROL}/update/core` };
const MANIFEST_TIMEOUT_MS = 30_000;
const BUNDLE_TIMEOUT_MS = 60_000; // plus 1 ms per 100 bytes of the signed size
const MAIN = "main.js";
const BUNDLE_FILE = /^app-([0-9a-f]{12})\.js$/;
const LEFTOVER = /^(app-[0-9a-f]{12}\.js\.part|manifest\.json\.tmp)$/;

type Slot = "app" | "core";

export type UpdaterCtx = {
	/** The plugin folder on disk ("" when the vault is not on a local disk: then nothing happens). */
	pluginDir: () => string;
	auth: () => DavAuth;
	keys: () => string[];
	/** main.js's own require, for the load check of a new main.js. */
	req: NodeRequire;
	state: () => CoreState;
	save: () => void;
	/** False once this copy of the plugin is unloaded: then no more file changes. */
	alive: () => boolean;
};

export class Updater {
	/** The last error of each slot; core.json updateError is both joined. */
	private errs: Record<Slot, string | null> = { app: null, core: null };

	constructor(private ctx: UpdaterCtx) {}

	/** loginOk: config.json in the same tick answered 2xx or 404; only then does a 404 here mean "unpublished". Never throws. */
	async pollAppSlot(loginOk: boolean): Promise<void> {
		const dir = this.ctx.pluginDir();
		if (!dir) return;
		try {
			await this.appSlot(dir, loginOk);
		} catch (e) {
			this.err("app", "app: " + why(e));
		}
	}

	/** Never throws. */
	async pollCoreSlot(loginOk: boolean): Promise<void> {
		const dir = this.ctx.pluginDir();
		if (!dir) return;
		try {
			await this.coreSlot(dir, loginOk);
		} catch (e) {
			this.err("core", "core: " + why(e));
		}
	}

	// ---- app slot (C.7) ------------------------------------------------------------

	private async appSlot(dir: string, loginOk: boolean): Promise<void> {
		const st = this.ctx.state();
		const r = await this.get(`${SLOT.app}/manifest.json`, MANIFEST_TIMEOUT_MS);
		if (r.status === 404) {
			// With a broken login a 404 cannot be told from "not paired": then nothing is removed.
			if (loginOk) this.unpublish(dir);
			return;
		}
		if (r.status < 200 || r.status >= 300) return this.err("app", `app: HTTP ${r.status}`);
		const text = r.text;
		const p = verifyManifest(text, this.ctx.keys());
		if (p.kind !== "app") return this.err("app", `app: the app slot holds a ${p.kind} manifest`);
		const local = loadStaged(dir, this.ctx.keys());
		// "New" means later than both the last accepted at and the staged manifest's own (the
		// truth on disk, also when core.json was lost or only the bundle file is damaged).
		const floor = local && later(local.at, st.lastAcceptedAt.app) ? local.at : st.lastAcceptedAt.app;
		const newer = later(p.at, floor);
		if (local && local.verified && local.sha256 === p.sha256) {
			// The same bytes are staged. Signed again with a later at (vlb bundle publish V
			// --force: a rollback to a release this computer already has), it is new: its
			// version and force count from now on. Otherwise it is just seen again.
			if (newer) {
				if (!this.ctx.alive()) return;
				await this.writeManifest(dir, text);
				this.accept(p, st.previousSha12, "signed again");
			} else {
				this.mirror(local);
				this.err("app", null);
			}
			return;
		}
		// A staged bundle whose file is missing or damaged may be fetched again with the same
		// manifest, never with an older one for the same bytes (that would undo a forced rollback).
		const again = (local?.sha256 || st.staged?.sha256) === p.sha256 && !later(floor, p.at);
		if (!newer && !again) {
			return this.err("app", "app: manifest older than the last accepted one (replay)");
		}
		if (p.minCore > CORE_VERSION) return this.err("app", `app: needs core ≥ ${p.minCore}`);
		const b = await this.get(`${SLOT.app}/app.js`, BUNDLE_TIMEOUT_MS + p.size / 100);
		if (b.status < 200 || b.status >= 300) return this.err("app", `app: app.js HTTP ${b.status}`);
		const bytes = new Uint8Array(b.arrayBuffer);
		checkBundle(bytes, p);
		if (!this.ctx.alive()) return;
		await this.stage(dir, p, text, bytes);
	}

	/** File first (.part, read back, re-hashed, renamed), then the manifest that names it, then old files go. */
	private async stage(dir: string, p: UpdatePayload, text: string, bytes: Uint8Array): Promise<void> {
		const bdir = path.join(dir, BUNDLES);
		await fs.promises.mkdir(bdir, { recursive: true });
		const file = path.join(bdir, bundleName(p.sha256));
		const part = file + ".part";
		try {
			await fs.promises.writeFile(part, bytes);
			if (sha256Hex(await fs.promises.readFile(part)) !== p.sha256) throw new Error("the bundle did not read back the same from disk");
			if (!this.ctx.alive()) return;
			await fs.promises.rename(part, file);
		} finally {
			await fs.promises.rm(part, { force: true }).catch(() => {});
		}
		await this.writeManifest(dir, text);
		const st = this.ctx.state();
		const sha12 = p.sha256.slice(0, 12);
		const was = st.staged?.sha12 ?? null;
		const previous = was && was !== sha12 ? was : st.previousSha12 !== sha12 ? st.previousSha12 : null;
		this.prune(bdir, [sha12, previous]);
		this.accept(p, previous, "staged");
	}

	private accept(p: UpdatePayload, previous: string | null, what: string): void {
		const st = this.ctx.state();
		const sha12 = p.sha256.slice(0, 12);
		st.staged = { sha12, sha256: p.sha256, version: p.version, force: p.force, minCore: p.minCore, at: p.at, stagedAt: new Date().toISOString() };
		st.previousSha12 = previous;
		if (later(p.at, st.lastAcceptedAt.app)) st.lastAcceptedAt.app = p.at;
		this.err("app", null);
		this.ctx.save();
		console.log(`[VLB] core: ${what} app ${p.version} (${sha12})${p.force ? " FORCED" : ""}; it starts at the next lock if it is picked`);
	}

	/** core.json lost or older than bundles/manifest.json (the truth): bring the copy up to date. */
	private mirror(local: { sha256: string; version: string; force: boolean; minCore: number; at: string }): void {
		const st = this.ctx.state();
		const s = st.staged;
		if (!s || s.sha256 !== local.sha256 || s.at !== local.at || s.force !== local.force || s.version !== local.version) {
			st.staged = { sha12: local.sha256.slice(0, 12), sha256: local.sha256, version: local.version, force: local.force, minCore: local.minCore, at: local.at, stagedAt: s?.stagedAt ?? new Date().toISOString() };
		}
		if (later(local.at, st.lastAcceptedAt.app)) st.lastAcceptedAt.app = local.at;
	}

	/** Explicit 404: nothing is published for this computer any more. */
	private unpublish(dir: string): void {
		const st = this.ctx.state();
		let had = st.staged !== null || st.previousSha12 !== null;
		const bdir = path.join(dir, BUNDLES);
		let names: string[] = [];
		try { names = fs.readdirSync(bdir); } catch { /* no bundles folder */ }
		// The manifest first: without it nothing is a candidate, whatever is left.
		for (const n of [STAGED_MANIFEST, ...names.filter((n) => n !== STAGED_MANIFEST)]) {
			if (n !== STAGED_MANIFEST && !BUNDLE_FILE.test(n) && !LEFTOVER.test(n)) continue;
			try {
				fs.rmSync(path.join(bdir, n));
				had = true;
			} catch { /* not there */ }
		}
		this.err("app", null);
		if (!had || !this.ctx.alive()) return;
		st.staged = null;
		st.previousSha12 = null;
		this.ctx.save();
		console.log("[VLB] core: the server bundle was unpublished; the built-in comes back at the next lock");
	}

	private async writeManifest(dir: string, text: string): Promise<void> {
		const f = path.join(dir, BUNDLES, STAGED_MANIFEST);
		await fs.promises.writeFile(f + ".tmp", text);
		await fs.promises.rename(f + ".tmp", f);
	}

	/** Every app-*.js but the ones kept, and leftovers of an interrupted stage. */
	private prune(bdir: string, keep: (string | null)[]): void {
		let names: string[] = [];
		try { names = fs.readdirSync(bdir); } catch { return; }
		for (const n of names) {
			const m = BUNDLE_FILE.exec(n);
			if (m ? keep.includes(m[1]) : !LEFTOVER.test(n)) continue;
			try { fs.rmSync(path.join(bdir, n)); } catch (e) { console.warn("[VLB] core: could not remove", n, e); }
		}
	}

	// ---- core slot (H) ---------------------------------------------------------------

	private async coreSlot(dir: string, loginOk: boolean): Promise<void> {
		const st = this.ctx.state();
		const r = await this.get(`${SLOT.core}/manifest.json`, MANIFEST_TIMEOUT_MS);
		if (r.status === 404) {
			if (loginOk) this.err("core", null); // nothing published; nothing local to remove
			return;
		}
		if (r.status < 200 || r.status >= 300) return this.err("core", `core: HTTP ${r.status}`);
		const p = verifyManifest(r.text, this.ctx.keys());
		if (p.kind !== "core") return this.err("core", `core: the core slot holds an ${p.kind} manifest`);
		const mainFile = path.join(dir, MAIN);
		const sha12 = p.sha256.slice(0, 12);
		if (sha256Hex(fs.readFileSync(mainFile)) === p.sha256) {
			if (st.coreInstalled?.sha12 !== sha12) st.coreInstalled = { version: p.version, sha12, at: new Date().toISOString() };
			if (later(p.at, st.lastAcceptedAt.core)) st.lastAcceptedAt.core = p.at;
			// A version patch that failed after the install is tried again here.
			try {
				if (this.manifestVersion(dir) !== p.version) this.patchVersion(dir, p.version);
			} catch (e) {
				return this.err("core", "core: main.js replaced, but manifest.json's version was not updated: " + errMsg(e));
			}
			return this.err("core", null);
		}
		if (!later(p.at, st.lastAcceptedAt.core)) {
			// The same manifest again: main.js was replaced since it was applied, by a newer
			// BRAT release (the GitHub build wins, by design). Never applied a second time.
			return this.err("core", Date.parse(p.at) === Date.parse(st.lastAcceptedAt.core)
				? "core: applied before; main.js has been replaced since (a BRAT update), so it is not applied again"
				: "core: manifest older than the last accepted one (replay)");
		}
		const b = await this.get(`${SLOT.core}/main.js`, BUNDLE_TIMEOUT_MS + p.size / 100);
		if (b.status < 200 || b.status >= 300) return this.err("core", `core: main.js HTTP ${b.status}`);
		const bytes = new Uint8Array(b.arrayBuffer);
		checkBundle(bytes, p);
		if (!this.ctx.alive()) return;

		const part = mainFile + ".part";
		try {
			await fs.promises.writeFile(part, bytes);
			const back = await fs.promises.readFile(part);
			if (sha256Hex(back) !== p.sha256) throw new Error("main.js did not read back the same from disk");
			const code = back.toString("utf8");
			// Compile check: a syntax error throws here, before anything runs.
			let fn: (m: unknown, e: unknown, r: NodeRequire) => void;
			try {
				fn = new Function("module", "exports", "require", code) as typeof fn;
			} catch (e) {
				return this.err("core", "core: does not compile: " + errMsg(e));
			}
			// Load check: its top level runs (classes and constants only, by rule) and must give
			// a plugin class. onload is NOT run: a main.js whose onload throws is not caught here.
			try {
				const m: { exports: Record<string, unknown> } = { exports: {} };
				fn(m, m.exports, this.ctx.req);
				const P: unknown = m.exports.default;
				if (typeof P !== "function" || typeof (P.prototype as { onload?: unknown } | undefined)?.onload !== "function") throw new Error("no plugin class as its default export");
			} catch (e) {
				return this.err("core", "core: does not load: " + errMsg(e));
			}
			if (!this.ctx.alive()) return;
			// main.js is replaced in one rename and never missing: the old one is copied aside first.
			fs.copyFileSync(mainFile, mainFile + ".prev");
			fs.renameSync(part, mainFile);
		} finally {
			await fs.promises.rm(part, { force: true }).catch(() => {});
		}
		st.coreInstalled = { version: p.version, sha12, at: new Date().toISOString() };
		st.lastAcceptedAt.core = p.at;
		this.err("core", null);
		try {
			this.patchVersion(dir, p.version);
		} catch (e) {
			this.err("core", "core: main.js replaced, but manifest.json's version was not updated: " + errMsg(e));
		}
		this.ctx.save();
		console.log(`[VLB] core: installed main.js ${p.version} (${sha12}); it runs from the next Obsidian start`);
	}

	private manifestVersion(dir: string): unknown {
		return (JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as Record<string, unknown>).version;
	}

	/** manifest.json version = the core bundle's, so the next start reports it and BRAT compares against it. */
	private patchVersion(dir: string, version: string): void {
		const f = path.join(dir, "manifest.json");
		const m = JSON.parse(fs.readFileSync(f, "utf8")) as Record<string, unknown>;
		m.version = version;
		fs.writeFileSync(f + ".tmp", JSON.stringify(m, null, "\t") + "\n");
		fs.renameSync(f + ".tmp", f);
	}

	// ---- shared ------------------------------------------------------------------------

	/** Any HTTP status comes back; no answer (offline, timeout) throws DavError status 0. */
	private async get(sp: string, ms: number): Promise<RequestUrlResponse> {
		const auth = this.ctx.auth();
		try {
			return await withTimeout(requestUrl({ url: davUrl(auth, sp), method: "GET", headers: davHeaders(auth), throw: false }), ms, `GET ${sp}`);
		} catch (e) {
			throw e instanceof DavError ? e : new DavError(`GET ${sp}: ${errMsg(e)}`, 0);
		}
	}

	private err(slot: Slot, msg: string | null): void {
		if (msg && msg !== this.errs[slot]) console.warn("[VLB]", msg);
		this.errs[slot] = msg;
		const st = this.ctx.state();
		st.updateError = [this.errs.app, this.errs.core].filter((x) => x).join("; ") || null;
	}
}

/** a is a later time than b (b "" or not a date: anything is later). */
export function later(a: string, b: string): boolean {
	const ta = Date.parse(a), tb = Date.parse(b);
	if (Number.isNaN(ta)) return false;
	return Number.isNaN(tb) || ta > tb;
}

function why(e: unknown): string {
	if (e instanceof DavError && e.status === 0) return `HTTP 0 (${e.message})`;
	return errMsg(e);
}
