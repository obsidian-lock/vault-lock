# Vault Lock: one-time setup on a Windows computer.
#
# Installs the plugin, plus BRAT, into an Obsidian vault and turns both on. The plugin then
# pairs itself with the backup server on first start, so the only thing left for the user
# is choosing a passphrase. Run it in PowerShell:
#
#   irm https://raw.githubusercontent.com/obsidian-lock/vault-lock/main/install.ps1 | iex
#
# Optional: set VLB_URL, VLB_USER and VLB_PASS first to use a fixed login instead of
# pairing. VLB_VAULT picks the vault folder when Obsidian knows several. VLB_NO_LAUNCH=1 skips opening Obsidian at the end. Safe to run again: it
# keeps the passphrase, the pairing and all other settings; with VLB_URL it only replaces
# the server fields.

& {
	$ErrorActionPreference = 'Stop'
	$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is very slow with the progress bar
	[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
	# Windows PowerShell 5.1 can serialize arrays as {"value":[...],"Count":n}; this stops that.
	Remove-TypeData System.Array -ErrorAction SilentlyContinue

	$PluginRepo = 'obsidian-lock/vault-lock'
	$PluginId = 'vault-lock'
	$BratRepo = 'TfTHacker/obsidian42-brat'
	$BratId = 'obsidian42-brat'

	function Write-Utf8([string]$Path, [string]$Text) {
		# No byte-order mark: Obsidian reads these files with JSON.parse.
		[IO.File]::WriteAllText($Path, $Text, (New-Object System.Text.UTF8Encoding($false)))
	}

	function Read-JsonFile([string]$Path) {
		if (-not (Test-Path -LiteralPath $Path)) { return $null }
		$raw = [IO.File]::ReadAllText($Path)
		if (-not $raw.Trim()) { return $null }
		return ($raw | ConvertFrom-Json)
	}

	function Write-JsonFile([string]$Path, $Value) {
		Write-Utf8 $Path (ConvertTo-Json -InputObject $Value -Depth 20)
	}

	function Set-Prop($Object, [string]$Name, $Value) {
		if ($Object.PSObject.Properties[$Name]) { $Object.$Name = $Value }
		else { $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value }
	}

	# A JSON array as a plain PowerShell array, however ConvertFrom-Json returned it.
	function ConvertTo-List($Value) {
		$list = @()
		foreach ($item in $Value) { if ($null -ne $item) { $list += $item } }
		return , $list
	}

	function Find-Vault {
		if ($env:VLB_VAULT) {
			if (-not (Test-Path -LiteralPath $env:VLB_VAULT -PathType Container)) { throw "VLB_VAULT folder not found: $env:VLB_VAULT" }
			return (Resolve-Path -LiteralPath $env:VLB_VAULT).Path
		}
		$cfg = Join-Path $env:APPDATA 'obsidian\obsidian.json'
		$json = Read-JsonFile $cfg
		$vaults = @()
		if ($json -and $json.vaults) {
			foreach ($p in $json.vaults.PSObject.Properties) {
				$v = $p.Value
				if ($v.path -and (Test-Path -LiteralPath $v.path -PathType Container)) {
					$vaults += [pscustomobject]@{ Path = [string]$v.path; Ts = [double]$v.ts }
				}
			}
		}
		if ($vaults.Count -eq 0) { throw 'No Obsidian vault found on this computer. Open your vault in Obsidian once, close Obsidian, then run this again.' }
		if ($vaults.Count -eq 1) { return $vaults[0].Path }
		$vaults = @($vaults | Sort-Object Ts -Descending)
		Write-Host 'Obsidian knows several vaults:'
		for ($i = 0; $i -lt $vaults.Count; $i++) { Write-Host ('  {0}) {1}' -f ($i + 1), $vaults[$i].Path) }
		$answer = Read-Host 'Which one should be locked and backed up? Type its number'
		$n = 0
		if (-not [int]::TryParse($answer, [ref]$n) -or $n -lt 1 -or $n -gt $vaults.Count) { throw "Not a number from the list: $answer" }
		return $vaults[$n - 1].Path
	}

	# Downloads all files first, then moves them into place, so a failed download changes nothing.
	function Install-Release([string]$Repo, [string]$Dir) {
		New-Item -ItemType Directory -Force -Path $Dir | Out-Null
		$files = 'main.js', 'manifest.json', 'styles.css'
		foreach ($f in $files) {
			Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/$Repo/releases/latest/download/$f" -OutFile (Join-Path $Dir "$f.download")
		}
		foreach ($f in $files) {
			Move-Item -Force -LiteralPath (Join-Path $Dir "$f.download") -Destination (Join-Path $Dir $f)
		}
	}

	try {
		$vault = Find-Vault
		$obsidian = Join-Path $vault '.obsidian'
		Write-Host "Vault: $vault"

		if (Get-Process -Name Obsidian -ErrorAction SilentlyContinue) {
			Write-Host 'Please close Obsidian (all windows). Waiting... (Ctrl+C cancels)' -ForegroundColor Yellow
			while (Get-Process -Name Obsidian -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 1 }
		}
		New-Item -ItemType Directory -Force -Path $obsidian | Out-Null

		# 1. The plugin, always the latest release.
		$pluginDir = Join-Path $obsidian "plugins\$PluginId"
		Write-Host 'Downloading Vault Lock...'
		Install-Release $PluginRepo $pluginDir

		# 2. Its settings: only the server fields are written; the passphrase and the rest are kept.
		$dataPath = Join-Path $pluginDir 'data.json'
		$data = Read-JsonFile $dataPath
		if ($null -eq $data) { $data = New-Object psobject }
		if ($env:VLB_URL) {
			Set-Prop $data 'webdavUrl' $env:VLB_URL.Trim()
			Set-Prop $data 'webdavUser' ([string]$env:VLB_USER).Trim()
			Set-Prop $data 'webdavPass' ([string]$env:VLB_PASS)
			Write-Host "Backup server: $($env:VLB_URL.Trim())"
		} else {
			Write-Host 'Backup: the plugin pairs this computer with the backup server by itself when Obsidian starts.'
		}
		Write-JsonFile $dataPath $data

		# 3. BRAT, which installs new releases of the plugin when Obsidian starts.
		$bratDir = Join-Path $obsidian "plugins\$BratId"
		if (-not (Test-Path -LiteralPath (Join-Path $bratDir 'main.js'))) {
			Write-Host 'Downloading BRAT (keeps the plugin up to date)...'
			Install-Release $BratRepo $bratDir
		}
		$bratPath = Join-Path $bratDir 'data.json'
		$brat = Read-JsonFile $bratPath
		if ($null -eq $brat) {
			$brat = [pscustomobject]@{
				pluginList = @(); pluginSubListFrozenVersion = @(); themesList = @()
				updateAtStartup = $true; updateThemesAtStartup = $true; enableAfterInstall = $true
				loggingEnabled = $false; loggingPath = 'BRAT-log'; loggingVerboseEnabled = $false
				debuggingMode = $false; notificationsEnabled = $true
				selectLatestPluginVersionByDefault = $false; allowIncompatiblePlugins = $false
			}
		}
		$list = ConvertTo-List $brat.pluginList
		if ($list -notcontains $PluginRepo) { $list = @($PluginRepo) + $list }
		Set-Prop $brat 'pluginList' $list
		$frozen = ConvertTo-List $brat.pluginSubListFrozenVersion
		$frozen = @($frozen | Where-Object { $_.repo -ne $PluginRepo })
		$frozen = @([pscustomobject]@{ repo = $PluginRepo; version = 'latest' }) + $frozen
		Set-Prop $brat 'pluginSubListFrozenVersion' $frozen
		Set-Prop $brat 'updateAtStartup' $true
		Write-JsonFile $bratPath $brat

		# 4. Turn both on, keeping every plugin that is already on.
		$cpPath = Join-Path $obsidian 'community-plugins.json'
		$enabled = ConvertTo-List (Read-JsonFile $cpPath)
		foreach ($id in @($PluginId, $BratId)) { if ($enabled -notcontains $id) { $enabled += $id } }
		Write-JsonFile $cpPath $enabled

		Write-Host ''
		Write-Host 'Done.' -ForegroundColor Green
		Write-Host 'Open Obsidian: it asks you to choose a passphrase. That is all.'
		Write-Host 'If Obsidian says community plugins are turned off: Settings > Community plugins > Turn on community plugins.'
		if (-not $env:VLB_NO_LAUNCH) {
			try { Start-Process ('obsidian://open?path=' + [uri]::EscapeDataString($vault)) } catch { }
		}
	} catch {
		Write-Host ''
		Write-Host "Setup failed: $($_.Exception.Message)" -ForegroundColor Red
		Write-Host 'Fix the problem and run the same command again; repeating it is safe.'
	} finally {
		Remove-Item Env:VLB_URL, Env:VLB_USER, Env:VLB_PASS, Env:VLB_VAULT, Env:VLB_NO_LAUNCH -ErrorAction SilentlyContinue
	}
}
