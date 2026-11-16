import { Component, Notice, Scope } from "obsidian";
import { MAX_BYTES, LIFEBOAT_FIRST_MS, LIFEBOAT_INTERVAL_MS } from "../shared/constants";
import { API, App, Host } from "../shared/contract";
import { computerName } from "../shared/computer";
import { hashPass, safeEqual } from "../shared/crypto";
import { authFor, dav, DavError, errMsg, withTimeout } from "../shared/dav";
import { PrivateFolder } from "../shared/privateFolder";
import { CONTROL, excluded, Index, LocalFile, MANIFEST, parentOf, scan } from "../shared/vaultfiles";

/**
 * The lifeboat: the core's own small app, for when no other app can run (both bad, or safe
 * mode ordered from the server). It locks the vault and keeps backing it up, nothing more:
 * every 10 minutes it uploads new and changed files and updates the index, in the same
 * format as the full backup. It never deletes, moves or trashes anything on the server, so
 * files removed here stay in the index until the full app takes over and trashes them.
 * No pairing, no commands, no config, no passphrase copy. Inline styles only.
 *
 * The private folder: hidden and encrypted while locked when data.json already holds the key
 * (the lifeboat never fetches one), hidden only otherwise; every unlock decrypts. Its backup
 * never lists the hidden folder, skips the visible one while it is hidden, and never uploads a
 * note that has an encrypted form beside it. The encryption switch reaches it through the
 * core's config poll.
 */

const IDLE_CHECK_MS = 15_000;
const FLUSH_EVERY_MS = 30_000;
const TITLE = "Obsidian";
const OVERLAY = "position:fixed;inset:0;z-index:100000;background:var(--background-primary, #1e1e1e);display:flex;align-items:center;justify-content:center;";
const BOX = "display:flex;flex-direction:column;gap:12px;min-width:260px;padding:24px;color:var(--text-normal, #dcddde);";
const INPUT = "padding:6px 8px;font-size:15px;";
const ERROR = "min-height:1.2em;color:var(--text-error, #e06c75);font-size:13px;";

export type LifeboatRun = { at: string; reason: string; files: number; uploaded: number; trashed: number; skipped: string[]; failed: string[] };

export function createLifeboat(host: Host): App {
	return new Lifeboat(host);
}

export class Lifeboat extends Component implements App {
	readonly api = API;
	readonly pf: PrivateFolder;
	/** Public for tests: what the last run did, and its error ("" when it went well). */
	lastRun: LifeboatRun | null = null;
	lastError = "";
	isLocked = false;
	/** An unlock is decrypting: the overlay stays up and isLocked stays true until the folder is back. */
	unlocking = false;
	lockRequested = false;
	private lockedAtUnload = false;
	private overlay: HTMLElement | null = null;
	private err: HTMLElement | null = null;
	private scope: Scope | null = null;
	private titleGuard: { saved: string; observer: MutationObserver | null } | null = null;
	private lastActivity = Date.now();
	private attempts = 0;
	private stopping = false;
	private stopped: Promise<void> | null = null;
	private inflight: Promise<void> | null = null;
	private unlockDone: Promise<void> | null = null;
	private rehide: Promise<void> | null = null;
	private firstTimer = 0;
	private index: Index = {};
	private dirty = false;
	private knownDirs = new Set<string>();

	constructor(readonly host: Host) {
		super();
		this.pf = new PrivateFolder(host.app, () => host.settings);
	}

	get hasPass(): boolean {
		return !!this.host.settings.passHash && !!this.host.settings.passSalt;
	}

