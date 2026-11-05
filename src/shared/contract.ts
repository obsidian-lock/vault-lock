import type { App as ObsidianApp, Component, PluginManifest } from "obsidian";
import type { VLBSettings } from "./settings";

/**
 * The contract between the core (main.js, rarely changes) and the app tier (the lock, the
 * backup, the control channel). The core creates a Host for every app it starts; the app
 * reaches Obsidian and the settings only through it.
 */

/** Level of the createApp contract; an app.js with another value is not started. */
export const API = 1 as const;

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
	/** data.json and data.bak.json. */
	saveSettings(): Promise<void>;
	/** A reconcile just proved it can write to the server. */
	heartbeat(): void;
	/** Snapshot for the "core" section of status.json. */
	coreStatus(): CoreStatus;
	/** True once the core gave up on this app: make no more requests, write nothing. */
	isAborted(): boolean;
}

export interface App extends Component {
	readonly api: typeof API;
	/** Resolves once events are registered and, when a passphrase is set, the vault is locked
	 *  and the private folder hidden. Never waits on the network. Called once. */
	start(): Promise<void>;
	/** Stop timers, let the backup job in progress finish, save the index, remove overlays.
	 *  Same promise on every call. The caller bounds the wait. */
	stop(): Promise<void>;
	locked(): boolean;
	/** "Lock vault now" */
	lock(): Promise<void>;
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
