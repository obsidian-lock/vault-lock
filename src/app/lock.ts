import { Notice, Scope } from "obsidian";
import type { VaultLockApp } from "./app";
import { HIDE_RETRY_MS } from "../shared/constants";
import { hashPass, safeEqual } from "../shared/crypto";
import { errMsg } from "../shared/dav";

const IDLE_CHECK_MS = 15_000;
const LOCKED_TITLE = "Obsidian";

export class LockScreen {
	locked = false;
	/** An unlock is decrypting the private folder: the overlay stays up and `locked` stays true until it is back. */
	unlocking = false;
	/** A lock asked for during an unlock: the unlock stops before the folder comes back. */
	lockRequested = false;
	private overlay: HTMLElement | null = null;
	private err: HTMLElement | null = null;
	private scope: Scope | null = null;
	private lastActivity = Date.now();
	/** The lock in progress, if any. */
	private inflight: Promise<void> | null = null;
	/** The show() in progress, awaited by a lock() that arrives meanwhile. */
	private unlockDone: Promise<void> | null = null;
	private hideTimer: number | null = null;
	private failedAttempts = 0;
	/** One title guard per window (main window and pop-outs) while locked. */
	private titleGuards = new Map<Document, { saved: string; observer: MutationObserver }>();
	private watched = new WeakSet<Window>();

	constructor(private owner: VaultLockApp) {}

	get hasPass(): boolean {
		return !!this.owner.settings.passHash && !!this.owner.settings.passSalt;
	}

	install(): void {
		this.watchWindow(window);
		this.owner.app.workspace.iterateAllLeaves((leaf) => this.watchWindow(leaf.view.containerEl.win));
		this.owner.registerInterval(window.setInterval(() => this.checkIdle(), IDLE_CHECK_MS));
		// Pop-out windows: their activity counts, and ones opened while locked get their title hidden too.
		this.owner.registerEvent(this.owner.app.workspace.on("window-open", (_ww, win) => {
			this.watchWindow(win);
			if (this.locked) this.guardTitle(win.document);
		}));
	}

	/** Activity, focus loss and the key swallow, per window: a pop-out is its own window whose events never reach the main one. */
	private watchWindow(win: Window): void {
		if (this.watched.has(win)) return;
		this.watched.add(win);
		const touch = () => { this.lastActivity = Date.now(); };
		for (const ev of ["mousemove", "mousedown", "keydown", "wheel", "touchstart"] as const) {
			this.owner.registerDomEvent(win.document, ev, touch, { passive: true, capture: true });
		}
		this.owner.registerDomEvent(win, "blur", () => {
			if (!this.owner.settings.lockOnBlur) return;
			// Moving between Obsidian's own windows is not leaving Obsidian: look again in a moment.
			win.setTimeout(() => { if (!this.anyWindowFocused()) void this.lock(); }, 150);
		});
		// Belt and braces: while locked, swallow every key that isn't typed into the unlock box.
		this.owner.registerDomEvent(win, "keydown", (e: KeyboardEvent) => {
			if (!this.locked) return;
			if (this.overlay && this.overlay.contains(e.target as Node)) return;
			e.stopImmediatePropagation();
			e.preventDefault();
		}, { capture: true });
	}

	private anyWindowFocused(): boolean {
		let focused = document.hasFocus();
		this.owner.app.workspace.iterateAllLeaves((leaf) => { if (leaf.view.containerEl.doc.hasFocus()) focused = true; });
		return focused;
	}

	private checkIdle(): void {
		const m = this.owner.settings.idleMinutes;
		if (!this.hasPass || this.locked || m <= 0) return;
		if (Date.now() - this.lastActivity >= m * 60_000) void this.lock();
	}

	/** Resolves once the private folder is hidden (its encryption goes on in the background). A
	 *  lock already under way (a blur or idle lock just before Obsidian quits) returns that same
	 *  lock, so the quit waits for its hide. A lock asked for during an unlock wins: the unlock
	 *  stops before the folder comes back and re-hides what it decrypted; this resolves with that. */
	lock(): Promise<void> {
		// A stopped app never locks again (a blur timer can fire after stop): its lock screen would never go away.
		if (this.owner.stopping) return Promise.resolve();
		if (!this.hasPass) { new Notice("Vault Lock: set a passphrase in settings first."); return Promise.resolve(); }
		if (this.unlocking && this.unlockDone) {
			this.lockRequested = true;
			// tryUnlock stores its re-hide in `inflight` before unlockDone resolves.
			return this.unlockDone.then(() => this.inflight ?? Promise.resolve());
		}
		if (this.inflight) return this.inflight;
		if (this.locked) return Promise.resolve();
		this.inflight = this.lockNow().finally(() => { this.inflight = null; });
		return this.inflight;
	}

	private async lockNow(): Promise<void> {
		this.locked = true;
		this.showOverlay();
		try {
			await this.owner.privateFolder.hide();
		} catch (e) {
			console.error("[VLB] lock failed", e);
			this.hideRetry();
		}
	}

	/** The folder could not be renamed (a file held open): try again every HIDE_RETRY_MS while locked. */
	private hideRetry(): void {
		if (this.hideTimer) return;
		this.hideTimer = window.setTimeout(() => {
			this.hideTimer = null;
			if (!this.locked || this.unlocking || this.owner.stopping) return;
			this.owner.privateFolder.hide().catch((e) => {
				console.error("[VLB] lock failed", e);
				this.hideRetry();
			});
		}, HIDE_RETRY_MS);
	}

