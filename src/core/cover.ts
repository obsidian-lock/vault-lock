/**
 * The core's fail-closed cover: an opaque layer over the whole window while no app has
 * locked the vault yet (at start, during a switch, during a reload). Inline styles only, so
 * it works without styles.css. While it is up, every key is swallowed and the window title is
 * kept at "Obsidian" (Obsidian rewrites it to the note's name at times). Obsidian's hotkeys
 * run in a window capture listener, before the swallow: an empty Scope on top of its keymap
 * (as the lock screens push) stops those.
 *
 * The cover never puts a note title back when it comes down: then a lock screen is up (which
 * restores the title itself on unlock) or there is no passphrase. Only a cover that removes
 * itself after a real disable restores the last title Obsidian asked for.
 */

import { Scope } from "obsidian";
import type { App } from "obsidian";

const STYLE = "position:fixed;inset:0;z-index:100001;background:var(--background-primary, #1e1e1e);";
const TITLE = "Obsidian";

/** A cover left up by a copy of the plugin that was unloaded; the next copy takes it over. */
export type LeftCover = { el: HTMLElement; timer: number; swallow: (e: KeyboardEvent) => void; guard?: TitleGuard | null; scope?: Held | null };

declare global {
	interface Window {
		/** Left by a copy of the plugin that is being unloaded (a BRAT update, a disable): the
		 *  next copy waits for `stopping` before it starts, and takes over `cover`. */
		__vaultLock?: { stopping?: Promise<void>; cover?: LeftCover };
	}
}

/** Keeps document.title at "Obsidian"; remembers what Obsidian asked for meanwhile. */
type TitleGuard = { saved: string; observer: MutationObserver | null };
/** The empty Scope pushed on Obsidian's keymap, with the keymap to pop it from. */
type Held = { scope: Scope; keymap: App["keymap"] };

export class Cover {
	private el: HTMLElement | null = null;
	private swallow: ((e: KeyboardEvent) => void) | null = null;
	private guard: TitleGuard | null = null;
	private scope: Held | null = null;

	constructor(private app: () => App) {}

	get shown(): boolean {
		return !!this.el;
	}

	show(): void {
		if (this.el) return;
		const left = window.__vaultLock?.cover;
		if (left) {
			// Left by the copy of the plugin before this one: keep it up, so there is no gap.
			window.clearTimeout(left.timer);
			delete window.__vaultLock?.cover;
			if (left.el.isConnected) {
				this.el = left.el;
				this.swallow = left.swallow;
				this.guard = left.guard ?? guardTitle(document.title);
				this.scope = left.scope ?? pushScope(this.app);
				document.title = TITLE;
				return;
			}
			document.removeEventListener("keydown", left.swallow, true);
			left.guard?.observer?.disconnect();
			popScope(left.scope ?? null);
		}
		const el = document.createElement("div");
		el.id = "vlb-cover";
		el.setAttribute("style", STYLE);
		document.body.appendChild(el);
		const swallow = (e: KeyboardEvent) => { e.stopImmediatePropagation(); e.preventDefault(); };
		document.addEventListener("keydown", swallow, true);
		this.el = el;
		this.swallow = swallow;
		this.guard = guardTitle(document.title);
		this.scope = pushScope(this.app);
		document.title = TITLE;
	}

	/** The title stays as it is: a lock screen is up now (or there is no passphrase). */
	hide(): void {
		if (!this.el || !this.swallow) return;
		remove(this.el, this.swallow, this.guard, this.scope, false);
		this.el = null;
		this.swallow = null;
		this.guard = null;
		this.scope = null;
	}

	/** Hand the cover to the next copy of the plugin. If none comes (a real disable), it
	 *  removes itself after ms: disabling the plugin unlocks the vault, by design. */
	leaveBehind(ms: number): void {
		this.show();
		if (!this.el || !this.swallow) return;
		const left: LeftCover = { el: this.el, swallow: this.swallow, guard: this.guard, scope: this.scope, timer: 0 };
		left.timer = window.setTimeout(() => {
			if (window.__vaultLock?.cover === left) delete window.__vaultLock.cover;
			// Nothing is locked any more: give Obsidian its title back.
			remove(left.el, left.swallow, left.guard ?? null, left.scope ?? null, true);
		}, ms);
		window.__vaultLock = { ...window.__vaultLock, cover: left };
		this.el = null;
		this.swallow = null;
		this.guard = null;
		this.scope = null;
	}
}

function guardTitle(current: string): TitleGuard {
	const g: TitleGuard = { saved: current === TITLE ? "" : current, observer: null };
	try {
		g.observer = new MutationObserver(() => {
			if (document.title === TITLE) return;
			g.saved = document.title;
			document.title = TITLE;
		});
		g.observer.observe(document.head, { subtree: true, childList: true, characterData: true });
	} catch (e) {
		console.warn("[VLB] cover: no title guard", e);
	}
	return g;
}

/** Never stops the cover: without a keymap it still swallows plain keys. */
function pushScope(app: () => App): Held | null {
	try {
		const keymap = app().keymap;
		const scope = new Scope();
		keymap.pushScope(scope);
		return { scope, keymap };
	} catch (e) {
		console.warn("[VLB] cover: no keymap scope", e);
		return null;
	}
}

function popScope(held: Held | null): void {
	if (!held) return;
	try { held.keymap.popScope(held.scope); } catch { /* gone */ }
}

function remove(el: HTMLElement, swallow: (e: KeyboardEvent) => void, guard: TitleGuard | null, scope: Held | null, restoreTitle: boolean): void {
	el.remove();
	document.removeEventListener("keydown", swallow, true);
	guard?.observer?.disconnect();
	popScope(scope);
	if (restoreTitle && guard?.saved && document.title === TITLE) document.title = guard.saved;
}
