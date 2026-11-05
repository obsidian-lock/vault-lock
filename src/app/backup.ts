import { requestUrl, RequestUrlResponse, TAbstractFile, TFolder } from "obsidian";
import type { VaultLockApp } from "./app";
import { Control } from "./control";
import { Pairing } from "./pairing";
import { MAX_BYTES } from "../shared/constants";
import { authFor, basicAuth, dav, davUrl, DavError, errMsg, withTimeout } from "../shared/dav";
import { excluded as isExcluded, Index, LocalFile, MANIFEST, parentOf, scan, stamp, TRASH } from "../shared/vaultfiles";

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

const DEBOUNCE_MS = 2_000;
const MANIFEST_FLUSH_MS = 5_000;
const RETRY_MS = 60_000;
const STARTUP_DELAY_MS = 8_000;
const FLUSH_EVERY_MS = 30_000; // during a long reconcile, save the index this often

export class Backup {
	manifest: Index = {};
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

	constructor(private owner: VaultLockApp) {
		this.control = new Control(owner, this);
		this.pairing = new Pairing(owner, this);
	}

	/** Runs once this computer has a working login on the server. */
	get enabled(): boolean {
		return this.paired && !this.stopped;
	}

	// ---- lifecycle -----------------------------------------------------------

	start(): void {
		const v = this.owner.app.vault;
		this.owner.registerEvent(v.on("create", (f) => this.onChange(f.path)));
		this.owner.registerEvent(v.on("modify", (f) => this.onChange(f.path)));
		this.owner.registerEvent(v.on("delete", (f) => this.onDelete(f)));
		this.owner.registerEvent(v.on("rename", (f, old) => this.onRename(f, old)));
		this.owner.registerDomEvent(window, "online", () => this.requestReconcile("online"));
		this.scheduleInterval();
		void this.begin();
	}

