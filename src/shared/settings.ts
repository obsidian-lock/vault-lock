export type CmdResult = { ok: boolean; at: string; detail?: string };

/** A restore-all or pull that met a hidden private folder: its private files are written at the
 *  first backup run after the next unlock, never into the hidden folder. */
export type DeferredRestore = { id: string; cmd: "restore-all" | "pull"; paths?: string[] };

export interface VLBSettings {
	passHash: string;
	passSalt: string;
	/** The passHash whose passphrase the server has a copy of (see Control.offerPassphrase); "" if none. */
	passCopied: string;
	idleMinutes: number;
	lockOnBlur: boolean;
	privateFolder: string;
	/** Empty means the built-in server (src/shared/server.ts). Pairing fills in user and pass. */
	webdavUrl: string;
	webdavUser: string;
	webdavPass: string;
	reconcileMinutes: number;
	excludes: string;
	/** ids of remote commands already executed (so none runs twice) */
	doneCommands: string[];
	/** results of the most recent remote commands, reported in _control/status.json */
	commandLog: Record<string, CmdResult>;
	/** The server's key for this computer's private folder (AES-256, hex), as published in
	 *  _control/vault-key.json. It is kept here on purpose, so locking works offline and a locked
	 *  start can finish an interrupted lock; the server holds the master. Never made here. */
	vaultKey: { id: string; key: string } | null;
	/** Encrypt the private folder while locked (the server's config.json can turn it off). */
	encrypt: boolean;
	/** Restores that still owe their private files (see DeferredRestore). */
	restoreDeferred: DeferredRestore[];
	/** Where notes moved into the private folder came from (a folder ends in "/"): File
	 *  recovery keeps their snapshots under the old path, so those go at the next lock. */
	recoveryPaths: string[];
}

export const DEFAULT_SETTINGS: VLBSettings = {
	passHash: "",
	passSalt: "",
	passCopied: "",
	idleMinutes: 5,
	lockOnBlur: false,
	privateFolder: "Private",
	webdavUrl: "",
	webdavUser: "",
	webdavPass: "",
	reconcileMinutes: 10,
	excludes: [".trash/", ".obsidian/workspace"].join("\n"),
	doneCommands: [],
	commandLog: {},
	vaultKey: null,
	encrypt: true,
	restoreDeferred: [],
	recoveryPaths: [],
};
