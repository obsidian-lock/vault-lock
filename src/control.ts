import type VLBPlugin from "./main";
import type { Backup, Entry } from "./backup";
import { CmdResult } from "./settings";
import { computerName } from "./pairing";

/**
 * VPS-side control, pull-based. Everything lives in the `_control/` folder on the
 * WebDAV server, next to the backup:
 *
 *   config.json    written by the server, read by the plugin every reconcile; server wins
 *   commands.json  [{ id, cmd, paths? }]  executed once each (ids are remembered)
 *   status.json    written by the plugin after every reconcile and on a failure:
 *                  version, health, last run, command results
 *
 * Nothing connects inbound to the laptop; the plugin polls over the same transport the
 * backup already uses, so if backups work, control works.
 */

export const CONTROL = "_control";
const CONFIG = `${CONTROL}/config.json`;
const COMMANDS = `${CONTROL}/commands.json`;
const STATUS = `${CONTROL}/status.json`;
const MAX_DONE = 300;
const MAX_LOG = 50;

type Command = { id: string; cmd: string; paths?: string[] };
/** `skipped`: over 100 MB. `failed`: "path: reason" for files that could not be backed up this time. */
export type ReconcileSummary = { at: string; reason: string; files: number; uploaded: number; trashed: number; skipped: string[]; failed: string[] };

export class Control {
	configError = "";
	/** The last reconcile that completed since Obsidian started; null until the first one. */
	lastReconcile: ReconcileSummary | null = null;

	constructor(private plugin: VLBPlugin, private backup: Backup) {}

	// ---- called by Backup -----------------------------------------------------

	async pull(): Promise<void> {
		await this.applyConfig();
		await this.runCommands();
	}

	/** `at` is when this was written; `lastError` is null while the backup is healthy. */
	async writeStatus(): Promise<void> {
		const s = this.plugin.settings;
		const body = {
			at: new Date().toISOString(),
			version: this.plugin.manifest.version,
			computer: computerName(),
			locked: this.plugin.lock.locked,
			lastReconcile: this.lastReconcile,
			lastError: this.backup.lastError || this.configError || null,
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
		const s = this.plugin.settings;
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
		if (changed) await this.plugin.saveSettings();
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
		const s = this.plugin.settings;
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
			await this.plugin.saveSettings();
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
				if (!this.plugin.lock.hasPass) throw new Error("no passphrase set");
				await this.plugin.lock.lock();
				return "locked";
			case "pull":
				return `${await this.pullPaths(c.paths ?? [])} files written`;
			case "restore-all":
				return await this.restoreAll();
			default:
				throw new Error("unknown command");
		}
	}

	// ---- server -> vault -------------------------------------------------------

	/** Write the server's copy of each path (file or folder) into the vault, unconditionally. */
	async pullPaths(paths: string[]): Promise<number> {
		await this.backup.loadManifest();
		const m = this.backup.manifest;
		let n = 0;
		for (const raw of paths) {
			if (typeof raw !== "string") continue;
			const p = raw.replace(/^\/+|\/+$/g, "");
			if (!p) continue;
			const keys = m[p] ? [p] : Object.keys(m).filter((k) => k.startsWith(p + "/"));
			if (keys.length === 0) throw new Error(`"${p}" is not in the server index`);
			for (const k of keys) if ((await this.writeFromServer(k, m[k], true)) === "written") n++;
		}
		return n;
	}

	/** Write every indexed file that is missing locally or older than the server copy. A note edited here since its last backup is kept. */
	async restoreAll(): Promise<string> {
		await this.backup.loadManifest();
		let written = 0, kept = 0;
		for (const [sp, e] of Object.entries(this.backup.manifest)) {
			const r = await this.writeFromServer(sp, e, false);
			if (r === "written") written++;
			else if (r === "kept") kept++;
		}
		return `${written} files written` + (kept ? `, ${kept} newer local files kept` : "");
	}

	private async writeFromServer(sp: string, e: Entry, force: boolean): Promise<"written" | "same" | "kept"> {
		const adapter = this.plugin.app.vault.adapter;
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
		const adapter = this.plugin.app.vault.adapter;
		let cur = "";
		for (const part of dir.split("/")) {
			cur = cur ? cur + "/" + part : part;
			if (!(await adapter.exists(cur))) await adapter.mkdir(cur);
		}
	}
}

function parentOf(p: string): string {
	const i = p.lastIndexOf("/");
	return i < 0 ? "" : p.slice(0, i);
}
