import { Component, TFolder } from "obsidian";
import type { App as ObsidianApp, PluginManifest, TAbstractFile } from "obsidian";
import css from "../../styles.css";
import { API, App, Host } from "../shared/contract";
import { PrivateFolder } from "../shared/privateFolder";
import type { VLBSettings } from "../shared/settings";
import { Backup } from "./backup";
import { deleteFileRecoveryRows } from "./fileRecovery";
import { LockScreen } from "./lock";
import { PassphraseModal } from "./passphrase";
import { renderSettings } from "./settingsTab";

/**
 * The app tier: the private folder's lock, backup, pairing and the control channel. Built
 * into main.js (the built-in app) and on its own into app.js. The core starts it through
 * createApp() and stops it with stop(); everything it registers is registered on this
 * Component, so unloading it removes all of it.
 */

export { API };

export function createApp(host: Host): App {
	return new VaultLockApp(host);
}

/** Old paths remembered for File recovery's clean-up, at most. */
const MAX_RECOVERY_PATHS = 200;
const SAVE_LATER_MS = 500;

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
	/** The last File recovery clean-up, for status.json: null until the first one. */
	fileRecovery: { at: string; deleted: number } | "unavailable" | null = null;
	private cleaning: Promise<void> | null = null;
	/** A pending save of recoveryPaths (a folder move brings one rename event per note). */
	private saveTimer: number | null = null;

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

		// Lock before Obsidian lists the vault. lock() resolves once the private folder is renamed
		// away (also when Obsidian crashed while unlocked and Private/ is still visible on disk), or
		// once the fallback overlay is up when that rename fails; the encryption goes on in the background.
		if (this.lockScreen.hasPass && __VLB_FAULT__ !== "never-lock") await this.lockScreen.lock();
		if (this.stopping) return;
		this.lockScreen.install();
		void this.cleanFileRecovery();
		this.registerEvent(this.app.vault.on("rename", (f, old) => this.noteMoved(f, old)));

		this.app.workspace.onLayoutReady(() => {
			if (this.stopping) return;
			// The lock above ran before the layout: tabs of private notes it brought back go now.
			if (this.lockScreen.locked) void this.privateFolder.closePrivateLeaves().catch((e) => console.error("[VLB] closing private tabs failed", e));
			this.backup.start();
			// First run: the passphrase is the one thing to set up. Asked again at every start until set.
			if (!this.lockScreen.hasPass) new PassphraseModal(this).open();
		});
		// The padlock: closed when locked (a passphrase is set), open otherwise.
		try {
			this.host.lockState(this.lockScreen.locked);
		} catch (e) {
			console.warn("[VLB] padlock not updated", e);
		}
	}

	/** Deletes File recovery's snapshots of private notes (both names) while the folder is locked.
	 *  One at a time; never rejects. */
	cleanFileRecovery(): Promise<void> {
		if (!this.cleaning) {
			this.cleaning = this.cleanNow()
				.catch((e) => console.error("[VLB] File recovery clean-up failed", e))
				.finally(() => { this.cleaning = null; });
		}
		return this.cleaning;
	}

	/** Both names of the folder (and the disk's spelling, when it differs), plus the old paths of
	 *  notes moved into it since the last clean-up. */
	private async cleanNow(): Promise<void> {
		const pf = this.privateFolder;
		if (!pf.enabled || !this.lockScreen.locked || this.stopping) return;
		const s = this.settings;
		const keys = [pf.name + "/", pf.hiddenName + "/"];
		if (pf.lastVisibleName && pf.lastVisibleName !== pf.name) keys.push(pf.lastVisibleName + "/");
		const moved = (s.recoveryPaths ?? []).slice();
		const deleted = await deleteFileRecoveryRows(this.app, [...keys, ...moved]);
		if (deleted === null) {
			if (this.fileRecovery !== "unavailable") console.warn("[VLB] File recovery's store was not found; snapshots of private notes were not deleted");
			this.fileRecovery = "unavailable";
			return;
		}
		this.fileRecovery = { at: new Date().toISOString(), deleted };
		if (deleted) console.log(`[VLB] deleted ${deleted} File recovery snapshot(s) of private notes`);
		if (moved.length) {
			// A move that came in meanwhile keeps its entry for the next lock.
			s.recoveryPaths = (s.recoveryPaths ?? []).filter((p) => !moved.includes(p));
			await this.saveSettings();
		}
	}

	/** A note or folder moved into the private folder from outside: File recovery keeps its
	 *  snapshots under the old path, readable while locked. The old path is remembered (saved,
	 *  so a restart still knows) and its snapshots go at the next lock, with the folder's. */
	noteMoved(f: TAbstractFile, oldPath: string): void {
		const pf = this.privateFolder;
		if (!pf.enabled || !pf.isPrivatePath(f.path) || pf.isPrivatePath(oldPath) || !oldPath) return;
		const key = f instanceof TFolder ? oldPath + "/" : oldPath;
		const s = this.settings;
		const list = s.recoveryPaths ?? [];
		// Once each; a folder's entry covers the notes in it (Obsidian reports every one of them).
		if (list.some((k) => k === key || (k.endsWith("/") && key.startsWith(k)))) return;
		const kept = key.endsWith("/") ? list.filter((k) => !k.startsWith(key)) : list;
		kept.push(key);
		while (kept.length > MAX_RECOVERY_PATHS) kept.shift();
		s.recoveryPaths = kept;
		if (this.saveTimer === null) {
			this.saveTimer = window.setTimeout(() => {
				this.saveTimer = null;
				void this.saveSettings().catch((e) => console.error("[VLB] could not save the settings", e));
			}, SAVE_LATER_MS);
		}
	}

	stop(): Promise<void> {
		if (!this.stopped) this.stopped = this.finish();
		return this.stopped;
	}

	private async finish(): Promise<void> {
		this.stopping = true;
		// The unlock dialog goes now, not after the waits below (F10: a passphrase typed meanwhile
		// would be answered "stopping").
		this.lockScreen.release();
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
			try { await this.saveSettings(); } catch (e) { console.error("[VLB] could not save the settings", e); }
		}
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

	/** Nothing private is exposed (the folder hidden, none at all, or the fallback up); never
	 *  while an unlock decrypts: the core would switch apps in the middle of it. */
	locked(): boolean {
		return this.lockScreen.nothingExposed() || this.lockedAtUnload;
	}

	lock(): Promise<void> {
		return this.lockScreen.lock();
	}

	unlock(): Promise<void> {
		return this.lockScreen.unlock();
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
