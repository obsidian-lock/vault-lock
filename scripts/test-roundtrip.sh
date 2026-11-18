#!/usr/bin/env bash
# Round trip of signed plugin code: the real server/vlb signs and publishes, and both a check
# written here from the payload rules and the plugin's own verifyManifest() and checkBundle() (from
# scripts/.build/testable.cjs, which npm test builds first) accept it and refuse any changed byte.
#
# Needs python3, openssl 3 or later and node. Never touches real paths: VLB_ROOT, VLB_KEY_DIR,
# VLB_ARCHIVE and VLB_RELEASES point into a temp dir, and a fake docker first in PATH records
# any container restart instead of doing it.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
VLB="$repo/server/vlb"
TESTABLE="$repo/scripts/.build/testable.cjs"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export VLB_ROOT="$tmp/root" VLB_KEY_DIR="$tmp/keys" VLB_ARCHIVE="$tmp/archive" VLB_RELEASES="file://$tmp/releases"
# vlb process checks the caps: a nearly full CI disk must not freeze the stranger (a restart) mid-test.
export VLB_DISK_MIN_FREE_MB=0

ok() { echo "ok - $*"; }
fail() { echo "FAIL - $*" >&2; exit 1; }
vlb() { python3 "$VLB" "$@"; }
# refuses WHAT CMD...: CMD must fail
refuses() {
	local what=$1; shift
	if "$@" >"$tmp/out" 2>&1; then cat "$tmp/out"; fail "$what: expected a refusal"; fi
	ok "$what (says: $(tail -n 1 "$tmp/out"))"
}
mode() { python3 -c 'import os, sys; print(oct(os.stat(sys.argv[1]).st_mode & 0o777)[2:])' "$1"; }
# field MANIFEST KEY: a field of the signed payload (decoded, not verified)
field() { python3 -c 'import base64, json, sys; p = json.loads(base64.b64decode(json.load(open(sys.argv[1]))["payload"])); print(json.dumps(p.get(sys.argv[2])))' "$1" "$2"; }
# jget FILE EXPR: a value from a JSON file, EXPR in Python with the file as j
jget() { python3 -c 'import json, sys; j = json.load(open(sys.argv[1])); print(json.dumps(eval(sys.argv[2])))' "$1" "$2"; }
no_docker() { [ ! -s "$tmp/docker-calls" ] || fail "$1 called docker: $(cat "$tmp/docker-calls")"; }

# Ed25519 with -rawin needs OpenSSL 3 or later; macOS ships LibreSSL as /usr/bin/openssl.
if ! openssl version 2>/dev/null | grep -q '^OpenSSL [3-9]'; then
	for dir in /opt/homebrew/opt/openssl/bin /opt/homebrew/bin /usr/local/opt/openssl/bin; do
		if [ -x "$dir/openssl" ] && "$dir/openssl" version | grep -q '^OpenSSL [3-9]'; then export PATH="$dir:$PATH"; break; fi
	done
fi
openssl version | grep -q '^OpenSSL [3-9]' || fail "needs OpenSSL 3 or later, found: $(openssl version)"
echo "# $(python3 --version), $(openssl version | cut -d' ' -f1-2), node $(node --version)"

# A fake docker: the commands under test must never restart a container, and none ever may here.
mkdir -p "$tmp/bin"
printf '#!/bin/sh\necho "$*" >> "%s/docker-calls"\n' "$tmp" > "$tmp/bin/docker"
chmod +x "$tmp/bin/docker"
export PATH="$tmp/bin:$PATH"
[ "$(command -v docker)" = "$tmp/bin/docker" ] || fail "the fake docker is not first in PATH"

# Two paired computers: "test" is yours, "other" is a stranger.
D="$VLB_ROOT/data/devices"
mkdir -p "$D/test-abc123" "$D/other-fedcba"
HASH='$2a$06$'"$(printf '%053d' 0)"
cat > "$VLB_ROOT/state.json" <<EOF
{"pairing": {"open": true, "since": "2026-11-05T00:00:00Z", "only": null},
 "devices": [
  {"id": "0123456789abcdef", "username": "d-0123456789abcdef", "hash": "$HASH", "folder": "test-abc123",
   "name": "test", "user": "ci", "os": "linux", "plugin": "1.7.0", "pairedAt": "2026-11-05T00:00:00Z", "mine": true, "frozen": null},
  {"id": "fedcba9876543210", "username": "d-fedcba9876543210", "hash": "$HASH", "folder": "other-fedcba",
   "name": "other", "user": "ci", "os": "linux", "plugin": "1.7.0", "pairedAt": "2026-11-05T00:00:00Z", "mine": false, "frozen": null}],
 "extraUsers": [], "banned": [], "moves": {}}
EOF

