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
ok "publish app 9.9.9 to the computers marked yours"
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
refuses "publish a local main.js as core" vlb bundle publish "$tmp/main.js" --core --version 1.7.1
refuses "a forced core bundle" vlb bundle publish "$tmp/main.js" --core --version 1.7.1 --unsafe-local --force
vlb bundle publish "$tmp/main.js" --core --version 1.7.1 --unsafe-local > /dev/null
CORE="$D/test-abc123/_control/update/core"
check "$CORE/manifest.json" "$CORE/main.js" core 1.7.1
vlb bundle unpublish --core > /dev/null
[ ! -e "$CORE" ] || fail "unpublish --core left files"
ok "core: a local main.js only with --unsafe-local, never forced"

# A release as vlb bundle fetch finds it on GitHub (here a file:// folder).
R="$tmp/releases/1.7.2"
mkdir -p "$R" "$tmp/releases/1.6.2"
printf 'module.exports = { API: 1, createApp() {} };\n// release app %s\n' "$RANDOM" > "$R/app.js"
printf 'module.exports = { default: class { onload() {} } };\n// release core %s\n' "$RANDOM" > "$R/main.js"
echo '{"id": "vault-lock", "version": "1.7.2"}' > "$R/manifest.json"
cp "$R/main.js" "$R/manifest.json" "$tmp/releases/1.6.2/"
vlb bundle fetch 1.7.2 > /dev/null
cmp -s "$R/main.js" "$VLB_ARCHIVE/1.7.2/main.js" && cmp -s "$R/app.js" "$VLB_ARCHIVE/1.7.2/app.js" || fail "fetch did not archive the files"
[ "$(jget "$VLB_ARCHIVE/1.7.2/meta.json" 'j["source"]')" = '"github"' ] || fail "meta.json source is not github"
refuses "fetch a release without app.js" vlb bundle fetch 1.6.2
[ -z "$(ls "$VLB_ARCHIVE/1.6.2")" ] || fail "a failed fetch left files: $(ls "$VLB_ARCHIVE/1.6.2")"
refuses "fetch a release whose manifest says another version" bash -c "mkdir -p '$tmp/releases/1.7.3' && cp '$R'/* '$tmp/releases/1.7.3/' && python3 '$VLB' bundle fetch 1.7.3"
ok "fetch"

vlb bundle publish 1.7.2 --core > /dev/null
check "$CORE/manifest.json" "$CORE/main.js" core 1.7.2
vlb bundle publish 1.7.2 > /dev/null
check "$APP/manifest.json" "$APP/app.js" app 1.7.2
refuses "publish a local file as a fetched release's version" vlb bundle publish "$tmp/app.js" --version 1.7.2
refuses "publish an archive with another --version" vlb bundle publish 1.7.2 --version 1.7.3
echo "// changed" >> "$VLB_ARCHIVE/1.7.2/main.js"
refuses "publish a changed main.js from the archive as core" vlb bundle publish 1.7.2 --core
ok "publish a fetched release as core and as app"

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

# ---- status ------------------------------------------------------------------------------
vlb status > "$tmp/status"
grep -q "published: app 1.7.2 .* -> plugin says: nothing yet (never checked in)" "$tmp/status" || { cat "$tmp/status"; fail "status: no published app line"; }
grep -q "published: core 1.7.2 " "$tmp/status" || { cat "$tmp/status"; fail "status: no published core line"; }
grep -q "SAFE MODE requested in config.json" "$tmp/status" || { cat "$tmp/status"; fail "status: no SAFE MODE line"; }
ok "status without status.json"
echo '{"at": "2026-11-05T00:00:00.000Z", "version": "1.6.2", "lastError": null}' > "$D/other-fedcba/_control/status.json"
sha12=$(python3 -c 'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest()[:12])' "$APP/app.js")
cat > "$D/test-abc123/_control/status.json" <<EOF
{"at": "2099-01-01T00:00:00.000Z", "version": "1.7.0", "lastError": null,
 "core": {"coreVersion": 1, "running": "server", "runningId": "server:$sha12", "runningVersion": "1.7.2",
  "startedAt": "2099-01-01T00:00:00.000Z", "builtin": "1.7.0",
  "server": {"version": "1.7.2", "sha12": "$sha12", "force": false, "minCore": 1, "state": "active", "why": "", "at": "2099-01-01T00:00:00Z"},
  "pending": null, "bad": {"builtin:1.7.0": {"n": 2, "at": "2099-01-01T00:00:00.000Z", "why": "crash"}},
  "lastGood": null, "sick": null, "safeMode": false, "watchdogMinutes": 120,
  "lastHeartbeat": null, "lastUpdateCheck": "2099-01-01T00:00:00.000Z", "updateError": "core: does not compile", "coreInstalled": null}}
