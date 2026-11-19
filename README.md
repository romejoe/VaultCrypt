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

1. Create a profile or import an existing `.kdbx` database in **Settings → VaultCrypt**.
2. Unlock the profile with your master password.
3. Add entries to the database via the plugin's editor commands.
4. Insert `{{vc:...}}` tokens into your notes — they render as chips in Live Preview and Reading mode.
5. Click the chip to copy the value; the clipboard is auto-cleared after the configured timeout.

Run **VaultCrypt: Insert entry as table** from the command palette, then select an entry and choose **Insert table**. This inserts a Markdown table at the editor cursor with a chip for each referenceable field and attachment. The note stores references to those values, so the chips reflect later value edits. To include newly added fields, insert a new table.

Run **VaultCrypt: Insert live entry table** to keep the rows in sync with the entry. In Live Preview or Reading view, select **Edit entry** to add, edit, or remove fields and attachments. Saved changes appear in the table automatically, and locking the profile hides the rows. The Markdown source stores a single entry reference.

If a token points to a missing entry, its revealed chip shows **Entry not found** with a **Create entry** pencil button. If the entry exists but the referenced field is missing, it shows **Field not found** with an **Add field** pencil button. Both open a form using the referenced entry path and field; select **Create entry** to save a new entry, or **Save** to update an existing one. You can also right-click an unlocked chip and select **Create entry** or **Edit entry**.

Fields can have empty values. Clearing a value and saving keeps the field; remove a custom field's row to delete it. Revealed empty fields display **(empty)**, and their copy button copies an empty string.

Enable **Settings → VaultCrypt → Auto-unlock on file open** and select **Remember password** when unlocking to automatically unlock referenced profiles when opening notes, including the active note restored after startup. Keyring-managed profiles try the remembered keyring password first, then their own remembered profile password if needed.

### Import existing databases

VaultCrypt scans its storage directory on first run and prompts you if it finds existing KeePass databases. To import databases later, copy the `.kdbx` files into the configured storage directory or a subfolder and select **Settings → VaultCrypt → Import vaults**.

Select the databases you want to use, edit the suggested profile names if needed, then select **Import selected**. If your notes already reference a profile, use its previous name to reconnect those references. VaultCrypt uses each database in place. Unlock each imported profile with the database’s existing password.

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
