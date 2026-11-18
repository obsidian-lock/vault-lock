# Security policy

## Reporting a vulnerability

Please report security issues privately through
[GitHub private vulnerability reporting](https://github.com/obsidian-lock/vault-lock/security/advisories/new),
not in a public issue.

Only the latest release is supported. Fixes ship as a new release, which BRAT installs
automatically.

## What counts as a vulnerability

The plugin's encryption covers the private folder while the vault is locked: AES-256-GCM,
every file up to 100 MB encrypted on lock, decrypted on unlock. Everything else is a
privacy screen with known limits, by design:

- notes outside the private folder, the private folder while unlocked, and files over
  100 MB are readable by anyone with access to the files; file names inside the hidden
  folder are visible to anyone who shows hidden files;
- deleting the plugin's `data.json` removes the lock;
- this computer's server key is stored in plain text in `data.json` (never uploaded);
- since 1.9.0 the key that encrypts the private folder is made by the backup server, which
  keeps it and puts a copy in the computer's own folder (`_control/vault-key.json`); the
  plugin stores it in plain text in `data.json` and `data.bak.json`, so anyone who can read
  those files can decrypt the private folder. The server keeps readable copies of the
  private notes, as before;
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

- a way to open the private folder's notes inside Obsidian while locked (a link, a
  bookmark, search, an embed), without touching files on disk (since 2.0.0 the rest of the
  vault stays usable while locked, by design);
- the private folder appearing in Obsidian while locked;
- a private file left readable on disk after a lock has finished (other than the limits
  above, or a file another program holds open), or a private file lost or damaged by the
  encryption;
- the plugin sending the vault key anywhere (it only reads it from the computer's own
  folder), or one computer reaching another computer's key;
- the passphrase hash or the server key being uploaded or leaked, or the passphrase going
  anywhere but the computer's own folder on the server;
- any way to make the plugin run server code that is not signed with the update key, or an
  older signed bundle than the last one it accepted;
- a way for one paired computer to read or change another computer's folder, to take over
  another computer's folder or login, or to get past the server's caps;
- any way for the plugin to delete or lose data on the server or the computer;
- a `_control/` input that does more than the documented commands (for example, writing
  outside the vault).