EOF
vlb status > "$tmp/status"
for want in "plugin code: server bundle 1.7.2 active (core 1); built-in 1.7.0" \
	"published: app 1.7.2 .* -> plugin says: running it" \
	"published: core 1.7.2 .* -> plugin says: core: does not compile" \
	"plugin problems: update error: core: does not compile; bad: builtin:1.7.0 (crashed at start)" \
	"plugin code: (plugin older than 1.7.0: no core)"; do
	grep -q "$want" "$tmp/status" || { cat "$tmp/status"; fail "status: no line like: $want"; }
done
ok "status with and without a core section"
# Any computer can write any status.json: an odd one in the first computer listed costs its own
# lines, never the listing of the computers after it, and is no error in vlb.log.
cat > "$D/test-abc123/_control/status.json" <<'EOF'
{"at": "x", "version": [1], "lastReconcile": "x",
 "core": {"running": "lifeboat", "builtin": "1.7.0", "server": {"state": ["a"]}, "updateError": ["a"],
  "bad": {"builtin:1.7.0": {"n": "2", "at": "x", "why": ["a"]}}}}
EOF
vlb status > "$tmp/status" || { cat "$tmp/status"; fail "status stopped at an odd status.json"; }
for want in "last check-in: (not understood" "plugin code: (not understood" "published: (not understood" \
	"plugin code: (plugin older than 1.7.0: no core)"; do
	grep -qF "$want" "$tmp/status" || { cat "$tmp/status"; fail "status with an odd status.json: no line like: $want"; }
done
! grep -q ERROR "$VLB_ROOT/vlb.log" || fail "an odd status.json logged an error: $(grep ERROR "$VLB_ROOT/vlb.log")"
ok "status with an odd status.json"
vlb help | grep -q "vlb bundle publish FILE|V" || fail "help does not list the bundle commands"
no_docker "key, bundle, safemode or status"
ok "none of key, bundle, safemode, status touched docker"

# ---- vlb mine copies what your computers have --------------------------------------------
# A forced --only test of the same version first: vlb mine must still give what your computers
# got (not forced), signed again with a later at so the plugin's replay guard takes it.
OTHER="$D/other-fedcba/_control/update/app"
vlb bundle publish 1.7.2 --only other --force > /dev/null
at_only=$(field "$OTHER/manifest.json" at)
vlb mine other > /dev/null
cmp -s "$APP/app.js" "$OTHER/app.js" || fail "vlb mine did not copy the app bundle"
check "$OTHER/manifest.json" "$OTHER/app.js" app 1.7.2
[ "$(field "$OTHER/manifest.json" force)" = false ] || fail "vlb mine gave the forced --only manifest, not what your computers got"
at_mine=$(field "$OTHER/manifest.json" at)
[[ "$at_mine" > "$at_only" ]] || fail "vlb mine kept an older at: $at_only then $at_mine"
[ "$(jget "$VLB_ROOT/state.json" 'j["bundleAt"]["app"]')" = "$at_mine" ] || fail "vlb mine did not record its at"
grep -q "could not copy the core bundle 1.7.2" "$VLB_ROOT/vlb.log" || fail "vlb mine copied a core bundle whose archive changed"
ok "vlb mine copies the bundles published to your computers (and refuses a changed archive)"

echo "all round-trip checks passed"