	// After a reload (a BRAT update) the core has already waited for the old copy's run to end.
	private async begin(): Promise<void> {
		if (this.stopped) return;
		try {
			await this.pairing.ensureIdentity();
			if (this.stopped) return;
			if (Pairing.isDeviceLogin(this.owner.settings.webdavUser)) {
				// Also covers an already-paired computer: the first check succeeds and starts the backup.
				this.pairing.start();
			} else {
				this.paired = true; // a login written by the setup script
				this.startupTimer = window.setTimeout(() => this.requestReconcile("startup"), STARTUP_DELAY_MS);
			}
		} catch (e) {
			// For example data.json cannot be saved (disk full): try again until it works.
			if (this.stopped) return;
			console.error("[VLB backup] could not start:", e, "— trying again in a minute");
			this.startupTimer = window.setTimeout(() => void this.begin(), RETRY_MS);
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
		this.checkAborted();
		const auth = authFor(this.owner.settings);
		const r = await withTimeout(requestUrl({
			url: auth.base,
			method: "PROPFIND",
			headers: { Authorization: basicAuth(auth), Depth: "0" },
			throw: false,
		}), 30_000, "PROPFIND");
		return r.status;
	}

	/** Stops at once; resolves when the run in progress has ended (it stops between files) and
	 *  the index is saved. The core bounds the wait, and once it gives up on this copy every
	 *  request fails, so the next copy of the plugin is the only one writing. */
	async stop(): Promise<void> {
		this.stopped = true;
		this.pairing.stop();
		for (const t of this.pending.values()) window.clearTimeout(t);
		this.pending.clear();
		for (const t of [this.manifestTimer, this.retryTimer, this.intervalTimer, this.startupTimer]) {
			if (t) window.clearTimeout(t);
		}
		await this.queue.catch(() => {});
		// A file uploaded in the last seconds whose index save was still waiting on its timer.
		try {
			await this.flushManifest();
		} catch (e) {
			console.log("[VLB backup] could not save the index while stopping:", errMsg(e));
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
		const pf = this.owner.privateFolder;
		if (!pf.enabled) return sp;
		if (sp === pf.name || sp.startsWith(pf.name + "/")) {
			if (await this.owner.app.vault.adapter.exists(pf.hiddenName)) return pf.hiddenName + sp.slice(pf.name.length);
		}
		return sp;
	}

	scheduleInterval(): void {
		if (this.stopped) return; // a stopped copy (after a reload) must not re-arm its timer
		if (this.intervalTimer) window.clearTimeout(this.intervalTimer);
		const min = Math.max(1, this.owner.settings.reconcileMinutes || 10);
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
			const adapter = this.owner.app.vault.adapter;
			// Lock/unlock renames Private <-> .Private; Obsidian reports that as a delete.
			const alt = this.owner.privateFolder.altPath(path);
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
		// Nothing may break the chain: after a rejected job every later one would be skipped until restart.
		this.queue = this.queue.catch(() => {}).then(async () => {
			if (opts.reconcile) this.reconcileQueued = false; // whether or not it runs now, a new one may be asked for
			if (!this.enabled) return;
			if (this.failed && !opts.force) return; // the retry reconcile will cover it
			try {
				await fn();
			} catch (e) {
				try {
					await this.onFailure(e);
				} catch (e2) {
					console.error("[VLB backup] could not handle the failure:", e2);
				}
			}
		});
	}

	private async onFailure(e: unknown): Promise<void> {
		console.error("[VLB backup]", e, "— retrying in a minute");
		if (this.stopped) return; // a newer copy of the plugin takes over
		if (e instanceof DavError && e.status === 401 && Pairing.isDeviceLogin(this.owner.settings.webdavUser)) {
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
		try {
			await this.control.pull();
		} catch (e) {
			// Server settings and commands never hold up the backup (data.json not saved: disk full, antivirus lock).
			this.control.configError = `config or commands not applied: ${errMsg(e)}`;
			console.warn("[VLB backup] config or commands not applied; backing up anyway:", e);
		}

		const local = new Map<string, LocalFile>();
		await scan(this.owner.app.vault.adapter, "", local, (p) => this.excluded(p), (p) => this.serverPath(p));

		let uploaded = 0;
		const skipped: string[] = [];
		const failed: string[] = []; // one file's trouble never stops the others
		let lastFlush = Date.now();
		for (const [sp, info] of local) {
			if (this.stopped) break; // the index is still saved below
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
			if (Date.now() - lastFlush > FLUSH_EVERY_MS) {
				const wrote = this.manifestDirty;
				await this.flushManifest();
				lastFlush = Date.now();
				// The server took the index: a long run is making progress (watchdog, D.1).
				if (wrote && __VLB_FAULT__ !== "no-heartbeat") this.owner.host.heartbeat();
			}
		}
		let trashed = 0;
		for (const sp of Object.keys(this.manifest)) {
			if (this.stopped) break;
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
		if (this.stopped) return; // the next copy of the plugin reports
		this.lastError = failed.length
			? `${failed.length} file(s) could not be backed up: ${failed.slice(0, 3).join("; ")}${failed.length > 3 ? "; …" : ""}`
			: "";
		this.control.lastReconcile = { at: new Date().toISOString(), reason, files: local.size, uploaded, trashed, skipped, failed };
		await this.control.writeStatus();
		// A finished run the server took: the core's watchdog hears about it (D.1). Never from
		// onFailure, live uploads or pairing.
		if (__VLB_FAULT__ !== "no-heartbeat") this.owner.host.heartbeat();
		console.log(`[VLB backup] reconcile (${reason}): ${local.size} files, ${uploaded} uploaded, ${trashed} trashed` +
			(skipped.length ? `, ${skipped.length} over 100 MB skipped: ${skipped.join(", ")}` : "") +
			(failed.length ? `, ${failed.length} failed` : ""));
	}

	private async syncPath(path: string): Promise<void> {
		if (this.excluded(path)) return;
		const st = await this.owner.app.vault.adapter.stat(path);
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
			data = await this.owner.app.vault.adapter.readBinary(path);
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

	private parseManifest(r: RequestUrlResponse): Index {
		try {
			const j = JSON.parse(r.text);
			return j && typeof j === "object" && !Array.isArray(j) ? (j as Index) : {};
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

	private url(sp: string): string {
		return davUrl(authFor(this.owner.settings), sp);
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
		this.checkAborted();
		return dav(authFor(this.owner.settings), method, sp, body, headers, alsoOk);
	}

	/** The core gave up on this copy of the app (it stopped too slowly): no more requests. */
	checkAborted(): void {
		if (this.owner.host.isAborted()) throw new DavError("stopped", 0);
	}

	// ---- helpers -------------------------------------------------------------

	private serverPath(path: string): string {
		return this.owner.privateFolder.toVisible(path);
	}

	private excluded(path: string): boolean {
		// The plugin's own folder holds data.json and its copy (passphrase hash, this computer's server key): never uploaded.
		return isExcluded(path, this.owner.manifest.dir ?? ".obsidian/plugins/vault-lock", this.owner.settings.excludes);
	}

	stamp(): string {
		return stamp();
	}
}

/** A file on this computer that cannot be read (permissions, a lock held by another program). */
class FileError extends Error {}

/** True when the trouble is with one file, not with the server or the login: skip it and go on. */
function isPerFile(e: unknown): boolean {
	if (e instanceof FileError) return true;
	return e instanceof DavError && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 403;
}
