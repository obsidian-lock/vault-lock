import { FileSystemAdapter, Notice, Platform, TFile, WorkspaceLeaf } from "obsidian";
import type { App } from "obsidian";
import * as fs from "fs";
import * as path from "path";
import {
	BUSY_RETRY_MS, CREATE_FOLDER_MS, ENC_PAUSE_MS, FS_RETRY_MS, FS_RETRY_STEP_MS, MAX_ENCRYPT_BYTES, RENAME_RETRY_MS, RENAME_RETRY_STEP_MS, SHOW_RENAME_RETRY_MS,
} from "./constants";
import type { VLBSettings } from "./settings";
import { stamp } from "./vaultfiles";
import { decryptBytes, fault, importVaultKey, isAsideName, isTmpName, isVlencName, NotVlenc, parseHeader, VLENC_MAGIC, encryptBytes } from "./vlenc";

/**
 * The private folder lives at `Private/` while unlocked and `.Private/` while locked.
 * Obsidian ignores dot-folders entirely (explorer, search, graph, switcher), so the rename is
 * the whole hiding mechanism inside Obsidian. On Windows the folder and everything in it also
 * get the hidden attribute, so File Explorer skips them. While hidden, every file in it is
 * encrypted to `<name>.vlenc` (shared/vlenc.ts) with the key the server made for this computer;
 * the unlock decrypts them before the folder comes back.
 *
 * Rules that keep every note (the invariants of the design doc):
 * - a plaintext is unlinked only after its .vlenc was written, fsynced, read back, decrypted
 *   and compared; a .vlenc only after its plaintext was written the same way, or when an
 *   identical plaintext already exists;
 * - a rename never replaces a file: the target is checked right before, else the file waits
 *   for the end of the pass and is reported;
 * - an x.vlenc the key cannot open is moved aside, never deleted; a .vlenc that is not ours
 *   (no magic) is a plain file; a .vlenc.tmp without a source is kept and reported;
 * - one transformation at a time per vault, across copies of the plugin: every job runs on one
 *   serial chain kept on window.__vaultLock.pf; cancellation is a generation counter checked
 *   between files, so the file in progress always finishes.
 */

export type EncStats = {
	on: boolean; keyId: string | null; keyDurable: boolean; files: number; plain: number; failed: string[];
	tooBig: string[]; undecryptable: number; recovered: number; hideError: string | null;
	lastPass: null | { at: string; kind: "encrypt" | "decrypt"; ms: number };
};

/** One file found under the hidden folder. rel is the vault path; isVlenc means the magic is there. */
type Found = { rel: string; abs: string; size: number; isVlenc: boolean; isTmp: boolean; isAside: boolean };
type Pair = "same" | "sibling" | "aside" | "keep-both";
type Decrypted = { plain: Uint8Array; header: { keyId: string; mtime: number } };

const fsp = fs.promises;
const RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

export class PrivateFolder {
	/** Set by the lock screens: "Unlocking… n of N" while the unlock decrypts. */
	progress: ((text: string | null) => void) | null = null;
	/** The key in the settings is on disk (both files). Nothing is encrypted before that. */
	keyDurable: boolean;
	/** Test hook: how many encrypt passes ran. */
	__passes = 0;

	private gen = 0;
	private queued = false;
	/** dispose() ran: no pass is ever queued again (the next copy of the plugin has its own). */
	private disposed = false;
	/** The last pass only hid (no key, or encryption off): plaintext is still under the hidden folder. */
	private lastHideOnly = false;
	/** A pass has started and not yet decided about its pause (finishLock() can still make it skip). */
	private prePause = false;
	private skipOnce = false;
	private retryTimer: number | null = null;
	private wake: (() => void) | null = null;
	private keyCache: { hex: string; key: Promise<CryptoKey> } | null = null;
	private strayMoved = 0;
	// Stats of the last pass (encrypt or decrypt) and of the last merge.
	private files = 0;
	private plain = 0;
	private failed: string[] = [];
	private strayFailed: string[] = [];
	private tooBig: string[] = [];
	private undecryptable = 0;
	private recovered = 0;
	private hideError: string | null = null;
	private lastPass: EncStats["lastPass"] = null;
	/** The last warning of ensureVisible(), so a check every 15 s does not repeat it. */
	private lastWarn = "";

	constructor(private app: App, private settings: () => VLBSettings) {
		// A key loaded from disk is durable by definition (the core validated it).
		this.keyDurable = !!settings().vaultKey;
	}

	get name(): string {
		return this.settings().privateFolder.trim().replace(/^\/+|\/+$/g, "");
	}
	get hiddenName(): string {
		return this.name ? "." + this.name : "";
	}
	get enabled(): boolean {
		return !!this.name && !this.name.startsWith(".") && !this.name.includes("/");
	}

	/** Map a path under `.Private/` to `Private/`, so the backup server never sees the hidden name. */
	toVisible(path: string): string {
		if (!this.enabled) return path;
		const h = this.hiddenName;
		if (path === h) return this.name;
		if (path.startsWith(h + "/")) return this.name + path.slice(h.length);
		return path;
	}

	/** The other on-disk location of a path inside the private folder, or null if not inside it. */
	altPath(path: string): string | null {
		if (!this.enabled) return null;
		const v = this.name, h = this.hiddenName;
		if (path === v) return h;
		if (path === h) return v;
		if (path.startsWith(v + "/")) return h + path.slice(v.length);
		if (path.startsWith(h + "/")) return v + path.slice(h.length);
		return null;
	}

