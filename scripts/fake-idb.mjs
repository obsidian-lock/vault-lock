// A small in-memory IndexedDB for the tests of File recovery's clean-up (src/app/fileRecovery.ts):
// open (an aborted upgrade creates nothing), one store per name with keyed indexes, cursors over
// a key range, deletes applied when the transaction commits (no request pending, back at the event
// loop), as the browser does it. Shared by scripts/fileRecovery.test.mjs and scripts/smoke.mjs.

const later = (fn) => setTimeout(fn, 0);
const names = (arr) => ({ contains: (n) => arr.includes(n), length: arr.length, item: (i) => arr[i] ?? null });

/** IDBKeyRange: strings compare by UTF-16 code units, as in the browser. */
export const KeyRange = {
	bound(lower, upper, lowerOpen = false, upperOpen = false) {
		return { lower, upper, lowerOpen, upperOpen, includes: (k) => (lowerOpen ? k > lower : k >= lower) && (upperOpen ? k < upper : k <= upper) };
	},
	only(k) {
		return { lower: k, upper: k, lowerOpen: false, upperOpen: false, includes: (x) => x === k };
	},
};

/** dbs: name → { stores: { store: { indexes: { index: keyPath }, rows: Map(primaryKey → value) } } } */
export function fakeIDB(dbs, { openThrows = false } = {}) {
	const log = { opened: [], closed: 0, transactions: [] };
	const factory = {
		open(name) {
			if (openThrows) throw new Error("SecurityError (test)");
			log.opened.push(name);
			const req = { result: undefined, error: null, transaction: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
			later(() => {
				let def = dbs[name];
				if (!def) {
					// No such database: the browser creates it (version 1) through an upgrade, unless that is aborted.
					const draft = { stores: {} };
					let aborted = false;
					req.transaction = { abort() { aborted = true; } };
					req.result = connection(draft, log);
					req.onupgradeneeded?.({ target: req, oldVersion: 0, newVersion: 1 });
					req.transaction = null;
					if (aborted) {
						req.result = undefined;
						req.error = new Error("AbortError");
						req.onerror?.({ target: req });
						return;
					}
					dbs[name] = def = draft;
				}
				req.result = connection(def, log);
				req.onsuccess?.({ target: req });
			});
			return req;
		},
	};
	return { factory, log };
}

function connection(def, log) {
	return {
		objectStoreNames: names(Object.keys(def.stores)),
		transaction(storeNames, mode = "readonly") {
			const t = transaction(def, [].concat(storeNames), mode);
			log.transactions.push(t);
			return t;
		},
		close() { log.closed++; },
	};
}

/** Deletes are applied when the transaction commits (no request pending, back at the event loop). */
function transaction(def, storeNames, mode) {
	for (const n of storeNames) if (!def.stores[n]) throw new Error("NotFoundError: " + n);
	const deleted = [];
	let pending = 0;
	const tx = {
		mode, error: null, state: "active", oncomplete: null, onerror: null, onabort: null,
		objectStore(n) {
			if (!storeNames.includes(n)) throw new Error("NotFoundError: " + n);
			return store(n);
		},
		abort() {
			if (tx.state !== "active") throw new Error("InvalidStateError");
			tx.state = "aborted";
			later(() => tx.onabort?.({ target: tx }));
		},
	};
	const settle = () => later(() => {
		if (pending > 0 || tx.state !== "active") return;
		tx.state = "committed";
		for (const [s, k] of deleted) def.stores[s].rows.delete(k);
		tx.oncomplete?.({ target: tx });
	});
	const store = (sn) => {
		const s = def.stores[sn];
		return {
			indexNames: names(Object.keys(s.indexes)),
			index(iname) {
				const keyPath = s.indexes[iname];
				if (!keyPath) throw new Error("NotFoundError: " + iname);
				return { openCursor: (range) => cursor(sn, s, keyPath, range) };
			},
		};
	};
	const cursor = (sn, s, keyPath, range) => {
		const rows = [...s.rows]
			.map(([pk, value]) => ({ pk, key: value[keyPath], value }))
			.filter((r) => typeof r.key === "string" && (!range || range.includes(r.key)))
			.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.pk - b.pk));
		let i = 0;
		const req = { result: null, error: null, onsuccess: null, onerror: null, transaction: tx };
		pending++;
		const step = () => later(() => {
			if (tx.state !== "active") return;
			const r = rows[i];
			let continued = false;
			req.result = r ? {
				key: r.key, primaryKey: r.pk, value: r.value,
				delete() {
					if (mode !== "readwrite") throw new Error("ReadOnlyError");
					deleted.push([sn, r.pk]);
					return { onsuccess: null, onerror: null };
				},
				continue() {
					if (continued) throw new Error("InvalidStateError");
					continued = true;
					i++;
					step();
				},
			} : null;
			try {
				req.onsuccess?.({ target: req });
			} catch {
				tx.abort(); // a throwing handler aborts the transaction
				return;
			}
			if (!r || !continued) { pending--; settle(); }
		});
		step();
		return req;
	};
	settle();
	return tx;
}

/** Runs fn with this IndexedDB (or none) as the window's, then puts things back. */
export async function withIDB(idb, fn) {
	const saved = { indexedDB: globalThis.indexedDB, IDBKeyRange: globalThis.IDBKeyRange };
	if (idb) { globalThis.indexedDB = idb; globalThis.IDBKeyRange = KeyRange; } else { delete globalThis.indexedDB; delete globalThis.IDBKeyRange; }
	try { return await fn(); } finally {
		for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; }
	}
}

/** A File recovery store (database "<appId>-backup", store "backups", index "path") holding one
 *  snapshot row per path given (the same path twice makes two rows). */
export function backupsDb(paths) {
	return { stores: { backups: { indexes: { path: "path" }, rows: new Map(paths.map((p, i) => [i + 1, { path: p, ts: 1_700_000_000_000 + i, data: "text " + i }])) } } };
}
