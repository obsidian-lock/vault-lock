import type { VaultLockApp } from "./app";
import type { Backup } from "./backup";
import { computerName } from "../shared/computer";
import { CmdResult } from "../shared/settings";
import { CONTROL, Entry, parentOf } from "../shared/vaultfiles";

/**
 * VPS-side control, pull-based. Everything lives in the `_control/` folder on the
 * WebDAV server, next to the backup:
 *
 *   config.json    written by the server, read by the plugin every reconcile; server wins
 *   commands.json  [{ id, cmd, paths? }]  executed once each (ids are remembered)
 *   status.json    written by the plugin after every reconcile and on a failure:
 *                  version, health, last run, command results
 *   passphrase.json written by the plugin once paired: a copy of the vault passphrase, for
 *                  the day it is forgotten (`vlb passphrase` shows it). Sent after the
 *                  passphrase is set, changed or typed to unlock; never kept on disk here.
 *
 * Nothing connects inbound to the laptop; the plugin polls over the same transport the
 * backup already uses, so if backups work, control works.
 */

const CONFIG = `${CONTROL}/config.json`;
const COMMANDS = `${CONTROL}/commands.json`;
const STATUS = `${CONTROL}/status.json`;
const PASSPHRASE = `${CONTROL}/passphrase.json`;
const MAX_DONE = 300;
const MAX_LOG = 50;

type Command = { id: string; cmd: string; paths?: string[] };
/** `skipped`: over 100 MB. `failed`: "path: reason" for files that could not be backed up this time. */
export type ReconcileSummary = { at: string; reason: string; files: number; uploaded: number; trashed: number; skipped: string[]; failed: string[] };

export class Control {
	configError = "";
	/** The last reconcile that completed since Obsidian started; null until the first one. */
	lastReconcile: ReconcileSummary | null = null;
	/** The passphrase as typed, held in memory only until the server has its copy. Never written to disk here. */
	private pendingPass: string | null = null;

	constructor(private owner: VaultLockApp, private backup: Backup) {}

	// ---- called by Backup -----------------------------------------------------

	async pull(): Promise<void> {
		await this.applyConfig();
		await this.runCommands();
		await this.sendPassphrase(); // a copy that could not be sent earlier (not paired yet, server unreachable)
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
		};
		await this.backup.ensureDir(CONTROL);
		await this.backup.dav("PUT", STATUS, JSON.stringify(body, null, 2), { "Content-Type": "application/json" });
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
		if (typeof cfg.idleMinutes === "number" && cfg.idleMinutes >= 0 && cfg.idleMinutes !== s.idleMinutes) { s.idleMinutes = cfg.idleMinutes; changed = true; }
		if (typeof cfg.lockOnBlur === "boolean" && cfg.lockOnBlur !== s.lockOnBlur) { s.lockOnBlur = cfg.lockOnBlur; changed = true; }
		if (typeof cfg.reconcileMinutes === "number" && cfg.reconcileMinutes >= 1 && cfg.reconcileMinutes !== s.reconcileMinutes) {
			s.reconcileMinutes = cfg.reconcileMinutes; changed = true; this.backup.scheduleInterval();
		}
		if (Array.isArray(cfg.excludes)) {
			const ex = cfg.excludes.filter((x): x is string => typeof x === "string").join("\n");
			if (ex !== s.excludes) { s.excludes = ex; changed = true; }
		}
		if (changed) await this.owner.saveSettings();
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
				return await this.pullPaths(c.paths ?? []);
			case "restore-all":
				return await this.restoreAll();
			default:
				throw new Error("unknown command");
		}
	}

	// ---- server -> vault -------------------------------------------------------

	/** Write the server's copy of each path (file or folder) into the vault, unconditionally. */
	async pullPaths(paths: string[]): Promise<string> {
		await this.backup.loadManifest();
		const m = this.backup.manifest;
		let n = 0, refused = 0;
		for (const raw of paths) {
			if (typeof raw !== "string") continue;
			const p = raw.replace(/^\/+|\/+$/g, "");
			if (!p) continue;
			const keys = m[p] ? [p] : Object.keys(m).filter((k) => k.startsWith(p + "/"));
			if (keys.length === 0) throw new Error(`"${p}" is not in the server index`);
			for (const k of keys) {
				const r = await this.writeFromServer(k, m[k], true);
				if (r === "written") n++;
				else if (r === "refused") refused++;
			}
		}
		return `${n} files written` + (refused ? `, ${refused} plugin files refused` : "");
	}

	/** Write every indexed file that is missing locally or older than the server copy. A note edited here since its last backup is kept. */
	async restoreAll(): Promise<string> {
		await this.backup.loadManifest();
		let written = 0, kept = 0, refused = 0;
		for (const [sp, e] of Object.entries(this.backup.manifest)) {
			if (!this.backup.enabled) throw new Error(`stopped (plugin reloaded or closed) after ${written} files; send restore-all again`);
			const r = await this.writeFromServer(sp, e, false);
			if (r === "written") written++;
			else if (r === "kept") kept++;
			else if (r === "refused") refused++;
		}
		return `${written} files written` + (kept ? `, ${kept} newer local files kept` : "") + (refused ? `, ${refused} plugin files refused` : "");
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

	private async writeFromServer(sp: string, e: Entry, force: boolean): Promise<"written" | "same" | "kept" | "refused"> {
		if (this.refused(sp)) {
			console.warn(`[VLB control] not written: ${sp} (plugin code is never taken from the server)`);
			return "refused";
		}
		const adapter = this.owner.app.vault.adapter;
		const local = await this.backup.toLocal(sp);
		const st = await adapter.stat(local);
		const haveLocal = !!st && st.type === "file";
		if (!force && haveLocal) {
			if (st.mtime === e.m && st.size === e.s) return "same";
			if (st.mtime > e.m) return "kept"; // changed on this computer after the last backup: the local note wins
		}

		const r = await this.backup.dav("GET", sp);
		if (r.status === 404) throw new Error(`${sp} missing on server`);
		if (r.arrayBuffer.byteLength !== e.s) throw new Error(`${sp}: the server copy is ${r.arrayBuffer.byteLength} bytes, the index says ${e.s}`);

		if (haveLocal) {
			// Never lose the local version: park it in the server trash before overwriting.
			const data = await adapter.readBinary(local);
			const dest = `_trash/${this.backup.stamp()}/${sp}`;
			await this.backup.ensureDir(parentOf(dest));
			await this.backup.dav("PUT", dest, data, { "Content-Type": "application/octet-stream" });
		}
		await this.mkdirs(parentOf(local));
		await adapter.writeBinary(local, r.arrayBuffer, { mtime: e.m });
		const st2 = await adapter.stat(local);
		this.backup.manifest[sp] = { m: st2?.mtime ?? e.m, s: st2?.size ?? e.s };
		this.backup.touchManifest();
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

/** Path parts the way Windows compares them: any case, trailing dots and spaces dropped. */
function canon(p: string): string[] {
	return p.split("/").map((s) => s.replace(/[. ]+$/, "").toLowerCase());
}
