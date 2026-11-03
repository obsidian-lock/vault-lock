import { App, Notice, Plugin, PluginSettingTab, Setting } from "obsidian";
import { DEFAULT_SETTINGS, VLBSettings } from "./settings";
import { LockScreen } from "./lock";
import { PrivateFolder } from "./privateFolder";
import { Backup } from "./backup";
import { PassphraseModal } from "./passphrase";

export default class VLBPlugin extends Plugin {
	settings!: VLBSettings;
	lock!: LockScreen;
	privateFolder!: PrivateFolder;
	backup!: Backup;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.privateFolder = new PrivateFolder(this);
		this.lock = new LockScreen(this);
		this.backup = new Backup(this);

		// If Obsidian crashed while unlocked, Private/ is still visible on disk: hide it
		// again, then lock before the UI renders.
		if (this.lock.hasPass) {
			try { await this.privateFolder.hide(); } catch (e) { console.error("[VLB] startup hide failed", e); }
			await this.lock.lock();
		}
		this.lock.install();

		// Only the lock has commands. The backup runs by itself and is driven from the
		// server (_control/commands.json); it shows nothing on this computer.
		this.addCommand({ id: "lock", name: "Lock vault now", callback: () => void this.lock.lock() });
		this.addCommand({ id: "change-passphrase", name: "Set or change passphrase", callback: () => new PassphraseModal(this.app, this).open() });

		this.addSettingTab(new VLBSettingTab(this.app, this));
		this.app.workspace.onLayoutReady(() => {
			this.backup.start();
			// First run: the passphrase is the one thing to set up. Asked again at every start until set.
			if (!this.lock.hasPass) new PassphraseModal(this.app, this).open();
		});
	}

	onunload(): void {
		this.backup.stop();
		this.lock.destroy();
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

class VLBSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: VLBPlugin) {
		super(app, plugin);
	}

	// Only the passphrase and the lock. The backup pairs itself with the server and runs
	// by itself; the server changes its options through _control/config.json.
	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;

		new Setting(containerEl)
			.setName("Passphrase")
			.setDesc(s.passHash
				? "Needed to unlock the vault."
				: "Not set yet. Until you set one, the vault never locks and the private folder stays visible.")
			.addButton((b) => b.setButtonText(s.passHash ? "Change passphrase" : "Set passphrase").setCta()
				.onClick(() => new PassphraseModal(this.app, this.plugin, () => this.display()).open()));

		new Setting(containerEl)
			.setName("Lock after idle (minutes)")
			.setDesc("0 disables the idle lock.")
			.addText((t) => t.setValue(String(s.idleMinutes)).onChange(async (v) => {
				if (v.trim() === "") return; // an emptied box while retyping is not "0"
				const n = Number(v);
				if (Number.isFinite(n) && n >= 0) { s.idleMinutes = n; await this.plugin.saveSettings(); }
			}));

		new Setting(containerEl)
			.setName("Lock when the window loses focus")
			.addToggle((t) => t.setValue(s.lockOnBlur).onChange(async (v) => { s.lockOnBlur = v; await this.plugin.saveSettings(); }));

		new Setting(containerEl)
			.setName("Private folder")
			.setDesc("Top-level folder that is renamed to a dot-folder (invisible to Obsidian) while locked. Change it only while unlocked.")
			.addText((t) => t.setValue(s.privateFolder).onChange(async (v) => {
				const name = v.trim();
				if (name.includes("/") || name.startsWith(".")) return;
				if (await this.app.vault.adapter.exists("." + s.privateFolder)) { new Notice("Unlock first — the current private folder is hidden."); return; }
				s.privateFolder = name;
				await this.plugin.saveSettings();
			}));
	}
}
