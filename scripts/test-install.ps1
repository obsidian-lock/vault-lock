# CI test for install.ps1 on Windows PowerShell 5.1 (what a Windows laptop has).
# Builds a fake Obsidian profile and vault, runs the installer the way users do
# (script text through Invoke-Expression), checks the files, then runs it again.

$ErrorActionPreference = 'Stop'
$failures = 0
function Check([bool]$Ok, [string]$What) {
	if ($Ok) { Write-Host "ok   $What" } else { Write-Host "FAIL $What" -ForegroundColor Red; $script:failures++ }
}
function Read-Text([string]$Path) { [IO.File]::ReadAllText($Path) }
function Has-Bom([string]$Path) { $b = [IO.File]::ReadAllBytes($Path); $b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF }

$root = Join-Path ([IO.Path]::GetTempPath()) ('vlb-test-' + [guid]::NewGuid())
$appData = Join-Path $root 'AppData'
$vault = Join-Path $root 'My Vault'
$obs = Join-Path $vault '.obsidian'
$pluginDir = Join-Path $obs 'plugins\vault-lock'
$bratDir = Join-Path $obs 'plugins\obsidian42-brat'
New-Item -ItemType Directory -Force -Path (Join-Path $appData 'obsidian'), $pluginDir | Out-Null

# Obsidian's vault list, one other plugin already on, and an existing passphrase that must survive.
$utf8 = New-Object System.Text.UTF8Encoding($false)
$vaultList = @{ vaults = @{ '0123456789abcdef' = @{ path = $vault; ts = 1767225600000; open = $true } } }
[IO.File]::WriteAllText((Join-Path $appData 'obsidian\obsidian.json'), (ConvertTo-Json -InputObject $vaultList -Depth 5), $utf8)
[IO.File]::WriteAllText((Join-Path $obs 'community-plugins.json'), '["some-other-plugin"]', $utf8)
[IO.File]::WriteAllText((Join-Path $pluginDir 'data.json'), '{"passHash":"aa11","passSalt":"bb22","idleMinutes":7,"doneCommands":["c1"],"commandLog":{"c1":{"ok":true,"at":"2026-10-29T00:00:00Z"}}}', $utf8)

$env:APPDATA = $appData
$installer = Read-Text (Join-Path $PSScriptRoot '..\install.ps1')
$password = 'p@ss "with" quotes & symbols'

foreach ($run in 1, 2) {
	Write-Host "--- run $run"
	$env:VLB_URL = 'https://vault.example.com/'
	$env:VLB_USER = 'obsidian'
	$env:VLB_PASS = $password
	$env:VLB_NO_LAUNCH = '1'
	Invoke-Expression $installer

	foreach ($f in 'main.js', 'manifest.json', 'styles.css') {
		Check (Test-Path (Join-Path $pluginDir $f)) "plugin $f installed"
		Check (Test-Path (Join-Path $bratDir $f)) "BRAT $f installed"
	}
	Check (-not (Get-ChildItem -Recurse -Path $obs -Filter '*.download')) 'no leftover downloads'

	$dataPath = Join-Path $pluginDir 'data.json'
	$dataRaw = Read-Text $dataPath
	$data = $dataRaw | ConvertFrom-Json
	Check ($data.webdavUrl -eq 'https://vault.example.com/') 'server URL written'
	Check ($data.webdavUser -eq 'obsidian') 'server user written'
	Check ($data.webdavPass -eq $password) 'server password written exactly'
	Check ($data.passHash -eq 'aa11' -and $data.passSalt -eq 'bb22') 'passphrase kept'
	Check ($data.idleMinutes -eq 7) 'other settings kept'
	Check ($dataRaw -match '"doneCommands":\s*\[\s*"c1"\s*\]') 'arrays stay arrays in data.json'
	Check (-not (Has-Bom $dataPath)) 'data.json has no BOM'

	$cpPath = Join-Path $obs 'community-plugins.json'
	$cpRaw = Read-Text $cpPath
	$cp = @(); foreach ($x in ($cpRaw | ConvertFrom-Json)) { $cp += $x }
	Check ($cpRaw.Trim().StartsWith('[')) 'community-plugins.json is an array'
	Check ($cp.Count -eq 3) "community-plugins.json has 3 entries (got: $($cp -join ', '))"
	foreach ($id in 'some-other-plugin', 'vault-lock', 'obsidian42-brat') { Check ($cp -contains $id) "$id is on" }
	Check (-not (Has-Bom $cpPath)) 'community-plugins.json has no BOM'

	$bratRaw = Read-Text (Join-Path $bratDir 'data.json')
	$brat = $bratRaw | ConvertFrom-Json
	$list = @(); foreach ($x in $brat.pluginList) { $list += $x }
	$frozen = @(); foreach ($x in $brat.pluginSubListFrozenVersion) { $frozen += $x }
	Check ($list.Count -eq 1 -and $list[0] -eq 'obsidian-lock/vault-lock') 'BRAT tracks the plugin once'
	Check ($frozen.Count -eq 1 -and $frozen[0].version -eq 'latest') 'BRAT follows the latest release'
	Check ($brat.updateAtStartup -eq $true) 'BRAT updates at startup'
	Check ($bratRaw -match '"pluginList":\s*\[') 'BRAT pluginList is an array'
	Check (-not ($bratRaw -match '"Count"')) 'no PowerShell array wrappers in BRAT data.json'

	Check (-not $env:VLB_PASS) 'password removed from the environment'
}

Remove-Item -Recurse -Force $root
if ($failures) { Write-Host "$failures check(s) failed" -ForegroundColor Red; exit 1 }
Write-Host 'All installer checks passed.' -ForegroundColor Green
