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

Profile and keyring creation reject existing files and folders in hidden,
visible unindexed, and indexed locations. Regression checks preserve existing
bytes and profile settings on failure, reject unreadable destinations, and verify
that new databases can still be created and reopened. The test suites share an
in-memory bundling and Obsidian host helper in `tests/helpers/obsidian-runtime.mjs`.

Directory migration tests cover hidden-to-visible and visible-to-hidden moves,
nested attachments and keyrings, path updates, destination collisions, and rollback
when moved files are not indexed yet. They also verify that cleanup preserves
new source files and that incomplete rollback is reported without replacing files.
Cleanup checks simulate non-recursive directory-removal failures, verify that
unindexed empty folders use local trash deepest first, and ensure cleanup errors
are reported without undoing successful migration or its path updates.

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
- Place a test KDBX file at a profile destination that is absent from settings,
  then try creating that profile. Confirm the error names the existing path and
  the original file is unchanged. Repeat with a keyring destination while keyring
  setup is disabled, and with hidden and visible storage directories.
- Use **Change storage directory** with **Move existing files** enabled to move
  from `.vaultcrypt` to `VaultCrypt` and back. Include profiles, a keyring, and a
  nested attachment folder. Confirm the files and configured paths move together,
  unlocking still works, and empty source folders are removed.
- Include empty nested folders in the hidden source directory. Confirm they are
  removed from the source and placed in the vault's `.trash` folder. If cleanup
  fails, confirm the warning names the remaining folder and migrated profiles
  still open from the new path.
- In a disposable vault, place a different file at a matching destination path
  before moving. Confirm the move fails without replacing that file, earlier
  moves are rolled back, and configured paths remain at the original location.
- Disable and enable the plugin repeatedly; confirm commands and chip actions
  are not duplicated and there are no console errors.
- Check an already-open note in live preview and reading mode, including secret
  tokens in a table. Confirm chips render, unlock, reveal, and copy as before.
- With Obsidian closed and the test storage directory empty, replace that
  directory with a file at the same path. Restart and confirm a path-specific
  error appears and the file is preserved. Repeat for a parent path segment.
- Record the Obsidian version, OS, paths checked, and results in the PR.

These app-level checks remain separate from the automated service tests.
