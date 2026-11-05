import { Notice, Plugin, PluginSettingTab } from "obsidian";
import type { App as ObsidianApp, PluginManifest } from "obsidian";
import { API, App, CoreStatus, Host, RunningInfo } from "../shared/contract";
import { CORE_VERSION, STOP_TIMEOUT_MS, UNLOAD_COVER_MS, WATCHDOG_DEFAULT_MIN } from "../shared/constants";
import { withTimeout } from "../shared/dav";
import { DEFAULT_SETTINGS, VLBSettings } from "../shared/settings";
import { createBuiltinApp } from "./builtin";
import { Cover } from "./cover";

/**
 * The core: the part of the plugin that rarely changes. It owns the settings (data.json and
 * its copy data.bak.json), the two commands, the setting tab and the fail-closed cover, and
 * runs the app tier (lock screen, private folder, backup, control channel) through the
 * contract in shared/contract.ts. For now it always runs the app built into main.js.
 */

const RETRY_START_MS = 60_000;

declare global {
	interface Window {
		/** Set by 1.6.x when it stops, and kept up to date here too, so a reload from or back
		 *  to 1.6.x also waits for the other copy's last backup run. */
		__vaultLockStopping?: Promise<void>;
	}
}

/** The app that runs now, and what it is. */
export type Running = { current: App | null; running: RunningInfo | null };

export default class VaultLockPlugin extends Plugin {
	settings!: VLBSettings;
	/** Public for tests: supervisor.current is the running app (lockScreen, backup, privateFolder). */
	supervisor: Running = { current: null, running: null };
	lastHeartbeat = 0;
	private host: HostImpl | null = null;
	private cover = new Cover();
	private startedAt = 0;
	private retryTimer = 0;
	private unloaded = false;

	get hasPass(): boolean {
		return !!this.settings.passHash && !!this.settings.passSalt;
	}

	async onload(): Promise<void> {
		await this.loadSettings();
		// Disabled again while it loaded: onunload has run, nothing here would ever be removed.
		if (this.unloaded) return;
		// Nothing of the vault shows until an app has locked it.
		if (this.hasPass) this.cover.show();
		await this.previousCopy();
		if (this.unloaded) return;

		// Only the lock has commands. The backup runs by itself and is driven from the
		// server (_control/commands.json); it shows nothing on this computer.
		this.addCommand({ id: "lock", name: "Lock vault now", callback: () => void this.supervisor.current?.lock() });
		this.addCommand({ id: "change-passphrase", name: "Set or change passphrase", callback: () => this.supervisor.current?.changePassphrase() });
		this.addSettingTab(new VLBSettingTab(this.app, this));

		await this.startApp();
	}

	/** Obsidian has already unloaded the app (children go first); its stop() is under way. */
	onunload(): void {
		this.unloaded = true;
		window.clearTimeout(this.retryTimer);
		const wasLocked = (this.supervisor.current?.locked() ?? false) || this.cover.shown;
		const stopping = this.shutdown();
		window.__vaultLock = { ...window.__vaultLock, stopping };
		void stopping.finally(() => {
			if (window.__vaultLock?.stopping === stopping) delete window.__vaultLock.stopping;
		});
		const legacy = window.__vaultLockStopping;
		window.__vaultLockStopping = legacy ? Promise.all([legacy, stopping]).then(() => {}) : stopping;
		// A reload (a BRAT update) takes this cover over; a real disable shows the vault after a moment.
		if (wasLocked) this.cover.leaveBehind(UNLOAD_COVER_MS);
		else this.cover.hide();
	}

	/** Starts the app built into main.js. The cover comes down only once it has locked the vault. */
	private async startApp(): Promise<void> {
		if (this.unloaded) return;
		const version = this.manifest.version;
		const running: RunningInfo = { id: "builtin:" + version, kind: "builtin", version };
		const host = new HostImpl(this, running);
		let app: App | null = null;
		try {
			app = createBuiltinApp(host);
			this.addChild(app);
			await app.start();
			if (this.unloaded) throw new Error("the plugin was unloaded while the app was starting");
		} catch (e) {
			// Fail closed: the cover stays up.
			console.error("[VLB] the app did not start; trying again in a minute", e);
			if (app) {
				try { await withTimeout(app.stop(), STOP_TIMEOUT_MS, "stopping the app"); } catch { /* aborted below */ }
				this.removeChild(app);
			}
			host.abort();
			if (!this.unloaded) this.retryTimer = window.setTimeout(() => void this.startApp(), RETRY_START_MS);
			return;
		}
		this.supervisor.current = app;
		this.supervisor.running = running;
		this.host = host;
		this.startedAt = this.lastHeartbeat = Date.now();
		// Fail closed: with a passphrase, the cover comes down only over a locked vault.
		if (this.hasPass && !app.locked()) console.error("[VLB] the app started without locking the vault; the cover stays up");
		else this.cover.hide();
	}

	/** Never rejects. Resolves when the app has finished its last backup run, or after 30 s;
	 *  after that it may make no more requests, so the next copy is the only one writing. */
	private async shutdown(): Promise<void> {
		const c = this.supervisor.current;
		const host = this.host;
		this.supervisor.current = null;
		this.supervisor.running = null;
		this.host = null;
		if (!c) return;
		try {
			await withTimeout(c.stop(), STOP_TIMEOUT_MS, "stopping the app");
		} catch (e) {
			console.warn("[VLB] the app had not stopped 30 s after it was asked to:", e);
		} finally {
			host?.abort();
		}
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

	coreStatus(): CoreStatus {
		const r = this.supervisor.running;
		const iso = (t: number) => (t ? new Date(t).toISOString() : null);
		return {
			coreVersion: CORE_VERSION,
			running: r?.kind ?? "builtin",
			runningId: r?.id ?? "",
			runningVersion: r?.version ?? "",
			startedAt: iso(this.startedAt) ?? "",
			builtin: this.manifest.version,
			server: null,
			pending: null,
			bad: {},
			lastGood: null,
			sick: null,
			safeMode: false,
			watchdogMinutes: WATCHDOG_DEFAULT_MIN,
			lastHeartbeat: iso(this.lastHeartbeat),
			lastUpdateCheck: null,
			updateError: null,
			coreInstalled: null,
		};
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

	private async readJson(path: string): Promise<Record<string, unknown> | null> {
		try {
			if (!(await this.app.vault.adapter.exists(path))) return null;
			const j: unknown = JSON.parse(await this.app.vault.adapter.read(path));
			return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
		} catch {
			return null;
		}
	}
}

/** What one app gets from the core. abort() is final: the app then makes no more requests. */
class HostImpl implements Host {
	readonly api = API;
	private aborted = false;

	constructor(private plugin: VaultLockPlugin, readonly running: RunningInfo) {}

	get app(): ObsidianApp {
		return this.plugin.app;
	}
	get manifest(): PluginManifest {
		return this.plugin.manifest;
	}
	/** The very object the core saves: the app changes it in place. */
	get settings(): VLBSettings {
		return this.plugin.settings;
	}
	saveSettings(): Promise<void> {
		return this.plugin.saveSettings();
	}
	heartbeat(): void {
		this.plugin.lastHeartbeat = Date.now();
	}
	coreStatus(): CoreStatus {
		return this.plugin.coreStatus();
	}
	isAborted(): boolean {
		return this.aborted;
	}
	abort(): void {
		this.aborted = true;
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
