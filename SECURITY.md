# Security Policy

Vaultlet stores passwords, TOTP secrets and passkeys, so security reports are
very welcome. Thank you for taking the time to report responsibly.

> Vaultlet is a personal open-source project and has **not** had an independent
> security audit. Keep backups of your vault file.

## Supported versions

Only the latest release receives security fixes. Please check that the issue
still exists in the latest release or on `main` before reporting.

## Reporting a vulnerability

**Please do not open a public issue, discussion or pull request for security
problems.**

Report privately through GitHub:
[Report a vulnerability](https://github.com/solirpa/vaultlet/security/advisories/new)
(Security tab → "Report a vulnerability").

Please include:

- the affected component (core, desktop app, browser extension, Android app, CLI)
  and version, OS and browser
- steps to reproduce, and a proof of concept if you have one
- what an attacker can achieve, and what access they need

## What to expect

This project is maintained by one person in their spare time.

- Acknowledgement within **7 days**.
- An assessment and, for confirmed issues, a fix plan within **30 days**.
- Fixes for serious issues released within **90 days**; you will be kept
  informed and credited in the advisory unless you prefer not to be.
- Please allow a reasonable time for a fix to be released before disclosing
  publicly.

There is no bug bounty.

## Scope

In scope, for example:

- Decrypting or tampering with a vault (`.kdbx`) without the master password,
  or weaknesses in how it is encrypted or written
- Sync and merge bugs that silently lose or corrupt entries
- A website, page script or another extension getting credentials, TOTP codes
  or passkey signatures it should not get, e.g. filling or signing on the wrong
  origin, or bypassing the user's confirmation
- Bypassing browser pairing, or talking to the desktop app's local IPC without
  being paired
- Android: autofill offering credentials to the wrong app or site, bypassing
  fingerprint unlock or auto-lock, secrets leaking through logs, backups,
  screenshots or the clipboard
- Secrets written to disk in plaintext, or kept in memory far longer than needed

Out of scope:

- Attacks that need an already compromised device (malware, keyloggers, root /
  administrator access, a malicious browser extension with full permissions)
- Weak master passwords, or someone who already knows the master password
- Physical access to an unlocked device
- Problems in third-party services such as your WebDAV provider
- Missing OS code signing (e.g. the macOS "unidentified developer" warning)
- Issues in dependencies that do not affect Vaultlet; please report those upstream

## Security design in brief

- Vaults are standard KeePass KDBX 4 files; vaults created by Vaultlet use
  Argon2id key derivation. All encryption and decryption happens on your
  device: sync (cloud folder or WebDAV) only ever moves the encrypted file.
- The browser extension never holds the vault. It talks to the desktop app
  through a native messaging host, using NaCl box encryption after a pairing
  that the user approves in the desktop app.
- Passkey private keys are never sent to the browser extension; the desktop
  app checks the origin and relying party ID before signing.
- On Android, the master password for fingerprint unlock is sealed by an
  Android Keystore key that requires a strong biometric and is invalidated
  when new fingerprints are enrolled.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for details.
