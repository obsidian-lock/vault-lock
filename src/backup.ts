import { requestUrl, RequestUrlResponse, TAbstractFile, TFolder } from "obsidian";
import type VLBPlugin from "./main";
import { b64 } from "./crypto";
import { Control, CONTROL } from "./control";
import { Pairing } from "./pairing";
import { PAIR_DIR, SERVER_URL } from "./server";

/**
 * One-way push of the vault to a WebDAV folder.
 *
 * Design: there is exactly one recovery mechanism — a reconcile that compares the
 * local file list (mtime+size) with an index (`_manifest.json`) stored on the server
 * and uploads whatever differs. Vault events only make the same thing happen sooner.
 * The reconcile runs at startup, on a timer, when the machine comes back online, and
 * one minute after any failure. Nothing is ever deleted on the server: removed or
 * renamed-away files are moved into `_trash/<timestamp>/`.
 *
 * Nothing runs until this computer is paired with the server (see pairing.ts), unless the
 * setup script wrote a login.
 *
 * The backup has no interface on this computer: no status bar item, no notices, no
 * commands. Its health is reported to the server in `_control/status.json` (after every
 * reconcile, and on a failure when the server can still be reached) and read there with
 * `vlb status`. The developer console gets a `[VLB backup]` line for everything.
 */

export type Entry = { m: number; s: number };
type Manifest = Record<string, Entry>;

const MANIFEST = "_manifest.json";
const TRASH = "_trash";
const MAX_BYTES = 100 * 1024 * 1024;
const DEBOUNCE_MS = 2_000;
const MANIFEST_FLUSH_MS = 5_000;
const RETRY_MS = 60_000;
const STARTUP_DELAY_MS = 8_000;
const REQUEST_TIMEOUT_MS = 60_000; // plus 1 ms per 100 bytes of body, so a big PUT gets its time
const FLUSH_EVERY_MS = 30_000; // during a long reconcile, save the index this often

export class Backup {
	manifest: Manifest = {};
	control: Control;
	pairing: Pairing;
	lastError = "";
	private manifestLoaded = false;
	private manifestDirty = false;
	private manifestTimer: number | null = null;
	private pending = new Map<string, number>();
	private queue: Promise<void> = Promise.resolve();
	private knownDirs = new Set<string>();
	private retryTimer: number | null = null;
	private intervalTimer: number | null = null;
	private startupTimer: number | null = null;
	private failed = false;
	private reconcileQueued = false;
	private stopped = false;
	private paired = false;
	private trashSeq = 0;

	constructor(private plugin: VLBPlugin) {
		this.control = new Control(plugin, this);
		this.pairing = new Pairing(plugin, this);
	}

	/** Runs once this computer has a working login on the server. */
	get enabled(): boolean {
		return this.paired && !this.stopped;
	}

	// ---- lifecycle -----------------------------------------------------------

	start(): void {
		const v = this.plugin.app.vault;
		this.plugin.registerEvent(v.on("create", (f) => this.onChange(f.path)));
		this.plugin.registerEvent(v.on("modify", (f) => this.onChange(f.path)));
		this.plugin.registerEvent(v.on("delete", (f) => this.onDelete(f)));
		this.plugin.registerEvent(v.on("rename", (f, old) => this.onRename(f, old)));
		this.plugin.registerDomEvent(window, "online", () => this.requestReconcile("online"));
		this.scheduleInterval();
		void this.begin();
	}

	private async begin(): Promise<void> {
		await this.pairing.ensureIdentity();
		if (this.stopped) return;
		if (Pairing.isDeviceLogin(this.plugin.settings.webdavUser)) {
			// Also covers an already-paired computer: the first check succeeds and starts the backup.
			this.pairing.start();
		} else {
			this.paired = true; // a login written by the setup script
			this.startupTimer = window.setTimeout(() => this.requestReconcile("startup"), STARTUP_DELAY_MS);
		}
	}

	/** Called by Pairing once the login works. */
	onPaired(newlyPaired: boolean): void {
		if (this.stopped) return;
		this.paired = true;
		this.failed = false;
		if (newlyPaired) console.log("[VLB backup] paired with the server; backing up now");
		this.requestReconcile(newlyPaired ? "paired" : "startup");
	}