	async start(): Promise<void> {
		if (this.hasPass) {
			this.lockNow();
			// Resolves after the rename; the encryption goes on in the background.
			try { await this.pf.hide(); } catch (e) { console.error("[VLB lifeboat] hiding the private folder failed", e); }
		}
		if (this.stopping) return;
		const touch = () => { this.lastActivity = Date.now(); };
		for (const ev of ["mousemove", "mousedown", "keydown", "wheel", "touchstart"] as const) {
			this.registerDomEvent(document, ev, touch, { capture: true, passive: true });
		}
		// While locked, no key reaches Obsidian except those typed into the unlock box.
		this.registerDomEvent(window, "keydown", (e: KeyboardEvent) => {
			if (!this.isLocked || (this.overlay && this.overlay.contains(e.target as Node))) return;
			e.stopImmediatePropagation();
			e.preventDefault();
		}, { capture: true });
		this.registerInterval(window.setInterval(() => this.checkIdle(), IDLE_CHECK_MS));
		this.registerDomEvent(window, "online", () => void this.run());
		this.firstTimer = window.setTimeout(() => void this.run(), LIFEBOAT_FIRST_MS);
		this.registerInterval(window.setInterval(() => void this.run(), LIFEBOAT_INTERVAL_MS));
		console.log("[VLB lifeboat] running: lock and a plain backup every 10 minutes");
	}

	stop(): Promise<void> {
		if (!this.stopped) this.stopped = this.finish();
		return this.stopped;
	}

	private async finish(): Promise<void> {
		this.stopping = true;
		window.clearTimeout(this.firstTimer);
		// The encryption pass stops at its next file whatever the network does.
		await Promise.allSettled([this.pf.dispose(), (async () => {
			try { await this.inflight; } catch { /* reported by run() */ }
			// A run that ended early may have uploaded files the index does not list yet.
			if (this.dirty && !this.host.isAborted()) {
				try { await this.flush(); } catch (e) { console.log("[VLB lifeboat] could not save the index while stopping:", errMsg(e)); }
			}
		})()]);
		this.removeOverlay(false);
		this.isLocked = false;
	}

	onunload(): void {
		// Obsidian unloads the children before the plugin's onunload: remember for the core's cover.
		this.lockedAtUnload = this.isLocked;
		void this.stop();
		this.removeOverlay(false);
	}

	locked(): boolean {
		return this.isLocked || this.lockedAtUnload;
	}

	/** A lock asked for during an unlock wins: the unlock stops before the folder comes back and re-hides. */
	async lock(): Promise<void> {
		if (this.stopping) return;
		if (!this.hasPass) { new Notice("Vault Lock: no passphrase is set."); return; }
		if (this.unlocking && this.unlockDone) {
			this.lockRequested = true;
			await this.unlockDone;
			await this.rehide;
			return;
		}
		this.lockNow();
		try { await this.pf.hide(); } catch (e) { console.error("[VLB lifeboat] hiding the private folder failed", e); }
	}

	finishLock(): Promise<void> {
		return this.pf.finishLock();
	}

	changePassphrase(): void {
		new Notice("Vault Lock is running in safe mode; the passphrase can be changed later.");
	}

	renderSettings(el: HTMLElement): void {
		el.createEl("p", { text: "Vault Lock is running its safe mode. The lock works; the other settings come back with the next update." });
	}

	// ---- lock screen -------------------------------------------------------------

	private checkIdle(): void {
		const m = this.host.settings.idleMinutes;
		if (!this.hasPass || this.isLocked || !(m > 0)) return;
		if (Date.now() - this.lastActivity >= m * 60_000) void this.lock();
	}

