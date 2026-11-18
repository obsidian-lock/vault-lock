import { Notice, Plugin, PluginSettingTab, setIcon } from "obsidian";
import type { App as ObsidianApp } from "obsidian";
import * as fs from "fs";
import * as path from "path";
import { QUIT_WAIT_MS, STOP_TIMEOUT_MS, UNLOAD_COVER_MS } from "../shared/constants";
import { withTimeout } from "../shared/dav";
import { DEFAULT_SETTINGS, DeferredRestore, VLBSettings } from "../shared/settings";
import { Supervisor } from "./supervisor";

/**
 * The core: the part of the plugin that rarely changes. It owns the settings (data.json and
 * its copy data.bak.json), the commands, the ribbon padlock, the setting tab and the
 * fail-closed cover (only while the private folder is visible), and runs one app (the built-in
 * one, or the lifeboat) through the contract in shared/contract.ts. The supervisor decides
 * which, and keeps the backup going.
 */

declare global {
	interface Window {
		/** Set by 1.6.x when it stops, and kept up to date here too, so a reload from or back
		 *  to 1.6.x also waits for the other copy's last backup run. */
		__vaultLockStopping?: Promise<void>;
	}
}

export default class VaultLockPlugin extends Plugin {
	settings!: VLBSettings;
	/** Public for tests: supervisor.current is the running app, supervisor.tick() runs a core tick. */
	supervisor: Supervisor = new Supervisor(this);
	/** The ribbon padlock; public for tests. */
	ribbon: HTMLElement | null = null;
	/** What the padlock shows: true = closed (a click unlocks). setRibbon() is its only writer. */
	uiLocked = true;
	private unloaded = false;

	get hasPass(): boolean {
		return !!this.settings?.passHash && !!this.settings?.passSalt;
	}

	/** The plugin folder on disk (core.json lives there); "" when the vault is not on a local disk. */
	get pluginDir(): string {
		const adapter = this.app.vault.adapter as { getBasePath?: () => string };
		const base = typeof adapter.getBasePath === "function" ? adapter.getBasePath() : "";
		if (!base) return "";
		return path.join(base, this.manifest.dir ?? this.app.vault.configDir + "/plugins/" + this.manifest.id);
	}

	/** The private folder is on disk under its visible name. Sync, so the cover can go up at
	 *  once; same name rules as shared/privateFolder.ts. False when the vault is not on a local disk. */
	privateVisible(): boolean {
		const n = (this.settings?.privateFolder ?? "").trim().replace(/^\/+|\/+$/g, "");
		if (!n || n.startsWith(".") || n.includes("/")) return false;
		const adapter = this.app.vault.adapter as { getBasePath?: () => string };
		const base = this.pluginDir && typeof adapter.getBasePath === "function" ? adapter.getBasePath() : "";
		if (!base) return false;
		try {
			return fs.existsSync(path.join(base, n));
		} catch {
			return true; // cannot tell: cover
		}
	}

	/** The padlock: closed while locked (click = unlock dialog), open while unlocked (click = lock). */
	setRibbon(locked: boolean): void {
		this.uiLocked = locked;
		const r = this.ribbon;
		if (!r) return;
		try {
			setIcon(r, locked ? "lock" : "lock-open");
			r.setAttribute("aria-label", locked ? "Unlock private folder" : "Lock private folder");
		} catch (e) {
			console.warn("[VLB] could not update the ribbon padlock", e);
		}
	}

	/** The ribbon click. Without a passphrase it asks for one. */
	private toggle(): void {
		const c = this.supervisor.current;
		if (!c) return;
		if (!this.hasPass) { c.changePassphrase(); return; }
		const p = this.uiLocked ? c.unlock() : c.lock();
		void Promise.resolve(p).catch((e) => console.error("[VLB] the padlock click failed", e));
	}