	/** Status of a login check, without throwing on HTTP errors. */
	async probe(): Promise<number> {
		const s = this.plugin.settings;
		const r = await withTimeout(requestUrl({
			url: this.base,
			method: "PROPFIND",
			headers: { Authorization: "Basic " + b64(s.webdavUser + ":" + s.webdavPass), Depth: "0" },
			throw: false,
		}), 30_000, "PROPFIND");
		return r.status;
	}

	stop(): void {
		this.stopped = true;
		this.pairing.stop();
		for (const t of this.pending.values()) window.clearTimeout(t);
		this.pending.clear();
		for (const t of [this.manifestTimer, this.retryTimer, this.intervalTimer, this.startupTimer]) {
			if (t) window.clearTimeout(t);
		}
	}

	/** Forget the server index; the next reconcile re-uploads every file. */
	clearIndex(): void {
		this.manifest = {};
		this.manifestLoaded = true;
		this.manifestDirty = true;
		this.knownDirs.clear();
	}

	/** Local path for a server path: inside the private folder, that is the hidden name while locked. */
	async toLocal(sp: string): Promise<string> {
		const pf = this.plugin.privateFolder;
		if (!pf.enabled) return sp;
		if (sp === pf.name || sp.startsWith(pf.name + "/")) {
			if (await this.plugin.app.vault.adapter.exists(pf.hiddenName)) return pf.hiddenName + sp.slice(pf.name.length);
		}
		return sp;
	}

	scheduleInterval(): void {
		if (this.intervalTimer) window.clearTimeout(this.intervalTimer);
		const min = Math.max(1, this.plugin.settings.reconcileMinutes || 10);
		this.intervalTimer = window.setTimeout(() => {
			this.requestReconcile("interval");
			this.scheduleInterval();
		}, min * 60_000);
	}

	// ---- vault events --------------------------------------------------------

	private onChange(path: string): void {
		if (!this.enabled || this.excluded(path)) return;
		const t = this.pending.get(path);
		if (t) window.clearTimeout(t);
		this.pending.set(path, window.setTimeout(() => {
			this.pending.delete(path);
			this.run(() => this.syncPath(path));
		}, DEBOUNCE_MS));
	}

	private onDelete(f: TAbstractFile): void {
		if (!this.enabled || this.excluded(f.path)) return;
		const isFolder = f instanceof TFolder;
		const path = f.path;
		this.run(async () => {
			const adapter = this.plugin.app.vault.adapter;
			// Lock/unlock renames Private <-> .Private; Obsidian reports that as a delete.
			const alt = this.plugin.privateFolder.altPath(path);
			if (alt && (await adapter.exists(alt))) return;
			if (await adapter.exists(path)) return;
			await this.trash(this.serverPath(path), isFolder);
		});
	}

	private onRename(f: TAbstractFile, oldPath: string): void {
		if (!this.enabled) return;
		const isFolder = f instanceof TFolder;
		const newPath = f.path;
		this.run(async () => {
			const from = this.serverPath(oldPath);
			const to = this.serverPath(newPath);
			if (from === to) return;
			const oldEx = this.excluded(oldPath);
			const newEx = this.excluded(newPath);
			if (newEx) { if (!oldEx) await this.trash(from, isFolder); return; }
			if (oldEx) { await this.syncNew(newPath, isFolder); return; }

			await this.loadManifest();
			const keys = this.keysUnder(from, isFolder);
			if (keys.length === 0) { await this.syncNew(newPath, isFolder); return; }

			await this.ensureDir(parentOf(to));
			let r = await this.dav("MOVE", from, undefined, { Destination: this.url(to), Overwrite: "F" }, [412]);
			if (r.status === 412) {
				// Something already sits at the new name on the server: keep it in the trash, never overwrite.
				await this.moveToTrash(to);
				for (const k of this.keysUnder(to, isFolder)) delete this.manifest[k];
				r = await this.dav("MOVE", from, undefined, { Destination: this.url(to), Overwrite: "F" });
			}
			for (const k of keys) {
				this.manifest[to + k.slice(from.length)] = this.manifest[k];
				delete this.manifest[k];
			}
			this.forgetDirs(from);
			this.touchManifest();
			if (r.status === 404) await this.syncNew(newPath, isFolder); // wasn't on the server after all
		});
	}

	private async syncNew(path: string, isFolder: boolean): Promise<void> {
		if (isFolder) this.requestReconcile("rename");
		else await this.syncPath(path);
	}

