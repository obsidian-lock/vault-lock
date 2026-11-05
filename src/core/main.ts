import { Notice, Plugin, PluginSettingTab } from "obsidian";
import type { App as ObsidianApp } from "obsidian";
import * as path from "path";
import { STOP_TIMEOUT_MS, UNLOAD_COVER_MS } from "../shared/constants";
import { withTimeout } from "../shared/dav";
import { DEFAULT_SETTINGS, VLBSettings } from "../shared/settings";
import { Supervisor } from "./supervisor";

/**
 * The core: the part of the plugin that rarely changes. It owns the settings (data.json and
 * its copy data.bak.json), the two commands, the setting tab and the fail-closed cover, and
 * runs one app (the built-in one, or the lifeboat) through the contract in
 * shared/contract.ts. The supervisor decides which, and keeps the backup going.
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

	async onload(): Promise<void> {
		await this.loadSettings();
		// Disabled again while it loaded: onunload has run, nothing here would ever be removed.
		if (this.unloaded) return;
		// Nothing of the vault shows until an app has locked it.
		if (this.hasPass) this.supervisor.cover.show();
		await this.previousCopy();
		if (this.unloaded) return;
		this.supervisor.loadState();

		// Only the lock has commands. The backup runs by itself and is driven from the
		// server (_control/commands.json); it shows nothing on this computer.
		this.addCommand({ id: "lock", name: "Lock vault now", callback: () => void this.supervisor.current?.lock() });
		this.addCommand({ id: "change-passphrase", name: "Set or change passphrase", callback: () => this.supervisor.current?.changePassphrase() });
		this.addSettingTab(new VLBSettingTab(this.app, this));
		// Obsidian closing or reloading the window is not a crash of the app that runs.
		this.registerDomEvent(window, "beforeunload", () => this.supervisor.cleanExit());

		await this.supervisor.startBest();
		if (this.unloaded) return;
		this.app.workspace.onLayoutReady(() => this.supervisor.startTicks());
	}

	/** Obsidian has already unloaded the app (children go first); its stop() is under way. */
	onunload(): void {
		this.unloaded = true;
		const S = this.supervisor;
		const wasLocked = S.lockedNow() || S.cover.shown;
		const stopping = S.shutdown();
		window.__vaultLock = { ...window.__vaultLock, stopping };
		void stopping.finally(() => {
			if (window.__vaultLock?.stopping === stopping) delete window.__vaultLock.stopping;
		});
		const legacy = window.__vaultLockStopping;
		window.__vaultLockStopping = legacy ? Promise.all([legacy, stopping]).then(() => {}) : stopping;
		// A reload (a BRAT update) takes this cover over; a real disable shows the vault after a moment.
		if (wasLocked) S.cover.leaveBehind(UNLOAD_COVER_MS);
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
		if (restored) await this.saveSettings();
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		// A second copy: Obsidian writes data.json in place, so a power cut mid-write would
		// otherwise lose the passphrase hash and this computer's server login.
		try {
			await this.app.vault.adapter.write(this.dataPath("data.bak.json"), JSON.stringify(this.settings));
		} catch (e) {
			console.error("[VLB] could not write data.bak.json", e);
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
