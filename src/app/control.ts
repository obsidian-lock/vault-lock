import type { VaultLockApp } from "./app";
import type { Backup } from "./backup";
import { computerName } from "../shared/computer";
import { DavError, errMsg } from "../shared/dav";
import { CmdResult, DeferredRestore } from "../shared/settings";
import { CONTROL, Entry, parentOf } from "../shared/vaultfiles";

/**
 * VPS-side control, pull-based. Everything lives in the `_control/` folder on the
 * WebDAV server, next to the backup:
 *
 *   config.json    written by the server, read by the plugin every reconcile; server wins
 *                  (its "core" key is for the core and ignored here; "encrypt" turns the
 *                  private folder's encryption on or off)
 *   commands.json  [{ id, cmd, paths? }]  executed once each (ids are remembered)
 *   status.json    written by the plugin after every reconcile and on a failure:
 *                  version, health, last run, command results, encryption
 *   passphrase.json written by the plugin once paired: a copy of the vault passphrase, for
 *                  the day it is forgotten (`vlb passphrase` shows it). Sent after the
 *                  passphrase is set, changed or typed to unlock; never kept on disk here.
 *   vault-key.json written by the server: the key for this computer's private folder. Read
 *                  once, saved in data.json and data.bak.json, never replaced (a different
 *                  key later is reported as a mismatch).
 *
 * Nothing connects inbound to the laptop; the plugin polls over the same transport the
 * backup already uses, so if backups work, control works.
 *
 * A restore (restore-all, pull) that meets the hidden private folder never writes into it:
 * its private files are remembered in settings.restoreDeferred (saved before the command is
 * marked done) and written at the first reconcile after the next unlock, with the same rules
 * as the command itself. Until then the backup leaves everything under the private folder
 * alone, so an older local note can never be uploaded over the newer server copy. The deferred
 * run clears its record after one complete pass: a file of its own that cannot be restored (a
 * stale index key, a server copy that changed, a name this disk refuses) is listed in the
 * command's result, while server or login trouble leaves the record for the next run.
 */

const CONFIG = `${CONTROL}/config.json`;
const COMMANDS = `${CONTROL}/commands.json`;
const STATUS = `${CONTROL}/status.json`;
const PASSPHRASE = `${CONTROL}/passphrase.json`;
const VAULT_KEY = `${CONTROL}/vault-key.json`;
const MAX_DONE = 300;
const MAX_LOG = 50;

type Command = { id: string; cmd: string; paths?: string[] };
type Written = "written" | "same" | "kept" | "refused" | "deferred";
/** `skipped`: over 100 MB. `failed`: "path: reason" for files that could not be backed up this time. */
export type ReconcileSummary = { at: string; reason: string; files: number; uploaded: number; trashed: number; skipped: string[]; failed: string[] };

export class Control {
	configError = "";
	/** A restore (pull, restore-all or the deferred one) is writing into the vault: the app makes no private folder meanwhile. */
	restoring = 0;
	/** The last reconcile that completed since Obsidian started; null until the first one. */
	lastReconcile: ReconcileSummary | null = null;
	/** What the last look at vault-key.json found. "unsaved": the key arrived but data.json or data.bak.json could not be written. */
	keyState: "ok" | "none" | "mismatch" | "invalid" | "unsaved" = "none";
	serverKeyId: string | null = null;
	/** The passphrase as typed, held in memory only until the server has its copy. Never written to disk here. */
	private pendingPass: string | null = null;
	private mismatchLogged = false;

	constructor(private owner: VaultLockApp, private backup: Backup) {}

	// ---- called by Backup -----------------------------------------------------

	async pull(): Promise<void> {
		await this.applyConfig();
		// The core's tick applies the same switch (it writes the very setting applyConfig compares
		// with), so the edge above can be missed: whatever a hide-only pass left is encrypted now.
		if (this.owner.privateFolder.leftPlain()) this.owner.privateFolder.requestEncrypt();
		await this.runCommands();
		await this.sendPassphrase(); // a copy that could not be sent earlier (not paired yet, server unreachable)
		await this.fetchVaultKey(); // last: the three above never wait on it
	}