	private lockNow(): void {
		this.isLocked = true;
		if (!this.titleGuard) {
			const g = { saved: document.title === TITLE ? "" : document.title, observer: null as MutationObserver | null };
			try {
				g.observer = new MutationObserver(() => {
					if (document.title === TITLE) return;
					g.saved = document.title;
					document.title = TITLE;
				});
				g.observer.observe(document.head, { subtree: true, childList: true, characterData: true });
			} catch (e) { console.warn("[VLB lifeboat] no title guard", e); }
			this.titleGuard = g;
		}
		document.title = TITLE;
		// Settings opens in its own window, which the overlay does not cover.
		try { (this.host.app as unknown as { setting?: { close?: () => void } }).setting?.close?.(); } catch { /* not there */ }
		if (this.overlay) return;
		try { this.scope = new Scope(); this.host.app.keymap.pushScope(this.scope); } catch { this.scope = null; }

		const o = document.createElement("div");
		o.id = "vlb-lifeboat";
		o.setAttribute("style", OVERLAY);
		const box = document.createElement("div");
		box.setAttribute("style", BOX);
		const title = document.createElement("div");
		title.textContent = "Vault locked";
		title.setAttribute("style", "font-size:20px;font-weight:600;text-align:center;");
		const input = document.createElement("input");
		input.type = "password";
		input.placeholder = "Passphrase";
		input.setAttribute("style", INPUT);
		const err = document.createElement("div");
		err.setAttribute("style", ERROR);
		const btn = document.createElement("button");
		btn.textContent = "Unlock";
		box.appendChild(title);
		box.appendChild(input);
		box.appendChild(err);
		box.appendChild(btn);
		o.appendChild(box);
		document.body.appendChild(o);
		this.overlay = o;
		this.err = err;

		let pending = false;
		const submit = async () => {
			if (pending) return;
			pending = true;
			btn.disabled = true;
			err.textContent = "";
			const ok = await this.tryUnlock(input.value);
			if (!ok) err.textContent = "Wrong passphrase";
			// Still locked (wrong passphrase, or the folder could not be opened): the box is usable again.
			if (this.isLocked) { input.value = ""; input.focus(); }
			btn.disabled = false;
			pending = false;
		};
		input.addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Enter") void submit(); });
		btn.addEventListener("click", () => void submit());
		window.setTimeout(() => input.focus(), 30);
	}

	/** Public for tests. True for the right passphrase; the vault is unlocked only once the
	 *  private folder came back (a failed or cancelled show keeps the overlay and re-hides). */
	async tryUnlock(pass: string): Promise<boolean> {
		const s = this.host.settings;
		const h = await hashPass(pass, s.passSalt);
		if (!safeEqual(h, s.passHash)) {
			this.attempts++;
			await new Promise((r) => setTimeout(r, Math.min(5000, 500 * this.attempts)));
			return false;
		}
		if (this.stopping) return false;
		this.attempts = 0;
		this.unlocking = true;
		this.lockRequested = false;
		this.pf.progress = (t) => { if (this.err) this.err.textContent = t ?? ""; };
		let done = false;
		this.unlockDone = (async () => {
			try {
				await this.pf.show(() => this.stopping || this.lockRequested);
				done = !this.stopping && !this.lockRequested;
				if (!done && this.lockRequested && this.err) this.err.textContent = "Locked again.";
			} catch (e) {
				console.error("[VLB lifeboat] showing the private folder failed", e);
				if (this.err) this.err.textContent = `The private folder could not be opened: ${errMsg(e)}. Try again.`;
			}
			if (!done && !this.stopping) {
				this.rehide = this.pf.hide().catch((e) => console.error("[VLB lifeboat] hiding the private folder failed", e)).finally(() => { this.rehide = null; });
			}
		})();
		await this.unlockDone;
		this.unlockDone = null;
		this.pf.progress = null;
		this.unlocking = false;
		if (!done) return true; // stays locked; the error line says why
		this.isLocked = false;
		this.lastActivity = Date.now();
		this.removeOverlay(true);
		return true;
	}

	/** The title goes back only on unlock; when stopped, the core's cover or the next lock screen keeps it hidden. */
	private removeOverlay(restoreTitle: boolean): void {
		if (this.scope) { try { this.host.app.keymap.popScope(this.scope); } catch { /* gone */ } this.scope = null; }
		const g = this.titleGuard;
		this.titleGuard = null;
		g?.observer?.disconnect();
		this.overlay?.remove();
		this.overlay = null;
		this.err = null;
		if (restoreTitle && g?.saved) document.title = g.saved;
	}

