import { Component } from "obsidian";
import type { App as ObsidianApp, PluginManifest } from "obsidian";
import css from "../../styles.css";
import { API, App, Host } from "../shared/contract";
import { PrivateFolder } from "../shared/privateFolder";
import type { VLBSettings } from "../shared/settings";
import { Backup } from "./backup";
import { LockScreen } from "./lock";
import { PassphraseModal } from "./passphrase";
import { renderSettings } from "./settingsTab";

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

	constructor(readonly host: Host) {
		super();
		this.app = host.app;
		this.manifest = host.manifest;
		this.privateFolder = new PrivateFolder(host.app, () => host.settings);
		this.lockScreen = new LockScreen(this);
		this.backup = new Backup(this);
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

		// Test builds only (scripts/build-tests.mjs); "" in releases, so these lines are dead code.
		if (__VLB_FAULT__ === "throw-start") throw new Error("test fault: throw-start");
		if (__VLB_FAULT__ === "hang-start") await new Promise<void>(() => {});

		// Lock before the UI renders. lock() puts the lock screen up at once and resolves once the
		// private folder is renamed away (also when Obsidian crashed while unlocked and Private/
		// is still visible on disk); its encryption goes on in the background.
		if (this.lockScreen.hasPass && __VLB_FAULT__ !== "never-lock") await this.lockScreen.lock();
		if (this.stopping) return;
		this.lockScreen.install();

		this.app.workspace.onLayoutReady(() => {
			if (this.stopping) return;
			this.backup.start();
			// First run: the passphrase is the one thing to set up. Asked again at every start until set.
			if (!this.lockScreen.hasPass) new PassphraseModal(this).open();
		});
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
