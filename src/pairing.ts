import { requestUrl } from "obsidian";
import { withTimeout } from "./backup";
import bcrypt from "bcryptjs";
import * as os from "os";
import type VLBPlugin from "./main";
import type { Backup } from "./backup";
import { b64, randomHex } from "./crypto";
import { PAIR_DIR, PAIR_LOGIN, SERVER_URL } from "./server";

/**
 * Pairing: how this computer gets its own login on the backup server without anyone
 * typing a password.
 *
 * On first start the plugin makes up a login (`d-<16 hex>`) and a random key, and saves
 * them before sending anything. It then drops a small request into the server's pairing
 * inbox: its id, the computer's name, and a bcrypt hash of the key (the key itself never
 * leaves this computer). While pairing is open on the server, every request is accepted:
 * the login starts working and backups begin. The server gives every computer its own
 * folder, so no computer can see another's files.
 *
 * Every 15 seconds (every minute while the server isn't accepting computers) the plugin
 * tries its login; while that gets 401 it (re)sends the request. Only a 401 means "not
 * paired": if the server can't be reached, the backup takes over with its usual
 * retry-every-minute, and comes back here if it ever gets a 401.
 *
 * Nothing shows on this computer while pairing: `vlb status` on the server lists the
 * computer once it is paired.
 */

const ID_RE = /^d-[a-f0-9]{16}$/;
const WAIT_MS = 15_000;
const CLOSED_MS = 60_000;
const FIRST_CHECK_MS = 8_000;
const BCRYPT_ROUNDS = 6; // the key is 256 random bits; bcrypt cost adds nothing but server CPU

export class Pairing {
	private timer: number | null = null;
	private running = false;
	private sawUnpaired = false;
	private loggedClosed = false;

	constructor(private plugin: VLBPlugin, private backup: Backup) {}

	/** True for a login this plugin made itself (as opposed to one the setup script wrote). */
	static isDeviceLogin(user: string): boolean {
		return ID_RE.test(user);
	}

	/** Makes up this computer's login on first start. Saved before the first request, so restarts reuse it. */
	async ensureIdentity(): Promise<void> {
		const s = this.plugin.settings;
		if (s.webdavUser || s.webdavPass) return;
		s.webdavUser = "d-" + randomHex(8);
		s.webdavPass = randomHex(32);
		await this.plugin.saveSettings();
	}

	start(firstDelay = FIRST_CHECK_MS): void {
		if (this.running) return;
		this.running = true;
		this.schedule(firstDelay);
	}

	stop(): void {
		this.running = false;
		if (this.timer) window.clearTimeout(this.timer);
		this.timer = null;
	}

	private schedule(ms: number): void {
		if (this.timer) window.clearTimeout(this.timer);
		this.timer = window.setTimeout(() => void this.tick(), ms);
	}

	private async tick(): Promise<void> {
		this.timer = null;
		if (!this.running) return;
		let next = WAIT_MS;
		let probe = 0;
		try {
			probe = await this.backup.probe();
		} catch (e) {
			console.log("[VLB pairing] server unreachable:", e instanceof Error ? e.message : e);
		}
		if (probe !== 401 && (probe > 0 && probe < 300 || !this.sawUnpaired)) {
			// Paired, or the server is unreachable before we ever saw "not paired":
			// hand over to the backup, which retries on its own and calls us back on a 401.
			this.running = false;
			this.backup.onPaired(this.sawUnpaired && probe < 300);
			return;
		}
		try {
			if (probe !== 401) throw new Error(probe ? `HTTP ${probe}` : "server unreachable");
			this.sawUnpaired = true;
			const sent = await this.sendRequest();
			if (sent === 401) {
				// Pairing is paused on the server.
				next = CLOSED_MS;
				if (!this.loggedClosed) {
					this.loggedClosed = true;
					console.log("[VLB pairing] the server is not accepting new computers right now (vlb open resumes it); asking again every minute");
				}
			} else if (sent >= 300 && sent !== 403) {
				// 201: request delivered. 403: our request is already waiting in the inbox.
				throw new Error(`pairing request: HTTP ${sent}`);
			}
		} catch (e) {
			// Offline, or the server is restarting after accepting someone: just try again.
			console.log("[VLB pairing] will retry:", e instanceof Error ? e.message : e);
		}
		if (this.running) this.schedule(next);
	}

	private async sendRequest(): Promise<number> {
		const s = this.plugin.settings;
		const id = s.webdavUser.slice(2);
		const body = JSON.stringify({
			v: 1,
			id,
			hash: bcrypt.hashSync(s.webdavPass, BCRYPT_ROUNDS),
			name: computerName(),
			user: safe(() => os.userInfo().username),
			os: process.platform,
			plugin: this.plugin.manifest.version,
		});
		const r = await withTimeout(requestUrl({
			url: `${SERVER_URL}${PAIR_DIR}/${id}.json`,
			method: "PUT",
			headers: { Authorization: "Basic " + b64(PAIR_LOGIN.user + ":" + PAIR_LOGIN.pass), "Content-Type": "application/json" },
			body,
			throw: false,
		}), 30_000, "pairing request");
		return r.status;
	}
}

export function computerName(): string {
	return safe(() => os.hostname().split(".")[0]) || "computer"; // "Laptop.local" -> "Laptop"
}

function safe(f: () => string): string {
	try {
		return f();
	} catch {
		return "";
	}
}
