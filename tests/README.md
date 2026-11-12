# Startup regression checks

Run `npm test` to exercise the real profile service with an in-memory Obsidian
runtime mock. The tests do not read or modify a vault. CI runs them alongside
the build and lint checks.

The unindexed-folder cases reproduce [issue #81](https://github.com/romejoe/VaultCrypt/issues/81).
Tests also cover nested directory creation, file collisions, concurrent folder
creation, and disk errors.

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
- Disable and enable the plugin repeatedly; confirm commands and chip actions
  are not duplicated and there are no console errors.
- Check an already-open note in live preview and reading mode, including secret
  tokens in a table. Confirm chips render, unlock, reveal, and copy as before.
- With Obsidian closed and the test storage directory empty, replace that
  directory with a file at the same path. Restart and confirm a path-specific
  error appears and the file is preserved. Repeat for a parent path segment.
- Record the Obsidian version, OS, paths checked, and results in the PR.

These app-level checks remain separate from the automated service tests.
