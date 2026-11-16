# Checks the attrib.exe calls the plugin makes on lock and unlock (src/shared/privateFolder.ts):
# the private folder and everything in it get the hidden attribute, then lose it again. In
# between, the file operations the encryptor relies on are run with Node's fs (what the plugin
# uses), not PowerShell cmdlets, which have their own rules for hidden items.
$ErrorActionPreference = 'Stop'
$root = Join-Path $env:TEMP ('vlb-hide-' + [guid]::NewGuid())
$dir = Join-Path $root '.Private'
New-Item -ItemType Directory -Path (Join-Path $dir 'Sub folder') -Force | Out-Null
Set-Content -Path (Join-Path $dir 'Journal.md') -Value 'a'
Set-Content -Path (Join-Path $dir 'Sub folder\Letter one.md') -Value 'b'
$attrib = Join-Path $env:SystemRoot 'System32\attrib.exe'

function All { @(Get-Item -Force $dir) + @(Get-ChildItem -Force -Recurse $dir) }
function IsHidden($i) { ($i.Attributes -band [IO.FileAttributes]::Hidden) -ne 0 }

# Lock
& $attrib +h $dir
& $attrib +h "$dir\*" /s /d
$bad = All | Where-Object { -not (IsHidden $_) }
if ($bad) { throw "not hidden: $($bad.FullName -join ', ')" }
if (Get-ChildItem $root) { throw 'the folder is still listed in a normal view' }
if ((All).Count -ne 4) { throw "expected 4 items, found $((All).Count)" }

# While locked: the encryptor's operations on the hidden folder (C.3), with Node's fs. The script
# goes through a file because Windows PowerShell 5.1 mangles quotes in arguments to native programs.
$js = Join-Path $root 'hidden-ops.js'
[IO.File]::WriteAllText($js, @'
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const dir = process.argv[2];
const hidden = path.join(dir, "Journal.md");
// E1: a new file beside the hidden ones, created exclusively, written and flushed.
const tmp = path.join(dir, "Journal.md.vlenc.tmp");
const fd = fs.openSync(tmp, "wx");
fs.writeSync(fd, "ciphertext");
fs.fsyncSync(fd);
fs.closeSync(fd);
// E3: renamed onto a name that does not exist.
fs.renameSync(tmp, path.join(dir, "Journal.md.vlenc"));
if (fs.readFileSync(path.join(dir, "Journal.md.vlenc"), "utf8") !== "ciphertext") throw new Error("the renamed file does not read back");
// Why a rename never replaces a file (B4): Windows refuses to write over a hidden one.
let code = "no error";
try { fs.writeFileSync(path.join(dir, "Sub folder", "Letter one.md"), "x"); } catch (e) { code = e.code; }
if (code !== "EPERM") throw new Error("writing over a hidden file: expected EPERM, got " + code);
// E4: the hidden plaintext removed; attrib -h first if Windows refuses.
try {
  fs.unlinkSync(hidden);
} catch (e) {
  if (e.code !== "EPERM") throw e;
  console.log("unlinking a hidden file needed attrib -h first");
  execFileSync(path.join(process.env.SystemRoot, "System32", "attrib.exe"), ["-h", hidden]);
  fs.unlinkSync(hidden);
}
if (fs.existsSync(hidden)) throw new Error("the hidden file is still there");
console.log("Node fs on the hidden folder: exclusive create, rename to a free name, unlink: ok; write over a hidden file: EPERM");
'@)
& node $js $dir
if ($LASTEXITCODE -ne 0) { throw "Node's file operations on the hidden folder failed (exit $LASTEXITCODE)" }
Remove-Item -Force $js
if (Test-Path (Join-Path $dir 'Journal.md')) { throw 'Journal.md is still there' }
if (-not (Test-Path (Join-Path $dir 'Journal.md.vlenc'))) { throw 'Journal.md.vlenc is missing' }

# Unlock
& $attrib -h $dir
& $attrib -h "$dir\*" /s /d
$bad = All | Where-Object { IsHidden $_ }
if ($bad) { throw "still hidden: $($bad.FullName -join ', ')" }
if ((Get-Content (Join-Path $dir 'Sub folder\Letter one.md')) -ne 'b') { throw 'note content changed' }

Remove-Item -Recurse -Force $root
Write-Host 'hide test passed'
