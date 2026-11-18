/** Obsidian opens maximized (1.9.2). Once per window: a later reload of the plugin (a server
 *  bundle, a BRAT update) leaves a window the user has resized alone. Not when it is already
 *  maximized or full screen, or minimized. A window that is not shown yet is asked again every
 *  second for up to 15 s; one that stays hidden is left alone, since maximize() would show it.
 *  Never throws. */

interface Win {
	isDestroyed(): boolean;
	isVisible(): boolean;
	isMinimized(): boolean;
	isMaximized(): boolean;
	isFullScreen(): boolean;
	maximize(): void;
}

type Host = { __vlbMaximized?: boolean; require?: (id: string) => unknown };

export const MAXIMIZE_TRIES = 15;

export function maximizeOnce(isStopping: () => boolean, host: Host = window as unknown as Host,
	later: (f: () => void, ms: number) => void = (f, ms) => { window.setTimeout(f, ms); }): void {
	if (host.__vlbMaximized) return;
	host.__vlbMaximized = true;
	let win: Win | null = null;
	try {
		const remote = host.require?.("@electron/remote") as { getCurrentWindow?: () => Win } | undefined;
		win = remote?.getCurrentWindow?.() ?? null;
	} catch (e) {
		console.warn("[VLB] no access to the window, not maximizing it", e);
		return;
	}
	if (!win) return;
	const w = win;
	let tries = 0;
	const tick = (): void => {
		try {
			if (w.isDestroyed() || w.isMaximized() || w.isFullScreen()) return;
			if (w.isVisible() && !w.isMinimized()) {
				w.maximize();
				return;
			}
		} catch (e) {
			console.warn("[VLB] could not maximize the window", e);
			return;
		}
		if (++tries < MAXIMIZE_TRIES && !isStopping()) later(tick, 1000);
	};
	tick();
}
