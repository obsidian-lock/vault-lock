import { BAD_RETRY_MS, CORE_VERSION } from "../shared/constants";
import { cmpVersion } from "../shared/version";

/**
 * Which app runs: the one built into main.js, a signed bundle from the server, or the
 * lifeboat (the core's own small lock and backup). pick() is a pure function of what is
 * known, called at every start and every core tick. Server bundles are read and checked here
 * too (step 4a); until then there is never a server candidate.
 */

export type Candidate = { id: string; kind: "builtin" | "server"; version: string; force: boolean };
export type ServerCandidate = Candidate & { kind: "server"; sha256: string; minCore: number; file: string; verified: boolean; why: string };
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
