# Storage regression checks

Run `npm test` to exercise the real profile, KDBX, session, and unlock-modal code
with an in-memory Obsidian runtime mock. The tests do not read or modify a vault.
CI runs them alongside the build and lint checks.

The unindexed-folder cases reproduce [issue #81](https://github.com/romejoe/VaultCrypt/issues/81).
Tests also cover nested directory creation, file collisions, concurrent folder
creation, and disk errors.

The hidden-database cases reproduce [issue #85](https://github.com/romejoe/VaultCrypt/issues/85).
They use real KDBX v3/v4 encryption with reduced test-only KDF parameters and cover
creation, unlock, editing, lock, password verification, and reopening saved data.
Both hidden and visible unindexed paths are checked, alongside indexed files.
Missing files, adapter failures, folder collisions, and unlock-modal error messages
are also covered. Production KDF defaults are unchanged.

## Manual acceptance before merging

Use a disposable Obsidian vault with test secrets only. Build with `npm run build`
and install `main.js`, `manifest.json`, and `styles.css` in its plugin directory.
Do not use a production vault for file-collision or missing-directory checks.

- Fully quit and reopen Obsidian with the plugin enabled and an existing storage
  directory. Repeat for `VaultCrypt`, `_VaultCrypt`, `.vaultcrypt`, and a nested
  custom path. Configure each path through settings before restarting.
- Confirm there is no “Folder already exists” error or plugin failure. Commands,
  settings, and unlocking should work without toggling the plugin.
- Start with a fresh vault without the storage directory; confirm it is created.
- Keep the default hidden `.vaultcrypt` directory when the sync notice appears.
  Create v3 and v4 test profiles, unlock each, add/edit a secret, lock, and unlock
  again. Restart Obsidian and confirm the saved values can still be read. Repeat
  with a visible storage directory and a nested hidden directory.
- Enter an incorrect profile password and confirm the password error still appears.
  With Obsidian closed, temporarily move a test database out of the vault. Restart
  and try unlocking it; confirm the error names the missing KDBX path. Restore it
  afterward. Repeat for a missing keyring and a missing keyring-managed profile.
- Disable and enable the plugin repeatedly; confirm commands and chip actions
  are not duplicated and there are no console errors.
- Check an already-open note in live preview and reading mode, including secret
  tokens in a table. Confirm chips render, unlock, reveal, and copy as before.
- With Obsidian closed and the test storage directory empty, replace that
  directory with a file at the same path. Restart and confirm a path-specific
  error appears and the file is preserved. Repeat for a parent path segment.
- Record the Obsidian version, OS, paths checked, and results in the PR.

These app-level checks remain separate from the automated service tests.
