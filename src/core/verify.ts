import * as crypto from "crypto";
import { MAX_BUNDLE_BYTES, MAX_MANIFEST_BYTES } from "../shared/constants";

/**
 * Checks for plugin code sent by the server. The server signs a small JSON payload
 * (what the bundle is: version, sha256, size, ...) with its Ed25519 key; the plugin knows the
 * public keys (UPDATE_PUBKEYS). Nothing from the server is evaluated unless the signature is
 * right for one of those keys AND the bundle's bytes have exactly the size and sha256 the
 * signed payload names. Node crypto only; no obsidian import (the unit tests load this file).
 */

export type UpdatePayload = {
	v: 1;
	kind: "app" | "core";
	version: string;
	sha256: string;
	size: number;
	force: boolean;
	minCore: number;
	at: string;
	note?: string;
};

export class VerifyError extends Error {}

const MAX_PAYLOAD_BYTES = 2_048;
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;

function no(why: string): never {
	throw new VerifyError(why);
}

function isObj(x: unknown): x is Record<string, unknown> {
	return !!x && typeof x === "object" && !Array.isArray(x);
}

/** The signed envelope { payload, sig } → the payload. Throws VerifyError with a short reason. */
export function verifyManifest(text: string, keysHex: string[]): UpdatePayload {
	if (typeof text !== "string") no("manifest is not text");
	if (Buffer.byteLength(text, "utf8") > MAX_MANIFEST_BYTES) no("manifest too big");
	let env: unknown;
	try { env = JSON.parse(text); } catch { no("manifest is not JSON"); }
	if (!isObj(env) || typeof env.payload !== "string" || typeof env.sig !== "string") no("manifest is not a signed envelope");
	if (!B64.test(env.sig) || !B64.test(env.payload)) no("signature or payload is not base64");
	const sig = Buffer.from(env.sig, "base64");
	const payload = Buffer.from(env.payload, "base64");
	if (sig.length !== 64) no("signature is not 64 bytes");
	if (payload.length > MAX_PAYLOAD_BYTES) no("payload too big");
	if (!keysHex.some((hex) => signedBy(payload, sig, hex))) no("signature invalid");

	// Signed by us: now the payload's own rules.
	let p: unknown;
	try { p = JSON.parse(payload.toString("utf8")); } catch { no("payload is not JSON"); }
	if (!isObj(p)) no("payload is not an object");
	if (p.v !== 1) no("payload v is not 1");
	if (p.kind !== "app" && p.kind !== "core") no("payload kind is not app or core");
	if (typeof p.version !== "string" || !/^\d+\.\d+\.\d+$/.test(p.version)) no("payload version is not x.y.z");
	if (typeof p.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(p.sha256)) no("payload sha256 is not 64 hex");
	if (typeof p.size !== "number" || !Number.isInteger(p.size) || p.size < 1 || p.size > MAX_BUNDLE_BYTES) no("payload size out of range");
	if (p.force !== undefined && typeof p.force !== "boolean") no("payload force is not true/false");
	if (p.minCore !== undefined && (typeof p.minCore !== "number" || !Number.isInteger(p.minCore) || p.minCore < 1)) no("payload minCore is not a whole number ≥ 1");
	if (typeof p.at !== "string" || Number.isNaN(Date.parse(p.at))) no("payload at is not a date");
	if (p.note !== undefined && typeof p.note !== "string") no("payload note is not text");
	const out: UpdatePayload = {
		v: 1,
		kind: p.kind,
		version: p.version,
		sha256: p.sha256,
		size: p.size,
		force: p.force === true,
		minCore: typeof p.minCore === "number" ? p.minCore : 1,
		at: p.at,
	};
	if (typeof p.note === "string") out.note = p.note;
	return out;
}

/** The bundle's bytes are exactly what the signed payload names. Throws VerifyError. */
export function checkBundle(bytes: Uint8Array, p: UpdatePayload): void {
	if (bytes.length !== p.size) no(`size is ${bytes.length} bytes, the signed size is ${p.size}`);
	if (sha256Hex(bytes) !== p.sha256) no("sha256 does not match the signed one");
}

export function sha256Hex(bytes: Uint8Array): string {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** One key: SPKI DER as hex, Ed25519 only. A key that cannot be read signs nothing. */
function signedBy(payload: Buffer, sig: Buffer, hex: string): boolean {
	try {
		const key = crypto.createPublicKey({ key: Buffer.from(hex, "hex"), format: "der", type: "spki" });
		if (key.asymmetricKeyType !== "ed25519") return false;
		return crypto.verify(null, payload, key, sig);
	} catch {
		return false;
	}
}
