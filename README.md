# VaultCrypt

**Inline encryption for notes using KeePass-compatible (`.kdbx`) storage.**

Reference secrets in your Markdown notes with tokens like `{{vc:profileId/path/to/entry#fieldName}}`. They render as interactive "chips" — masked by default, never exposing plaintext in your notes.

## Features

- Store secrets in KeePass v3/v4 (`.kdbx`) databases inside your vault
- Reference secrets inline with `{{vc:...}}` tokens that render as masked chips
- Copy secret values to clipboard (auto-cleared after a configurable timeout)
- Lock/unlock profiles per session with auto-lock timers
- Optional master keyring for storing profile passwords
- Works on desktop and mobile (`isDesktopOnly: false`)
- Argon2id KDF (KDBX v4) for strong key derivation

## Usage

### Token Syntax

```
{{vc:profileId/Group/Entry#FieldName}}
```

- `profileId` — the profile configured in plugin settings
- `Group/Entry` — path to the KeePass entry
- `FieldName` — field on that entry (e.g. `Password`, `UserName`, or a custom field)

### Workflow

1. Create a profile in **Settings → VaultCrypt** pointing to a `.kdbx` file (or let the plugin create one).
2. Unlock the profile with your master password.
3. Add entries to the database via the plugin's editor commands.
4. Insert `{{vc:...}}` tokens into your notes — they render as chips in Live Preview and Reading mode.
5. Click the chip to copy the value; the clipboard is auto-cleared after the configured timeout.

## Installation

### Community Plugin (recommended)

Search for **VaultCrypt** in **Settings → Community plugins → Browse**.

### Manual

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/romejoe/obsidian-vaultcrypt/releases).
2. Copy the three files to `<YourVault>/.obsidian/plugins/vaultcrypt/`.
3. Reload Obsidian and enable **VaultCrypt** in **Settings → Community plugins**.

## Development

```bash
npm install       # Install dependencies
npm run dev       # Watch mode — auto-recompile on change
npm run build     # Type check + production bundle
npm run lint      # ESLint analysis
```

To test locally, copy `main.js`, `manifest.json`, and `styles.css` to your vault's plugin folder and reload Obsidian (**Settings → Community plugins**).

## Releasing

```bash
npm run version   # Bump version in manifest.json / versions.json
npm run release   # npm version minor + git push + push tags
```

GitHub Actions (`.github/workflows/release.yml`) packages and attaches the release artifacts automatically on tagged commits. The tag must match the version in `manifest.json` exactly (no leading `v`).

## Security

- Argon2id KDF, 3 iterations, 64 MiB memory (KDBX v4); AES-KDF 600k iterations (KDBX v3)
- Passwords wrapped in `ProtectedValue` (kdbxweb) — never stored as plaintext
- Clipboard auto-cleared after configurable timeout
- No vault contents in settings or logs
- No network calls

## Support

If VaultCrypt saves you time, consider [sponsoring on GitHub](https://github.com/sponsors/romejoe).
