import { requestUrl, RequestUrlResponse } from "obsidian";
import { b64 } from "./crypto";
import { SERVER_URL } from "./server";
import type { VLBSettings } from "./settings";

/** Plain WebDAV requests to this computer's folder on the backup server. */

const REQUEST_TIMEOUT_MS = 60_000; // plus 1 ms per 100 bytes of body, so a big PUT gets its time

export type DavAuth = { base: string; user: string; pass: string };

/** Server address (ending in "/") and login from the settings, read fresh for every request. */
export function authFor(s: VLBSettings): DavAuth {
	let base = s.webdavUrl.trim() || SERVER_URL;
	if (!base.endsWith("/")) base += "/";
	return { base, user: s.webdavUser, pass: s.webdavPass };
}

export function davUrl(auth: DavAuth, sp: string): string {
	return auth.base + sp.split("/").map(encodeURIComponent).join("/");
}

export function basicAuth(auth: DavAuth): string {
	return "Basic " + b64(auth.user + ":" + auth.pass);
}

/** Headers for every request. "no-cache": Obsidian's requestUrl goes through Chromium's HTTP
 *  cache, and the server sends no Cache-Control, so without it a GET of a file only the server
 *  writes (config.json, commands.json, the update slots) could come from the disk cache for days. */
export function davHeaders(auth: DavAuth): Record<string, string> {
	return { Authorization: basicAuth(auth), "Cache-Control": "no-cache" };
}

/** One request; throws DavError unless the status is a success for this method. No answer at
 *  all (offline, connection refused, timeout) is DavError status 0. */
export async function dav(auth: DavAuth, method: string, sp: string, body?: ArrayBuffer | string, headers: Record<string, string> = {}, alsoOk: number[] = []): Promise<RequestUrlResponse> {
	const h: Record<string, string> = { ...davHeaders(auth), ...headers };
	const bytes = typeof body === "string" ? body.length : body ? body.byteLength : 0;
	let r: RequestUrlResponse;
	try {
		r = await withTimeout(requestUrl({ url: davUrl(auth, sp), method, headers: h, body, throw: false }), REQUEST_TIMEOUT_MS + bytes / 100, `${method} ${sp}`);
	} catch (e) {
		throw e instanceof DavError ? e : new DavError(`${method} ${sp}: ${errMsg(e)}`, 0);
	}
	const ok =
		r.status < 300 ||
		alsoOk.includes(r.status) ||
		(method === "MKCOL" && r.status === 405) ||
		(method === "MOVE" && r.status === 404) ||
		(method === "GET" && r.status === 404);
	if (!ok) throw new DavError(`${method} ${sp}: HTTP ${r.status}`, r.status);
	return r;
}

export class DavError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
	}
}

/** Fail instead of waiting forever on a connection that stays open but never answers. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	let timer = 0;
	const limit = new Promise<never>((_, reject) => {
		timer = window.setTimeout(() => reject(new DavError(`${what}: no answer from the server in ${Math.round(ms / 1000)} s`, 0)), ms);
	});
	return Promise.race([p, limit]).finally(() => window.clearTimeout(timer));
}

export function errMsg(e: unknown): string {
	if (e instanceof Error) return e.message;
	return String(e);
}