	/** V, V/…, H or H/… (folders arrive from scan() with a trailing "/"). */
	isPrivatePath(p: string): boolean {
		return this.enabled && (under(p, this.name) || under(p, this.hiddenName));
	}
	/** H or H/… */
	isHiddenPath(p: string): boolean {
		return this.enabled && under(p, this.hiddenName);
	}
	/** V or V/… (a server path). */
	isPrivateServerPath(sp: string): boolean {
		return this.enabled && under(sp, this.name);
	}

	encryptionReady(): boolean {
		const s = this.settings();
		return this.enabled && s.encrypt && !!s.vaultKey && this.keyDurable;
	}

	/** The last pass left the hidden folder plaintext (no key or encryption off then) and it could
	 *  be encrypted now: the switch or the key arrived by another road than applyConfig's edge
	 *  (the core's tick writes the same setting). Cheap: no disk read. */
	leftPlain(): boolean {
		return this.lastHideOnly && this.encryptionReady();
	}

	stats(): EncStats {
		const s = this.settings();
		return {
			on: s.encrypt, keyId: s.vaultKey?.id ?? null, keyDurable: this.keyDurable, files: this.files, plain: this.plain,
			failed: [...this.failed, ...this.strayFailed], tooBig: [...this.tooBig], undecryptable: this.undecryptable,
			recovered: this.recovered, hideError: this.hideError, lastPass: this.lastPass,
		};
	}

	// ---- the jobs ----------------------------------------------------------------------

	/** Rename V → H (strays made while locked are merged in first), then queue the encryption
	 *  pass; resolves after the rename. Rejects when the folder could not be renamed (hideError). */
	hide(): Promise<void> {
		this.clearRetry();
		return this.serial(async () => {
			if (!this.enabled) return;
			const adapter = this.app.vault.adapter;
			const V = this.name, H = this.hiddenName;
			try {
				if (await adapter.exists(V)) {
					if (await adapter.exists(H)) {
						const left = await this.mergeVisibleIntoHidden();
						if (left) throw new Error(`${left} file(s) could not be moved out of ${V}: ${this.strayFailed.join("; ")}`);
					} else {
						await this.closeLeavesUnder(V);
						await this.renameRetry(V, H, RENAME_RETRY_MS);
					}
				}
				if (!(await adapter.exists(H))) return; // no private folder at all
				// The folder only: one exec, so Explorer never shows ".Private" with readable
				// names for the length of a pass. Every file gets it after the pass.
				await this.setWindowsHidden(H, true, false);
				this.hideError = null;
			} catch (e) {
				this.hideError = msg(e);
				// Whatever is under H/ should still be encrypted.
				if (await adapter.exists(H)) this.kick(false);
				throw e;
			}
			this.kick(false);
		});
	}

	/** Decrypt everything under H and rename it back to V. cancelled is asked between files and
	 *  before the rename: true keeps the folder hidden (the caller stays locked). Rejects when a
	 *  stray could not be moved, the pass itself failed, or the rename failed. */
	show(cancelled: () => boolean = () => false): Promise<void> {
		this.cancelPasses();
		this.clearRetry();
		return this.serial(async () => {
			if (!this.enabled || cancelled()) return;
			const adapter = this.app.vault.adapter;
			const V = this.name, H = this.hiddenName;
			try {
				if (!(await adapter.exists(H))) return;
				// Unmark first, while Obsidian still ignores the dot-folder and sees no changes.
				await this.setWindowsHidden(H, false, true);
				if (await adapter.exists(V)) {
					const left = await this.mergeVisibleIntoHidden();
					if (left) throw new Error(`${left} file(s) in ${V} could not be moved into the private folder: ${this.strayFailed.join("; ")}`);
				}
				await this.decryptAll(cancelled);
				if (cancelled()) return;
				await this.renameRetry(H, V, SHOW_RENAME_RETRY_MS);
			} finally {
				this.progress?.(null);
			}
			if (this.strayMoved) {
				new Notice(`Vault Lock: ${this.strayMoved} file(s) created in ${V} while it was locked were moved into the private folder.`, 15000);
				this.strayMoved = 0;
			}
		});
	}

	/** Ends a pause that sleeps now, makes a queued pass skip its pause, and resolves when the
	 *  jobs queued so far are done, plus the pass a running hide() queues as it ends (on Windows
	 *  its attrib call is slow enough that the pass is not queued yet when this is called).
	 *  One-shot: the next lock pauses again. Never rejects. */
	async finishLock(): Promise<void> {
		const { chains, key } = this.store();
		for (let i = 0; i < 4; i++) {
			this.wake?.();
			if (this.queued || this.prePause) this.skipOnce = true;
			const t = chains[key];
			await (t ?? Promise.resolve()).catch(() => {});
			if (chains[key] === t && !this.queued && !this.prePause) return;
		}
	}

