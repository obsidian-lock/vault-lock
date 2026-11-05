# Security policy

## Reporting a vulnerability

Please report security issues privately through
[GitHub private vulnerability reporting](https://github.com/obsidian-lock/vault-lock/security/advisories/new),
not in a public issue.

Only the latest release is supported. Fixes ship as a new release, which BRAT installs
automatically.

## What counts as a vulnerability

The plugin is a privacy screen and makes no encryption claims. These limits are known and by
design:

- notes, including the private folder, are readable by anyone with access to the files;
- deleting the plugin's `data.json` removes the lock;
- this computer's server key is stored in plain text in `data.json` (never uploaded);
- since 1.6.0 the plugin sends the vault passphrase, on purpose, to the computer's own
  folder on the server (`_control/passphrase.json`), so the server can show it when it is
  forgotten;
- anyone with write access to a computer's server folder can control the plugin through
  `_control/`: settings, commands, restoring files. Not code: since 1.7.0 plugin code from
  the server runs only when it is signed with the update key. That key lives only on the
  backup server, readable by root, so root on that server can run code on the paired
  computers. The public keys are in `src/shared/server.ts`;
- the pairing login built into the plugin is public: it can only drop a small request into
  the server's pairing inbox. Anyone can pair and gets an empty folder of their own, which
  the server freezes when it grows past the caps.

Things worth reporting, for example:

- a way to get past the lock screen or reach the vault's notes inside Obsidian while locked,
  without touching files on disk;
- the private folder appearing in Obsidian while locked;
- the passphrase hash or the server key being uploaded or leaked, or the passphrase going
  anywhere but the computer's own folder on the server;
- any way to make the plugin run server code that is not signed with the update key, or an
  older signed bundle than the last one it accepted;
- a way for one paired computer to read or change another computer's folder, to take over
  another computer's folder or login, or to get past the server's caps;
- any way for the plugin to delete or lose data on the server or the computer;
- a `_control/` input that does more than the documented commands (for example, writing
  outside the vault).
