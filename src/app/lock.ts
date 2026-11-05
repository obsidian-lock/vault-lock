import { Notice, Scope } from "obsidian";
import type { VaultLockApp } from "./app";
import { hashPass, safeEqual } from "../shared/crypto";

const IDLE_CHECK_MS = 15_000;
const LOCKED_TITLE = "Obsidian";

export class LockScreen {
	locked = false;
	private overlay: HTMLElement | null = null;
	private scope: Scope | null = null;
	private lastActivity = Date.now();
	private busy = false;
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

	async lock(): Promise<void> {
		// A stopped app never locks again (a blur timer can fire after stop): its lock screen would never go away.
		if (this.owner.stopping) return;
		if (!this.hasPass) { new Notice("Vault Lock: set a passphrase in settings first."); return; }
		if (this.locked || this.busy) return;
		this.busy = true;
		try {
			this.locked = true;
			this.showOverlay();
			await this.owner.privateFolder.hide();
		} catch (e) {
			console.error("[VLB] lock failed", e);
		} finally {
			this.busy = false;
		}
	}

	private async tryUnlock(pass: string): Promise<boolean> {
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
		this.locked = false;
		this.lastActivity = Date.now();
		this.owner.backup.control.offerPassphrase(pass);
		this.removeOverlay(true);
		try { await this.owner.privateFolder.show(() => this.owner.stopping); } catch (e) { console.error("[VLB] unhide failed", e); }
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
			if (!ok) {
				input.value = "";
				err.setText("Wrong passphrase");
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
	}

	destroy(): void {
		this.removeOverlay(false);
		this.locked = false;
	}
}
