# Changelog

Each release's section below becomes its GitHub release notes. Versions follow
[semantic versioning](https://semver.org).

## 1.4.0 — 2026-11-02

The backup is invisible on the computer. Its health is read on the server.

- **No backup interface in Obsidian:** the status bar item, every backup notice, and the
  *Back up now*, *Reset backup index* and *Restore vault from server* commands are gone.
  What is left on the computer is the lock screen, the passphrase prompt and the lock
  settings. The server does what those commands did (`commands.json`: `reset-index`,
  `restore-all`) and shows the state (`vlb status`).
- **Failures reach the server:** `_control/status.json` is now also written when a backup
  fails (if the server can still be reached), with the error. `lastError` is `null` while
  the backup is healthy. `lastReconcile` gains `at` and `skipped` (files over 100 MB).
- Server: `vlb status` prints the last error and the skipped files per computer.
- The developer console still logs every step as `[VLB backup]` and `[VLB pairing]`.

## 1.3.0 — 2026-11-01

Pairing: install with BRAT, choose a passphrase, and the backup sets itself up. No server
address or password to type, copy or publish.

- **Pairing:** on first start the plugin makes up its own login and key and sends only a
  bcrypt hash of the key to the server's pairing inbox. While pairing is open the server
  accepts the first computer that asks, gives it its own folder, and closes pairing.
- **One folder per computer:** a paired computer sees only its own folder on the server, so
  a stranger who pairs never sees your notes.
- **Self-healing:** if the server revokes this computer's login, the plugin asks to pair
  again every minute and reconnects once pairing is open (`vlb open --into` continues the
  old folder).
- New status bar states: `Backup: pairing…` and `Backup: ⚠ not paired`.
- `status.json` now includes the computer's name.
- Server: `server/vlb` (pairing and computer admin), a second container for the pairing
  inbox, a 15-second systemd timer, and an updated Caddy snippet. The WebDAV image is
  pinned.
- The setup command no longer needs server details; without them the plugin pairs.

## 1.2.0 — 2026-10-31

- **Settings are only about the passphrase and the lock:** passphrase, idle minutes, lock
  on focus loss, and the private folder. The backup status, server fields, backup buttons,
  full-check interval and exclude list are gone from the settings. The backup is configured
  by the setup command and runs by itself; the server can still change its options through
  `_control/config.json`.
- The *Back up now*, *Reset backup index* and *Restore vault from server* commands are
  still in the command palette.

## 1.1.1 — 2026-10-29

- **Lock screen:** window titles stay "Obsidian" while locked, in the main window and in
  pop-out windows. Before, Obsidian could put the open note's name back in the title.
- **Lock screen:** the Settings window closes when the vault locks. Obsidian 1.14 opens
  Settings in its own window, which the lock overlay doesn't cover.
- The plugin's author is now listed as obsidian-lock.

## 1.1.0 — 2026-10-29

Zero-setup install: the only thing a user does is choose a passphrase.

- **Setup command for Windows:** [`install.ps1`](install.ps1) installs the plugin and BRAT
  into the vault, writes the server details, and turns both on. Safe to run again.
- **Passphrase prompt:** asked for on first start (and at every start until set). New
  *Set or change passphrase* command.
- **Backup is always on** once a server is set; the *Enable backup* switch is gone.
- **Simpler settings:** the passphrase and a live backup status. Everything else is under
  *Advanced*, and server fields apply together with *Save and test*.
- CI tests the setup command on Windows PowerShell 5.1.

## 1.0.0 — 2026-10-29

First release.

- **Lock screen:** passphrase overlay at launch, after N idle minutes, when the window loses
  focus (optional), and on the *Lock vault now* command. Hotkeys and the command palette are
  blocked while locked. The passphrase is stored only as a PBKDF2-SHA256 hash.
- **Private folder:** a top-level folder (default `Private`) is renamed to a dot-folder while
  locked, so Obsidian ignores it, and on Windows it also gets the hidden attribute.
- **One-way WebDAV backup:** the whole vault as plain files, kept correct by a single
  reconcile against a server-side index. Deleted and renamed-away files go to
  `_trash/<timestamp>/`; nothing on the server is ever deleted. Includes *Reset backup
  index* and *Restore vault from server*.
- **Server-side control:** `_control/config.json` (settings overrides),
  `_control/commands.json` (`reconcile`, `reset-index`, `lock`, `pull`, `restore-all`) and
  `_control/status.json` (health report).