	/** The private folder always exists while unlocked (1.9.1; the app asks, the lifeboat never
	 *  does). Made empty, through Obsidian so the file list shows it at once, only when the top of
	 *  the vault holds it in no form: neither the visible nor the hidden name, in any case (NTFS
	 *  and APFS ignore case), and no file by that name. A job on the serial chain, so it never runs
	 *  during a hide, a show or a pass of any copy of the plugin; cancelled() (locked, unlocking, a
	 *  restore, stopping) is asked as it starts and again right before the folder is made. Never
	 *  rejects: a failure is logged once and the next check tries again. */
	ensureVisible(cancelled: () => boolean): Promise<void> {
		return this.serial(async () => {
			if (this.disposed || !this.enabled || cancelled()) return;
			const adapter = this.app.vault.adapter as FileSystemAdapter;
			if (typeof adapter.getBasePath !== "function") return; // not on a local disk
			const fold = (n: string) => n.normalize("NFC").toLowerCase();
			const V = this.name;
			const names = new Set([fold(V), fold(this.hiddenName)]);
			const top = await fsp.readdir(path.toNamespacedPath(adapter.getBasePath()), { withFileTypes: true });
			const there = top.find((e) => names.has(fold(e.name)));
			if (there) {
				if (!there.isDirectory()) this.warnOnce(`"${there.name}" at the top of the vault is not a folder; no private folder is made`);
				return;
			}
			if (this.disposed || cancelled()) return;
			await bounded(this.app.vault.createFolder(V), CREATE_FOLDER_MS, `making ${V}/`);
			this.lastWarn = "";
			console.log(`[VLB] the private folder ${V}/ was missing and has been made`);
		}).catch((e) => this.warnOnce(`the private folder could not be made (tried again at the next check): ${msg(e)}`));
	}

	private warnOnce(text: string): void {
		if (text === this.lastWarn) return;
		this.lastWarn = text;
		console.warn("[VLB] " + text);
	}

	/** Encrypt a hidden folder now (the key arrived, or encryption was turned on). */
	requestEncrypt(): void {
		this.kick(true);
	}

	/** The app stops: end the pause, stop at the next file, and wait for the jobs queued so far
	 *  (not for the ones the next copy of the plugin may have queued behind them). From now on
	 *  nothing queues a pass here: a key or switch that arrives as the app stops is the next
	 *  copy's job, not an uncancellable pass on a stopped one. */
	dispose(): Promise<void> {
		this.disposed = true;
		this.cancelPasses();
		this.clearRetry();
		return this.tail().catch(() => {});
	}

	/** Test hook (a crashed process): the retry timer goes and the running pass stops at its next file. */
	__testAbandon(): void {
		this.clearRetry();
		this.cancelPasses();
	}

	/** Test hook: the busy retry fires now. */
	__fireRetry(): void {
		this.clearRetry();
		this.kick(true);
	}

	// ---- the chain ----------------------------------------------------------------------

	/** The chain of this vault, shared by every PrivateFolder of this vault in this window. */
	private store(): { chains: Record<string, Promise<void>>; key: string } {
		const w = (window.__vaultLock ??= {});
		const chains = (w.pf ??= {});
		const adapter = this.app.vault.adapter as { getBasePath?: () => string };
		const key = typeof adapter.getBasePath === "function" ? adapter.getBasePath() : "";
		return { chains, key };
	}

	private tail(): Promise<void> {
		const { chains, key } = this.store();
		return chains[key] ?? Promise.resolve();
	}

	private serial<T>(fn: () => Promise<T>): Promise<T> {
		const { chains, key } = this.store();
		const prev = chains[key] ?? Promise.resolve();
		const run = prev.then(fn, fn);
		chains[key] = run.then(() => {}, () => {});
		return run;
	}

	private cancelPasses(): void {
		this.gen++;
		this.wake?.();
	}

	private clearRetry(): void {
		if (this.retryTimer) window.clearTimeout(this.retryTimer);
		this.retryTimer = null;
	}

	private scheduleRetry(): void {
		if (this.retryTimer || this.disposed) return;
		this.retryTimer = window.setTimeout(() => {
			this.retryTimer = null;
			this.kick(true);
		}, BUSY_RETRY_MS);
	}

	/** Queue one encryption pass; one waiting pass is enough, however often this is asked. */
	private kick(now: boolean): void {
		if (this.queued || this.disposed) return;
		this.queued = true;
		const g = this.gen;
		void this.serial(() => this.pass(now, g).catch((e) => console.error("[VLB] encryption pass failed", e)));
	}

	private async pass(now: boolean, g: number): Promise<void> {
		this.queued = false;
		this.prePause = true;
		// The generation is read after the await: a show() or dispose() that lands during it
		// must not be followed by the 5 s pause.
		const hidden = await this.app.vault.adapter.exists(this.hiddenName);
		if (g !== this.gen || this.disposed || !hidden) {
			this.prePause = false;
			if (!this.queued) this.skipOnce = false; // nothing waits for it any more
			return;
		}
		const skip = now || this.skipOnce;
		this.skipOnce = false;
		this.prePause = false;
		if (!skip) {
			await this.pause();
			if (g !== this.gen) return;
		}
		this.__passes++;
		let ready = false;
		try {
			ready = await this.encryptAll(() => g !== this.gen);
		} catch (e) {
			this.failed.push("pass: " + msg(e));
			ready = true;
		} finally {
			await this.setWindowsHidden(this.hiddenName, true, true);
		}
		this.lastHideOnly = !ready;
		// Hide-only passes (no key yet) are not retried: nothing would change.
		if (ready && this.failed.length && g === this.gen) this.scheduleRetry();
	}

	/** ENC_PAUSE_MS, ended early by finishLock(), show() or dispose(). */
	private pause(): Promise<void> {
		return new Promise<void>((resolve) => {
			const done = () => {
				window.clearTimeout(t);
				if (this.wake === done) this.wake = null;
				resolve();
			};
			const t = window.setTimeout(done, ENC_PAUSE_MS);
			this.wake = done;
		});
	}

