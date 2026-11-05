const ITERATIONS = 200_000;

export function toHex(b: Uint8Array): string {
	return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function fromHex(h: string): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(new ArrayBuffer(h.length / 2));
	for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substring(i * 2, i * 2 + 2), 16);
	return out;
}

export function randomHex(bytes: number): string {
	const b = new Uint8Array(bytes);
	crypto.getRandomValues(b);
	return toHex(b);
}

/** PBKDF2-SHA256, 200k iterations. Returns hex. */
export async function hashPass(pass: string, saltHex: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveBits"]);
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", salt: fromHex(saltHex), iterations: ITERATIONS, hash: "SHA-256" },
		key,
		256,
	);
	return toHex(new Uint8Array(bits));
}

export function safeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let r = 0;
	for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return r === 0;
}

export function b64(s: string): string {
	return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}