	// ---- backup-lite ---------------------------------------------------------------

	/** One run at a time; a run already going is returned instead of starting another. */
	run(): Promise<void> {
		if (this.stopping) return Promise.resolve();
		if (!this.inflight) this.inflight = this.backup().finally(() => { this.inflight = null; });
		return this.inflight;
	}

	private async backup(): Promise<void> {
		const s = this.host.settings;
		if (!s.webdavUser) return; // not paired: the lifeboat does not pair
		try {
			const r = await this.dav("GET", MANIFEST);
			let index: Index = {};
			if (r.status !== 404) {
				try {
					const j: unknown = JSON.parse(r.text);
					if (j && typeof j === "object" && !Array.isArray(j)) index = j as Index;
				} catch { /* unreadable index: start a new one, as the full app does */ }
			}
			this.index = index;
			this.dirty = false;
			this.knownDirs.clear();
			const adapter = this.host.app.vault.adapter;
			const ownDir = this.host.manifest.dir ?? this.host.app.vault.configDir + "/plugins/" + this.host.manifest.id;
			const local = new Map<string, LocalFile>();
			// Never the hidden folder; not the visible one either while it is hidden (a lock mid-scan included).
			const hidden = this.pf.enabled && (await adapter.exists(this.pf.hiddenName));
			await scan(adapter, "", local, (p) => excluded(p, ownDir, s.excludes) || this.pf.isHiddenPath(p) || (hidden && this.pf.isPrivatePath(p)), (p) => this.pf.toVisible(p));

			let uploaded = 0;
			const skipped: string[] = [];
			const failed: string[] = [];
			const listed = new Map<string, string[]>(); // folder → names, one listing per run
			let lastFlush = Date.now();
			// Smallest first: a big file on a slow line never holds up the small ones.
			const todo = [...local].filter(([sp, info]) => {
				const cur = index[sp];
				return !(cur && cur.m === info.m && cur.s === info.s);
			}).sort((a, b) => a[1].s - b[1].s);
			for (const [sp, info] of todo) {
				if (this.stopping) break;
				if (info.s > MAX_BYTES) { skipped.push(sp); continue; }
				// A visible private note with x.vlenc, x.vlenc.tmp or an undecryptable copy beside it:
				// the readable server copy may be the only readable one.
				if (this.pf.isPrivateServerPath(sp) && (await this.encryptedFormBeside(sp, listed))) {
					failed.push(`${sp}: an encrypted or undecryptable copy exists beside it; not uploaded`);
					continue;
				}
				try {
					const bytes = await adapter.readBinary(info.path);
					await this.ensureDir(parentOf(sp));
					try {
						await this.dav("PUT", sp, bytes, { "Content-Type": "application/octet-stream" });
					} catch (e) {
						if (!(e instanceof DavError && e.status === 409)) throw e;
						// A folder we believed in is gone on the server: make them again, once.
						this.knownDirs.clear();
						await this.ensureDir(parentOf(sp));
						await this.dav("PUT", sp, bytes, { "Content-Type": "application/octet-stream" });
					}
					index[sp] = { m: info.m, s: info.s };
					this.dirty = true;
					uploaded++;
				} catch (e) {
					// The server or the login is the trouble: stop this run. Anything else is this one file.
					if (this.host.isAborted() || (e instanceof DavError && (e.status === 401 || e.status === 403 || e.status >= 500))) throw e;
					// No answer in time: the server gone, or only this file too big for the line?
					if (e instanceof DavError && e.status === 0 && !(await this.serverAnswers())) throw e;
					failed.push(`${sp}: ${errMsg(e)}`);
					console.error(`[VLB lifeboat] could not back up ${sp}:`, e);
				}
				if (this.dirty && Date.now() - lastFlush > FLUSH_EVERY_MS) { await this.flush(); lastFlush = Date.now(); }
			}
			await this.flush();
			if (this.stopping) return; // the next app reports
			this.lastRun = { at: new Date().toISOString(), reason: "lifeboat", files: local.size, uploaded, trashed: 0, skipped, failed };
			this.lastError = failed.length
				? `${failed.length} file(s) could not be backed up: ${failed.slice(0, 3).join("; ")}${failed.length > 3 ? "; …" : ""}`
				: "";
			await this.writeStatus();
			this.host.heartbeat();
			console.log(`[VLB lifeboat] backup: ${local.size} files, ${uploaded} uploaded` + (failed.length ? `, ${failed.length} failed` : ""));
		} catch (e) {
			if (this.host.isAborted()) return;
			this.lastError = errMsg(e);
			console.error("[VLB lifeboat] backup run failed; next one in 10 minutes:", e);
			try { await this.writeStatus(); } catch { /* the server cannot be reached */ }
		}
	}