	// ---- whole-folder passes --------------------------------------------------------------

	/** Encrypt every plaintext under H. Returns false when there is no key yet (hide only). */
	private async encryptAll(cancelled: () => boolean): Promise<boolean> {
		const t0 = Date.now();
		this.failed = [];
		this.tooBig = [];
		this.undecryptable = 0;
		this.recovered = 0;
		const H = this.hiddenName;
		if (!(await this.app.vault.adapter.exists(H))) return true;
		const list = await this.walk(H);
		await this.cleanTmps(list);
		if (!this.encryptionReady()) {
			this.count(list);
			this.lastPass = { at: new Date().toISOString(), kind: "encrypt", ms: Date.now() - t0 };
			return false;
		}
		const key = { key: await this.cryptoKey(), id: this.settings().vaultKey?.id ?? "" };
		const todo = list.filter((f) => !f.isVlenc && !f.isAside && !f.isTmp).sort((a, b) => a.size - b.size);
		const deferred: Found[] = [];
		let changed = false;
		for (const x of todo) {
			if (cancelled()) break;
			if (x.size > MAX_ENCRYPT_BYTES) { this.tooBig.push(x.rel); continue; }
			try {
				const r = await this.encryptOne(x, key);
				if (r.changed) changed = true;
				if (r.sibling) todo.push(r.sibling); // the recovered copy is a plaintext too: encrypt it in this pass
				if (r.result === "deferred") deferred.push(x);
			} catch (e) {
				this.failed.push(`${x.rel}: ${msg(e)}`);
			}
		}
		for (const x of deferred) {
			if (cancelled()) break;
			try {
				const r = await this.encryptOne(x, key);
				if (r.changed) changed = true;
				if (r.result === "deferred") this.failed.push(`${x.rel}: the name ${x.rel}.vlenc is taken by another file`);
			} catch (e) {
				this.failed.push(`${x.rel}: ${msg(e)}`);
			}
		}
		this.count(changed ? await this.walk(H) : list);
		this.lastPass = { at: new Date().toISOString(), kind: "encrypt", ms: Date.now() - t0 };
		return true;
	}

	/** Decrypt every .vlenc under H (the folder is still hidden). Per-file trouble is reported, never fatal. */
	private async decryptAll(cancelled: () => boolean): Promise<void> {
		const t0 = Date.now();
		this.failed = [];
		this.tooBig = [];
		this.undecryptable = 0;
		this.recovered = 0;
		const H = this.hiddenName;
		if (!(await this.app.vault.adapter.exists(H))) return;
		const list = await this.walk(H);
		await this.cleanTmps(list);
		const vlencs = list.filter((f) => f.isVlenc && !f.isAside).sort((a, b) => a.size - b.size);
		const N = vlencs.length;
		let changed = false;
		if (N > 0) {
			this.progress?.(`Unlocking… 0 of ${N}`);
			if (!this.settings().vaultKey) {
				this.failed.push("no key on this computer yet; the encrypted files stay as they are");
			} else {
				const key = await this.cryptoKey();
				const deferred: Found[] = [];
				for (let i = 0; i < N; i++) {
					if (cancelled()) break;
					const f = vlencs[i];
					try {
						const r = await this.decryptOne(f, key);
						if (r !== "plain" && r !== "deferred") changed = true;
						if (r === "deferred") deferred.push(f);
					} catch (e) {
						this.failed.push(`${f.rel}: ${msg(e)}`);
					}
					this.progress?.(`Unlocking… ${i + 1} of ${N}`);
				}
				for (const f of deferred) {
					if (cancelled()) break;
					try {
						const r = await this.decryptOne(f, key);
						if (r !== "plain" && r !== "deferred") changed = true;
						if (r === "deferred") this.failed.push(`${f.rel}: the name is taken by another file`);
					} catch (e) {
						this.failed.push(`${f.rel}: ${msg(e)}`);
					}
				}
			}
		}
		this.count(changed ? await this.walk(H) : list);
		this.lastPass = { at: new Date().toISOString(), kind: "decrypt", ms: Date.now() - t0 };
	}

	private count(list: Found[]): void {
		this.files = list.filter((f) => f.isVlenc && !f.isAside).length;
		this.plain = list.filter((f) => !f.isVlenc && !f.isAside && !f.isTmp).length;
	}

	/** Everything under dir, recursively, with Node fs; symlinks are not followed. A listing or
	 *  stat that fails is a per-file failure, never the end of the pass. */
	private async walk(dir: string): Promise<Found[]> {
		const out: Found[] = [];
		const visit = async (d: string): Promise<void> => {
			let entries: fs.Dirent[];
			try {
				entries = await fsp.readdir(this.abs(d), { withFileTypes: true });
			} catch (e) {
				this.failed.push(`${d}: ${msg(e)}`);
				return;
			}
			for (const e of entries) {
				const rel = `${d}/${e.name}`;
				try {
					if (e.isDirectory()) { await visit(rel); continue; }
					if (!e.isFile()) continue;
					const abs = this.abs(rel);
					const st = await fsp.lstat(abs);
					const isTmp = isTmpName(e.name);
					const isAside = isAsideName(e.name);
					const isVlenc = !isTmp && isVlencName(e.name) && (await this.hasMagic(abs));
					out.push({ rel, abs, size: st.size, isVlenc, isTmp, isAside });
				} catch (err) {
					this.failed.push(`${rel}: ${msg(err)}`);
				}
			}
		};
		await visit(dir);
		return out;
	}

