import { FileSystemAdapter, Notice, Platform, TFile, WorkspaceLeaf } from "obsidian";
import type { App } from "obsidian";
import type { VLBSettings } from "./settings";

/**
 * The private folder lives at `Private/` while unlocked and `.Private/` while locked.
 * Obsidian ignores dot-folders entirely (explorer, search, graph, switcher), so the
 * rename is the whole hiding mechanism inside Obsidian. On Windows the folder and everything
 * in it also get the hidden attribute, so File Explorer skips them. Nothing is encrypted.
 */
export class PrivateFolder {
	/** hide() and show() run one at a time, so a quick unlock cannot overtake a lock. */
	private chain: Promise<void> = Promise.resolve();

	constructor(private app: App, private settings: () => VLBSettings) {}

	get name(): string {
		return this.settings().privateFolder.trim().replace(/^\/+|\/+$/g, "");
	}
	get hiddenName(): string {
		return this.name ? "." + this.name : "";
	}
	get enabled(): boolean {
		return !!this.name && !this.name.startsWith(".") && !this.name.includes("/");
	}

	/** Map a path under `.Private/` to `Private/`, so the backup server never sees the hidden name. */
	toVisible(path: string): string {
		if (!this.enabled) return path;
		const h = this.hiddenName;
		if (path === h) return this.name;
		if (path.startsWith(h + "/")) return this.name + path.slice(h.length);
		return path;
	}

	/** The other on-disk location of a path inside the private folder, or null if not inside it. */
	altPath(path: string): string | null {
		if (!this.enabled) return null;
		const v = this.name, h = this.hiddenName;
		if (path === v) return h;
		if (path === h) return v;
		if (path.startsWith(v + "/")) return h + path.slice(v.length);
		if (path.startsWith(h + "/")) return v + path.slice(h.length);
		return null;
	}

	hide(): Promise<void> {
		return this.serial(async () => {
			if (!this.enabled) return;
			await this.rename(this.name, this.hiddenName, true);
			// Also when it was hidden already (Obsidian was closed while locked).
			await this.setWindowsHidden(this.hiddenName, true);
		});
	}

	show(): Promise<void> {
		return this.serial(async () => {
			if (!this.enabled) return;
			// Unmark first, while Obsidian still ignores the dot-folder and sees no changes.
			await this.setWindowsHidden(this.hiddenName, false);
			await this.rename(this.hiddenName, this.name, false);
		});
	}

	private serial(fn: () => Promise<void>): Promise<void> {
		const run = this.chain.then(fn, fn);
		this.chain = run.catch(() => {});
		return run;
	}

	private async rename(from: string, to: string, hidden: boolean): Promise<void> {
		const adapter = this.app.vault.adapter;
		const [fromExists, toExists] = await Promise.all([adapter.exists(from), adapter.exists(to)]);
		if (!fromExists) return;
		if (toExists) {
			console.error(`[VLB] both "${from}" and "${to}" exist; refusing to rename`);
			new Notice(`Vault Lock: both "${from}" and "${to}" exist. Merge them by hand.`, 15000);
			return;
		}
		if (hidden) await this.closeLeavesUnder(from);
		await adapter.rename(from, to);
	}

	/**
	 * Close every tab showing a file under `prefix`, after saving what was typed in it. Closing
	 * alone saves too, but asynchronously, and the folder is renamed right after: that write
	 * would land on the old path and fail, taking the last seconds of typing with it.
	 */
	private async closeLeavesUnder(prefix: string): Promise<void> {
		const leaves: WorkspaceLeaf[] = [];
		this.app.workspace.iterateAllLeaves((leaf) => {
			const f = (leaf.view as unknown as { file?: TFile }).file;
			if (f && (f.path === prefix || f.path.startsWith(prefix + "/"))) leaves.push(leaf);
		});
		type Saver = { save?: () => Promise<void>; saving?: boolean };
		const views = leaves.map((l) => l.view as unknown as Saver);
		for (const v of views) {
			if (typeof v.save !== "function") continue;
			try { await v.save(); } catch (e) { console.error("[VLB] saving a private note before the lock failed", e); }
		}
		// save() returns at once when a save is already under way; give those a moment to finish.
		const deadline = Date.now() + 3000;
		while (views.some((v) => v.saving) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
		for (const l of leaves) l.detach();
	}

	/**
	 * Windows only, best effort: set or clear the hidden attribute on the folder and everything
	 * in it. Failure is harmless: Obsidian ignores the attribute either way.
	 */
	private async setWindowsHidden(rel: string, hidden: boolean): Promise<void> {
		if (!Platform.isWin) return;
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) return;
		try {
			if (!(await adapter.exists(rel))) return;
			const abs = adapter.getFullPath(rel);
			const flag = hidden ? "+h" : "-h";
			await attrib([flag, abs]);
			await attrib([flag, abs + "\\*", "/s", "/d"]);
		} catch (e) {
			console.warn("[VLB] attrib failed", e);
		}
	}
}

/** Run Windows' attrib.exe without a console window. Never rejects. */
function attrib(args: string[]): Promise<void> {
	const { execFile } = require("child_process") as typeof import("child_process");
	const exe = (process.env.SystemRoot || "C:\\Windows") + "\\System32\\attrib.exe";
	return new Promise((resolve) => {
		execFile(exe, args, { timeout: 30_000, windowsHide: true }, (err) => {
			if (err) console.warn("[VLB] attrib " + args.join(" ") + " failed", err.message);
			resolve();
		});
	});
}