	/** `at` is when this was written; `lastError` is null while the backup is healthy. */
	async writeStatus(): Promise<void> {
		const s = this.owner.settings;
		const body = {
			at: new Date().toISOString(),
			version: this.owner.manifest.version,
			computer: computerName(),
			locked: this.owner.lockScreen.locked,
			lastReconcile: this.lastReconcile,
			lastError: this.backup.lastError || this.configError || null,
			configError: this.configError || null,
			passphraseCopied: !!s.passHash && s.passCopied === s.passHash,
			settings: { idleMinutes: s.idleMinutes, lockOnBlur: s.lockOnBlur, reconcileMinutes: s.reconcileMinutes, excludes: s.excludes.split("\n").filter(Boolean), privateFolder: s.privateFolder },
			commands: s.commandLog,
			core: this.coreStatus(),
			encryption: { ...this.owner.privateFolder.stats(), keyState: this.keyState, serverKeyId: this.serverKeyId, restoreDeferred: s.restoreDeferred.map((d) => d.id) },
		};
		await this.backup.ensureDir(CONTROL);
		await this.backup.dav("PUT", STATUS, JSON.stringify(body, null, 2), { "Content-Type": "application/json" });
	}

	/** Which app the core runs, and its health (vlb status prints it). Never stops a status report. */
	private coreStatus(): unknown {
		try {
			return this.owner.host.coreStatus();
		} catch (e) {
			console.warn("[VLB control] no core status:", e);
			return null;
		}
	}

	// ---- config ----------------------------------------------------------------

	private async applyConfig(): Promise<void> {
		const r = await this.backup.dav("GET", CONFIG);
		this.configError = "";
		if (r.status === 404) return;
		let cfg: Record<string, unknown>;
		try {
			cfg = JSON.parse(r.text);
		} catch {
			this.configError = "config.json is not valid JSON; ignored";
			return;
		}
		if (!cfg || typeof cfg !== "object") return;
		const s = this.owner.settings;
		let changed = false;
		let turnedOn = false;
		if (typeof cfg.idleMinutes === "number" && cfg.idleMinutes >= 0 && cfg.idleMinutes !== s.idleMinutes) { s.idleMinutes = cfg.idleMinutes; changed = true; }
		if (typeof cfg.lockOnBlur === "boolean" && cfg.lockOnBlur !== s.lockOnBlur) { s.lockOnBlur = cfg.lockOnBlur; changed = true; }
		if (typeof cfg.reconcileMinutes === "number" && cfg.reconcileMinutes >= 1 && cfg.reconcileMinutes !== s.reconcileMinutes) {
			s.reconcileMinutes = cfg.reconcileMinutes; changed = true; this.backup.scheduleInterval();
		}
		if (Array.isArray(cfg.excludes)) {
			const ex = cfg.excludes.filter((x): x is string => typeof x === "string").join("\n");
			if (ex !== s.excludes) { s.excludes = ex; changed = true; }
		}
		// A missing key leaves the setting as it is (on by default).
		if (typeof cfg.encrypt === "boolean" && cfg.encrypt !== s.encrypt) { s.encrypt = cfg.encrypt; changed = true; turnedOn = cfg.encrypt; }
		if (changed) await this.owner.saveSettings();
		// A hidden folder is encrypted now, not at the next lock.
		if (turnedOn) this.owner.privateFolder.requestEncrypt();
	}

	// ---- the vault key -----------------------------------------------------------