	// ---- queue / failure handling -------------------------------------------

	private run(fn: () => Promise<void>, opts: { force?: boolean; reconcile?: boolean } = {}): void {
		this.queue = this.queue.then(async () => {
			if (opts.reconcile) this.reconcileQueued = false; // whether or not it runs now, a new one may be asked for
			if (!this.enabled) return;
			if (this.failed && !opts.force) return; // the retry reconcile will cover it
			try {
				await fn();
			} catch (e) {
				await this.onFailure(e);
			}
		});
	}

	private async onFailure(e: unknown): Promise<void> {
		console.error("[VLB backup]", e, "— retrying in a minute");
		if (e instanceof DavError && e.status === 401 && Pairing.isDeviceLogin(this.plugin.settings.webdavUser)) {
			// The server no longer knows this computer (its login was removed): pair again.
			this.paired = false;
			this.failed = false;
			this.manifestLoaded = false;
			this.knownDirs.clear();
			this.pairing.start();
			return;
		}
		const first = !this.failed;
		this.lastError = errMsg(e);
		this.failed = true;
		if (!this.retryTimer) {
			this.retryTimer = window.setTimeout(() => {
				this.retryTimer = null;
				this.requestReconcile("retry");
			}, RETRY_MS);
		}
		// Tell the server, if it can still be reached (a single bad file, a frozen folder):
		// nothing shows on this computer, so `vlb status` is where the error is read.
		if (first) {
			try {
				await this.flushManifest(); // keep the progress made so far
			} catch (e2) {
				console.log("[VLB backup] could not save the index to the server:", errMsg(e2));
			}
			try {
				await this.control.writeStatus();
			} catch (e2) {
				console.log("[VLB backup] could not report the error to the server:", errMsg(e2));
			}
		}
	}

	requestReconcile(reason: string): void {
		if (!this.enabled || this.reconcileQueued) return;
		this.reconcileQueued = true;
		this.run(() => this.reconcile(reason), { force: true, reconcile: true });
	}

	// ---- the core ------------------------------------------------------------

	private async reconcile(reason: string): Promise<void> {
		this.failed = false;
		await this.loadManifest();
		await this.control.pull();

		const local = new Map<string, { path: string; m: number; s: number }>();
		await this.scan("", local);

		let uploaded = 0;
		const skipped: string[] = [];
		const failed: string[] = []; // one file's trouble never stops the others
		let lastFlush = Date.now();
		for (const [sp, info] of local) {
			const cur = this.manifest[sp];
			if (cur && cur.m === info.m && cur.s === info.s) continue;
			if (info.s > MAX_BYTES) { skipped.push(sp); continue; }
			try {
				if (await this.upload(info.path, sp, info.m, info.s)) uploaded++;
			} catch (e) {
				if (!isPerFile(e)) throw e;
				failed.push(`${sp}: ${errMsg(e)}`);
				console.error(`[VLB backup] could not back up ${sp}:`, e);
			}
			if (Date.now() - lastFlush > FLUSH_EVERY_MS) { await this.flushManifest(); lastFlush = Date.now(); }
		}
		let trashed = 0;
		for (const sp of Object.keys(this.manifest)) {
			if (local.has(sp)) continue;
			try {
				await this.trash(sp, false);
				trashed++;
			} catch (e) {
				if (!isPerFile(e)) throw e;
				failed.push(`${sp}: ${errMsg(e)}`);
				console.error(`[VLB backup] could not move ${sp} to the trash:`, e);
			}
		}
		await this.flushManifest();
		this.lastError = failed.length
			? `${failed.length} file(s) could not be backed up: ${failed.slice(0, 3).join("; ")}${failed.length > 3 ? "; …" : ""}`
			: "";
		this.control.lastReconcile = { at: new Date().toISOString(), reason, files: local.size, uploaded, trashed, skipped, failed };
		await this.control.writeStatus();
		console.log(`[VLB backup] reconcile (${reason}): ${local.size} files, ${uploaded} uploaded, ${trashed} trashed` +
			(skipped.length ? `, ${skipped.length} over 100 MB skipped: ${skipped.join(", ")}` : "") +
			(failed.length ? `, ${failed.length} failed` : ""));
	}