# The plugin-side check (B.4). usage: node check.cjs MANIFEST HEXFILE BUNDLE KIND VERSION [MODE]
# MODE (flip-payload, flip-sig, wrong-key, flip-bundle) changes one thing and expects a refusal.
cat > "$tmp/check.cjs" <<'EOF'
const crypto = require("crypto"), fs = require("fs");
const [manifestPath, hexPath, bundlePath, kind, version, mode, testablePath] = process.argv.slice(2);
const MAX_MANIFEST = 4096, MAX_PAYLOAD = 2048, MAX_BUNDLE = 2097152;
function no(why) { throw new Error(why); }
function verifyManifest(text, keysHex) {
	if (Buffer.byteLength(text, "utf8") > MAX_MANIFEST) no("manifest too big");
	let env; try { env = JSON.parse(text); } catch { no("manifest is not JSON"); }
	if (!env || typeof env !== "object" || typeof env.payload !== "string" || typeof env.sig !== "string") no("not an envelope");
	const sig = Buffer.from(env.sig, "base64"), payload = Buffer.from(env.payload, "base64");
	if (sig.length !== 64) no("signature is not 64 bytes");
	if (payload.length > MAX_PAYLOAD) no("payload too big");
	if (!keysHex.some((h) => crypto.verify(null, payload, { key: Buffer.from(h, "hex"), format: "der", type: "spki" }, sig))) no("signature invalid");
	let p; try { p = JSON.parse(payload.toString("utf8")); } catch { no("payload is not JSON"); }
	if (!p || typeof p !== "object") no("payload is not an object");
	if (p.v !== 1) no("v is not 1");
	if (p.kind !== "app" && p.kind !== "core") no("bad kind");
	if (typeof p.version !== "string" || !/^\d+\.\d+\.\d+$/.test(p.version)) no("bad version");
	if (typeof p.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(p.sha256)) no("bad sha256");
	if (!Number.isInteger(p.size) || p.size < 1 || p.size > MAX_BUNDLE) no("bad size");
	if (p.force !== undefined && typeof p.force !== "boolean") no("bad force");
	if (p.minCore !== undefined && (!Number.isInteger(p.minCore) || p.minCore < 1)) no("bad minCore");
	if (typeof p.at !== "string" || Number.isNaN(Date.parse(p.at))) no("bad at");
	if (p.note !== undefined && typeof p.note !== "string") no("bad note");
	return { ...p, force: p.force ?? false, minCore: p.minCore ?? 1 };
}
function checkBundle(bytes, p) {
	if (bytes.length !== p.size) no("size mismatch");
	if (crypto.createHash("sha256").update(bytes).digest("hex") !== p.sha256) no("sha256 mismatch");
}
let text = fs.readFileSync(manifestPath, "utf8");
let keys = [fs.readFileSync(hexPath, "utf8").trim()];
let bundle = fs.readFileSync(bundlePath);
if (mode === "flip-payload") {
	const env = JSON.parse(text), b = Buffer.from(env.payload, "base64");
	b[b.length - 3] ^= 1;
	text = JSON.stringify({ payload: b.toString("base64"), sig: env.sig });
} else if (mode === "flip-sig") {
	const env = JSON.parse(text), b = Buffer.from(env.sig, "base64");
	b[10] ^= 1;
	text = JSON.stringify({ payload: env.payload, sig: b.toString("base64") });
} else if (mode === "wrong-key") {
	keys = [crypto.generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("hex")];
} else if (mode === "flip-bundle") {
	bundle = Buffer.from(bundle);
	bundle[0] ^= 1;
}
const checks = [["this script", verifyManifest, checkBundle]];
if (!testablePath || !fs.existsSync(testablePath)) { console.error(`FAIL: ${testablePath} is missing: run node scripts/build-tests.mjs first`); process.exit(1); }
const t = require(testablePath);
if (typeof t.verifyManifest !== "function" || typeof t.checkBundle !== "function") { console.error("FAIL: testable.cjs has no verifyManifest/checkBundle"); process.exit(1); }
checks.push(["the plugin's verifyManifest()", t.verifyManifest, t.checkBundle]);
for (const [who, verify, check] of checks) {
	let p;
	try {
		p = verify(text, keys);
		check(new Uint8Array(bundle), p);
	} catch (e) {
		if (mode) { console.log(`refused by ${who}: ${e.message}`); continue; }
		console.error(`FAIL: ${who}: ${e.message}`); process.exit(1);
	}
	if (mode) { console.error(`FAIL: ${who} accepted a manifest with ${mode}`); process.exit(1); }
	if (p.kind !== kind || p.version !== version) { console.error(`FAIL: ${who}: got ${p.kind} ${p.version}`); process.exit(1); }
	console.log(`verified by ${who}: ${p.kind} ${p.version} sha12 ${p.sha256.slice(0, 12)} force ${p.force}`);
}
EOF
check() { node "$tmp/check.cjs" "$1" "$VLB_KEY_DIR/signing.spki.hex" "$2" "$3" "$4" "${5:-}" "$TESTABLE"; }

