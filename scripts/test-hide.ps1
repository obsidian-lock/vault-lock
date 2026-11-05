# Checks the attrib.exe calls the plugin makes on lock and unlock (src/shared/privateFolder.ts):
# the private folder and everything in it get the hidden attribute, then lose it again.
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

# Unlock
& $attrib -h $dir
& $attrib -h "$dir\*" /s /d
$bad = All | Where-Object { IsHidden $_ }
if ($bad) { throw "still hidden: $($bad.FullName -join ', ')" }
if ((Get-Content (Join-Path $dir 'Sub folder\Letter one.md')) -ne 'b') { throw 'note content changed' }

Remove-Item -Recurse -Force $root
Write-Host 'hide test passed'
