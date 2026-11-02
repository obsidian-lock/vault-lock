# Vault Lock & Backup

[![Latest release](https://img.shields.io/github/v/release/obsidian-lock/vault-lock-backup?sort=semver&label=release)](https://github.com/obsidian-lock/vault-lock-backup/releases/latest)
[![CI](https://github.com/obsidian-lock/vault-lock-backup/actions/workflows/ci.yml/badge.svg)](https://github.com/obsidian-lock/vault-lock-backup/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/obsidian-lock/vault-lock-backup)](LICENSE)
![Obsidian 1.5+ desktop](https://img.shields.io/badge/Obsidian-1.5%2B%20desktop-7c3aed?logo=obsidian&logoColor=white)

An Obsidian plugin for one person, one computer, and a server you control:

- **Nothing to set up.** Install with BRAT and choose a passphrase. The plugin pairs itself
  with your server: no server address or password to type, and none published anywhere.
- **Lock screen.** A passphrase overlay at launch, after a few idle minutes, or on demand.
- **Private folder.** One folder disappears from Obsidian whenever the vault is locked.
- **One-way backup.** Every file in the vault is copied to your own WebDAV server as plain
  files. Nothing on the server is ever deleted.
- **Server-side control.** The server can change settings, send commands, and read the
  plugin's health by editing a few JSON files next to the backup. Nothing connects in to
  your computer.

> [!IMPORTANT]
> This is a **privacy screen, not a safe.** Nothing is encrypted. Anyone with access to the
> vault's files can read them, private folder included. Use full-disk encryption
> (BitLocker, FileVault, LUKS) to protect a lost or stolen laptop. See
> [Security model](#security-model).

## Contents

- [Design principles](#design-principles)
- [Install](#install)
- [Set up](#set-up)
- [Commands](#commands)
- [How the backup works](#how-the-backup-works)
- [Pairing](#pairing)
- [Server setup](#server-setup)
- [Controlling the plugin from the server](#controlling-the-plugin-from-the-server)
- [Security model](#security-model)
- [Troubleshooting](#troubleshooting)
- [Building and releasing](#building-and-releasing)

## Design principles

- **Never lose data.** The server never deletes anything. Files you delete or rename away
  are moved into `_trash/<timestamp>/`. A restore parks the local copy in `_trash/` before
  overwriting it.
- **One mechanism.** Backup reliability comes from a single *reconcile* that compares every
  local file with an index on the server and uploads whatever differs. Live file events
  only make it happen sooner, so a missed event can never cause a missed file.
- **Plain files.** The backup is your vault as ordinary files. No database and no
  proprietary format, so you can read or restore it with any tool.
- **Failures are visible.** Errors show in the status bar and retry on their own. Nothing
  fails silently.

## Install

The plugin is not in the Obsidian community catalogue; [BRAT](https://github.com/TfTHacker/obsidian42-brat)
installs it from this repository and keeps it up to date.

1. *Settings → Community plugins → Browse*, install **BRAT** and enable it.
2. Open this link in your browser. Obsidian will ask BRAT to add the plugin:
   ```
   obsidian://brat?plugin=obsidian-lock/vault-lock-backup
   ```
   Or go to *BRAT settings → Add beta plugin* and enter `obsidian-lock/vault-lock-backup`.
3. Enable **Vault Lock & Backup** under *Settings → Community plugins*.

That's all. There are no server details to enter: see [Pairing](#pairing).

**Windows, one command instead:** close Obsidian, open PowerShell and paste
`irm https://raw.githubusercontent.com/obsidian-lock/vault-lock-backup/main/install.ps1 | iex`.
[`install.ps1`](install.ps1) installs this plugin and BRAT into the vault Obsidian knows
(it asks if there are several), turns both on, and opens Obsidian. Running it again is safe.

**Manual install:** download `main.js`, `manifest.json` and `styles.css` from the
[latest release](https://github.com/obsidian-lock/vault-lock-backup/releases/latest) into
`<vault>/.obsidian/plugins/vault-lock-backup/`, then enable the plugin.

Desktop only (Windows, macOS, Linux). Obsidian 1.5.0 or newer.

## Set up

The first time Obsidian starts with the plugin, it asks for a passphrase. **That is the
only step.** If you close the prompt, it comes back at the next start.

- If Obsidian says community plugins are turned off: *Settings → Community plugins → Turn
  on community plugins*.
- The backup starts by itself. The status bar shows `Backup: pairing…` for up to a minute
  the first time, then `Backup: ✓ HH:MM`.
- To change the passphrase: *Settings → Vault Lock & Backup → Change passphrase*, or the
  *Set or change passphrase* command. It asks for the current one first.
- Put notes that should disappear while locked in a top-level folder named `Private`.

The plugin's settings are only about the passphrase and the lock. The backup has no
settings there: it pairs itself with the server and runs by itself.

| Setting | Default |
| --- | --- |
| Passphrase | set on first start; **Change passphrase** asks for the current one first |
| Lock after idle (minutes) | 5 (`0` turns it off) |
| Lock when the window loses focus | off |
| Private folder | `Private`; change it only while unlocked |

The server can change the lock options and the backup options; see
[Controlling the plugin from the server](#controlling-the-plugin-from-the-server).

## Commands

Open the command palette (Ctrl/Cmd+P):

| Command | What it does |
| --- | --- |
| **Lock vault now** | Locks immediately. Needs a passphrase. |
| **Set or change passphrase** | Opens the passphrase prompt. |
| **Back up now** | Runs a full reconcile right away. |
| **Reset backup index** | Forgets the server index and re-uploads every file. |
| **Restore vault from server** | Downloads every indexed file that is missing or different locally. Use it for a new computer or a repair. Local copies it overwrites go to `_trash/` on the server first. |

## How the backup works

The reconcile lists every local file (modification time and size) and compares it with
`_manifest.json` on the server. It uploads whatever is new or changed. Anything in the index
that no longer exists locally is moved to `_trash/`. It runs:

- 8 seconds after Obsidian starts,
- every *N* minutes (default 10),
- when the computer comes back online,
- one minute after any failure, until it succeeds.

Edits, renames and deletes are also sent within a couple of seconds as they happen. The
reconcile is the safety net that catches anything those miss.

What this computer's folder on the server looks like (each paired computer has its own,
`data/devices/<computer>-<id>/`, and sees only that):

```
<computer's folder>/
├── Notes/…, Private/…           your vault as plain files, including .obsidian/
├── _manifest.json               index: path → modification time + size
├── _trash/<timestamp>/…         deleted, renamed-away, or overwritten files
└── _control/
    ├── config.json              you write: settings overrides
    ├── commands.json            you write: one-shot commands
    └── status.json              the plugin writes: health, last run, command results
```

Details:

- The private folder is always stored as `Private/` on the server, even while it is hidden
  locally as `.Private/`.
- Always skipped: the plugin's own `data.json` (it holds your passphrase hash and this
  computer's server key), files over 100 MB (with a notice), and top-level
  `_manifest.json`, `_trash/`, `_control/` and `_pair/` in the vault, because those names
  are reserved on the server.
- Status bar: `Backup: syncing…`, `Backup: ✓ 14:05`, `Backup: ⚠ retrying`,
  `Backup: pairing…`, or `Backup: ⚠ not paired` (pairing is paused on the server; see
  [Pairing](#pairing)).
- Nothing uploads while Obsidian is closed. The reconcile at the next start catches up.

## Pairing

A computer gets its own login on the server without anyone typing a password:

1. On first start the plugin makes up a login and a random key and saves them in its
   `data.json`.
2. It drops a small request into the server's pairing inbox: an id, the computer's name,
   and a bcrypt hash of the key. The key itself never leaves the computer.
3. Within 15 seconds the server accepts the request: the computer gets its own login and
   its own folder. **Every** computer that asks is accepted, so yours can never be blocked
   by someone else pairing first.
4. The plugin notices its login works and starts backing up.

Every computer sees only its own folder. If a stranger installs the plugin, they get an
empty sandbox of their own, never your notes. Strangers are kept cheap: a computer you
haven't marked with `vlb mine` is frozen (it can read but not write) when its folder grows
past 10 GB, when all strangers together pass 30 GB, or when the disk has less than 10 GB
free. Once you have marked your computer, the strangers' folders are also left out of the
nightly snapshot.

The inbox's login is built into the plugin and is public on purpose. It can only create
files of up to 4 KB in the inbox, a separate container that can't reach the backups.

On the server, `vlb` manages it:

| Command | What it does |
| --- | --- |
| `vlb status` | Pairing state and every paired computer: yours or stranger, folder, size, frozen or not, last check-in. |
| `vlb mine COMPUTER` | This computer is yours: never frozen, always in the snapshot. Run it once your computer shows `Backup: ✓`. |
| `vlb move COMPUTER FOLDER` | That computer continues an existing folder: a new or reinstalled laptop picks up where the old one left off (and can then use *Restore vault from server*). Its login is reset; it pairs again within a minute. |
| `vlb remove COMPUTER` | Revoke a computer's login and refuse that computer from now on. Its folder is kept. `vlb move` lets it back in. |
| `vlb close` / `vlb open` | Pause and resume accepting computers. Paused computers keep asking every minute. `vlb open --only NAME` accepts just the computer with that name (for a flood). |

`COMPUTER` is the computer's name (if unique), login, id or folder as `vlb status` shows
it. A computer whose login stops working (for example after `vlb move`) asks to pair again
every minute, so it reconnects by itself. At most 100 computers can be paired; beyond that
new ones are refused until you remove some.

## Server setup

The [`server/`](server) folder is a tested setup: [hacdias/webdav](https://github.com/hacdias/webdav)
in Docker (one container for the backups, one for the pairing inbox) behind
[Caddy](https://caddyserver.com), which provides HTTPS automatically, plus `vlb`.

```sh
mkdir -p /opt/obsidian-webdav && cd /opt/obsidian-webdav
# from server/: docker-compose.yml here (set the Docker network your reverse proxy is on),
# vlb into /usr/local/bin, the two systemd units into /etc/systemd/system
install -m 755 vlb /usr/local/bin/vlb
vlb apply --no-restart                 # writes conf/webdav/ and conf/pair/ from state.json
docker compose up -d
systemctl daemon-reload && systemctl enable --now vlb-pair.timer   # handles the inbox every 15 s
vlb status                             # pairing is open from the start
```

1. Point a DNS name (for example `vault.example.com`) at the server, and put it in
   `SERVER_URL` in [`src/server.ts`](src/server.ts) if you build your own copy.
2. Add [`server/Caddyfile.snippet`](server/Caddyfile.snippet) to your Caddyfile and reload
   Caddy. It sends `/_pair/` to the inbox (4 KB limit) and everything else to the backups.
   If you use another reverse proxy, **don't rewrite the `Host` header**: WebDAV `MOVE`
   compares it with the destination URL.
3. Install the plugin on a computer; `vlb status` shows it within a minute.

Never edit `conf/` by hand: `vlb` regenerates it from `state.json`. Backups land in
`/opt/obsidian-webdav/data/devices/`. Take a nightly snapshot of `data/`, `conf/` and
`state.json` to somewhere off the server, for example with restic or
`tar czf /backups/vault-$(date +%F).tgz --exclude-from=snapshot-exclude.txt data conf state.json`
(`snapshot-exclude.txt` is written by `vlb`: the strangers' folders, once you have run
`vlb mine`).

## Controlling the plugin from the server

Everything happens in `_control/` inside the computer's folder (on the server:
`data/devices/<folder>/_control/`). The plugin reads it at the start of every reconcile (at
startup and every 10 minutes by default) and writes `status.json` afterwards.

**`config.json`**: any subset of these. The server's value wins and is saved on the
computer.

```json
{ "idleMinutes": 5, "lockOnBlur": false, "reconcileMinutes": 10,
  "excludes": [".trash/", ".obsidian/workspace"] }
```

`reconcileMinutes` is how often the whole vault is compared with the server (besides live
uploads). `excludes` lists path prefixes that are never uploaded. These two have no setting
in Obsidian; this file is the place to change them.

**`commands.json`**: a list. Each `id` runs once, ever, and its result is reported in
`status.json`. To run something again, add it with a new id.

```json
[
  { "id": "2026-10-29-a", "cmd": "reconcile" },
  { "id": "2026-10-29-b", "cmd": "reset-index" },
  { "id": "2026-10-29-c", "cmd": "lock" },
  { "id": "2026-10-29-d", "cmd": "pull", "paths": ["Notes/todo.md", "Projects"] },
  { "id": "2026-10-29-e", "cmd": "restore-all" }
]
```

| Command | Effect |
| --- | --- |
| `reconcile` | Does nothing extra. Commands are read at the start of a reconcile, so this only confirms the channel works. |
| `reset-index` | Forgets the index; every file is re-uploaded. |
| `lock` | Locks the vault. Fails if no passphrase is set. |
| `pull` | Writes the server's copy of the listed files or folders into the vault, unconditionally. Use it after editing files directly on the server. |
| `restore-all` | Writes every indexed file that is missing or different locally. |

`pull` and `restore-all` upload the local version to `_trash/` before overwriting it, so
nothing is lost on either side.

**`status.json`**: written by the plugin.

```json
{ "at": "2026-10-29T18:00:00.000Z", "version": "1.3.0", "computer": "LAPTOP", "locked": false,
  "lastReconcile": { "reason": "interval", "files": 812, "uploaded": 3, "trashed": 0 },
  "lastError": null, "settings": { "idleMinutes": 5, "…": "…" },
  "commands": { "2026-10-29-d": { "ok": true, "at": "…", "detail": "4 files written" } } }
```

A cron job on the server can alert you when `at` is older than a day, which means the
computer has stopped backing up.

## Security model

**What it does**

- The passphrase is never stored. Only a PBKDF2-SHA256 hash (200,000 iterations, random
  salt) is kept in the plugin's `data.json`.
- Each wrong passphrase adds a growing delay, up to 5 seconds.
- While locked, an overlay covers the whole window and pop-out windows go blank. Hotkeys
  and the command palette don't work, the Settings window is closed, and every window
  title shows only "Obsidian".
- On lock, tabs showing private notes are closed and the private folder is renamed to a
  dot-folder (`Private/` → `.Private/`). Obsidian ignores dot-folders completely: file
  explorer, search, graph and quick switcher. On Windows the folder also gets the hidden
  attribute.
- If Obsidian crashes while unlocked, the folder is hidden again and the vault locks at
  the next start, before the interface appears.

**What it does not do**

- **No encryption.** Notes, including the private folder, are plain files on disk and on the
  server. Anyone who can open the files, or delete the plugin's `data.json`, gets past the
  lock.
- This computer's server key is stored in plain text in `data.json`. That file is never
  uploaded.
- **Whoever controls the server controls the plugin.** Anyone who can write to a
  computer's folder can change its settings and use `pull` to overwrite notes. Local
  versions go to `_trash/` first, but protect the server as carefully as the vault itself.
  Serve it over HTTPS only.
- The server's address is built into the plugin, so it is public. Anyone can pair, but
  every computer gets its own sealed folder, so a stranger gets a small sandbox and never
  your notes: see [Pairing](#pairing).

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Troubleshooting

- **Lost passphrase.** Close Obsidian. Delete
  `<vault>/.obsidian/plugins/vault-lock-backup/data.json` and rename `.Private` back to
  `Private`. Obsidian then asks for a new passphrase. Deleting `data.json` also deletes this
  computer's pairing: it pairs again as a new computer with a fresh folder. On the server,
  `vlb move <new computer> <old folder>` makes it continue the old folder instead.
- **"Both Private and .Private exist".** This only happens if folders are created by hand.
  The plugin refuses to rename either one. Merge them manually.
- **Don't keep the vault in OneDrive, iCloud Drive or Dropbox.** A second sync engine
  fighting over the `Private` ↔ `.Private` rename is the one thing that can corrupt this
  setup.
- **`Backup: ⚠ not paired`.** Pairing is paused on the server; `vlb open` resumes it. The
  plugin asks again every minute.
- **`Backup: pairing…` for more than a couple of minutes.** The server is full (`vlb status`
  says FULL; `vlb remove` strangers) or `vlb open --only` names another computer.
- **`Backup: ⚠ retrying` with HTTP 403 right after pairing.** The server froze this
  computer as a stranger over the caps. On the server: `vlb mine <its name>`.
- **`Backup: ⚠ retrying`.** A notice shows the error, and the plugin retries every minute.
- **The setup command says "Setup failed".** It prints the reason. Fix it and run the same
  command again.
- **The backup fails right after you create a new DNS name.** Your computer may have cached the
  old "not found" answer. Flush it (`ipconfig /flushdns` on Windows) or wait a few minutes.

## Building and releasing

```sh
npm ci
npm run check   # type-check
npm run build   # -> main.js
```

To release: bump `version` in `manifest.json` (and `package.json`) and add a section to
[CHANGELOG.md](CHANGELOG.md). Then commit, tag with the same version and push:

```sh
git tag 1.0.1 && git push origin main 1.0.1
```

GitHub Actions builds `main.js` and publishes the release with notes from the changelog.
BRAT installs it on the next Obsidian start. CI also runs
[`scripts/test-install.ps1`](scripts/test-install.ps1), which tests the setup command on
Windows PowerShell 5.1.

## License

[MIT](LICENSE)