	/** The server's key for this computer, applied once: saved in both settings files before
	 *  anything is encrypted with it; a different key published later is reported, never taken. */
	private async fetchVaultKey(): Promise<void> {
		const s = this.owner.settings;
		const pf = this.owner.privateFolder;
		const r = await this.backup.dav("GET", VAULT_KEY);
		if (r.status === 404) { this.keyState = s.vaultKey ? "ok" : "none"; return; }
		let k: { v?: unknown; id?: unknown; key?: unknown } | null = null;
		try { k = JSON.parse(r.text); } catch { /* invalid */ }
		if (!k || typeof k !== "object" || k.v !== 1 || typeof k.id !== "string" || !/^[a-f0-9]{16}$/.test(k.id) || typeof k.key !== "string" || !/^[a-f0-9]{64}$/.test(k.key)) {
			this.keyState = "invalid";
			return;
		}
		const id = k.id, key = k.key;
		if (!s.vaultKey) {
			pf.keyDurable = false;
			s.vaultKey = { id, key }; // in memory only until both files hold it: nothing encrypts meanwhile
			try {
				await this.owner.host.saveSettings(true);
			} catch (e) {
				s.vaultKey = null;
				this.keyState = "unsaved";
				throw e; // nothing was encrypted; the next reconcile tries again
			}
			pf.keyDurable = true;
			this.keyState = "ok";
			this.serverKeyId = null;
			console.log(`[VLB control] vault key received (id ${id})`);
			pf.requestEncrypt();
			return;
		}
		if (s.vaultKey.id !== id || s.vaultKey.key !== key) {
			this.keyState = "mismatch";
			this.serverKeyId = id;
			if (!this.mismatchLogged) {
				this.mismatchLogged = true;
				console.error(`[VLB control] the server publishes vault key ${id}; this computer keeps its own (${s.vaultKey.id})`);
			}
		} else {
			this.keyState = "ok";
			this.serverKeyId = null;
		}
	}

	// ---- passphrase copy -------------------------------------------------------

	/** Called with the passphrase as typed (set, changed, or used to unlock). Sends the server
	 *  a copy unless it has this passphrase already; until that succeeds (not paired yet, or
	 *  the server is unreachable) it stays in memory and every reconcile tries again. */
	offerPassphrase(pass: string): void {
		const s = this.owner.settings;
		if (s.passCopied === s.passHash) { this.pendingPass = null; return; }
		this.pendingPass = pass;
		void this.sendPassphrase();
	}

	private async sendPassphrase(): Promise<void> {
		const pass = this.pendingPass;
		if (!pass || !this.backup.enabled) return;
		const s = this.owner.settings;
		const hash = s.passHash;
		try {
			await this.backup.ensureDir(CONTROL);
			const body = { passphrase: pass, at: new Date().toISOString(), computer: computerName() };
			await this.backup.dav("PUT", PASSPHRASE, JSON.stringify(body, null, 2), { "Content-Type": "application/json" });
			s.passCopied = hash;
			await this.owner.saveSettings();
			if (this.pendingPass === pass) this.pendingPass = null;
		} catch (e) {
			console.error("[VLB control] passphrase copy not sent yet; tried again at the next reconcile or unlock", e);
		}
	}

	// ---- commands --------------------------------------------------------------

	private async runCommands(): Promise<void> {
		const r = await this.backup.dav("GET", COMMANDS);
		if (r.status === 404) return;
		let list: unknown;
		try {
			list = JSON.parse(r.text);
		} catch {
			this.configError = "commands.json is not valid JSON; ignored";
			return;
		}
		if (!Array.isArray(list)) return;
		const s = this.owner.settings;
		const done = new Set(s.doneCommands);
		for (const c of list as Command[]) {
			if (!c || typeof c.id !== "string" || typeof c.cmd !== "string" || done.has(c.id)) continue;
			let res: CmdResult;
			try {
				res = { ok: true, at: new Date().toISOString(), detail: await this.exec(c) };
			} catch (e) {
				res = { ok: false, at: new Date().toISOString(), detail: e instanceof Error ? e.message : String(e) };
			}
			done.add(c.id);
			// Ids no longer in the file are forgotten, so the cap can never make an old command run again.
			s.doneCommands = Array.from(done).filter((id) => (list as Command[]).some((x) => x && x.id === id)).slice(-MAX_DONE);
			s.commandLog[c.id] = res;
			for (const k of Object.keys(s.commandLog).slice(0, -MAX_LOG)) delete s.commandLog[k];
			// Also saves a restoreDeferred record the command left: the two reach disk together.
			await this.owner.saveSettings();
			console.log(`[VLB control] ${c.cmd} (${c.id}): ${res.ok ? "ok" : "FAILED"} ${res.detail ?? ""}`);
		}
	}

