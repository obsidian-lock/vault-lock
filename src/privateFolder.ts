import { FileSystemAdapter, Notice, Platform, TFile, WorkspaceLeaf } from "obsidian";
import type VLBPlugin from "./main";

/**
 * The private folder lives at `Private/` while unlocked and `.Private/` while locked.
 * Obsidian ignores dot-folders entirely (explorer, search, graph, switcher), so the
 * rename is the whole hiding mechanism. Nothing is encrypted.
 */
export class PrivateFolder {
	constructor(private plugin: VLBPlugin) {}

	get name(): string {
		return this.plugin.settings.privateFolder.trim().replace(/^\/+|\/+$/g, "");
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

	async hide(): Promise<void> {
		if (!this.enabled) return;
		await this.rename(this.name, this.hiddenName, true);
	}

	async show(): Promise<void> {
		if (!this.enabled) return;
		await this.rename(this.hiddenName, this.name, false);
	}

	private async rename(from: string, to: string, hidden: boolean): Promise<void> {
		const adapter = this.plugin.app.vault.adapter;
		const [fromExists, toExists] = await Promise.all([adapter.exists(from), adapter.exists(to)]);
		if (!fromExists) return;
		if (toExists) {
			console.error(`[VLB] both "${from}" and "${to}" exist; refusing to rename`);
			new Notice(`Vault Lock: both "${from}" and "${to}" exist. Merge them by hand.`, 15000);
			return;
		}
		if (hidden) await this.closeLeavesUnder(from);
		await adapter.rename(from, to);
		this.setWindowsHiddenAttr(to, hidden);
	}

	/**
	 * Close every tab showing a file under `prefix`, after saving what was typed in it. Closing
	 * alone saves too, but asynchronously, and the folder is renamed right after: that write
	 * would land on the old path and fail, taking the last seconds of typing with it.
	 */
	private async closeLeavesUnder(prefix: string): Promise<void> {
		const leaves: WorkspaceLeaf[] = [];
		this.plugin.app.workspace.iterateAllLeaves((leaf) => {
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

	/** Best effort: also hide from Explorer. Failure is harmless. */
	private setWindowsHiddenAttr(rel: string, hidden: boolean): void {
		if (!Platform.isWin) return;
		try {
			const adapter = this.plugin.app.vault.adapter;
			if (!(adapter instanceof FileSystemAdapter)) return;
			const abs = adapter.getFullPath(rel);
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const { execFile } = require("child_process") as typeof import("child_process");
			execFile("attrib", [hidden ? "+h" : "-h", abs], () => {});
		} catch (e) {
			console.warn("[VLB] attrib failed", e);
		}
	}
}
