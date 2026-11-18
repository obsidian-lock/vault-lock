import { Notice, Scope } from "obsidian";
import type { VaultLockApp } from "./app";
import { HIDE_RETRY_MS } from "../shared/constants";
import { hashPass, safeEqual } from "../shared/crypto";
import { errMsg } from "../shared/dav";
import { UnlockModal } from "./unlockModal";

const IDLE_CHECK_MS = 15_000;
const LOCKED_TITLE = "Obsidian";

/**
 * The lock of the private folder. Locked means the folder is hidden (renamed to its dot-name,
 * encrypted in the background); Obsidian stays usable. The padlock in the ribbon (the core's)
 * locks, and unlocks through a small passphrase dialog. The old whole-window overlay is only the
 * fallback: it goes up when the folder could not be hidden, and down once a retry hides it.
 */
export class LockScreen {
	/** The user-facing state: locked (the folder hidden, or the fallback up) or unlocked. */
	locked = false;
	/** An unlock is decrypting the private folder: `locked` stays true until it is back. */
	unlocking = false;
	/** A lock asked for during an unlock: the unlock stops before the folder comes back. */
	lockRequested = false;
	/** The passphrase is being checked (PBKDF2, a few hundred ms): a lock() meanwhile wins over the unlock that would follow. */
	private checking = false;
	/** The fallback overlay, only while the folder could not be hidden. */
	private overlay: HTMLElement | null = null;
	private overlayInput: HTMLInputElement | null = null;
	private err: HTMLElement | null = null;
	private scope: Scope | null = null;
	private modal: { m: UnlockModal; done: Promise<void> } | null = null;
	private lastActivity = Date.now();
	/** The lock in progress, if any. */
	private inflight: Promise<void> | null = null;
	/** The show() in progress, awaited by a lock() that arrives meanwhile. */
	private unlockDone: Promise<void> | null = null;
	private hideTimer: number | null = null;
	private failedAttempts = 0;
	/** One title guard per window (main window and pop-outs) while the fallback is up. */
	private titleGuards = new Map<Document, { saved: string; observer: MutationObserver }>();
	/** An opaque layer over each pop-out window while the fallback is up: keys are swallowed
	 *  there, but a click on a link or a recent file would open the plaintext note. */
	private popCovers = new Map<Document, HTMLElement>();
	private watched = new WeakSet<Window>();

	constructor(private owner: VaultLockApp) {}

	get hasPass(): boolean {
		return !!this.owner.settings.passHash && !!this.owner.settings.passSalt;
	}