	private async exec(c: Command): Promise<string> {
		switch (c.cmd) {
			case "reconcile":
				return "ran"; // commands run at the start of a reconcile, which then proceeds
			case "reset-index":
				this.backup.clearIndex();
				return "index cleared; full re-upload follows";
			case "lock":
				if (!this.owner.lockScreen.hasPass) throw new Error("no passphrase set");
				await this.owner.lockScreen.lock();
				return "locked";
			case "pull":
				return await this.pullPaths(c.paths ?? [], c.id);
			case "restore-all":
				return await this.restoreAll(c.id);
			default:
				throw new Error("unknown command");
		}
	}

	// ---- server -> vault -------------------------------------------------------

	/** Write the server's copy of each path (file or folder) into the vault, unconditionally. */
	async pullPaths(paths: string[], id = ""): Promise<string> {
		await this.backup.loadManifest();
		const m = this.backup.manifest;
		const n = { written: 0, refused: 0, deferred: 0 };
		const clean = paths.filter((p): p is string => typeof p === "string").map((p) => p.replace(/^\/+|\/+$/g, "")).filter(Boolean);
		this.wrotePrivate = false;
		this.restoring++;
		try {
			for (const p of clean) {
				const keys = m[p] ? [p] : Object.keys(m).filter((k) => k.startsWith(p + "/"));
				if (keys.length === 0) throw new Error(`"${p}" is not in the server index`);
				for (const k of keys) this.tally(n, await this.writeFromServer(k, m[k], true), { id, cmd: "pull", paths: clean });
			}
		} finally {
			this.restoring--;
			await this.hideIfLocked();
		}
		return `${n.written} files written` + (n.refused ? `, ${n.refused} plugin files refused` : "") + deferredNote(n.deferred);
	}

	/** Write every indexed file that is missing locally or older than the server copy. A note edited here since its last backup is kept. */
	async restoreAll(id = ""): Promise<string> {
		await this.backup.loadManifest();
		const n = { written: 0, kept: 0, refused: 0, deferred: 0 };
		this.wrotePrivate = false;
		this.restoring++;
		try {
			for (const [sp, e] of Object.entries(this.backup.manifest)) {
				if (!this.backup.enabled) throw new Error(`stopped (plugin reloaded or closed) after ${n.written} files; send restore-all again`);
				this.tally(n, await this.writeFromServer(sp, e, false), { id, cmd: "restore-all" });
			}
		} finally {
			this.restoring--;
			await this.hideIfLocked();
		}
		return `${n.written} files written` + (n.kept ? `, ${n.kept} newer local files kept` : "") + (n.refused ? `, ${n.refused} plugin files refused` : "") + deferredNote(n.deferred);
	}

	/** Counts one result; the first deferred private file records the command in the settings
	 *  (idempotent on id), so a throw later in the loop still leaves the record for runCommands' save. */
	private tally(n: { written: number; kept?: number; refused: number; deferred: number }, r: Written, d: DeferredRestore): void {
		if (r === "written") n.written++;
		else if (r === "kept") n.kept = (n.kept ?? 0) + 1;
		else if (r === "refused") n.refused++;
		else if (r === "deferred") {
			n.deferred++;
			const s = this.owner.settings;
			if (d.id && !s.restoreDeferred.some((x) => x.id === d.id)) s.restoreDeferred.push(d);
		}
	}