	private async scan(dir: string, out: Map<string, { path: string; m: number; s: number }>): Promise<void> {
		const adapter = this.plugin.app.vault.adapter;
		let listed;
		try {
			listed = await adapter.list(dir);
		} catch (e) {
			if (dir === "") listed = await adapter.list("/");
			else throw e;
		}
		for (const f of listed.files) {
			const p = clean(f);
			if (this.excluded(p)) continue;
			const st = await adapter.stat(p);
			if (!st || st.type !== "file") continue;
			out.set(this.serverPath(p), { path: p, m: st.mtime, s: st.size });
		}
		for (const d of listed.folders) {
			const p = clean(d);
			if (this.excluded(p + "/")) continue;
			await this.scan(p, out);
		}
	}

	private async syncPath(path: string): Promise<void> {
		if (this.excluded(path)) return;
		const st = await this.plugin.app.vault.adapter.stat(path);
		if (!st || st.type !== "file") return;
		await this.loadManifest();
		const sp = this.serverPath(path);
		const cur = this.manifest[sp];
		if (cur && cur.m === st.mtime && cur.s === st.size) return;
		await this.upload(path, sp, st.mtime, st.size);
	}

	/** False when the file is over the size limit; the next reconcile reports it in status.json. */
	private async upload(path: string, sp: string, m: number, s: number): Promise<boolean> {
		if (s > MAX_BYTES) {
			console.log(`[VLB backup] skipping ${path} (over 100 MB)`);
			return false;
		}
		let data: ArrayBuffer;
		try {
			data = await this.plugin.app.vault.adapter.readBinary(path);
		} catch (e) {
			throw new FileError(`cannot be read: ${errMsg(e)}`);
		}
		await this.ensureDir(parentOf(sp));
		try {
			await this.dav("PUT", sp, data, { "Content-Type": "application/octet-stream" });
		} catch (e) {
			if (!(e instanceof DavError && e.status === 409)) throw e;
			// A folder we believed in is gone on the server (removed by hand): make them all again, once.
			this.knownDirs.clear();
			await this.ensureDir(parentOf(sp));
			await this.dav("PUT", sp, data, { "Content-Type": "application/octet-stream" });
		}
		this.manifest[sp] = { m, s };
		this.touchManifest();
		return true;
	}

	private async trash(sp: string, isFolder: boolean): Promise<void> {
		await this.loadManifest();
		const keys = this.keysUnder(sp, isFolder);
		// Nothing indexed there means nothing to keep. Obsidian reports a deleted folder's files
		// before the folder itself, so by the time the folder arrives its files are already in
		// the trash, and moving the empty folder over them would destroy them.
		if (keys.length === 0) return;
		await this.moveToTrash(sp);
		for (const k of keys) delete this.manifest[k];
		this.forgetDirs(sp);
		this.touchManifest();
	}

	/** MOVE a server path into `_trash/<stamp>/`, never over something already there: nothing in the trash is ever overwritten. */
	async moveToTrash(sp: string): Promise<void> {
		for (let attempt = 0; ; attempt++) {
			const dir = attempt === 0 ? stamp() : `${stamp()}-${Date.now().toString(36)}-${++this.trashSeq}`;
			const dest = `${TRASH}/${dir}/${sp}`;
			await this.ensureDir(parentOf(dest));
			const r = await this.dav("MOVE", sp, undefined, { Destination: this.url(dest), Overwrite: "F" }, [412]); // 404 = already gone
			if (r.status !== 412) return;
			if (attempt >= 2) throw new DavError(`MOVE ${sp}: HTTP 412`, 412);
		}
	}

	// ---- manifest ------------------------------------------------------------

	async loadManifest(): Promise<void> {
		if (this.manifestLoaded) return;
		const r = await this.dav("GET", MANIFEST);
		this.manifest = r.status === 404 ? {} : this.parseManifest(r);
		this.manifestLoaded = true;
		this.manifestDirty = false;
	}

	private parseManifest(r: RequestUrlResponse): Manifest {
		try {
			const j = JSON.parse(r.text);
			return j && typeof j === "object" && !Array.isArray(j) ? (j as Manifest) : {};
		} catch {
			return {};
		}
	}

	touchManifest(): void {
		this.manifestDirty = true;
		if (this.manifestTimer) return;
		this.manifestTimer = window.setTimeout(() => {
			this.manifestTimer = null;
			this.run(() => this.flushManifest());
		}, MANIFEST_FLUSH_MS);
	}

