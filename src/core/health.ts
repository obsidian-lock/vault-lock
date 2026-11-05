import * as fs from "fs";
import * as path from "path";
import { WATCHDOG_DEFAULT_MIN, WATCHDOG_MAX_MIN, WATCHDOG_MIN_MIN } from "../shared/constants";
import type { CoreConfig } from "../shared/contract";
import type { BadMap } from "./loader";

/**
 * core.json in the plugin folder: what the core remembers between starts (which app is
 * starting, which ones failed, the last server settings for the core). Read and written with
 * Node fs, synchronously, so onunload can still write it. A missing or damaged file means
 * defaults: nothing in it is needed to start the built-in app.
 */

export const CORE_FILE = "core.json";

export type IdAt = { id: string; at: string };
export type Staged = { sha12: string; sha256: string; version: string; force: boolean; minCore: number; at: string; stagedAt: string };

export type CoreState = {
	v: 1;
	/** Written before an app starts, cleared 90 s after a good start or on a clean unload. */
	starting: IdAt | null;
	bad: BadMap;
	lastGood: IdAt | null;
	/** The app the watchdog found not backing up. */
	sick: IdAt | null;
	lastAcceptedAt: { app: string; core: string };
	staged: Staged | null;
	previousSha12: string | null;
	config: CoreConfig;
	lastUpdateCheck: string | null;
	updateError: string | null;
	coreInstalled: { version: string; sha12: string; at: string } | null;
	[key: string]: unknown;
};

export function defaults(): CoreState {
	return {
		v: 1,
		starting: null,
		bad: {},
		lastGood: null,
		sick: null,
		lastAcceptedAt: { app: "", core: "" },
		staged: null,
		previousSha12: null,
		config: parseCoreConfig(undefined),
		lastUpdateCheck: null,
		updateError: null,
		coreInstalled: null,
	};
}

/** The "core" key of config.json (or of core.json): safeMode only when exactly true; watchdog minutes clamped. */
export function parseCoreConfig(c: unknown): CoreConfig {
	const o = isObj(c) ? c : {};
	const w = o.watchdogMinutes;
	return {
		safeMode: o.safeMode === true,
		watchdogMinutes: typeof w === "number" && Number.isFinite(w)
			? Math.min(WATCHDOG_MAX_MIN, Math.max(WATCHDOG_MIN_MIN, w))
			: WATCHDOG_DEFAULT_MIN,
	};
}

/** Never throws: missing, unreadable, not an object, or another v → defaults. Unknown fields are kept. */
export function readCoreState(dir: string): CoreState {
	if (!dir) return defaults();
	let j: unknown;
	try {
		j = JSON.parse(fs.readFileSync(path.join(dir, CORE_FILE), "utf8"));
	} catch {
		return defaults();
	}
	if (!isObj(j) || j.v !== 1) return defaults();
	const s: CoreState = { ...defaults(), ...j, v: 1 };
	// Every known field is checked on its own, so one odd value never costs the others.
	s.starting = idAt(j.starting);
	s.bad = cleanBad(j.bad);
	s.lastGood = idAt(j.lastGood);
	s.sick = idAt(j.sick);
	const la = isObj(j.lastAcceptedAt) ? j.lastAcceptedAt : {};
	s.lastAcceptedAt = { app: str(la.app) ?? "", core: str(la.core) ?? "" };
	s.staged = isObj(j.staged) ? (j.staged as Staged) : null;
	s.previousSha12 = str(j.previousSha12);
	s.config = parseCoreConfig(j.config);
	s.lastUpdateCheck = str(j.lastUpdateCheck);
	s.updateError = str(j.updateError);
	s.coreInstalled = isObj(j.coreInstalled) ? (j.coreInstalled as CoreState["coreInstalled"]) : null;
	return s;
}

/** Synchronous and atomic: core.json.tmp, then rename over core.json. Throws when it cannot write. */
export function writeCoreState(dir: string, s: CoreState): void {
	if (!dir) return;
	const file = path.join(dir, CORE_FILE);
	const text = JSON.stringify(s, null, 1);
	try {
		fs.writeFileSync(file + ".tmp", text);
		fs.renameSync(file + ".tmp", file);
	} catch (e) {
		// Windows: an antivirus scan can hold the file for a moment. A plain write is still
		// better than none; a torn file reads as defaults, which is harmless.
		fs.writeFileSync(file, text);
		console.warn("[VLB] core.json written without the atomic rename:", e);
	}
}

function isObj(x: unknown): x is Record<string, unknown> {
	return !!x && typeof x === "object" && !Array.isArray(x);
}

function str(x: unknown): string | null {
	return typeof x === "string" ? x : null;
}

function idAt(x: unknown): IdAt | null {
	if (!isObj(x) || typeof x.id !== "string" || !x.id) return null;
	return { id: x.id, at: isoOf(x.at) };
}

function isoOf(x: unknown): string {
	if (typeof x === "number" && Number.isFinite(x)) return new Date(x).toISOString();
	return typeof x === "string" ? x : "";
}

function cleanBad(x: unknown): BadMap {
	const out: BadMap = {};
	if (!isObj(x)) return out;
	for (const [id, e] of Object.entries(x)) {
		if (!isObj(e)) continue;
		const n = typeof e.n === "number" && Number.isFinite(e.n) ? e.n : 0;
		out[id] = { n, at: isoOf(e.at), why: str(e.why) ?? "" };
	}
	return out;
}