	/** A restore wrote private files visible while the window is locked (no hidden folder before
	 *  the restore, or a lock that landed during it): hide and encrypt them now. hide() merges a
	 *  visible folder into the hidden one when both exist. A rename that fails is retried by the
	 *  lock screen every HIDE_RETRY_MS and never fails the command: its files were written. */
	private async hideIfLocked(): Promise<void> {
		const wrote = this.wrotePrivate;
		this.wrotePrivate = false;
		if (!wrote || !this.owner.privateFolder.enabled || !this.owner.lockScreen.locked) return;
		await this.owner.lockScreen.ensureHidden();
	}

	/** Set by writeFromServer when a private file was written visible; read by hideIfLocked. */
	private wrotePrivate = false;

	/** The private files a restore-all or pull left for after the unlock: written at the first
	 *  reconcile that finds the folder visible, with the command's own rules. Server or login
	 *  trouble (a throw) leaves the record in place (tried again next run) and the gate stays
	 *  closed meanwhile; one file's own trouble is listed and the others go on, so a record never
	 *  outlives one complete pass (the gate would otherwise stay shut for good). */
	async runDeferredRestore(): Promise<void> {
		const s = this.owner.settings;
		const pf = this.owner.privateFolder;
		if (!s.restoreDeferred.length || !pf.enabled) return;
		if (await this.owner.app.vault.adapter.exists(pf.hiddenName)) return; // still locked: wait
		this.wrotePrivate = false;
		this.restoring++;
		try {
			for (const d of s.restoreDeferred.slice()) {
				await this.backup.loadManifest();
				const m = this.backup.manifest;
				let keys = Object.keys(m).filter((k) => pf.isPrivateServerPath(k));
				if (d.cmd === "pull") keys = keys.filter((k) => (d.paths ?? []).some((p) => k === p || k.startsWith(p + "/")));
				const n = { written: 0, kept: 0, refused: 0, deferred: 0 };
				const failed: string[] = [];
				for (const k of keys) {
					try {
						this.tally(n, await this.writeFromServer(k, m[k], d.cmd === "pull"), d);
					} catch (e) {
						if (!perFile(e)) throw e;
						failed.push(`${k}: ${errMsg(e)}`);
					}
				}
				if (n.deferred) { console.log(`[VLB control] deferred ${d.cmd} (${d.id}): locked again meanwhile; the rest waits for the next unlock`); break; }
				s.restoreDeferred = s.restoreDeferred.filter((x) => x !== d);
				const note = `; deferred private files: ${n.written} written, ${n.kept} newer local kept` + (failed.length ? `, ${failed.length} not restored: ${failed.join("; ")}` : "");
				const log = s.commandLog[d.id];
				if (log) log.detail = (log.detail ?? "") + note;
				await this.owner.saveSettings();
				console.log(`[VLB control] deferred ${d.cmd} (${d.id})` + note);
				if (failed.length) {
					this.configError = `deferred ${d.cmd} (${d.id}): ${failed.length} private file(s) not restored: ${failed.slice(0, 3).join("; ")}`;
					console.warn("[VLB control] " + this.configError);
				}
			}
		} finally {
			this.restoring--;
			// A lock that landed during the run: what was written visible is hidden again.
			await this.hideIfLocked();
		}
	}

	/** Plugin code never comes from the server: inside the plugins folder only data.json files
	 *  are written, and nothing in this plugin's own folder. Paths are compared as Windows reads them. */
	private refused(sp: string): boolean {
		if (/[\\:]/.test(sp)) return true;
		const parts = canon(sp);
		if (parts.some((p) => !p)) return true; // "", ".", "..": could point anywhere
		// A Windows short name (".obsidian" -> "OBSIDI~1") opens the same folder: count it as a match.
		const under = (dir: string) => canon(dir).every((p, i) => parts[i] === p || /~\d/.test(parts[i] ?? ""));
		const plugins = this.owner.app.vault.configDir + "/plugins";
		if (under(this.owner.manifest.dir ?? plugins + "/vault-lock")) return true;
		return under(plugins) && parts[parts.length - 1] !== "data.json";
	}