	async onload(): Promise<void> {
		await this.loadSettings();
		// Disabled again while it loaded: onunload has run, nothing here would ever be removed.
		if (this.unloaded) return;
		// A visible private folder shows nothing until an app has hidden it. A hidden one needs no
		// cover: the rest of the vault stays usable while the app starts.
		if (this.hasPass && this.privateVisible()) this.supervisor.cover.show();
		await this.previousCopy();
		if (this.unloaded) return;
		// The previous copy may have shown the folder while this one waited. A cover it left over a
		// hidden folder (1.9.x covered the window whenever it was locked) hides nothing: it goes now.
		if (this.hasPass && this.privateVisible()) this.supervisor.cover.show();
		else this.supervisor.cover.hide();
		this.supervisor.loadState();

		// Only the lock has commands. The backup runs by itself and is driven from the
		// server (_control/commands.json); it shows nothing on this computer.
		this.addCommand({ id: "lock", name: "Lock private folder", callback: () => void this.supervisor.current?.lock() });
		this.addCommand({ id: "unlock", name: "Unlock private folder", callback: () => void this.supervisor.current?.unlock() });
		this.addCommand({ id: "change-passphrase", name: "Set or change passphrase", callback: () => this.supervisor.current?.changePassphrase() });
		// The padlock in the left ribbon locks and unlocks. Its title stays fixed: Obsidian keys
		// the item by it (and lists it under that name); the tooltip follows the state.
		this.ribbon = this.addRibbonIcon("lock", "Vault Lock", () => this.toggle());
		this.setRibbon(this.hasPass);
		this.addSettingTab(new VLBSettingTab(this.app, this));
		// Obsidian closing or reloading the window is not a crash of the app that runs.
		this.registerDomEvent(window, "beforeunload", () => this.supervisor.cleanExit());
		// Closing Obsidian while unlocked used to leave the private folder visible on disk until
		// the next start (seen on Windows, 2026-11-14). Lock on the way out: Obsidian waits for
		// the task before it quits. The lock wins over an unlock under way; the encryption that
		// follows the rename is waited for up to QUIT_WAIT_MS (leftovers are finished at the next
		// start). A failed lock never holds up the quit.
		this.registerEvent(this.app.workspace.on("quit", (tasks) => {
			const current = this.supervisor.current;
			if (!this.hasPass || !current) return;
			tasks.add(async () => {
				try {
					await current.lock();
					await withTimeout(current.finishLock(), QUIT_WAIT_MS, "finishing the lock");
				} catch (e) {
					console.error("[VLB] locking at quit failed", e);
				}
			});
		}));

		await this.supervisor.startBest();
		if (this.unloaded) return;
		this.app.workspace.onLayoutReady(() => this.supervisor.startTicks());
	}

	/** Obsidian has already unloaded the app (children go first); its stop() is under way. */
	onunload(): void {
		this.unloaded = true;
		const S = this.supervisor;
		// A cover is left behind only when it, or the fallback overlay, was all that hid a visible
		// private folder. A hidden folder needs none; an unlocked one neither (disable = unlock).
		const expose = S.cover.shown || (this.hasPass && this.privateVisible() && S.lockedNow());
		const stopping = S.shutdown();
		window.__vaultLock = { ...window.__vaultLock, stopping };
		void stopping.finally(() => {
			if (window.__vaultLock?.stopping === stopping) delete window.__vaultLock.stopping;
		});
		const legacy = window.__vaultLockStopping;
		window.__vaultLockStopping = legacy ? Promise.all([legacy, stopping]).then(() => {}) : stopping;
		// A reload (a BRAT update) takes this cover over; a real disable shows the vault after a moment.
		if (expose) S.cover.leaveBehind(UNLOAD_COVER_MS);
		else S.cover.hide();
	}

	/** After a reload (a BRAT update) the copy before this one may still be finishing a
	 *  backup run: let it end first, so only one copy ever writes to the server. */
	private async previousCopy(): Promise<void> {
		const legacy = window.__vaultLockStopping;
		const waits = [window.__vaultLock?.stopping, legacy].filter((p): p is Promise<void> => !!p);
		if (waits.length === 0) return;
		try {
			await withTimeout(Promise.all(waits), STOP_TIMEOUT_MS + 5_000, "previous copy of the plugin");
		} catch {
			console.warn("[VLB] the previous copy of the plugin has not stopped; starting anyway");
		}
		if (legacy && window.__vaultLockStopping === legacy) delete window.__vaultLockStopping;
	}

