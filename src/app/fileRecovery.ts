import type { App as ObsidianApp } from "obsidian";

/**
 * Obsidian's File recovery keeps snapshots of edited notes in IndexedDB (database
 * `<appId>-backup`, store `backups`, index `path`; Obsidian 1.14.4 and 1.15.1). Those of private
 * notes would stay readable there while the folder is hidden, so they go at every lock.
 */

/** Deletes File recovery's snapshots named by keys: a key ending in "/" means every file under
 *  that folder, any other key one file's path. Returns the count, or null when the database or
 *  its store is not there (Obsidian changed, or no IndexedDB in a test). Never throws. */
export async function deleteFileRecoveryRows(app: ObsidianApp, keys: readonly string[]): Promise<number | null> {
	try {
		const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
		const appId = (app as unknown as { appId?: string }).appId;
		// Each row once: a key under a folder key is covered by it.
		const all = [...new Set(keys)].filter((k) => k && k !== "/");
		const ks = all.filter((k) => !all.some((f) => f !== k && f.endsWith("/") && k.startsWith(f)));
		if (!idb || !appId || ks.length === 0) return null;
		const db = await openExisting(idb, appId + "-backup");
		if (!db) return null;
		try {
			if (!db.objectStoreNames.contains("backups")) return null;
			const tx = db.transaction("backups", "readwrite");
			const st = tx.objectStore("backups");
			if (!st.indexNames.contains("path")) { tx.abort(); return null; }
			let n = 0;
			const done = new Promise<void>((resolve, reject) => {
				tx.oncomplete = () => resolve();
				tx.onerror = () => reject(tx.error ?? new Error("transaction failed"));
				tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
			});
			// One cursor per key, all in this transaction.
			for (const k of ks) {
				const range = k.endsWith("/") ? IDBKeyRange.bound(k, k + "￿") : IDBKeyRange.only(k);
				const req = st.index("path").openCursor(range);
				req.onsuccess = () => {
					const c = req.result;
					if (!c) return;
					c.delete();
					n++;
					c.continue();
				};
			}
			await done;
			return n;
		} finally {
			db.close();
		}
	} catch (e) {
		console.warn("[VLB] File recovery clean-up failed", e);
		return null;
	}
}

/** Opens the database at its current version; null when there is none. An upgrade means it did
 *  not exist: that is aborted, so nothing is created. */
function openExisting(idb: IDBFactory, name: string): Promise<IDBDatabase | null> {
	return new Promise((resolve) => {
		let upgrade = false, settled = false;
		const give = (db: IDBDatabase | null) => {
			if (settled) { db?.close(); return; }
			settled = true;
			resolve(db);
		};
		let req: IDBOpenDBRequest;
		try {
			req = idb.open(name);
		} catch {
			give(null);
			return;
		}
		req.onupgradeneeded = () => {
			upgrade = true;
			try { req.transaction?.abort(); } catch { /* already gone */ }
		};
		req.onsuccess = () => {
			if (upgrade) { req.result.close(); give(null); return; }
			give(req.result);
		};
		req.onerror = () => give(null);
		// Another tab upgrading it: give up now; a late success is closed again.
		req.onblocked = () => give(null);
	});
}