	private async writeFromServer(sp: string, e: Entry, force: boolean): Promise<Written> {
		if (this.refused(sp)) {
			console.warn(`[VLB control] not written: ${sp} (plugin code is never taken from the server)`);
			return "refused";
		}
		const adapter = this.owner.app.vault.adapter;
		const pf = this.owner.privateFolder;
		const isPrivate = pf.isPrivateServerPath(sp);
		// Never into the hidden folder: it waits for the first reconcile after the unlock. While
		// the folder is not hidden, the local path is the server path.
		if (isPrivate && (await adapter.exists(pf.hiddenName))) return "deferred";
		const local = sp;
		const st = await adapter.stat(local);
		const haveLocal = !!st && st.type === "file";
		if (!force && haveLocal) {
			if (st.mtime === e.m && st.size === e.s) return "same";
			if (st.mtime > e.m) return "kept"; // changed on this computer after the last backup: the local note wins
		}

		const r = await this.backup.dav("GET", sp);
		if (r.status === 404) throw new RestoreFileError(`${sp} missing on server`);
		if (r.arrayBuffer.byteLength !== e.s) throw new RestoreFileError(`${sp}: the server copy is ${r.arrayBuffer.byteLength} bytes, the index says ${e.s}`);

		if (haveLocal) {
			// Never lose the local version: park it in the server trash before overwriting.
			let data: ArrayBuffer;
			try {
				data = await adapter.readBinary(local);
			} catch (err) {
				throw new RestoreFileError(`${sp}: the local copy cannot be read: ${errMsg(err)}`);
			}
			const dest = `_trash/${this.backup.stamp()}/${sp}`;
			await this.backup.ensureDir(parentOf(dest));
			await this.backup.dav("PUT", dest, data, { "Content-Type": "application/octet-stream" });
		}
		// A lock may have landed since the check above (the GET and the park take time): never a
		// readable copy beside the hidden folder, let alone inside it.
		if (isPrivate && (await adapter.exists(pf.hiddenName))) return "deferred";
		try {
			await this.mkdirs(parentOf(local));
			await adapter.writeBinary(local, r.arrayBuffer, { mtime: e.m });
		} catch (err) {
			throw new RestoreFileError(`${sp}: cannot be written here: ${errMsg(err)}`);
		}
		const st2 = await adapter.stat(local);
		this.backup.manifest[sp] = { m: st2?.mtime ?? e.m, s: st2?.size ?? e.s };
		this.backup.touchManifest();
		if (isPrivate) this.wrotePrivate = true;
		return "written";
	}

	private async mkdirs(dir: string): Promise<void> {
		if (!dir) return;
		const adapter = this.owner.app.vault.adapter;
		let cur = "";
		for (const part of dir.split("/")) {
			cur = cur ? cur + "/" + part : part;
			if (!(await adapter.exists(cur))) await adapter.mkdir(cur);
		}
	}
}

function deferredNote(n: number): string {
	return n ? `, ${n} private files deferred (locked): they are restored at the first backup run after the next unlock` : "";
}

/** One file of a restore that cannot be written: gone from the server, a server copy that is not
 *  what the index says, a local copy that cannot be read or a name this disk refuses. */
class RestoreFileError extends Error {}

/** True when the trouble is with one file, not with the server or the login (the deferred run then goes on with the others). */
function perFile(e: unknown): boolean {
	if (e instanceof RestoreFileError) return true;
	return e instanceof DavError && e.status >= 400 && e.status < 500 && e.status !== 401 && e.status !== 403;
}

/** Path parts the way Windows compares them: any case, trailing dots and spaces dropped. */
function canon(p: string): string[] {
	return p.split("/").map((s) => s.replace(/[. ]+$/, "").toLowerCase());
}