	async loadSettings(): Promise<void> {
		const adapter = this.app.vault.adapter;
		let saved = await this.loadData();
		let restored = false;
		if (saved == null && (await adapter.exists(this.dataPath("data.json")))) {
			// data.json is there but unreadable (a power cut while Obsidian wrote it). Without
			// this, the vault would open unlocked and this computer would pair again as a new one.
			const aside = this.dataPath(`data.json.corrupt-${Date.now()}`);
			try { await adapter.rename(this.dataPath("data.json"), aside); } catch (e) { console.error("[VLB] could not move the damaged data.json aside", e); }
			saved = await this.readJson(this.dataPath("data.bak.json"));
			restored = saved != null;
			if (restored) console.error(`[VLB] data.json was damaged; settings restored from data.bak.json (the damaged file is kept as ${aside})`);
			else new Notice("Vault Lock: its settings file was damaged and there is no copy. Set the passphrase again.", 0);
		}
		saved = saved ?? {};
		delete saved.backupEnabled; // 1.0.0 had an on/off switch; backup now runs whenever a server is set
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
		this.settings.doneCommands = Array.isArray(saved.doneCommands) ? saved.doneCommands : [];
		this.settings.commandLog = saved.commandLog && typeof saved.commandLog === "object" ? saved.commandLog : {};
		// The vault key is used as it is on disk, or not at all.
		const vk: unknown = saved.vaultKey;
		this.settings.vaultKey = isObj(vk) && typeof vk.id === "string" && /^[a-f0-9]{16}$/.test(vk.id) && typeof vk.key === "string" && /^[a-f0-9]{64}$/.test(vk.key)
			? { id: vk.id, key: vk.key } : null;
		this.settings.encrypt = typeof saved.encrypt === "boolean" ? saved.encrypt : true;
		this.settings.restoreDeferred = Array.isArray(saved.restoreDeferred) ? (saved.restoreDeferred as unknown[]).filter(validDeferred) : [];
		this.settings.recoveryPaths = Array.isArray(saved.recoveryPaths) ? (saved.recoveryPaths as unknown[]).filter((p): p is string => typeof p === "string" && !!p) : [];
		if (restored) await this.saveSettings();
	}

	/** With strict, a failure to write the copy rejects too (the vault key counts as saved only
	 *  when both files hold it). */
	async saveSettings(strict = false): Promise<void> {
		await this.saveData(this.settings);
		// A second copy: Obsidian writes data.json in place, so a power cut mid-write would
		// otherwise lose the passphrase hash and this computer's server login.
		try {
			await this.app.vault.adapter.write(this.dataPath("data.bak.json"), JSON.stringify(this.settings));
		} catch (e) {
			console.error("[VLB] could not write data.bak.json", e);
			if (strict) throw e;
		}
	}

	private dataPath(name: string): string {
		return (this.manifest.dir ?? ".obsidian/plugins/vault-lock") + "/" + name;
	}

	private async readJson(file: string): Promise<Record<string, unknown> | null> {
		try {
			if (!(await this.app.vault.adapter.exists(file))) return null;
			const j: unknown = JSON.parse(await this.app.vault.adapter.read(file));
			return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
		} catch {
			return null;
		}
	}
}

function isObj(x: unknown): x is Record<string, unknown> {
	return !!x && typeof x === "object" && !Array.isArray(x);
}

function validDeferred(x: unknown): x is DeferredRestore {
	if (!isObj(x) || typeof x.id !== "string" || !x.id) return false;
	if (x.cmd !== "restore-all" && x.cmd !== "pull") return false;
	return x.paths === undefined || (Array.isArray(x.paths) && x.paths.every((p) => typeof p === "string"));
}

class VLBSettingTab extends PluginSettingTab {
	constructor(app: ObsidianApp, private plugin: VaultLockPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const current = this.plugin.supervisor.current;
		if (current) current.renderSettings(containerEl);
		else containerEl.createEl("p", { text: "Vault Lock is starting…" });
	}
}
