import type { App as ObsidianApp, Component, PluginManifest } from "obsidian";
import type { VLBSettings } from "./settings";

/**
 * The contract between the core (main.js, rarely changes) and the app tier (the lock, the
 * backup, the control channel). The core creates a Host for every app it starts; the app
 * reaches Obsidian and the settings only through it.
 */

/** Level of the createApp contract; an app.js with another value is not started. 2 since
 *  2.0.0: the lock hides the private folder, not the window (a 1.9.x app.js never runs here). */
export const API = 2 as const;

export type RunningInfo = { id: string; kind: "builtin" | "server" | "lifeboat"; version: string };

export interface Host {
	readonly api: typeof API;
	readonly app: ObsidianApp;
	/** id, version (the installed release), dir */
	readonly manifest: PluginManifest;
	/** One shared object; the core owns saving it. */
	readonly settings: VLBSettings;
	/** What this host was created for. */
	readonly running: RunningInfo;
	/** data.json and data.bak.json. With strict, a failure to write the copy rejects too (the
	 *  vault key is used only once both files hold it). */
	saveSettings(strict?: boolean): Promise<void>;
	/** A reconcile just proved it can write to the server. */
	heartbeat(): void;
	/** Snapshot for the "core" section of status.json. */
	coreStatus(): CoreStatus;
	/** True once the core gave up on this app: make no more requests, write nothing. */
	isAborted(): boolean;
	/** The lock state the user sees (locked: the padlock shows closed and unlocks on a click).
	 *  Only the app that runs or is starting is heard. */
	lockState(locked: boolean): void;
}

export interface App extends Component {
	readonly api: typeof API;
	/** Resolves once events are registered and, when a passphrase is set, nothing private is
	 *  exposed (the private folder hidden, or the fallback overlay up). Never waits on the
	 *  network. Called once. */
	start(): Promise<void>;
	/** Stop timers, let the backup job in progress finish, save the index, remove overlays.
	 *  Same promise on every call. The caller bounds the wait. */
	stop(): Promise<void>;
	/** True when nothing private is exposed: the folder is hidden, or there is no private
	 *  folder at all, or the fallback overlay is up. */
	locked(): boolean;
	/** "Lock private folder": resolves once it is hidden (or the fallback overlay is up). */
	lock(): Promise<void>;
	/** "Unlock private folder": opens the unlock dialog; resolves when it closes (unlocked or
	 *  dismissed). */
	unlock(): Promise<void>;
	/** Resolves once the private folder's background encryption after a lock is done (the quit
	 *  task waits for it). */
	finishLock(): Promise<void>;
	/** Opens the passphrase dialog (set or change). */
	changePassphrase(): void;
	/** Body of the setting tab; el is already empty. */
	renderSettings(el: HTMLElement): void;
}

/** Module shape of app.js and of core/builtin.ts. */
export interface AppModule { API: typeof API; createApp(host: Host): App }

export type CoreConfig = { safeMode: boolean; watchdogMinutes: number };

export type CoreStatus = {
	coreVersion: number;
	running: RunningInfo["kind"];
	runningId: string;
	runningVersion: string;
	startedAt: string;
	builtin: string;
	server: null | { version: string; sha12: string; force: boolean; minCore: number; state: string; why: string; at: string };
	pending: null | RunningInfo["kind"];
	bad: Record<string, { n: number; at: string; why: string }>;
	lastGood: null | { id: string; at: string };
	sick: null | { id: string; at: string };
	safeMode: boolean;
	watchdogMinutes: number;
	lastHeartbeat: string | null;
	lastUpdateCheck: string | null;
	updateError: string | null;
	coreInstalled: null | { version: string; sha12: string; at: string };
};
