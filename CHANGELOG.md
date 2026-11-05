# Changelog

Each release's section below becomes its GitHub release notes. Versions follow
[semantic versioning](https://semver.org).

## 1.7.0 — 2026-11-05

A bad update can no longer stop the lock or the backup. Nothing new to see or set on the
computer.

- **Obsidian opens behind a cover until the lock is up.** The window is covered from the
  first moment, also when the plugin's main part fails to start, and the cover comes down
  only once the vault is locked. Typing and Obsidian's shortcuts do nothing under it.
- **A small built-in fallback keeps the lock and the backup going.** If the plugin's main
  part throws, hangs, or crashes twice within 90 seconds of a start, a minimal lock screen
  and a plain backup take over (new and changed files every 10 minutes; nothing on the
  server is ever deleted). The main part is tried again after 24 hours, or at once when a
  new version arrives.
- **The server can send signed fixes.** Only code signed with the project's update key
  runs. It is checked again every time before it starts, a bundle that fails sends the
  plugin back to its built-in code, and a newer release always wins over an older fix
  unless the fix is forced. The server can also replace the plugin itself (`main.js`) for
  the next start, after the same checks.
- **Safe mode from the server.** The server can switch a computer to the fallback and back
  (`vlb safemode on|off`).
- **A stuck backup is noticed and handled.** When no backup run has finished for two hours
  (by default) although the server provably takes writes from this computer, the plugin
  switches to its fallback. A server that is down, full or refusing is never blamed on the plugin.
- **One slow file no longer holds up the backup.** Files go up smallest first, and a file
  the connection cannot push in time is counted as failed (`lastReconcile.failed`) while
  the run goes on, instead of stopping it until the next try.
- **Server files are never read stale from the cache.** Every request tells the browser
  cache to stay out, so a changed `config.json` or `commands.json` is seen at the next
  check. Before, it could be read from the cache for days.
- The release has a fourth file, `app.js`: the plugin's main part alone, for the server.
  BRAT ignores it.
- `status.json` gains a `core` section (which code runs and how it is doing); `vlb status`
  shows it as the "plugin code" lines. Server: `vlb key init|show`, `vlb bundle
  fetch|publish|unpublish`, `vlb safemode on|off`.

## 1.6.2 — 2026-11-05

Fixes that keep the backup running whatever happens on the computer.

- **One failure can no longer pause the backup until Obsidian restarts.** An error while
  handling a failed run no longer skips every later one, and a start that fails (for
  example when the settings file cannot be saved) is tried again every minute.
- **Server settings and commands never hold up the backup.** If they cannot be applied
  (disk full, a file locked by antivirus), the files are still backed up and the problem
  is reported in `status.json` (`configError`).
- **Plugin code is never written from the server.** `restore-all` and `pull` bring back
  other plugins' settings (`data.json`) but not their code, and nothing in this plugin's
  own folder; the files left out are counted in the command's result. After a full
  restore, reinstall other plugins from Obsidian.
- **An update no longer runs two backups at once.** When BRAT reloads the plugin, the old
  copy stops between files and saves the index, and the new one waits for it (at most
  30 s). A `restore-all` cut short this way is reported as failed, so it can be sent again.

## 1.6.1 — 2026-11-04

- **The private folder is hidden in Windows File Explorer too.** While locked, the folder
  and every file in it get Windows' hidden attribute (before, only the folder did), so
  Explorer and its search skip them unless *Hidden items* is switched on. The attribute is
  also set again when Obsidian starts while locked, and is cleared before unlocking.
- No console window flashes while this happens, and a quick unlock can no longer overtake
  a lock that is still finishing.
- Hiding is not encryption: anyone who shows hidden items can still open the notes.

## 1.6.0 — 2026-11-03

- The server keeps a copy of the vault passphrase, for the day it is forgotten. Once
  paired, the plugin sends it over the same connection as the backup after it is set,
  changed or typed to unlock. The computer never writes it to disk; the server keeps it in
  `_control/passphrase.json`, and `vlb passphrase` shows it.
- `vlb status` shows the addresses each computer connects from.

## 1.5.1 — 2026-11-03

Fixes from a line-by-line review of the plugin and the server, before daily use.

- **Deleting a folder no longer loses its trash copies.** Nothing in the server's `_trash/`
  is ever overwritten: a deleted folder's files are moved one by one, and the empty folder
  that follows is left alone. Renames never overwrite on the server either.
- **One bad file no longer stops the backup.** A file that cannot be read or stored is
  reported (`lastReconcile.failed` in `status.json`, shown by `vlb status`) and the others
  go on. The index is saved every 30 s during a long upload and when a run fails.
- **Locking saves first.** A private note being typed is saved before its tab is closed.
- **A damaged `data.json`** (power cut while it was written) no longer opens the vault
  unlocked or pairs the computer again as a new one: a copy, `data.bak.json`, is kept and
  restored; the damaged file is set aside.
- **Pop-out windows** count as activity for the idle lock, and moving between Obsidian's
  own windows no longer triggers *Lock when the window loses focus*.
- `restore-all` keeps notes edited on the computer after their last backup.
- Every request to the server has a time limit, so a stalled connection no longer freezes
  the backup until restart. A revoked login during a run no longer blocks later runs.
- The plugin's own folder (which holds the server key) is never backed up.
- Server: a container restart that fails is retried; the pairing inbox accepts only a
  pairing `PUT` and stray entries are removed; when all slots are taken the oldest stranger
  is retired so your own computer always gets in; `vlb move` restores the old folder's files
  before the first backup; caps are checked every minute; uploads are capped at 110 MB.

## 1.5.0 — 2026-11-03

Renamed to **Vault Lock**. The backup is a quiet part of the lock now, not half of the name.

- Plugin id `vault-lock` (was `vault-lock-backup`) and repository `obsidian-lock/vault-lock`.
  In BRAT, add `obsidian-lock/vault-lock`. An installation of the old id keeps working but no
  longer updates: remove it and add the new one (the passphrase is asked for again).
- Commands are now `vault-lock:lock` and `vault-lock:change-passphrase`.
- Nothing else changed.

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