	/** x.vlenc.tmp is ours only while its source (x or x.vlenc) is there; otherwise it is kept and
	 *  reported. The pair rule's sibling (C.5) is written through the pair's own x.vlenc.tmp, so a
	 *  crash in the middle of it leaves exactly this: x, x.vlenc and the temp file. */
	private async cleanTmps(list: Found[]): Promise<void> {
		for (const t of list) {
			if (!t.isTmp) continue;
			const src = t.abs.slice(0, -".tmp".length);
			const x = src.slice(0, -".vlenc".length);
			try {
				if ((await this.lexists(x)) || (await this.lexists(src))) await this.fsRetry(() => fsp.unlink(t.abs));
				else this.failed.push(`${t.rel}: orphan temp file kept`);
			} catch (e) {
				this.failed.push(`${t.rel}: ${msg(e)}`);
			}
		}
	}

	// ---- one file --------------------------------------------------------------------------

	/** The encrypt state machine for one plaintext x. changed: something on disk is different now. */
	private async encryptOne(x: Found, key: { key: CryptoKey; id: string }): Promise<{ result: "done" | "deferred" | "kept"; changed: boolean; sibling?: Found }> {
		const enc = x.abs + ".vlenc";
		const tmp = x.abs + ".vlenc.tmp";
		let changed = false;
		let sibling: Found | undefined;
		if (await this.lexists(enc)) {
			const p = await this.repairPair(x, key.key);
			if (p.pair === "keep-both") return { result: "deferred", changed };
			changed = true;
			sibling = p.sibling;
		}
		// E0
		const st0 = await fsp.stat(x.abs);
		const st = await this.app.vault.adapter.stat(x.rel);
		if (!st) throw new Error("cannot stat");
		const m = st.mtime;
		const plain = await fsp.readFile(x.abs);
		await fault("enc:before-tmp");
		// E1: the temporary file is written fresh (an old one may be removed: the source x exists).
		await this.unlinkIfExists(tmp);
		await this.writeNew(tmp, await encryptBytes(key.key, key.id, plain, m));
		changed = true;
		await fault("enc:after-tmp");
		// E2: read back from disk and compare.
		const d = await decryptBytes(key.key, await fsp.readFile(tmp));
		if (!same(d.plain, plain) || d.header.mtime !== m) throw new Error("verify failed");
		await fault("enc:after-verify");
		// E3: never over an existing file; the tmp is cleaned by the next pass.
		if (await this.lexists(enc)) return { result: "deferred", changed, sibling };
		await this.fsRetry(() => fsp.rename(tmp, enc));
		await fault("enc:after-rename");
		// E4: x rewritten meanwhile by another program? Then both stay; the pair rule sorts them out next time.
		const st1 = await fsp.stat(x.abs);
		if (st1.mtimeMs !== st0.mtimeMs || st1.size !== st0.size) {
			this.failed.push(`${x.rel}: changed while being encrypted; kept`);
			return { result: "kept", changed, sibling };
		}
		await this.unlinkRetry(x.abs);
		return { result: "done", changed, sibling };
	}

	/** The decrypt state machine for one x.vlenc. "plain": not ours (no magic), left alone. */
	private async decryptOne(f: Found, key: CryptoKey): Promise<"done" | "deferred" | "aside" | "plain" | "paired"> {
		const enc = f.abs;
		const xAbs = enc.slice(0, -".vlenc".length);
		const xRel = f.rel.slice(0, -".vlenc".length);
		const tmp = xAbs + ".vlenc.tmp";
		// D0
		const cipher = await fsp.readFile(enc);
		let d: Decrypted;
		try {
			d = await decryptBytes(key, cipher);
		} catch (e) {
			if (e instanceof NotVlenc) return "plain";
			const hdr = parseHeader(cipher);
			await this.moveAside(xAbs, enc);
			this.failed.push(`${xRel}: cannot be decrypted (file key ${hdr.keyId}, this computer holds ${this.settings().vaultKey?.id ?? "none"})`);
			return "aside";
		}
		if (await this.lexists(xAbs)) {
			// The name is held by one of our own .vlenc files (a plain "x.vlenc" of the user, encrypted
			// to x.vlenc.vlenc): it frees the name when it is decrypted; try again after the others.
			if (await this.hasMagic(xAbs)) return "deferred";
			await this.settlePair(xRel, xAbs, enc, d);
			return "paired";
		}
		await fault("dec:before-tmp");
		// D1
		await this.unlinkIfExists(tmp);
		await this.writeNew(tmp, d.plain);
		await fault("dec:after-tmp");
		// D2
		if (!same(await fsp.readFile(tmp), d.plain)) throw new Error("verify failed");
		await fault("dec:after-verify");
		// D3: the original mtime, on the tmp so a crash after the rename keeps it.
		await this.setMtime(tmp, d.header.mtime);
		// D4
		if (await this.lexists(xAbs)) return "deferred";
		await this.fsRetry(() => fsp.rename(tmp, xAbs));
		await fault("dec:after-rename");
		// D5
		await this.fsRetry(() => fsp.unlink(enc));
		await fault("dec:after-unlink");
		// D7: what the index compares must read back unchanged.
		const st = await this.app.vault.adapter.stat(xRel);
		if (st && st.mtime !== d.header.mtime) console.log(`[VLB] mtime drift on ${xRel}: ${st.mtime} instead of ${d.header.mtime}`);
		return "done";
	}