	/** True for the right passphrase. The vault is unlocked only when the private folder came
	 *  back: a failed or cancelled show() keeps the lock screen up (with the reason) and re-hides. */
	async tryUnlock(pass: string): Promise<boolean> {
		const s = this.owner.settings;
		const h = await hashPass(pass, s.passSalt);
		if (!safeEqual(h, s.passHash)) {
			this.failedAttempts++;
			await new Promise((r) => setTimeout(r, Math.min(5000, 500 * this.failedAttempts)));
			return false;
		}
		// Being stopped (a switch): the next app's lock screen is coming; never open the folder under it.
		if (this.owner.stopping) return false;
		this.failedAttempts = 0;
		this.owner.backup.control.offerPassphrase(pass);
		const pf = this.owner.privateFolder;
		this.unlocking = true;
		this.lockRequested = false;
		pf.progress = (t) => this.err?.setText(t ?? "");
		let done = false;
		this.unlockDone = (async () => {
			try {
				await pf.show(() => this.owner.stopping || this.lockRequested);
				done = !this.owner.stopping && !this.lockRequested;
				if (!done && this.lockRequested) this.err?.setText("Locked again.");
			} catch (e) {
				console.error("[VLB] unhide failed", e);
				this.err?.setText(`The private folder could not be opened: ${errMsg(e)}. Try again.`);
			}
			// The one re-hide (what was decrypted is encrypted again); set before unlockDone resolves.
			if (!done && !this.owner.stopping) {
				this.inflight = pf.hide().catch((e) => {
					console.error("[VLB] lock failed", e);
					this.hideRetry();
				}).finally(() => { this.inflight = null; });
			}
		})();
		await this.unlockDone;
		this.unlockDone = null;
		pf.progress = null;
		this.unlocking = false;
		if (!done) return true; // stays locked; the error line says why
		this.locked = false;
		this.lastActivity = Date.now();
		this.removeOverlay(true);
		// Runs a deferred restore within seconds.
		this.owner.backup.requestReconcile("unlock");
		return true;
	}

	private showOverlay(): void {
		if (this.overlay) return;
		this.scope = new Scope();
		this.owner.app.keymap.pushScope(this.scope);
		this.guardTitle(document);
		this.owner.app.workspace.iterateAllLeaves((leaf) => this.guardTitle(leaf.view.containerEl.doc));
		// Settings opens in its own window, which the overlay does not cover. Leaving it open
		// would let someone switch the plugin off and so unlock the vault.
		(this.owner.app as unknown as { setting?: { close?: () => void } }).setting?.close?.();
		document.body.addClass("vlb-locked");

		const o = document.body.createDiv({ cls: "vlb-overlay" });
		const box = o.createDiv({ cls: "vlb-box" });
		box.createDiv({ cls: "vlb-title", text: "Vault locked" });
		const input = box.createEl("input", {
			type: "password",
			cls: "vlb-input",
			attr: { placeholder: "Passphrase", autocomplete: "off", spellcheck: "false" },
		});
		const err = box.createDiv({ cls: "vlb-error" });
		const btn = box.createEl("button", { text: "Unlock", cls: "mod-cta" });

		let pending = false;
		const submit = async () => {
			if (pending) return;
			pending = true;
			btn.disabled = true;
			err.setText("");
			const ok = await this.tryUnlock(input.value);
			if (!ok) err.setText("Wrong passphrase");
			// Still locked (wrong passphrase, or the folder could not be opened): the box is usable again.
			if (this.locked) {
				input.value = "";
				btn.disabled = false;
				input.focus();
			}
			pending = false;
		};
		input.addEventListener("keydown", (e) => { if (e.key === "Enter") void submit(); });
		btn.addEventListener("click", () => void submit());
		// Keep focus inside the box.
		o.addEventListener("mousedown", (e) => { if (e.target === o) { e.preventDefault(); input.focus(); } });

		this.overlay = o;
		this.err = err;
		window.setTimeout(() => input.focus(), 30);
	}

	/**
	 * Keep a window's title at "Obsidian" while locked. Obsidian rewrites titles to the active
	 * note's name when the workspace finishes loading or a tab closes, so setting it once is
	 * not enough. The title Obsidian wanted is remembered and restored on unlock.
	 */
	private guardTitle(doc: Document): void {
		if (this.titleGuards.has(doc)) return;
		const g = { saved: doc.title, observer: new MutationObserver(() => {
			if (doc.title === LOCKED_TITLE) return;
			g.saved = doc.title;
			doc.title = LOCKED_TITLE;
		}) };
		this.titleGuards.set(doc, g);
		doc.title = LOCKED_TITLE;
		g.observer.observe(doc.head, { subtree: true, childList: true, characterData: true });
	}

	/** Titles go back only on unlock. When the app stops while locked, the core's cover (or
	 *  the next app's lock screen) is what keeps the note's name out of the title. */
	private removeOverlay(restoreTitles: boolean): void {
		if (this.scope) { this.owner.app.keymap.popScope(this.scope); this.scope = null; }
		document.body.removeClass("vlb-locked");
		for (const [doc, g] of this.titleGuards) {
			g.observer.disconnect();
			if (restoreTitles && g.saved) doc.title = g.saved;
		}
		this.titleGuards.clear();
		this.overlay?.remove();
		this.overlay = null;
		this.err = null;
	}

	destroy(): void {
		if (this.hideTimer) window.clearTimeout(this.hideTimer);
		this.hideTimer = null;
		this.removeOverlay(false);
		this.locked = false;
	}
}
