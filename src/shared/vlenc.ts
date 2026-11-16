/**
 * The encrypted form of a private file, `<name>.vlenc`. Pure: no obsidian import, so the unit
 * tests load it. AES-256-GCM through WebCrypto with the vault key the server made for this
 * computer.
 *
 *   offset  size  field
 *   0       6     magic "VLENC1"
 *   6       1     format version 0x01
 *   7       8     key id (the 16-hex vault key id) as bytes
 *   15      8     mtime of the plaintext, ms since the epoch, unsigned big-endian
 *   23      12    IV, random per file per encryption
 *   35      n+16  ciphertext of the n plaintext bytes, then the 16-byte GCM tag
 *
 * The 35 header bytes are the additional data, so the key id and the mtime are authenticated
 * too. The smallest file is 51 bytes (an empty plaintext).
 */

export const VLENC_MAGIC = "VLENC1";
export const VLENC_HEADER = 35;
const VERSION = 0x01;
const IV_LEN = 12;
const TAG_LEN = 16;

export type VlencHeader = { keyId: string; mtime: number };

/** Not a .vlenc file: no magic, another version, or too short to hold a header and a tag. */
export class NotVlenc extends Error {}

const KEY_RE = /^[a-f0-9]{64}$/;
const ID_RE = /^[a-f0-9]{16}$/;

/** Raw AES-GCM key, not extractable, for encrypt and decrypt. */
export async function importVaultKey(hex: string): Promise<CryptoKey> {
	if (!KEY_RE.test(hex)) throw new Error("the vault key is not 64 hex characters");
	return globalThis.crypto.subtle.importKey("raw", hexBytes(hex), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export function parseHeader(bytes: Uint8Array): VlencHeader {
	if (bytes.length < VLENC_HEADER + TAG_LEN) throw new NotVlenc("too short for a .vlenc file");
	for (let i = 0; i < VLENC_MAGIC.length; i++) {
		if (bytes[i] !== VLENC_MAGIC.charCodeAt(i)) throw new NotVlenc("no VLENC1 magic");
	}
	if (bytes[6] !== VERSION) throw new NotVlenc("unknown .vlenc version " + bytes[6]);
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let keyId = "";
	for (let i = 7; i < 15; i++) keyId += bytes[i].toString(16).padStart(2, "0");
	return { keyId, mtime: Number(view.getBigUint64(15)) };
}

export async function encryptBytes(key: CryptoKey, keyId: string, plain: Uint8Array, mtime: number): Promise<Uint8Array> {
	if (!ID_RE.test(keyId)) throw new Error("the key id is not 16 hex characters");
	if (!Number.isInteger(mtime) || mtime < 0) throw new Error("mtime is not a whole number of ms");
	const header = new Uint8Array(new ArrayBuffer(VLENC_HEADER));
	for (let i = 0; i < VLENC_MAGIC.length; i++) header[i] = VLENC_MAGIC.charCodeAt(i);
	header[6] = VERSION;
	header.set(hexBytes(keyId), 7);
	new DataView(header.buffer).setBigUint64(15, BigInt(mtime));
	globalThis.crypto.getRandomValues(header.subarray(23, 23 + IV_LEN));
	const ct = await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv: header.subarray(23, 23 + IV_LEN), additionalData: header }, key, asBuffer(plain));
	const out = new Uint8Array(new ArrayBuffer(VLENC_HEADER + ct.byteLength));
	out.set(header, 0);
	out.set(new Uint8Array(ct), VLENC_HEADER);
	return out;
}

/** NotVlenc for a file that is not ours; the WebCrypto OperationError (wrong key, a changed
 *  byte, a cut-off file) comes through as it is. */
export async function decryptBytes(key: CryptoKey, bytes: Uint8Array): Promise<{ plain: Uint8Array; header: VlencHeader }> {
	const header = parseHeader(bytes);
	const aad = asBuffer(bytes.subarray(0, VLENC_HEADER));
	const iv = asBuffer(bytes.subarray(23, 23 + IV_LEN));
	const ct = asBuffer(bytes.subarray(VLENC_HEADER));
	const plain = await globalThis.crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad }, key, ct);
	return { plain: new Uint8Array(plain), header };
}

/** ".vlenc" at the end; a ".vlenc.tmp" is not one. */
export function isVlencName(name: string): boolean {
	return name.endsWith(".vlenc");
}

export function isTmpName(name: string): boolean {
	return name.endsWith(".vlenc.tmp");
}

/** A .vlenc moved aside because this computer's key cannot open it; "-2", "-3" when the name was taken. */
export function isAsideName(name: string): boolean {
	return /\.undecryptable-\d{4}-\d{2}-\d{2}_\d{6}(-\d+)?\.vlenc$/.test(name);
}

/**
 * Test builds only (__VLB_FAULT__ "runtime"): when the test set globalThis.__vlbFault to this
 * step, log it and hang for ever, so the files on disk are what a power cut here would leave.
 * It never throws, so no catch or finally tidies up. Dead code in release builds.
 */
export async function fault(step: string): Promise<void> {
	if (__VLB_FAULT__ === "runtime" && (globalThis as { __vlbFault?: string }).__vlbFault === step) {
		console.log("[VLB] fault stop " + step);
		await new Promise<void>(() => {});
	}
}

function hexBytes(hex: string): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
	for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
	return out;
}

/** WebCrypto takes any view; the typing wants one over a plain ArrayBuffer. */
function asBuffer(u8: Uint8Array): Uint8Array<ArrayBuffer> {
	return u8 as Uint8Array<ArrayBuffer>;
}