	/** x and x.vlenc both exist (a crash between steps, or a plain file of the user named x.vlenc). */
	private async repairPair(x: Found, key: CryptoKey): Promise<{ pair: Pair; sibling?: Found }> {
		const enc = x.abs + ".vlenc";
		const cipher = await fsp.readFile(enc);
		let d: Decrypted;
		try {
			d = await decryptBytes(key, cipher);
		} catch (e) {
			if (e instanceof NotVlenc) return { pair: "keep-both" }; // a plain file owns the name
			await this.moveAside(x.abs, enc);
			return { pair: "aside" };
		}
		return this.settlePair(x.rel, x.abs, enc, d);
	}

	/** d is the content of enc, x exists: identical → enc goes; different → d becomes a sibling note, then enc goes. */
	private async settlePair(xRel: string, xAbs: string, enc: string, d: Decrypted): Promise<{ pair: Pair; sibling?: Found }> {
		if (same(d.plain, await fsp.readFile(xAbs))) {
			await this.fsRetry(() => fsp.unlink(enc));
			return { pair: "same" };
		}
		const base = path.basename(xAbs);
		const dot = base.lastIndexOf(".");
		const ext = dot > 0 ? base.slice(dot) : "";
		const stem = xAbs.slice(0, xAbs.length - ext.length);
		const S = stamp();
		// Through the pair's own temporary file (x.vlenc.tmp): its source x.vlenc exists until the
		// end, so a crash leaves what C.3's temp rule cleans up, never an orphan with readable text.
		const tmp = enc + ".tmp";
		await this.unlinkIfExists(tmp);
		await this.writeNew(tmp, d.plain);
		let target: string;
		try {
			await this.setMtime(tmp, d.header.mtime);
			try {
				target = await this.freeName(`${stem} (recovered ${S})`, ext);
				if (await this.lexists(target)) throw new Error(`${path.basename(target)} appeared meanwhile`);
				await this.fsRetry(() => fsp.rename(tmp, target));
			} catch (e) {
				// The long sibling name is too much for this disk (Windows says ENOENT for that, with
				// the temp file still there): a short one in the same folder.
				const code = (e as NodeJS.ErrnoException).code;
				if (code !== "ENAMETOOLONG" && !(code === "ENOENT" && (await this.lexists(tmp)))) throw e;
				target = await this.freeName(path.dirname(xAbs) + path.sep + `recovered ${S}`, ext);
				if (await this.lexists(target)) throw new Error(`${path.basename(target)} appeared meanwhile`);
				await this.fsRetry(() => fsp.rename(tmp, target));
			}
		} catch (e) {
			// Nothing is lost: the text is still in enc. The half-made sibling goes (B3: its source exists).
			await this.unlinkIfExists(tmp).catch(() => {});
			throw e;
		}
		await this.fsRetry(() => fsp.unlink(enc));
		this.recovered++;
		const rel = `${parentOf(xRel)}/${path.basename(target)}`;
		return { pair: "sibling", sibling: { rel, abs: target, size: d.plain.length, isVlenc: false, isTmp: false, isAside: false } };
	}

	/** x.vlenc → x.undecryptable-<stamp>.vlenc (never deleted; vlb vaultkey can open it by hand). */
	private async moveAside(xAbs: string, enc: string): Promise<void> {
		const aside = await this.freeName(`${xAbs}.undecryptable-${stamp()}`, ".vlenc");
		await this.fsRetry(() => fsp.rename(enc, aside));
		this.undecryptable++;
	}

	/** base+ext, or base-2+ext, base-3+ext … whichever is free (also as a .vlenc / .vlenc.tmp). */
	private async freeName(base: string, ext: string): Promise<string> {
		for (let n = 1; ; n++) {
			const t = n === 1 ? base + ext : `${base}-${n}${ext}`;
			if (!(await this.lexists(t)) && !(await this.lexists(t + ".vlenc")) && !(await this.lexists(t + ".vlenc.tmp"))) return t;
		}
	}

	// ---- strays (C.9) ------------------------------------------------------------------------

