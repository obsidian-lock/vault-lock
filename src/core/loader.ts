import * as fs from "fs";
import * as path from "path";
import { BAD_RETRY_MS, CORE_VERSION } from "../shared/constants";
import { API, AppModule } from "../shared/contract";
import { cmpVersion } from "../shared/version";
import { checkBundle, verifyManifest } from "./verify";

/**
 * Which app runs: the one built into main.js, a signed bundle from the server, or the
 * lifeboat (the core's own small lock and backup). pick() is a pure function of what is
 * known, called at every start and every core tick. The staged server bundle is read and
 * checked here (loadStaged) every time it is considered, so a file changed on disk is never
 * evaluated. No obsidian import: the unit tests load this file.
 */

export const BUNDLES = "bundles";
export const STAGED_MANIFEST = "manifest.json";

export type Candidate = { id: string; kind: "builtin" | "server"; version: string; force: boolean };
/** code: the verified bundle text, only when verified; at: the signed payload's at. */
export type ServerCandidate = Candidate & { kind: "server"; sha256: string; minCore: number; file: string; verified: boolean; why: string; at: string; code?: string };
export type ServerState = "none" | "staged" | "waiting" | "active" | "superseded" | "rejected" | "bad";
export type Pick = { choice: "builtin" | "server" | "lifeboat"; serverState: ServerState; why: string };
/** at: ISO */
export type BadEntry = { n: number; at: string; why: string };
export type BadMap = Record<string, BadEntry>;

export function builtinCandidate(version: string): Candidate {
	return { id: "builtin:" + version, kind: "builtin", version, force: false };
}

/** Failed twice (or once for good: a throw, a timeout, an unlocked start, the watchdog) in the last 24 h. */
export function isBad(bad: BadMap, id: string, now: number): boolean {
	const e = bad[id];
	return !!e && e.n >= 2 && now - Date.parse(e.at) < BAD_RETRY_MS;
}

export function pick(input: { safeMode: boolean; builtin: Candidate; server: ServerCandidate | null; bad: BadMap; now: number; runningId?: string }): Pick {
	const { safeMode, builtin: B, server: S, bad, now, runningId } = input;
	if (safeMode) return { choice: "lifeboat", serverState: S ? "superseded" : "none", why: "safe mode" };
	const sOk = !!S && S.verified && S.minCore <= CORE_VERSION && !isBad(bad, S.id, now);
	const bOk = !isBad(bad, B.id, now);
	let serverState: ServerState = "none";
	let why = "";
	if (S && !S.verified) { serverState = "rejected"; why = S.why; }
	else if (S && S.minCore > CORE_VERSION) { serverState = "rejected"; why = "needs core ≥ " + S.minCore; }
	else if (S && isBad(bad, S.id, now)) { serverState = "bad"; why = bad[S.id].why; }
	let choice: Pick["choice"];
	// Ties go to the built-in: a newer BRAT release supersedes an older unforced server bundle by itself.
	if (sOk && bOk) choice = S.force || cmpVersion(S.version, B.version) > 0 ? "server" : "builtin";
	else if (sOk) choice = "server";
	else if (bOk) choice = "builtin";
	else { choice = "lifeboat"; why = S ? "both candidates are bad" : "the built-in app is bad"; }
	if (choice === "server" && S) serverState = runningId === S.id ? "active" : "waiting";
	else if (sOk) serverState = "superseded";
	return { choice, serverState, why };
}

/** bundles/app-<sha12>.js */
export function bundleName(sha256: string): string {
	return `app-${sha256.slice(0, 12)}.js`;
}

/**
 * The staged server bundle: bundles/manifest.json verified against keysHex, then
 * bundles/app-<sha12>.js checked against it (size, sha256). null when nothing is staged; any
 * failure gives verified: false with the reason. Synchronous, never throws.
 */
export function loadStaged(pluginDir: string, keysHex: string[]): ServerCandidate | null {
	if (!pluginDir) return null;
	const dir = path.join(pluginDir, BUNDLES);
	let text: string;
	try {
		text = fs.readFileSync(path.join(dir, STAGED_MANIFEST), "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
		return unverified("manifest unreadable: " + String((e as Error).message ?? e));
	}
	let p;
	try {
		p = verifyManifest(text, keysHex);
	} catch (e) {
		return unverified("manifest: " + (e as Error).message);
	}
	const file = path.join(dir, bundleName(p.sha256));
	const c: ServerCandidate = {
		id: "server:" + p.sha256.slice(0, 12), kind: "server", version: p.version, force: p.force,
		sha256: p.sha256, minCore: p.minCore, file, verified: false, why: "", at: p.at,
	};
	if (p.kind !== "app") return { ...c, why: "the staged manifest is for a " + p.kind + " bundle" };
	let bytes: Buffer;
	try {
		bytes = fs.readFileSync(file);
	} catch {
		return { ...c, why: "bundle file missing" };
	}
	try {
		checkBundle(bytes, p);
	} catch (e) {
		return { ...c, why: "bundle: " + (e as Error).message };
	}
	return { ...c, verified: true, code: bytes.toString("utf8") };
}

function unverified(why: string): ServerCandidate {
	return { id: "server:?", kind: "server", version: "", force: false, sha256: "", minCore: 1, file: "", verified: false, why, at: "" };
}

/**
 * Evaluates a verified app.js the way Obsidian evaluates main.js; req is main.js's
 * own require, so the bundle gets the same obsidian module. Throws unless it has the module
 * shape of the contract.
 */
export function evaluateApp(code: string, req: NodeRequire): AppModule {
	const m: { exports: Record<string, unknown> } = { exports: {} };
	new Function("module", "exports", "require", code)(m, m.exports, req);
	const x = m.exports;
	if (x.API !== API) throw new Error(`app.js has API ${String(x.API)}, the core needs ${API}`);
	if (typeof x.createApp !== "function") throw new Error("app.js has no createApp");
	return x as unknown as AppModule;
}
