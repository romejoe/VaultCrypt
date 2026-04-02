# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # Install dependencies
npm run dev          # Watch mode (auto-recompile on change)
npm run build        # TypeScript type check + production esbuild bundle
npm run lint         # ESLint analysis (or: eslint ./src/)
npm run version      # Bump version in manifest.json/versions.json
npm run release      # npm version minor + git push + push tags
```

**Testing:** Manual only. Copy `main.js`, `manifest.json`, `styles.css` to `<Vault>/.obsidian/plugins/vaultcrypt/` and reload Obsidian (**Settings → Community plugins**).

## Architecture

VaultCrypt is an Obsidian plugin for inline encryption of sensitive values using KeePass-compatible `.kdbx` databases. Users reference secrets in Markdown with tokens like `{{vc:profileId/path/to/entry#fieldName}}`, which render as interactive "chips" without exposing plaintext in notes.

### State Management

The plugin uses `@maverick-js/signals` for reactive state. Two key signals drive the entire UI:
- `settings$` — persisted profile configurations
- `vaultCryptState$` — runtime lock/unlock status per profile

Effects on these signals update editor decorations and the status bar automatically.

### Core Services (`src/`)

| File | Responsibility |
|------|----------------|
| `main.ts` | Plugin lifecycle only — `onload`, `onunload`, command/event registration |
| `kdbx-service.ts` | KDBX database creation, loading, entry/field CRUD; registers Argon2 |
| `unlock-session.ts` | In-memory unlocked databases, auto-lock timers, lock/unlock callbacks |
| `keyring-service.ts` | Master keyring KDBX storing profile passwords (optional feature) |
| `profile-service.ts` | Profile CRUD, `.vaultcrypt/` directory and config file management |
| `settings.ts` | `VaultCryptSettingTab`, settings interfaces, defaults |
| `types.ts` | Core interfaces (`VaultCryptProfile`, `VaultCryptState`) |

### Token Rendering Pipeline

1. `inline-parser.ts` — regex tokenizer extracts `{{vc:...}}` tokens from markdown
2. `editor-extension.ts` — CodeMirror 6 plugin applies decorations in live-preview; handles autocompletion by traversing the database
3. `chip-component.ts` — renders the interactive chip widget (masked value, copy, edit, delete actions) in both editor and reading mode
4. `attachment-chip.ts` — handles file attachment display within chips
5. `clipboard-intercept.ts` — intercepts clipboard events to strip masked values; auto-clears clipboard after configurable timeout

### Data Persistence

- **Plugin settings** (`data.json`) — Obsidian `loadData()`/`saveData()` for profile paths, keyring status, timeouts
- **Config mirror** (`.vaultcrypt/vaultcrypt.config.json`) — JSON mirror readable by external tools
- **Profile databases** (`.vaultcrypt/{profileId}.kdbx`) — KeePass v3/v4 files
- **Keyring** (`.vaultcrypt/_keyring.kdbx`) — optional master keyring

### Security Design

- Argon2id KDF for KDBX v4 (3 iterations, 65536 KiB memory); AES KDF for v3 (600k iterations)
- Password fields wrapped in `ProtectedValue` (kdbxweb); never stored as plaintext
- Clipboard auto-clear timeout; no vault contents in settings or logs
- Plugin-level listeners/intervals should use `this.register*` helpers for safe cleanup on unload; component-local listeners must be explicitly cleaned up

## Key Conventions

- **Keep `main.ts` minimal** — lifecycle and registration only; all logic lives in service modules
- **Command IDs are stable** — never rename after release (breaks user hotkeys)
- **File size guideline** — split files exceeding ~200–300 lines into focused modules
- **TypeScript strict mode** — `noImplicitAny`, `strictNullChecks` enforced
- **No network calls** without explicit user opt-in and documentation
- **Mobile compatible** (`isDesktopOnly: false`) — avoid Node/Electron-only APIs

## Versioning & Releases

- Bump `version` in `manifest.json` and update `versions.json` (plugin version → min app version)
- GitHub release tag must match `manifest.json` version exactly (no leading `v`)
- Release artifacts: `main.js`, `manifest.json`, `styles.css` — attached individually
- GitHub Actions (`.github/workflows/release.yml`) automates packaging on tagged commits