	private async encryptedFormBeside(sp: string, listed: Map<string, string[]>): Promise<boolean> {
		const dir = parentOf(sp);
		let names = listed.get(dir);
		if (!names) {
			names = [];
			try {
				for (const f of (await this.host.app.vault.adapter.list(dir)).files) names.push(f.replace(/^\/+/, "").slice(dir ? dir.length + 1 : 0));
			} catch { /* no such folder */ }
			listed.set(dir, names);
		}
		const base = sp.slice(dir ? dir.length + 1 : 0);
		return names.some((n) => n === base + ".vlenc" || n === base + ".vlenc.tmp" || n.startsWith(base + ".undecryptable-"));
	}

	/** One cheap request (MKCOL _control: 405 when it is there) with a short limit. */
	private async serverAnswers(): Promise<boolean> {
		if (this.stopping || this.host.isAborted()) return false;
		try {
			await withTimeout(this.dav("MKCOL", CONTROL + "/"), 30_000, "MKCOL _control");
			return true;
		} catch {
			return false;
		}
	}

	private async flush(): Promise<void> {
		if (!this.dirty) return;
		await this.dav("PUT", MANIFEST, JSON.stringify(this.index), { "Content-Type": "application/json" });
		this.dirty = false;
	}

	private async writeStatus(): Promise<void> {
		const s = this.host.settings;
		const body = {
			at: new Date().toISOString(),
			version: this.host.manifest.version,
			computer: computerName(),
			locked: this.isLocked,
			lifeboat: true,
			lastReconcile: this.lastRun,
			lastError: this.lastError || null,
			passphraseCopied: !!s.passHash && s.passCopied === s.passHash,
			settings: null,
			commands: {},
			core: this.host.coreStatus(),
			// No control channel here: the key is "ok" when data.json holds one; a pending restore waits for the full app.
			encryption: { ...this.pf.stats(), keyState: s.vaultKey ? "ok" : "none", serverKeyId: null, restoreDeferred: s.restoreDeferred.map((d) => d.id) },
		};
		await this.ensureDir(CONTROL);
		await this.dav("PUT", `${CONTROL}/status.json`, JSON.stringify(body, null, 2), { "Content-Type": "application/json" });
	}

	private async ensureDir(dir: string): Promise<void> {
		if (!dir) return;
		let cur = "";
		for (const part of dir.split("/")) {
			cur = cur ? cur + "/" + part : part;
			if (this.knownDirs.has(cur)) continue;
			await this.dav("MKCOL", cur + "/"); // 405 = already there
			this.knownDirs.add(cur);
		}
	}

	/** Only GET, PUT and MKCOL are ever sent. Nothing once the core gave up on this lifeboat. */
	private dav(method: "GET" | "PUT" | "MKCOL", sp: string, body?: ArrayBuffer | string, headers: Record<string, string> = {}) {
		if (this.host.isAborted()) throw new DavError("stopped", 0);
		return dav(authFor(this.host.settings), method, sp, body, headers);
	}
}