	/** A link clicked while locked makes V/x beside H/: move every such file into H/ under a
	 *  free name. Returns how many could not be moved (they are reported and stay in V). */
	private async mergeVisibleIntoHidden(): Promise<number> {
		const adapter = this.app.vault.adapter;
		const V = this.name, H = this.hiddenName;
		this.strayFailed = [];
		if (!(await adapter.exists(V)) || !(await adapter.exists(H))) return 0;
		// A stray is usually open in a tab, and adapter.rename bypasses the vault: an open view
		// would make V/x again at its next save. Save and detach first.
		await this.closeLeavesUnder(V);
		const files: string[] = [];
		const folders: string[] = [];
		await this.listTree(V, files, folders);
		// Names are compared as the disk compares them where that matters (NTFS and APFS ignore
		// case; a stray "secret.md" beside "Secret.md.vlenc" would otherwise take the real note's
		// name and win the pair rule at the unlock): folded, which on a case-sensitive disk only
		// costs a "(created while locked)" suffix where none was needed.
		const fold = (n: string) => n.normalize("NFC").toLowerCase();
		const listed = new Map<string, Set<string>>(); // H/dir → folded names there (one listing per folder)
		const names = async (dir: string): Promise<Set<string>> => {
			let s = listed.get(dir);
			if (!s) {
				s = new Set<string>();
				try { for (const e of await fsp.readdir(this.abs(dir))) s.add(fold(e)); } catch { /* not there yet */ }
				listed.set(dir, s);
			}
			return s;
		};
		const taken = async (t: string): Promise<boolean> => {
			const s = await names(parentOf(t));
			const b = fold(path.basename(t));
			return s.has(b) || s.has(b + ".vlenc") || s.has(b + ".vlenc.tmp") || [...s].some((n) => n.startsWith(b + ".undecryptable-"));
		};
		let moved = 0, left = 0;
		for (const rel of files) {
			const sub = rel.slice(V.length + 1);
			const dir = parentOf(sub) ? `${H}/${parentOf(sub)}` : H;
			const base = path.basename(sub);
			const dot = base.lastIndexOf(".");
			const ext = dot > 0 ? base.slice(dot) : "";
			const stem = base.slice(0, base.length - ext.length);
			const move = async (to: string): Promise<void> => {
				await this.mkdirs(parentOf(to));
				if (await this.lexists(this.abs(to))) throw new Error(`${to} appeared meanwhile`);
				await this.fsRetry(() => adapter.rename(rel, to));
				(await names(parentOf(to))).add(fold(path.basename(to)));
				moved++;
				await fault("merge:after-move");
			};
			try {
				try {
					let target = `${dir}/${base}`;
					if (await taken(target)) {
						for (let n = 1; ; n++) {
							target = `${dir}/${stem} (created while locked)${n === 1 ? "" : `-${n}`}${ext}`;
							if (!(await taken(target))) break;
						}
					}
					await move(target);
				} catch (e) {
					if ((e as NodeJS.ErrnoException).code !== "ENAMETOOLONG") throw e;
					let target = "";
					for (let n = 1; ; n++) {
						target = `${dir}/created while locked ${n}${ext}`;
						if (!(await taken(target))) break;
					}
					await move(target);
				}
			} catch (e) {
				this.strayFailed.push(`${rel}: left in ${V}: ${msg(e)}`);
				left++;
			}
		}
		// The emptied folders, deepest first, then V itself; a folder with something left stays.
		for (const dir of [...folders].reverse().concat(V)) {
			try {
				const l = await adapter.list(dir);
				if (l.files.length === 0 && l.folders.length === 0) await fsp.rmdir(this.abs(dir));
			} catch { /* not empty, or gone */ }
		}
		if (moved) {
			this.strayMoved += moved;
			console.log(`[VLB] ${moved} file(s) created in ${V} while locked were moved into the private folder`);
		}
		return left;
	}

	private async listTree(dir: string, files: string[], folders: string[]): Promise<void> {
		const l = await this.app.vault.adapter.list(dir);
		for (const f of l.files) files.push(f.replace(/^\/+/, ""));
		for (const d of l.folders) {
			const p = d.replace(/^\/+/, "");
			folders.push(p);
			await this.listTree(p, files, folders);
		}
	}

	private async mkdirs(dir: string): Promise<void> {
		if (!dir) return;
		const adapter = this.app.vault.adapter;
		let cur = "";
		for (const part of dir.split("/")) {
			cur = cur ? cur + "/" + part : part;
			if (!(await adapter.exists(cur))) await adapter.mkdir(cur);
		}
	}

	// ---- helpers -------------------------------------------------------------------------------

	/** The folder rename, retried on any error (a file held open, an antivirus scan). */
	private async renameRetry(from: string, to: string, ms: number): Promise<void> {
		const adapter = this.app.vault.adapter;
		const deadline = Date.now() + ms;
		for (;;) {
			try {
				await adapter.rename(from, to);
				return;
			} catch (e) {
				if (Date.now() >= deadline) throw new Error(`rename ${from} → ${to} failed: ${msg(e)}`);
				await sleep(RENAME_RETRY_STEP_MS);
				if (!(await adapter.exists(from)) && (await adapter.exists(to))) return; // done after all
			}
		}
	}

	/** A per-file rename or unlink, retried on EPERM/EACCES/EBUSY (a handle Defender or the Search indexer holds). */
	private async fsRetry<T>(op: () => Promise<T>): Promise<T> {
		const deadline = Date.now() + FS_RETRY_MS;
		for (;;) {
			try {
				return await op();
			} catch (e) {
				if (!RETRY_CODES.has((e as NodeJS.ErrnoException).code ?? "") || Date.now() >= deadline) throw e;
				await sleep(FS_RETRY_STEP_MS);
			}
		}
	}

	/** unlink; on Windows a file carrying the hidden attribute may refuse (EPERM): clear it and try again. */
	private async unlinkRetry(abs: string): Promise<void> {
		try {
			await this.fsRetry(() => fsp.unlink(abs));
		} catch (e) {
			if (!Platform.isWin || (e as NodeJS.ErrnoException).code !== "EPERM") throw e;
			await attrib(["-h", abs]);
			await this.fsRetry(() => fsp.unlink(abs));
		}
	}

	private async unlinkIfExists(abs: string): Promise<void> {
		if (await this.lexists(abs)) await this.fsRetry(() => fsp.unlink(abs));
	}

	/** A new file: exclusive create, write, fsync, close. */
	private async writeNew(abs: string, bytes: Uint8Array): Promise<void> {
		const fh = await fsp.open(abs, "wx");
		try {
			await fh.writeFile(bytes);
			await fh.sync();
		} finally {
			await fh.close();
		}
	}