# ---- key ---------------------------------------------------------------------------
vlb key init > "$tmp/out"
hex=$(cat "$VLB_KEY_DIR/signing.spki.hex")
[ ${#hex} = 88 ] && [ "${hex:0:24}" = 302a300506032b6570032100 ] || fail "SPKI hex looks wrong: $hex"
grep -q "$hex" "$tmp/out" || fail "key init did not print the hex"
[ "$(mode "$VLB_KEY_DIR/signing.pem")" = 600 ] || fail "signing.pem is not 600"
[ "$(mode "$VLB_KEY_DIR")" = 700 ] || fail "the key folder is not 700"
[ ! -e "$VLB_KEY_DIR/signing.pem.tmp" ] || fail "key init left signing.pem.tmp"
ok "key init: $hex"
refuses "key init twice" vlb key init
vlb key show | grep -q "$hex" || fail "key show does not print the hex"
ok "key show"

# ---- publish an app bundle -------------------------------------------------------------
# Not plain text on purpose: UTF-8, a CR LF and a NUL must arrive byte for byte.
printf 'module.exports = { API: 1, createApp() {} };\r\n// \xc3\xbc \x00 %s\n' "$RANDOM$RANDOM" > "$tmp/app.js"
APP="$D/test-abc123/_control/update/app"
vlb bundle publish "$tmp/app.js" --version 9.9.9 --note ci > /dev/null
cmp -s "$tmp/app.js" "$APP/app.js" || fail "the published app.js differs from the file"
[ "$(mode "$APP/app.js")" = 644 ] && [ "$(mode "$APP/manifest.json")" = 644 ] || fail "published files are not 644"
[ ! -e "$D/other-fedcba/_control" ] || fail "a stranger got a bundle without --only"
[ -f "$VLB_ARCHIVE/9.9.9/app.js" ] && [ -f "$VLB_ARCHIVE/9.9.9/app.manifest.json" ] && [ -f "$VLB_ARCHIVE/9.9.9/meta.json" ] || fail "archive incomplete"
[ "$(field "$APP/manifest.json" note)" = '"ci"' ] || fail "note missing"
[ "$(jget "$VLB_ROOT/state.json" 'j["bundles"]["app"]["targets"]')" = '"mine"' ] || fail "state.bundles.app is not for mine"
[ "$(field "$APP/manifest.json" minCore)" = 3 ] || fail "9.9.9 does not carry minCore 3: $(field "$APP/manifest.json" minCore)"
ok "publish app 9.9.9 to the computers marked yours (minCore 3)"
check "$APP/manifest.json" "$APP/app.js" app 9.9.9
for m in flip-payload flip-sig wrong-key flip-bundle; do
	check "$APP/manifest.json" "$APP/app.js" app 9.9.9 "$m"
done
at1=$(field "$APP/manifest.json" at)

vlb bundle publish "$tmp/app.js" --version 9.9.9 --force > /dev/null
at2=$(field "$APP/manifest.json" at)
[[ "$at2" > "$at1" ]] || fail "a second publish within a second did not get a later at: $at1 then $at2"
[ "$(field "$APP/manifest.json" force)" = true ] || fail "--force not in the payload"
[ "$(field "$APP/manifest.json" note)" = null ] || fail "a note was written without --note (it must be left out, never null)"
check "$APP/manifest.json" "$APP/app.js" app 9.9.9
ok "publish again: at $at1 -> $at2, FORCED, no note"

refuses "publish without --version" vlb bundle publish "$tmp/app.js"
refuses "publish with a bad version" vlb bundle publish "$tmp/app.js" --version 1.7
refuses "publish an unknown computer" vlb bundle publish "$tmp/app.js" --version 9.9.9 --only nobody
head -c 2097153 /dev/zero > "$tmp/big.js"
refuses "publish over 2 MB" vlb bundle publish "$tmp/big.js" --version 9.9.9
: > "$tmp/empty.js"
refuses "publish an empty file" vlb bundle publish "$tmp/empty.js" --version 9.9.9
refuses "publish a note too long for the payload" vlb bundle publish "$tmp/app.js" --version 9.9.9 --note "$(printf '%02000d' 0)"

vlb bundle publish "$tmp/app.js" --version 9.9.8 --only other > /dev/null
check "$D/other-fedcba/_control/update/app/manifest.json" "$D/other-fedcba/_control/update/app/app.js" app 9.9.8
[ "$(field "$D/other-fedcba/_control/update/app/manifest.json" minCore)" = 3 ] || fail "9.9.8 does not carry minCore 3"
[ "$(jget "$VLB_ROOT/state.json" 'j["bundles"]["app"]["version"]')" = '"9.9.9"' ] || fail "an --only publish replaced the record for your computers"
ok "publish --only a stranger; the record for your computers is kept"

# ---- unpublish ---------------------------------------------------------------------------
vlb bundle unpublish > /dev/null
[ ! -e "$APP" ] || fail "unpublish left $(ls "$APP")"
[ -f "$D/other-fedcba/_control/update/app/app.js" ] || fail "unpublish without --only touched a stranger"
[ "$(jget "$VLB_ROOT/state.json" 'j["bundles"]["app"]')" = null ] || fail "unpublish kept the record"
vlb bundle unpublish --only other > /dev/null
[ ! -e "$D/other-fedcba/_control/update" ] || fail "unpublish --only other left files"
vlb bundle unpublish --only test | grep -q "nothing to do" || fail "unpublish twice is not fine"
ok "unpublish (yours, then --only a stranger, then again)"

# ---- core bundles ------------------------------------------------------------------------
printf 'module.exports = { default: class { onload() {} } };\n// core %s\n' "$RANDOM" > "$tmp/main.js"
refuses "publish a local main.js as core" vlb bundle publish "$tmp/main.js" --core --version 1.9.1
refuses "a forced core bundle" vlb bundle publish "$tmp/main.js" --core --version 1.9.1 --unsafe-local --force
vlb bundle publish "$tmp/main.js" --core --version 1.9.1 --unsafe-local > /dev/null
CORE="$D/test-abc123/_control/update/core"
check "$CORE/manifest.json" "$CORE/main.js" core 1.9.1
[ "$(field "$CORE/manifest.json" minCore)" = 2 ] || fail "core 1.9.1 does not carry minCore 2"
vlb bundle unpublish --core > /dev/null
[ ! -e "$CORE" ] || fail "unpublish --core left files"
ok "core: a local main.js only with --unsafe-local, never forced"

# A release as vlb bundle fetch finds it on GitHub (here a file:// folder).
R="$tmp/releases/1.9.2"
mkdir -p "$R" "$tmp/releases/1.6.2"
printf 'module.exports = { API: 1, createApp() {} };\n// release app %s\n' "$RANDOM" > "$R/app.js"
printf 'module.exports = { default: class { onload() {} } };\n// release core %s\n' "$RANDOM" > "$R/main.js"
echo '{"id": "vault-lock", "version": "1.9.2"}' > "$R/manifest.json"
cp "$R/main.js" "$R/manifest.json" "$tmp/releases/1.6.2/"
vlb bundle fetch 1.9.2 > /dev/null
cmp -s "$R/main.js" "$VLB_ARCHIVE/1.9.2/main.js" && cmp -s "$R/app.js" "$VLB_ARCHIVE/1.9.2/app.js" || fail "fetch did not archive the files"
[ "$(jget "$VLB_ARCHIVE/1.9.2/meta.json" 'j["source"]')" = '"github"' ] || fail "meta.json source is not github"
refuses "fetch a release without app.js" vlb bundle fetch 1.6.2
[ -z "$(ls "$VLB_ARCHIVE/1.6.2")" ] || fail "a failed fetch left files: $(ls "$VLB_ARCHIVE/1.6.2")"
refuses "fetch a release whose manifest says another version" bash -c "mkdir -p '$tmp/releases/1.9.3' && cp '$R'/* '$tmp/releases/1.9.3/' && python3 '$VLB' bundle fetch 1.9.3"
ok "fetch"

vlb bundle publish 1.9.2 --core > /dev/null
check "$CORE/manifest.json" "$CORE/main.js" core 1.9.2
vlb bundle publish 1.9.2 > /dev/null
check "$APP/manifest.json" "$APP/app.js" app 1.9.2
[ "$(field "$CORE/manifest.json" minCore)" = 2 ] && [ "$(field "$APP/manifest.json" minCore)" = 2 ] || fail "release 1.9.2 does not carry minCore 2"
refuses "publish a local file as a fetched release's version" vlb bundle publish "$tmp/app.js" --version 1.9.2
refuses "publish an archive with another --version" vlb bundle publish 1.9.2 --version 1.9.3
echo "// changed" >> "$VLB_ARCHIVE/1.9.2/main.js"
refuses "publish a changed main.js from the archive as core" vlb bundle publish 1.9.2 --core
ok "publish a fetched release as core and as app"

# ---- the publish floor (1.9.0) and minCore -------------------------------------------------
# Plugin code older than 1.9.0 would trash the readable private notes on the server: never published.
refuses "publish app 1.8.0" vlb bundle publish "$tmp/app.js" --version 1.8.0 --only other
grep -q "older than 1.9.0" "$tmp/out" || fail "the 1.8.0 refusal does not say why: $(cat "$tmp/out")"
refuses "publish core 1.8.0" vlb bundle publish "$tmp/main.js" --core --version 1.8.0 --unsafe-local --only other
refuses "publish app 0.0.1" vlb bundle publish "$tmp/app.js" --version 0.0.1 --force --only other
[ ! -e "$VLB_ARCHIVE/1.8.0" ] && [ ! -e "$VLB_ARCHIVE/0.0.1" ] || fail "a refused publish wrote into the archive"
# Fetching an old release stays harmless; publishing it is refused, in both slots.
mkdir -p "$tmp/releases/1.8.0"
printf 'module.exports = { API: 1, createApp() {} };\n// old app\n' > "$tmp/releases/1.8.0/app.js"
printf 'module.exports = { default: class { onload() {} } };\n// old core\n' > "$tmp/releases/1.8.0/main.js"
echo '{"id": "vault-lock", "version": "1.8.0"}' > "$tmp/releases/1.8.0/manifest.json"
vlb bundle fetch 1.8.0 > /dev/null
refuses "publish the fetched release 1.8.0" vlb bundle publish 1.8.0 --only other
refuses "publish the fetched release 1.8.0 as core" vlb bundle publish 1.8.0 --core --only other
[ ! -e "$D/other-fedcba/_control/update/core" ] || fail "a refused core publish wrote into the computer's folder"
vlb bundle publish "$tmp/app.js" --version 1.9.0 --only other > /dev/null
[ "$(field "$D/other-fedcba/_control/update/app/manifest.json" minCore)" = 2 ] || fail "app 1.9.0 does not carry minCore 2"
vlb bundle publish "$tmp/main.js" --core --version 1.9.0 --unsafe-local --only other > /dev/null
[ "$(field "$D/other-fedcba/_control/update/core/manifest.json" minCore)" = 2 ] || fail "core 1.9.0 does not carry minCore 2"
vlb bundle publish "$tmp/app.js" --version 2.0.0 --only other > /dev/null
[ "$(field "$D/other-fedcba/_control/update/app/manifest.json" minCore)" = 3 ] || fail "app 2.0.0 does not carry minCore 3"
check "$D/other-fedcba/_control/update/app/manifest.json" "$D/other-fedcba/_control/update/app/app.js" app 2.0.0
[ "$(jget "$VLB_ROOT/state.json" 'j["bundles"]["app"]["version"]')" = '"1.9.2"' ] || fail "an --only publish replaced the record for your computers"
ok "publish floor: below 1.9.0 refused in both slots; minCore 2 for 1.9.x, 3 for 2.0.0"

# ---- safe mode ---------------------------------------------------------------------------
CFG="$D/test-abc123/_control/config.json"
echo '{"idleMinutes": 7, "reconcileMinutes": 3, "core": {"watchdogMinutes": 30}}' > "$CFG"
vlb safemode on --only test > /dev/null
[ "$(jget "$CFG" 'j["core"]["safeMode"]')" = true ] || fail "safeMode not set"
[ "$(jget "$CFG" '[j["idleMinutes"], j["reconcileMinutes"], j["core"]["watchdogMinutes"]]')" = '[7, 3, 30]' ] || fail "safemode lost other keys"
[ "$(mode "$CFG")" = 644 ] || fail "config.json is not 644"
vlb safemode on --only other > /dev/null
[ "$(jget "$D/other-fedcba/_control/config.json" 'j')" = '{"core": {"safeMode": true}}' ] || fail "safemode on a computer without config.json"
refuses "safemode with a bad word" vlb safemode maybe
ok "safemode on keeps the other keys"

# ---- encryption switch -------------------------------------------------------------------
vlb encrypt off --only test > /dev/null
[ "$(jget "$CFG" 'j["encrypt"]')" = false ] || fail "encrypt off did not write encrypt: false"
[ "$(jget "$CFG" '[j["idleMinutes"], j["reconcileMinutes"], j["core"]]')" = '[7, 3, {"watchdogMinutes": 30, "safeMode": true}]' ] || fail "encrypt off lost other keys (core.safeMode included): $(cat "$CFG")"
[ "$(mode "$CFG")" = 644 ] || fail "config.json is not 644 after encrypt"
vlb encrypt on > /dev/null
[ "$(jget "$CFG" 'j["encrypt"]')" = true ] || fail "encrypt on (your computers) did not write encrypt: true"
[ "$(jget "$D/other-fedcba/_control/config.json" 'j.get("encrypt")')" = null ] || fail "encrypt without --only touched a stranger"
refuses "encrypt with a bad word" vlb encrypt maybe
refuses "encrypt an unknown computer" vlb encrypt off --only nobody
ok "encrypt off/on edits only encrypt in config.json"

# ---- status ------------------------------------------------------------------------------
vlb status > "$tmp/status"
grep -q "published: app 1.9.2 .* -> plugin says: nothing yet (never checked in)" "$tmp/status" || { cat "$tmp/status"; fail "status: no published app line"; }
grep -q "published: core 1.9.2 " "$tmp/status" || { cat "$tmp/status"; fail "status: no published core line"; }
grep -q "SAFE MODE requested in config.json" "$tmp/status" || { cat "$tmp/status"; fail "status: no SAFE MODE line"; }
! grep -q "^    encryption" "$tmp/status" || { cat "$tmp/status"; fail "status: an encryption line for a computer that never checked in"; }
ok "status without status.json"
echo '{"at": "2026-11-05T00:00:00.000Z", "version": "1.6.2", "lastError": null}' > "$D/other-fedcba/_control/status.json"
sha12=$(python3 -c 'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest()[:12])' "$APP/app.js")
cat > "$D/test-abc123/_control/status.json" <<EOF
{"at": "2099-01-01T00:00:00.000Z", "version": "1.9.0", "lastError": null,
 "core": {"coreVersion": 2, "running": "server", "runningId": "server:$sha12", "runningVersion": "1.9.2",
  "startedAt": "2099-01-01T00:00:00.000Z", "builtin": "1.9.0",
  "server": {"version": "1.9.2", "sha12": "$sha12", "force": false, "minCore": 2, "state": "active", "why": "", "at": "2099-01-01T00:00:00Z"},
  "pending": null, "bad": {"builtin:1.9.0": {"n": 2, "at": "2099-01-01T00:00:00.000Z", "why": "crash"}},
  "lastGood": null, "sick": null, "safeMode": false, "watchdogMinutes": 120,
  "lastHeartbeat": null, "lastUpdateCheck": "2099-01-01T00:00:00.000Z", "updateError": "core: does not compile", "coreInstalled": null}}
EOF
vlb status > "$tmp/status"
for want in "plugin code: server bundle 1.9.2 active (core 2); built-in 1.9.0" \
	"published: app 1.9.2 .* -> plugin says: running it" \
	"published: core 1.9.2 .* -> plugin says: core: does not compile" \
	"plugin problems: update error: core: does not compile; bad: builtin:1.9.0 (crashed at start)" \
	"plugin code: (plugin older than 1.7.0: no core)" \
	"encryption: (plugin older than 1.9.0)"; do
	grep -q "$want" "$tmp/status" || { cat "$tmp/status"; fail "status: no line like: $want"; }
done
ok "status with and without a core section"
# Any computer can write any status.json: an odd one in the first computer listed costs its own
# lines, never the listing of the computers after it, and is no error in vlb.log.
cat > "$D/test-abc123/_control/status.json" <<'EOF'
{"at": "x", "version": [1], "lastReconcile": "x",
 "core": {"running": "lifeboat", "builtin": "1.9.0", "server": {"state": ["a"]}, "updateError": ["a"],
  "bad": {"builtin:1.9.0": {"n": "2", "at": "x", "why": ["a"]}}},
 "encryption": {"files": [1], "failed": "x"}}
EOF
vlb status > "$tmp/status" || { cat "$tmp/status"; fail "status stopped at an odd status.json"; }
for want in "last check-in: (not understood" "plugin code: (not understood" "published: (not understood" \
	"encryption: (not understood" "plugin code: (plugin older than 1.7.0: no core)" "encryption: (plugin older than 1.9.0)"; do
	grep -qF "$want" "$tmp/status" || { cat "$tmp/status"; fail "status with an odd status.json: no line like: $want"; }
done
! grep -q ERROR "$VLB_ROOT/vlb.log" || fail "an odd status.json logged an error: $(grep ERROR "$VLB_ROOT/vlb.log")"
ok "status with an odd status.json"
vlb help | grep -q "vlb bundle publish FILE|V" || fail "help does not list the bundle commands"
vlb help | grep -q "vlb encrypt on|off" && vlb help | grep -q "vlb vaultkey COMPUTER" && vlb help | grep -q "vault-keys" \
	&& vlb help | grep -q "older than 1.9.0 are refused" || fail "help does not list encrypt, vaultkey, the key location and the floor"
no_docker "key, bundle, safemode, encrypt or status"
ok "none of key, bundle, safemode, encrypt, status touched docker"

# ---- vlb mine copies what your computers have --------------------------------------------
# A forced --only test of the same version first: vlb mine must still give what your computers
# got (not forced), signed again with a later at so the plugin's replay guard takes it.
OTHER="$D/other-fedcba/_control/update/app"
vlb bundle publish 1.9.2 --only other --force > /dev/null
at_only=$(field "$OTHER/manifest.json" at)
vlb mine other > /dev/null
cmp -s "$APP/app.js" "$OTHER/app.js" || fail "vlb mine did not copy the app bundle"
check "$OTHER/manifest.json" "$OTHER/app.js" app 1.9.2
[ "$(field "$OTHER/manifest.json" force)" = false ] || fail "vlb mine gave the forced --only manifest, not what your computers got"
[ "$(field "$OTHER/manifest.json" minCore)" = 2 ] || fail "vlb mine signed 1.9.2 without minCore 2"
at_mine=$(field "$OTHER/manifest.json" at)
[[ "$at_mine" > "$at_only" ]] || fail "vlb mine kept an older at: $at_only then $at_mine"
[ "$(jget "$VLB_ROOT/state.json" 'j["bundleAt"]["app"]')" = "$at_mine" ] || fail "vlb mine did not record its at"
grep -q "could not copy the core bundle 1.9.2" "$VLB_ROOT/vlb.log" || fail "vlb mine copied a core bundle whose archive changed"
ok "vlb mine copies the bundles published to your computers (and refuses a changed archive)"

# A record of plugin code below the floor (published by an older vlb) is never copied to a
# computer newly marked yours, and the record itself is left alone.
python3 - "$VLB_ROOT/state.json" <<'PY'
import json, sys
s = json.load(open(sys.argv[1]))
s["devices"][1]["mine"] = False
s["bundles"]["app"] = {"version": "1.8.0", "sha12": "000000000000", "force": False, "at": "2026-11-01T00:00:00Z", "targets": "mine"}
json.dump(s, open(sys.argv[1], "w"))
PY
cat "$OTHER/manifest.json" "$OTHER/app.js" > "$tmp/other-app-before"
vlb mine other > /dev/null
grep -q "not copied: the app bundle 1.8.0 published to your computers is older than 1.9.0" "$VLB_ROOT/vlb.log" || fail "vlb mine did not log the refused old record"
cat "$OTHER/manifest.json" "$OTHER/app.js" | cmp -s - "$tmp/other-app-before" || fail "vlb mine replaced the app bundle with a record below the floor"
[ "$(jget "$VLB_ROOT/state.json" 'j["bundles"]["app"]["version"]')" = '"1.8.0"' ] || fail "vlb mine changed the record"
ok "vlb mine never copies a bundle below 1.9.0"

# ---- vault keys ------------------------------------------------------------------------------
KEYS="$VLB_KEY_DIR/vault-keys"
T_ID=0123456789abcdef O_ID=fedcba9876543210 N_ID=00112233445566aa
PUB_T="$D/test-abc123/_control/vault-key.json" PUB_O="$D/other-fedcba/_control/vault-key.json"
LOGF="$VLB_ROOT/vlb.log"
[ ! -e "$KEYS" ] && [ ! -e "$PUB_T" ] || fail "a vault key was made before vlb process"
# process: run vlb process quietly (on macOS du -sb fails and folder_size is 0, which is fine)
process() { vlb process > "$tmp/process.out" 2>&1 || { cat "$tmp/process.out"; fail "vlb process failed"; }; }
keyof() { jget "$1" 'j["key"]'; }
: > "$tmp/docker-calls"
process
! grep -qv '^logs ' "$tmp/docker-calls" || fail "vlb process called docker for more than its logs: $(cat "$tmp/docker-calls")"
: > "$tmp/docker-calls"
[ "$(mode "$KEYS")" = 700 ] || fail "the vault-keys folder is not 700"
for pair in "$T_ID:$PUB_T" "$O_ID:$PUB_O"; do
	id=${pair%%:*} pub=${pair#*:}
	m="$KEYS/$id.json"
	[ -f "$m" ] && [ "$(mode "$m")" = 600 ] || fail "master $m missing or not 600"
	[ "$(jget "$m" 'j["id"]')" = "\"$id\"" ] && [ "$(jget "$m" 'j["v"]')" = 1 ] || fail "master $m has the wrong id or v"
	[[ "$(keyof "$m")" =~ ^\"[0-9a-f]{64}\"$ ]] || fail "master $m key is not 64 hex: $(keyof "$m")"
	[ -f "$pub" ] && [ "$(mode "$pub")" = 644 ] || fail "published copy $pub missing or not 644"
	[ "$(jget "$pub" '[j["v"], j["id"], j["key"], j["at"]]')" = "$(jget "$m" '[j["v"], j["id"], j["key"], j["at"]]')" ] || fail "$pub is not the master's copy"
done
[ "$(keyof "$KEYS/$T_ID.json")" != "$(keyof "$KEYS/$O_ID.json")" ] || fail "two computers got the same key"
grep -q "made the vault key for d-$T_ID" "$LOGF" && grep -q "vault key of test written to its folder" "$LOGF" || fail "vlb process did not log the keys"
T_KEY=$(keyof "$KEYS/$T_ID.json")
ok "vlb process makes a master (600, dir 700) and a copy in the folder (644) for every computer"

for f in "$KEYS/$T_ID.json" "$KEYS/$O_ID.json" "$PUB_T" "$PUB_O"; do cp "$f" "$f.saved"; done
process
for f in "$KEYS/$T_ID.json" "$KEYS/$O_ID.json" "$PUB_T" "$PUB_O"; do cmp -s "$f" "$f.saved" || fail "a second vlb process changed $f"; done
ok "a second vlb process changes nothing"

echo 'junk' > "$PUB_T"
process
cmp -s "$PUB_T" "$PUB_T.saved" || fail "vlb process did not put the master's copy back: $(cat "$PUB_T")"
[ "$(mode "$PUB_T")" = 644 ] || fail "the restored copy is not 644"
ok "an overwritten copy in the folder is put back"

echo '{"id": "junk"}' > "$KEYS/$T_ID.json"
process
grep -q "could not write the vault key for test: .* not a valid key file" "$LOGF" || fail "a junk master was not reported"
[ "$(cat "$KEYS/$T_ID.json")" = '{"id": "junk"}' ] || fail "vlb process overwrote a master it could not read"
cmp -s "$PUB_T" "$PUB_T.saved" && cmp -s "$PUB_O" "$PUB_O.saved" || fail "a junk master changed a published copy"
refuses "vaultkey with a junk master" vlb vaultkey test
grep -q "not a valid key file" "$tmp/out" || fail "vaultkey does not say the master is unreadable"
cp "$KEYS/$T_ID.json.saved" "$KEYS/$T_ID.json"
ok "a master that does not parse is reported, never replaced"

made_before=$(grep -c "made the vault key for d-$T_ID" "$LOGF")
rm "$KEYS/$T_ID.json"
process
grep -q "vault key of test: master recovered from the published copy" "$LOGF" || fail "the lost master was not recovered"
[ "$(keyof "$KEYS/$T_ID.json")" = "$T_KEY" ] || fail "the recovered master is not the published key"
[ "$(mode "$KEYS/$T_ID.json")" = 600 ] || fail "the recovered master is not 600"
[ "$(grep -c "made the vault key for d-$T_ID" "$LOGF")" = "$made_before" ] || fail "a new key was made while a copy existed"
cmp -s "$PUB_T" "$PUB_T.saved" || fail "recovering the master changed the published copy"
ok "a lost master comes back from the published copy (never a new key)"

# A pairing request: the new computer's key exists before the container restart gives it a login.
mkdir -p "$VLB_ROOT/inbox"
printf '{"id": "%s", "hash": "%s", "name": "newpc", "user": "ci", "os": "linux", "plugin": "1.9.0"}' "$N_ID" "$HASH" > "$VLB_ROOT/inbox/$N_ID.json"
lines=$(wc -l < "$LOGF")
process
tail -n +"$((lines + 1))" "$LOGF" > "$tmp/newlog"
NEW="$D/newpc-001122"
[ -f "$KEYS/$N_ID.json" ] && [ -f "$NEW/_control/vault-key.json" ] || { cat "$tmp/newlog"; fail "the new computer has no key"; }
[ "$(keyof "$NEW/_control/vault-key.json")" = "$(keyof "$KEYS/$N_ID.json")" ] || fail "the new computer's copy is not its master"
made=$(grep -n "made the vault key for d-$N_ID" "$tmp/newlog" | head -n 1 | cut -d: -f1)
restarted=$(grep -n "restarted obsidian-webdav" "$tmp/newlog" | head -n 1 | cut -d: -f1)
[ -n "$made" ] && [ -n "$restarted" ] && [ "$made" -lt "$restarted" ] || { cat "$tmp/newlog"; fail "the key was not made before the restart"; }
grep -q '^restart obsidian-webdav' "$tmp/docker-calls" || fail "the pairing did not restart the webdav container"
: > "$tmp/docker-calls"
ok "pairing through the inbox: key made, then the container restarted"

# vlb status: the encryption line (and none for a computer that never checked in).
# enc_fixture STATUS_FILE JSON: a 1.9.0 status.json whose encryption section is a healthy one
# changed by JSON.
enc_fixture() {
	python3 - "$1" "$2" <<'PY'
import json, sys
e = {"on": True, "keyId": "0123456789abcdef", "keyDurable": True, "keyState": "ok", "serverKeyId": None,
     "files": 12, "plain": 0, "failed": [], "tooBig": [], "undecryptable": 0, "recovered": 0,
     "hideError": None, "lastPass": None, "restoreDeferred": []}
e.update(json.loads(sys.argv[2]))
json.dump({"at": "2099-01-01T00:00:00.000Z", "version": "1.9.0", "lastError": None, "encryption": e}, open(sys.argv[1], "w"))
PY
}
# block NAME: the lines vlb status printed for that computer
block() { awk -v n="$1" '/^- /{p = index($0, ": " n " (") > 0} p' "$tmp/status"; }
ST_T="$D/test-abc123/_control/status.json" ST_O="$D/other-fedcba/_control/status.json"
enc_fixture "$ST_T" '{}'
enc_fixture "$ST_O" '{"plain": 1, "failed": ["Private/a.md: verify failed"], "undecryptable": 2, "tooBig": ["Private/big.bin"], "hideError": "rename failed: EPERM", "restoreDeferred": ["x"], "keyId": "fedcba9876543210"}'
vlb status > "$tmp/status" || { cat "$tmp/status"; fail "status failed"; }
block test | grep -qx "    encryption: on, key 0123456789abcdef, 12 files encrypted" || { cat "$tmp/status"; fail "status: no healthy encryption line"; }
! block test | grep -q "encryption problems" || { cat "$tmp/status"; fail "status: problems for a healthy computer"; }
for want in "encryption: on, key fedcba9876543210, 12 files encrypted, 1 plain, 1 failed, 2 undecryptable, 1 over 100 MB" \
	"encryption problems: folder not hidden: rename failed: EPERM; failed: Private/a.md: verify failed" \
	"encryption problems: private restore pending (x): private files are not backed up until the first backup run after an unlock"; do
	block other | grep -qF "$want" || { cat "$tmp/status"; fail "status: no line like: $want"; }
done
block newpc | grep -q "never checked in" || { cat "$tmp/status"; fail "status: newpc block not found"; }
! block newpc | grep -q "encryption" || { cat "$tmp/status"; fail "status: an encryption line for a computer that never checked in"; }
ok "status: healthy, counts and problems, nothing for a computer that never checked in"

enc_fixture "$ST_T" '{"keyId": null, "keyState": "unsaved", "keyDurable": false, "files": 0, "plain": 3}'
enc_fixture "$ST_O" '{"keyState": "mismatch", "serverKeyId": "aaaaaaaaaaaaaaaa", "keyId": "fedcba9876543210"}'
vlb status > "$tmp/status" || { cat "$tmp/status"; fail "status failed"; }
for want in "encryption: on, NO KEY on the computer yet (published $(jget "$PUB_T" 'j["at"]' | tr -d '"'); picked up at its next backup run)" \
	"encryption problems: key not saved on the computer (keyState unsaved): nothing is encrypted until data.json can be written"; do
	block test | grep -qF "$want" || { cat "$tmp/status"; fail "status: no line like: $want"; }
done
block other | grep -qF "encryption: on, key fedcba9876543210 KEY MISMATCH: the server publishes aaaaaaaaaaaaaaaa (the computer keeps its own; see vlb vaultkey)" || { cat "$tmp/status"; fail "status: no mismatch line"; }
enc_fixture "$ST_O" '{"on": false, "files": 0, "plain": 3}'
mv "$PUB_T" "$tmp/pub-t-away"
vlb status > "$tmp/status" || { cat "$tmp/status"; fail "status failed"; }
block test | grep -qF "encryption: on, NO KEY on the computer yet (none published yet: vlb process makes one within 15 s)" || { cat "$tmp/status"; fail "status: no 'none published' line"; }
block other | grep -qF "encryption: OFF (vlb encrypt on turns it on), 0 files encrypted, 3 plain" || { cat "$tmp/status"; fail "status: no OFF line"; }
mv "$tmp/pub-t-away" "$PUB_T"
ok "status: no key (published or not), key not saved, mismatch, off"

# vlb vaultkey
enc_fixture "$ST_T" '{}'
vlb vaultkey test > "$tmp/vk" || { cat "$tmp/vk"; fail "vaultkey test failed"; }
grep -qF "Vault key of test (d-$T_ID, made " "$tmp/vk" && grep -q "$(echo "$T_KEY" | tr -d '"')$" "$tmp/vk" || { cat "$tmp/vk"; fail "vaultkey does not print the key"; }
grep -qx "published copy: present" "$tmp/vk" || { cat "$tmp/vk"; fail "vaultkey: copy not present"; }
grep -qx "plugin reports: key $T_ID, 12 files encrypted" "$tmp/vk" || { cat "$tmp/vk"; fail "vaultkey: no plugin line"; }
grep -q '^A .vlenc file is: "VLENC1", 0x01' "$tmp/vk" || { cat "$tmp/vk"; fail "vaultkey: no format line"; }
rm "$PUB_T"
vlb vaultkey test | grep -qx "published copy: MISSING (next vlb process tick writes it)" || fail "vaultkey: a missing copy is not reported"
vlb vaultkey newpc | grep -qx "plugin reports: nothing yet (never checked in)" || fail "vaultkey: a computer that never checked in"
mv "$KEYS/$N_ID.json" "$tmp/n-master" && mv "$NEW/_control/vault-key.json" "$tmp/n-pub"
refuses "vaultkey for a computer without a key" vlb vaultkey newpc
[ ! -e "$KEYS/$N_ID.json" ] || fail "vlb vaultkey made a key"
mv "$tmp/n-master" "$KEYS/$N_ID.json" && mv "$tmp/n-pub" "$NEW/_control/vault-key.json"
refuses "vaultkey for an unknown computer" vlb vaultkey nobody
refuses "vaultkey for an id without a key" vlb vaultkey d-1111111111111111
no_docker "vaultkey or status"
process
cmp -s "$PUB_T" "$PUB_T.saved" || fail "the next vlb process did not write the missing copy"
: > "$tmp/docker-calls"
ok "vaultkey: key, copy present/missing, plugin report, format; never makes a key"

# A removed computer keeps its master: vlb vaultkey by its login still works.
vlb remove other > /dev/null
: > "$tmp/docker-calls"
vlb vaultkey "d-$O_ID" > "$tmp/vk" || { cat "$tmp/vk"; fail "vaultkey for a removed computer failed"; }
grep -q "(d-$O_ID, made .*): $(keyof "$KEYS/$O_ID.json" | tr -d '"')$" "$tmp/vk" || { cat "$tmp/vk"; fail "vaultkey for a removed computer: no key"; }
grep -qx "published copy: (computer removed)" "$tmp/vk" || { cat "$tmp/vk"; fail "vaultkey for a removed computer: no '(computer removed)'"; }
! grep -q "plugin reports" "$tmp/vk" || fail "vaultkey for a removed computer printed a plugin line"
no_docker "vaultkey"
ok "vaultkey for a removed computer"

# vlb move: the same id pairs again into another folder and its key follows it there.
vlb move test other-fedcba > /dev/null
printf '{"id": "%s", "hash": "%s", "name": "test", "user": "ci", "os": "linux", "plugin": "1.9.0"}' "$T_ID" "$HASH" > "$VLB_ROOT/inbox/$T_ID.json"
process
[ "$(jget "$VLB_ROOT/state.json" '[d["folder"] for d in j["devices"] if d["id"] == "'"$T_ID"'"]')" = '["other-fedcba"]' ] || fail "the move did not happen"
[ "$(keyof "$PUB_O")" = "$T_KEY" ] && [ "$(jget "$PUB_O" 'j["id"]')" = "\"$T_ID\"" ] || fail "the moved computer's folder does not hold its key: $(cat "$PUB_O")"
[ "$(keyof "$KEYS/$T_ID.json")" = "$T_KEY" ] || fail "the move changed the master"
vlb vaultkey test | grep -qx "published copy: present" || fail "vaultkey after the move: copy not present"
ok "vlb move: the same id gets the same key in its new folder"

# ---- a retired stranger's folder ---------------------------------------------------------
# Every folder holds the copy of its vault key from the first tick on. A stranger retired to make
# room (open-door pairing) that never connected leaves no folder behind for good: the copy and an
# empty _control/ are not data. Its master stays in KEY_DIR, and its id is banned as before.
Q_ID=aaaaaaaaaaaaaaaa R_ID=bbbbbbbbbbbbbbbb
python3 - "$VLB_ROOT/state.json" "$HASH" "$Q_ID" <<'PY'
import json, sys
p, h, qid = sys.argv[1:4]
s = json.load(open(p))
s["devices"].append({"id": qid, "username": "d-" + qid, "hash": h, "folder": "quiet-aaaaaa", "name": "quiet", "user": "ci",
                     "os": "linux", "plugin": "1.9.0", "pairedAt": "2026-11-01T00:00:00Z", "mine": False, "frozen": None})
json.dump(s, open(p, "w"), indent=2)
PY
mkdir -p "$D/quiet-aaaaaa"
process
[ -f "$D/quiet-aaaaaa/_control/vault-key.json" ] && [ -f "$KEYS/$Q_ID.json" ] || fail "the quiet stranger got no key"
[ "$(find "$D/quiet-aaaaaa" -type f | wc -l | tr -d ' ')" = 1 ] || fail "the quiet stranger's folder holds more than its key copy: $(find "$D/quiet-aaaaaa" -type f)"
strangers=$(jget "$VLB_ROOT/state.json" 'len([d for d in j["devices"] if not d.get("mine")])')
printf '{"id": "%s", "hash": "%s", "name": "another", "user": "ci", "os": "linux", "plugin": "1.9.0"}' "$R_ID" "$HASH" > "$VLB_ROOT/inbox/$R_ID.json"
lines=$(wc -l < "$LOGF")
VLB_MAX_DEVICES="$strangers" python3 "$VLB" process > "$tmp/process.out" 2>&1 || { cat "$tmp/process.out"; fail "vlb process (full) failed"; }
tail -n +"$((lines + 1))" "$LOGF" > "$tmp/retirelog"
grep -q "retired the oldest stranger quiet (d-$Q_ID); folder data/devices/quiet-aaaaaa removed" "$tmp/retirelog" || { cat "$tmp/retirelog"; fail "the quiet stranger was not retired, or its folder was kept"; }
[ ! -e "$D/quiet-aaaaaa" ] || fail "the retired stranger's folder is still there: $(find "$D/quiet-aaaaaa")"
[ -f "$KEYS/$Q_ID.json" ] || fail "retiring the stranger removed its master key"
[ "$(jget "$VLB_ROOT/state.json" '"'"$Q_ID"'" in j["banned"]')" = true ] || fail "the retired stranger is not banned"
[ -d "$D/another-bbbbbb" ] && [ -f "$D/another-bbbbbb/_control/vault-key.json" ] || fail "the new stranger was not accepted with a key"
: > "$tmp/docker-calls"
ok "a retired stranger that held nothing but its key copy leaves no folder; its master and its ban stay"

# ---- the encryption default for new computers ---------------------------------------------
# A computer that pairs gets {"encrypt": false} (or what vlb encrypt default says) before its login
# works; a move keeps the folder's own choice and its other keys; a retired stranger whose
# config.json holds only that switch still leaves no folder.
PCFG="$D/another-bbbbbb/_control/config.json"
[ "$(jget "$PCFG" 'j')" = '{"encrypt": false}' ] || fail "a new computer did not get encrypt: false at pairing: $(cat "$PCFG" 2>&1)"
[ "$(mode "$PCFG")" = 644 ] || fail "the pairing config.json is not 644"
[ "$(jget "$D/other-fedcba/_control/config.json" '[j["encrypt"], j["core"]["safeMode"]]')" = '[false, true]' ] \
	|| fail "the move into a folder without a choice did not add encrypt: false, or lost its other keys: $(cat "$D/other-fedcba/_control/config.json")"
vlb status > "$tmp/status-def"
grep -qx "New computers: encryption off (vlb encrypt default on|off)" "$tmp/status-def" || fail "status does not show the encryption default"
vlb encrypt default on > /dev/null
[ "$(jget "$VLB_ROOT/state.json" 'j["encryptDefault"]')" = true ] || fail "encrypt default on was not saved"
vlb status | grep -qx "New computers: encryption on (vlb encrypt default on|off)" || fail "status does not show the default on"
[ "$(jget "$PCFG" 'j')" = '{"encrypt": false}' ] || fail "encrypt default changed a paired computer"
S_ID=cccccccccccccccc
printf '{"id": "%s", "hash": "%s", "name": "third", "user": "ci", "os": "linux", "plugin": "1.9.0"}' "$S_ID" "$HASH" > "$VLB_ROOT/inbox/$S_ID.json"
process
[ "$(jget "$D/third-cccccc/_control/config.json" 'j')" = '{"encrypt": true}' ] || fail "with default on, a new computer did not get encrypt: true"
echo '{"encrypt": true, "idleMinutes": 4}' > "$D/other-fedcba/_control/config.json"
vlb encrypt default off > /dev/null
[ "$(jget "$VLB_ROOT/state.json" 'j["encryptDefault"]')" = false ] || fail "encrypt default off was not saved"
vlb move test other-fedcba > /dev/null
printf '{"id": "%s", "hash": "%s", "name": "test", "user": "ci", "os": "linux", "plugin": "1.9.0"}' "$T_ID" "$HASH" > "$VLB_ROOT/inbox/$T_ID.json"
process
[ "$(jget "$D/other-fedcba/_control/config.json" 'j')" = '{"encrypt": true, "idleMinutes": 4}' ] || fail "a move replaced the folder's own encryption choice: $(cat "$D/other-fedcba/_control/config.json")"
refuses "encrypt default with --only" vlb encrypt default on --only test
refuses "encrypt default with a bad word" vlb encrypt default maybe
python3 - "$VLB_ROOT/state.json" <<'PY2'
import json, sys
s = json.load(open(sys.argv[1]))
for d in s["devices"]:
    if d["name"] == "another":
        d["frozen"] = "2026-11-18T00:00:00Z"  # a frozen stranger is retired first
json.dump(s, open(sys.argv[1], "w"), indent=2)
PY2
strangers=$(jget "$VLB_ROOT/state.json" 'len([d for d in j["devices"] if not d.get("mine")])')
U_ID=dddddddddddddddd
printf '{"id": "%s", "hash": "%s", "name": "fourth", "user": "ci", "os": "linux", "plugin": "1.9.0"}' "$U_ID" "$HASH" > "$VLB_ROOT/inbox/$U_ID.json"
VLB_MAX_DEVICES="$strangers" python3 "$VLB" process > "$tmp/process.out" 2>&1 || { cat "$tmp/process.out"; fail "vlb process (full, 2) failed"; }
[ ! -e "$D/another-bbbbbb" ] || fail "a retired stranger with only the pairing config.json kept its folder: $(find "$D/another-bbbbbb")"
[ "$(jget "$D/fourth-dddddd/_control/config.json" 'j')" = '{"encrypt": false}' ] || fail "the fourth computer did not get encrypt: false"
: > "$tmp/docker-calls"
vlb encrypt default off > /dev/null
vlb help | grep -q "vlb encrypt default on|off" || fail "help does not list encrypt default"
no_docker "encrypt default"
ok "new computers get the encryption default at pairing; moves keep a folder's choice; retiring still cleans up"

echo "all round-trip checks passed"
