export type CmdResult = { ok: boolean; at: string; detail?: string };

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
};