	/** The quarter millisecond makes the time read back as the same integer whether the adapter
	 *  floors or rounds mtimeMs, whatever libuv's truncation does (a bare m/1000 can read back as m-1). */
	private setMtime(abs: string, m: number): Promise<void> {
		return fsp.utimes(abs, new Date(), (m + 0.25) / 1000);
	}

	private async lexists(abs: string): Promise<boolean> {
		try {
			await fsp.lstat(abs);
			return true;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw e;
		}
	}

	/** The first 7 bytes are the magic and the version. A file that cannot be opened or read (held
	 *  by another program, too many handles) throws: the caller counts it as a per-file failure and
	 *  leaves it alone, since calling it plaintext would encrypt a .vlenc twice and skip it at the unlock. */
	private async hasMagic(abs: string): Promise<boolean> {
		const fh = await fsp.open(abs, "r");
		try {
			const buf = new Uint8Array(7);
			const { bytesRead } = await fh.read(buf, 0, 7, 0);
			if (bytesRead < 7 || buf[6] !== 0x01) return false;
			for (let i = 0; i < VLENC_MAGIC.length; i++) if (buf[i] !== VLENC_MAGIC.charCodeAt(i)) return false;
			return true;
		} finally {
			await fh.close();
		}
	}

	/** Namespaced absolute path (Windows long paths) for every Node fs call. */
	private abs(rel: string): string {
		const adapter = this.app.vault.adapter as FileSystemAdapter;
		if (typeof adapter.getFullPath !== "function") throw new Error("the vault is not on a local disk");
		return path.toNamespacedPath(adapter.getFullPath(rel));
	}

	private async cryptoKey(): Promise<CryptoKey> {
		const k = this.settings().vaultKey;
		if (!k) throw new Error("no vault key");
		if (!this.keyCache || this.keyCache.hex !== k.key) {
			const key = importVaultKey(k.key);
			this.keyCache = { hex: k.key, key };
			key.catch(() => { if (this.keyCache?.key === key) this.keyCache = null; });
		}
		return this.keyCache.key;
	}

	/**
	 * Close every tab showing a file under `prefix`, after saving what was typed in it. Closing
	 * alone saves too, but asynchronously, and the folder is renamed right after: that write
	 * would land on the old path and fail, taking the last seconds of typing with it.
	 */
	private async closeLeavesUnder(prefix: string): Promise<void> {
		const leaves: WorkspaceLeaf[] = [];
		this.app.workspace.iterateAllLeaves((leaf) => {
			const f = (leaf.view as unknown as { file?: TFile }).file;
			if (f && (f.path === prefix || f.path.startsWith(prefix + "/"))) leaves.push(leaf);
		});
		type Saver = { save?: () => Promise<void>; saving?: boolean };
		const views = leaves.map((l) => l.view as unknown as Saver);
		for (const v of views) {
			if (typeof v.save !== "function") continue;
			try { await v.save(); } catch (e) { console.error("[VLB] saving a private note before the lock failed", e); }
		}
		// save() returns at once when a save is already under way; give those a moment to finish.
		const deadline = Date.now() + 3000;
		while (views.some((v) => v.saving) && Date.now() < deadline) await sleep(50);
		for (const l of leaves) l.detach();
	}

	/**
	 * Windows only, best effort: set or clear the hidden attribute on the folder and, with
	 * filesToo, everything in it. Failure is harmless: Obsidian ignores the attribute either way.
	 */
	private async setWindowsHidden(rel: string, hidden: boolean, filesToo: boolean): Promise<void> {
		if (!Platform.isWin) return;
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) return;
		try {
			if (!(await adapter.exists(rel))) return;
			const abs = adapter.getFullPath(rel);
			const flag = hidden ? "+h" : "-h";
			await attrib([flag, abs]);
			if (filesToo) await attrib([flag, abs + "\\*", "/s", "/d"]);
		} catch (e) {
			console.warn("[VLB] attrib failed", e);
		}
	}
}

/** p is name, name/ or name/… */
function under(p: string, name: string): boolean {
	return !!name && (p === name || p.startsWith(name + "/"));
}

function parentOf(p: string): string {
	const i = p.lastIndexOf("/");
	return i < 0 ? "" : p.slice(0, i);
}

function same(a: Uint8Array, b: Uint8Array): boolean {
	if (a.byteLength !== b.byteLength) return false;
	return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
}

function msg(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/** p, or a rejection after ms: a job that hangs must not hold up the chain (and so a lock) for good. */
function bounded<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	let t: ReturnType<typeof setTimeout> | undefined;
	const limit = new Promise<never>((_, reject) => { t = setTimeout(() => reject(new Error(`${what}: not done in ${Math.round(ms / 1000)} s`)), ms); });
	return Promise.race([p, limit]).finally(() => clearTimeout(t));
}

/** Run Windows' attrib.exe without a console window. Never rejects. */
function attrib(args: string[]): Promise<void> {
	const { execFile } = require("child_process") as typeof import("child_process");
	const exe = (process.env.SystemRoot || "C:\\Windows") + "\\System32\\attrib.exe";
	return new Promise((resolve) => {
		execFile(exe, args, { timeout: 30_000, windowsHide: true }, (err) => {
			if (err) console.warn("[VLB] attrib " + args.join(" ") + " failed", err.message);
			resolve();
		});
	});
}
