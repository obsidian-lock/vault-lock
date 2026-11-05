import type { DataAdapter } from "obsidian";
import { PAIR_DIR } from "./server";

/** Which vault files are backed up, and the index format on the server. */

/** The server index: server path -> mtime (ms) and size of the copy that was uploaded. */
export type Entry = { m: number; s: number };
export type Index = Record<string, Entry>;
/** A file found by scan(): its path in the vault, mtime and size. */
export type LocalFile = { path: string; m: number; s: number };

export const MANIFEST = "_manifest.json";
export const TRASH = "_trash";
export const CONTROL = "_control";

/** Never backed up: the plugin's own folder (data.json holds the passphrase hash and this
 *  computer's server key), the server's own files, and the excludes lines. */
export function excluded(path: string, ownDir: string, excludes: string): boolean {
	if (path === ownDir || path.startsWith(ownDir + "/") || path === MANIFEST) return true;
	for (const reserved of [TRASH, CONTROL, PAIR_DIR]) {
		if (path === reserved || path.startsWith(reserved + "/")) return true;
	}
	for (const line of excludes.split("\n")) {
		const p = line.trim();
		if (p && path.startsWith(p)) return true;
	}
	return false;
}

/** Every file under dir that is not skipped, keyed by its server path. */
export async function scan(adapter: DataAdapter, dir: string, out: Map<string, LocalFile>, skip: (path: string) => boolean, serverPath: (path: string) => string): Promise<void> {
	let listed;
	try {
		listed = await adapter.list(dir);
	} catch (e) {
		if (dir === "") listed = await adapter.list("/");
		else throw e;
	}
	for (const f of listed.files) {
		const p = clean(f);
		if (skip(p)) continue;
		const st = await adapter.stat(p);
		if (!st || st.type !== "file") continue;
		out.set(serverPath(p), { path: p, m: st.mtime, s: st.size });
	}
	for (const d of listed.folders) {
		const p = clean(d);
		if (skip(p + "/")) continue;
		await scan(adapter, p, out, skip, serverPath);
	}
}

export function clean(p: string): string {
	return p.replace(/^\/+/, "");
}

export function parentOf(p: string): string {
	const i = p.lastIndexOf("/");
	return i < 0 ? "" : p.slice(0, i);
}

/** Local time, for trash folder names. */
export function stamp(): string {
	const d = new Date();
	const z = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}
