/**
 * The backup server this plugin pairs with. A fork changes these lines.
 *
 * PAIR_LOGIN is public on purpose: on the server it can only create small files in the
 * pairing inbox, and only while pairing is open. It must match PAIR_PASSWORD in server/vlb.
 */
export const SERVER_URL = "https://vault.815431624.xyz/";
export const PAIR_LOGIN = { user: "pair", pass: "vault-lock-backup-pairing" };
/** Where pairing requests go, relative to SERVER_URL. Never used for vault files. */
export const PAIR_DIR = "_pair";
/**
 * Public keys (Ed25519, SPKI DER as hex) that may sign app bundles sent by the server.
 * A list, so a key can be replaced by shipping a release with both.
 */
export const UPDATE_PUBKEYS: string[] = [
	"302a300506032b6570032100013ad6aaff6d668cd02419f35297d7008b4162e5d82186c7b7528f7386d302e4", // 2026-11-05
];