	install(): void {
		this.watchWindow(window);
		this.owner.app.workspace.iterateAllLeaves((leaf) => this.watchWindow(leaf.view.containerEl.win));
		this.owner.registerInterval(window.setInterval(() => this.checkIdle(), IDLE_CHECK_MS));
		// Pop-out windows: their activity counts, and ones opened under the fallback are covered too.
		this.owner.registerEvent(this.owner.app.workspace.on("window-open", (_ww, win) => {
			this.watchWindow(win);
			if (this.overlay) this.coverWindow(win.document);
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
		// Under the fallback overlay only: swallow every key that isn't typed into its box.
		this.owner.registerDomEvent(win, "keydown", (e: KeyboardEvent) => {
			if (!this.overlay) return;
			if (this.overlay.contains(e.target as Node)) return;
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
		if (!this.hasPass || m <= 0 || (this.locked && !this.strayVisible())) return;
		if (Date.now() - this.lastActivity >= m * 60_000) void this.lock();
	}

	/** Locked, yet Private/ is on disk with nothing over it: made while locked (a note created
	 *  there, a link clicked, a folder made by hand). Under the fallback the retry takes care of it. */
	private strayVisible(): boolean {
		return this.locked && !this.overlay && this.owner.privateFolder.visibleOnDisk();
	}

	/** True when nothing private is exposed: the folder is not on disk under its visible name (hidden,
	 *  or none at all), or the fallback overlay covers it. Never during an unlock's decrypt: the
	 *  hidden folder still exists then, and the core must not switch apps in the middle of it. */
	nothingExposed(): boolean {
		const pf = this.owner.privateFolder;
		return !this.unlocking && (!!this.overlay || !pf.enabled || !pf.visibleOnDisk());
	}

	/** Resolves once the private folder is hidden (its encryption goes on in the background), or the
	 *  fallback overlay is up. A lock already under way (a blur or idle lock just before Obsidian
	 *  quits) returns that same lock, so the quit waits for its hide. A lock asked for during an
	 *  unlock wins: the unlock stops before the folder comes back and re-hides what it decrypted;
	 *  this resolves with that. Already locked: nothing to do, unless Private/ came back meanwhile
	 *  (strayVisible): then it is hidden like a lock would, and the idle, blur, quit and command
	 *  locks all come through here. */
	lock(): Promise<void> {
		// A stopped app never locks again (a blur timer can fire after stop).
		if (this.owner.stopping) return Promise.resolve();
		if (!this.hasPass) { new Notice("Vault Lock: set a passphrase in settings first."); return Promise.resolve(); }
		// The passphrase is still being checked: the folder is hidden, and the unlock stops once the check is done.
		if (this.checking && this.locked) { this.lockRequested = true; return this.inflight ?? Promise.resolve(); }
		if (this.unlocking && this.unlockDone) {
			this.lockRequested = true;
			// tryUnlock stores its re-hide in `inflight` before unlockDone resolves.
			return this.unlockDone.then(() => this.inflight ?? Promise.resolve());
		}
		if (this.inflight) return this.inflight;
		if (this.locked) {
			if (!this.strayVisible()) return Promise.resolve();
			this.inflight = this.ensureHidden().finally(() => { this.inflight = null; });
			return this.inflight;
		}
		this.inflight = this.lockNow().finally(() => { this.inflight = null; });
		return this.inflight;
	}

	private async lockNow(): Promise<void> {
		this.locked = true;
		this.padlock(true);
		this.hideRetryStop();
		try {
			await this.owner.privateFolder.hide();
			this.afterHide();
		} catch (e) {
			this.hideFailed(e);
		}
	}

	/** Opens the unlock dialog; resolves when it closes. Under the fallback overlay, its box is
	 *  the dialog: focus it. An unlock already decrypting, or a dialog already open: nothing new. */
	unlock(): Promise<void> {
		if (!this.hasPass || !this.locked || this.unlocking || this.owner.stopping) return Promise.resolve();
		if (this.overlay) { this.overlayInput?.focus(); return Promise.resolve(); }
		if (this.modal) return this.modal.done;
		const m = new UnlockModal(this.owner.app, this, this.owner.privateFolder);
		const done = m.openAndWait().finally(() => { if (this.modal?.m === m) this.modal = null; });
		this.modal = { m, done };
		return done;
	}

	/** Locked, but private files are visible (made while locked, or a restore that a lock caught
	 *  mid-write): hide and encrypt them now. A failed rename puts the fallback up and is tried
	 *  again every HIDE_RETRY_MS, as after a lock; never rejects. */
	async ensureHidden(): Promise<void> {
		if (!this.locked || this.owner.stopping) return;
		try {
			await this.owner.privateFolder.hide();
			this.afterHide();
		} catch (e) {
			this.hideFailed(e);
		}
	}

	/** The folder is hidden: the fallback goes, File recovery's private snapshots go, open dialogs
	 *  go (one may show a private note's text: File recovery's history, a search), and open notes
	 *  that embed a private note are drawn again without it. The title Obsidian asked for under
	 *  the fallback is not put back: it may name a private note (as the cover, never). */
	private afterHide(): void {
		this.removeOverlay(false);
		void this.owner.cleanFileRecovery();
		this.closeOtherModals();
		this.rerenderEmbeds();
	}

	/** Every open dialog in every window, except Settings (usable while locked, F.4) and this
	 *  plugin's own (the unlock dialog, the passphrase dialog): its close button is clicked. */
	private closeOtherModals(): void {
		for (const doc of this.documents()) {
			try {
				for (const c of Array.from(doc.querySelectorAll(".modal-container"))) {
					if (c.querySelector(".mod-settings, .vlb-unlock, .vlb-passphrase")) continue;
					(c.querySelector(".modal-close-button") as HTMLElement | null)?.click();
				}
			} catch (e) {
				console.warn("[VLB] could not close a dialog at the lock", e);
			}
		}
	}

	/** The main window's document and every pop-out's. */
	private documents(): Document[] {
		const docs = [document];
		this.owner.app.workspace.iterateAllLeaves((leaf) => {
			const d = leaf.view.containerEl.doc;
			if (!docs.includes(d)) docs.push(d);
		});
		return docs;
	}

	/** The folder could not be hidden (a file held open, a stray that cannot be moved): the
	 *  whole-window fallback covers Obsidian until a retry hides it, or until an unlock. */
	private hideFailed(e: unknown): void {
		console.error("[VLB] lock failed", e);
		if (!this.locked || this.owner.stopping) return;
		this.showOverlay();
		this.hideRetry();
	}

	/** Try the hide again every HIDE_RETRY_MS while locked and not hidden. */
	private hideRetry(): void {
		if (this.hideTimer) return;
		this.hideTimer = window.setTimeout(() => {
			this.hideTimer = null;
			if (!this.locked || this.unlocking || this.owner.stopping) return;
			this.owner.privateFolder.hide().then(() => {
				if (this.locked && !this.owner.stopping) this.afterHide();
			}, (e) => this.hideFailed(e));
		}, HIDE_RETRY_MS);
	}

	private hideRetryStop(): void {
		if (this.hideTimer) window.clearTimeout(this.hideTimer);
		this.hideTimer = null;
	}

	/** Reading views keep an embedded private note's text until drawn again. Live Preview and
	 *  Canvas are not covered (a known limit). */
	private rerenderEmbeds(): void {
		this.owner.app.workspace.iterateAllLeaves((leaf) => {
			const v = leaf.view as unknown as { getViewType?: () => string; previewMode?: { rerender?: (full: boolean) => void } };
			if (v.getViewType?.() !== "markdown") return;
			try { v.previewMode?.rerender?.(true); } catch { /* a view in the middle of closing */ }
		});
	}

	/** True for the right passphrase. The folder is unlocked only when it came back: a failed or
	 *  cancelled show() keeps it locked (with the reason, through say) and re-hides. The dialog
	 *  sets pf.progress itself; a direct call (the fallback box, tests) shows it through say. */
	async tryUnlock(pass: string, say: (text: string) => void = (t) => this.err?.setText(t)): Promise<boolean> {
		const s = this.owner.settings;
		this.lockRequested = false;
		this.checking = true;
		let h: string;
		try {
			h = await hashPass(pass, s.passSalt);
		} finally {
			this.checking = false;
		}
		if (!safeEqual(h, s.passHash)) {
			this.failedAttempts++;
			await new Promise((r) => setTimeout(r, Math.min(5000, 500 * this.failedAttempts)));
			return false;
		}
		// Being stopped (a switch): the next app takes over; never open the folder now. The
		// passphrase was right, so the box says why it stays locked, not "Wrong passphrase".
		if (this.owner.stopping) { say("Vault Lock is restarting; try again in a moment."); return true; }
		this.failedAttempts = 0;
		this.owner.backup.control.offerPassphrase(pass);
		// A lock asked for while the passphrase was checked (a blur, the quit task) wins: nothing is opened (B15).
		if (this.lockRequested) { say("Locked again."); return true; }
		const pf = this.owner.privateFolder;
		this.unlocking = true;
		let ownProgress: ((t: string | null) => void) | null = null;
		if (!pf.progress) pf.progress = ownProgress = (t) => say(t ?? "");
		let done = false;
		this.unlockDone = (async () => {
			try {
				await pf.show(() => this.owner.stopping || this.lockRequested);
				done = !this.owner.stopping && !this.lockRequested;
				if (!done && this.lockRequested) say("Locked again.");
			} catch (e) {
				console.error("[VLB] unhide failed", e);
				say(`The private folder could not be opened: ${errMsg(e)}. Try again.`);
			}
			// The one re-hide (what was decrypted is encrypted again); set before unlockDone resolves.
			if (!done && !this.owner.stopping) {
				this.inflight = pf.hide().then(() => this.afterHide(), (e) => this.hideFailed(e))
					.finally(() => { this.inflight = null; });
			}
		})();
		await this.unlockDone;
		this.unlockDone = null;
		if (ownProgress && pf.progress === ownProgress) pf.progress = null;
		this.unlocking = false;
		if (!done) return true; // stays locked; the error line says why
		this.locked = false;
		this.padlock(false);
		this.lastActivity = Date.now();
		this.removeOverlay(true);
		// Runs a deferred restore within seconds.
		this.owner.backup.requestReconcile("unlock");
		return true;
	}

	/** The padlock follows the user-facing state. A failure there never stops a lock or an unlock. */
	private padlock(locked: boolean): void {
		try {
			this.owner.host.lockState(locked);
		} catch (e) {
			console.warn("[VLB] padlock not updated", e);
		}
	}

	/** The fallback: the whole window covered, its own passphrase box, keys swallowed. */
	private showOverlay(): void {
		if (this.overlay) return;
		// An open unlock dialog would sit invisible under the overlay and come back stale after it.
		this.closeModal();
		this.scope = new Scope();
		this.owner.app.keymap.pushScope(this.scope);
		for (const doc of this.documents()) this.coverWindow(doc);
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
			const ok = await this.tryUnlock(input.value, (t) => err.setText(t));
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
		this.overlayInput = input;
		this.err = err;
		window.setTimeout(() => input.focus(), 30);
	}

	/** A pop-out window under the fallback: its title guarded, an opaque layer over it (plain DOM
	 *  with inline styles: another window's elements have neither Obsidian's helpers nor, for
	 *  sure, this plugin's stylesheet). The main window has the overlay itself. */
	private coverWindow(doc: Document): void {
		this.guardTitle(doc);
		if (doc === document || this.popCovers.has(doc)) return;
		try {
			const c = doc.createElement("div");
			c.className = "vlb-popout-cover";
			c.setAttribute("style", "position:fixed;inset:0;z-index:100000;background:var(--background-primary,#1e1e1e);");
			doc.body.appendChild(c);
			doc.body.classList.add("vlb-locked");
			this.popCovers.set(doc, c);
		} catch (e) {
			console.warn("[VLB] could not cover a pop-out window", e);
		}
	}

	/**
	 * Keep a window's title at "Obsidian" under the fallback. Obsidian rewrites titles to the
	 * active note's name when the workspace finishes loading or a tab closes, so setting it once
	 * is not enough. The title Obsidian wanted is remembered and restored at an unlock.
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

	/** Titles go back only when the overlay goes at an unlock. After a hide the title stays
	 *  "Obsidian" until Obsidian sets the next one. When the app stops under it, the core's cover
	 *  (or the next app's fallback) is what keeps the note's name out of the title. */
	private removeOverlay(restoreTitles: boolean): void {
		if (this.scope) { this.owner.app.keymap.popScope(this.scope); this.scope = null; }
		document.body.removeClass("vlb-locked");
		for (const [doc, g] of this.titleGuards) {
			g.observer.disconnect();
			if (restoreTitles && g.saved) doc.title = g.saved;
		}
		this.titleGuards.clear();
		for (const [doc, c] of this.popCovers) {
			try { c.remove(); doc.body.classList.remove("vlb-locked"); } catch { /* the window is gone */ }
		}
		this.popCovers.clear();
		this.overlay?.remove();
		this.overlay = null;
		this.overlayInput = null;
		this.err = null;
	}

	private closeModal(): void {
		const md = this.modal;
		this.modal = null;
		try { md?.m.close(); } catch (e) { console.warn("[VLB] could not close the unlock dialog", e); }
	}

	/** The app is stopping (a switch): the dialog closes now, before the stop waits for the backup's
	 *  last run, so a passphrase typed meanwhile is not answered "Wrong passphrase". The user clicks
	 *  the padlock again under the new app. The hide retry stops too; the next app has its own. */
	release(): void {
		this.hideRetryStop();
		this.closeModal();
	}

	destroy(): void {
		this.release();
		this.removeOverlay(false);
		this.locked = false;
	}
}
