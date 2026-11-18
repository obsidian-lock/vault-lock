import { Component } from "obsidian";
import type { App as ObsidianApp, PluginManifest } from "obsidian";
import css from "../../styles.css";
import { PRIVATE_RECHECK_MS } from "../shared/constants";
import { API, App, Host } from "../shared/contract";
import { PrivateFolder } from "../shared/privateFolder";
import type { VLBSettings } from "../shared/settings";
import { Backup } from "./backup";
import { LockScreen } from "./lock";
import { PassphraseModal } from "./passphrase";
import { renderSettings } from "./settingsTab";
import { maximizeOnce } from "./window";

/**
 * The app tier: lock screen, private folder, backup, pairing and the control channel. Built
 * into main.js (the built-in app) and on its own into app.js. The core starts it through
 * createApp() and stops it with stop(); everything it registers is registered on this
 * Component, so unloading it removes all of it.
 */

export { API };

export function createApp(host: Host): App {
	return new VaultLockApp(host);
}

export class VaultLockApp extends Component implements App {
	readonly api = API;
	readonly app: ObsidianApp;
	readonly manifest: PluginManifest;
	readonly privateFolder: PrivateFolder;
	readonly lockScreen: LockScreen;
	readonly backup: Backup;
	stopping = false;
	private stopped: Promise<void> | null = null;
	private lockedAtUnload = false;
	/** Obsidian's layout is ready: the vault is loaded, so the private folder may be made. */
	private layoutReady = false;
	/** A check of the private folder waits on its chain (one is enough). */
	private folderCheckQueued = false;
	/** The private folder's name at the last check: a name just changed in the settings waits for the next one. */
	private folderName: string;
	private folderTimer: number | null = null;

	constructor(readonly host: Host) {
		super();
		this.app = host.app;
		this.manifest = host.manifest;
		this.privateFolder = new PrivateFolder(host.app, () => host.settings);
		this.lockScreen = new LockScreen(this);
		this.backup = new Backup(this);
		this.folderName = this.privateFolderName();
	}

	get settings(): VLBSettings {
		return this.host.settings;
	}

	saveSettings(strict?: boolean): Promise<void> {
		return this.host.saveSettings(strict);
	}

	async start(): Promise<void> {
		// The same rules as styles.css, so an app.js from the server has its styles even when the file on disk is older.
		const style = document.head.createEl("style", { text: css });
		this.register(() => style.remove());
		// Obsidian opens maximized (once per window; never throws).
		maximizeOnce(() => this.stopping);

		// Test builds only (scripts/build-tests.mjs); "" in releases, so these lines are dead code.
		if (__VLB_FAULT__ === "throw-start") throw new Error("test fault: throw-start");
		if (__VLB_FAULT__ === "hang-start") await new Promise<void>(() => {});

		// Lock before the UI renders. lock() puts the lock screen up at once and resolves once the
		// private folder is renamed away (also when Obsidian crashed while unlocked and Private/
		// is still visible on disk); its encryption goes on in the background.
		if (this.lockScreen.hasPass && __VLB_FAULT__ !== "never-lock") await this.lockScreen.lock();
		if (this.stopping) return;
		this.lockScreen.install();
		// The private folder deleted or renamed away while unlocked comes back within seconds. The
		// events of the lock's own rename are no exception to make: the check finds the vault locked.
		const gone = (p: string) => {
			const name = this.privateFolderName();
			if (!name || fold(p) !== fold(name)) return;
			if (this.folderTimer !== null) window.clearTimeout(this.folderTimer);
			this.folderTimer = window.setTimeout(() => { this.folderTimer = null; this.ensurePrivateFolder(); }, PRIVATE_RECHECK_MS);
		};
		this.registerEvent(this.app.vault.on("delete", (f) => gone(f.path)));
		this.registerEvent(this.app.vault.on("rename", (_f, oldPath) => gone(oldPath)));
		this.register(() => { if (this.folderTimer !== null) window.clearTimeout(this.folderTimer); });

		this.app.workspace.onLayoutReady(() => {
			if (this.stopping) return;
			this.layoutReady = true;
			this.backup.start();
			// The private folder is there from the first start on, before a passphrase is chosen.
			this.ensurePrivateFolder();
			// First run: the passphrase is the one thing to set up. Asked again at every start until set.
			if (!this.lockScreen.hasPass) new PassphraseModal(this).open();
		});
	}

	/** The private folder always exists while unlocked (1.9.1). Asked once the layout is ready,
	 *  after an unlock and after a passphrase is saved, every 15 s (the idle check) and soon after
	 *  the folder was deleted or renamed away. Never while locked or unlocking, during a restore or
	 *  once stopping: the lock's rename makes the folder disappear, and a folder made then would
	 *  meet the hidden one coming back. The job runs on the private folder's chain and asks again
	 *  right before it makes the folder; this never waits and never throws. */
	ensurePrivateFolder(): void {
		if (!this.layoutReady || this.folderCheckQueued || this.privateFolderBusy()) return;
		const name = this.privateFolderName();
		// A name being typed in the settings: only a name seen at two checks in a row is made.
		if (name !== this.folderName) { this.folderName = name; return; }
		if (!name) return;
		this.folderCheckQueued = true;
		void this.privateFolder.ensureVisible(() => this.privateFolderBusy()).finally(() => { this.folderCheckQueued = false; });
	}

	private privateFolderBusy(): boolean {
		const ls = this.lockScreen;
		return this.stopping || ls.locked || ls.unlocking || this.backup.control.restoring > 0;
	}

	/** The configured name when it is a usable one, else "". */
	private privateFolderName(): string {
		try {
			return this.privateFolder.enabled ? this.privateFolder.name : "";
		} catch {
			return ""; // not a string in data.json
		}
	}

	stop(): Promise<void> {
		if (!this.stopped) this.stopped = this.finish();
		return this.stopped;
	}

	private async finish(): Promise<void> {
		this.stopping = true;
		// Side by side: the encryption pass stops at its next file whatever the network does, so the
		// core's stop bound can only ever cut off requests, never a half-written file.
		await Promise.allSettled([this.privateFolder.dispose(), this.backup.stop()]);
		this.lockScreen.destroy();
	}

	onunload(): void {
		// Obsidian unloads a plugin's children before calling the plugin's own onunload, so the
		// core asks locked() after this: remember it, for the cover the core leaves behind.
		this.lockedAtUnload = this.lockScreen.locked;
		void this.stop();
		this.lockScreen.destroy();
	}

	/** Not while an unlock decrypts: the core would switch apps in the middle of it. */
	locked(): boolean {
		return (this.lockScreen.locked && !this.lockScreen.unlocking) || this.lockedAtUnload;
	}

	lock(): Promise<void> {
		return this.lockScreen.lock();
	}

	finishLock(): Promise<void> {
		return this.privateFolder.finishLock();
	}

	changePassphrase(): void {
		new PassphraseModal(this).open();
	}

	renderSettings(el: HTMLElement): void {
		renderSettings(el, this.host, this);
	}
}

/** Names as NTFS and APFS compare them. */
function fold(n: string): string {
	return n.normalize("NFC").toLowerCase();
}