	async flushManifest(): Promise<void> {
		if (!this.manifestDirty) return;
		await this.dav("PUT", MANIFEST, JSON.stringify(this.manifest), { "Content-Type": "application/json" });
		this.manifestDirty = false;
	}

	private keysUnder(sp: string, isFolder: boolean): string[] {
		if (!isFolder) return this.manifest[sp] ? [sp] : [];
		return Object.keys(this.manifest).filter((k) => k === sp || k.startsWith(sp + "/"));
	}

	// ---- WebDAV --------------------------------------------------------------

	private get base(): string {
		let u = this.plugin.settings.webdavUrl.trim() || SERVER_URL;
		if (!u.endsWith("/")) u += "/";
		return u;
	}

	private url(sp: string): string {
		return this.base + sp.split("/").map(encodeURIComponent).join("/");
	}

	async ensureDir(dir: string): Promise<void> {
		if (!dir) return;
		let cur = "";
		for (const part of dir.split("/")) {
			cur = cur ? cur + "/" + part : part;
			if (this.knownDirs.has(cur)) continue;
			await this.dav("MKCOL", cur + "/"); // 405 = already exists
			this.knownDirs.add(cur);
		}
	}

	private forgetDirs(prefix: string): void {
		for (const d of Array.from(this.knownDirs)) {
			if (d === prefix || d.startsWith(prefix + "/")) this.knownDirs.delete(d);
		}
	}

	async dav(method: string, sp: string, body?: ArrayBuffer | string, headers: Record<string, string> = {}, alsoOk: number[] = []): Promise<RequestUrlResponse> {
		const s = this.plugin.settings;
		const h: Record<string, string> = { Authorization: "Basic " + b64(s.webdavUser + ":" + s.webdavPass), ...headers };
		const bytes = typeof body === "string" ? body.length : body ? body.byteLength : 0;
		const r = await withTimeout(requestUrl({ url: this.url(sp), method, headers: h, body, throw: false }), REQUEST_TIMEOUT_MS + bytes / 100, `${method} ${sp}`);
		const ok =
			r.status < 300 ||
			alsoOk.includes(r.status) ||
			(method === "MKCOL" && r.status === 405) ||
			(method === "MOVE" && r.status === 404) ||
			(method === "GET" && r.status === 404);
		if (!ok) throw new DavError(`${method} ${sp}: HTTP ${r.status}`, r.status);
		return r;
	}

	// ---- helpers -------------------------------------------------------------

	private serverPath(path: string): string {
		return this.plugin.privateFolder.toVisible(path);
	}

	private excluded(path: string): boolean {
		// The plugin's own folder holds data.json and its copy (passphrase hash, this computer's server key): never uploaded.
		const own = this.plugin.manifest.dir ?? ".obsidian/plugins/vault-lock";
		if (path === own || path.startsWith(own + "/") || path === MANIFEST) return true;
		for (const reserved of [TRASH, CONTROL, PAIR_DIR]) {
			if (path === reserved || path.startsWith(reserved + "/")) return true;
		}
		for (const line of this.plugin.settings.excludes.split("\n")) {
			const p = line.trim();
			if (p && path.startsWith(p)) return true;
		}
		return false;
	}

	stamp(): string {
		return stamp();
	}
}

function clean(p: string): string {
	return p.replace(/^\/+/, "");
}

function parentOf(p: string): string {
	const i = p.lastIndexOf("/");
	return i < 0 ? "" : p.slice(0, i);
}

function stamp(): string {
	const d = new Date();
	const z = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}

export class DavError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
	}
}

/** A file on this computer that cannot be read (permissions, a lock held by another program). */
class FileError extends Error {}

/** True when the trouble is with one file, not with the server or the login: skip it and go on. */
function isPerFile(e: unknown): boolean {
	if (e instanceof FileError) return true;
	return e instanceof DavError && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 403;
}

/** Fail instead of waiting forever on a connection that stays open but never answers. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	let timer = 0;
	const limit = new Promise<never>((_, reject) => {
		timer = window.setTimeout(() => reject(new DavError(`${what}: no answer from the server in ${Math.round(ms / 1000)} s`, 0)), ms);
	});
	return Promise.race([p, limit]).finally(() => window.clearTimeout(timer));
}

function errMsg(e: unknown): string {
	if (e instanceof Error) return e.message;
	return String(e);
}
