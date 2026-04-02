import {App} from 'obsidian';
import type {VaultCryptSettings} from './settings';
import type {DeepReadonly} from './utils';
import type {UnlockSessionService} from './unlock-session';
import type {KeyringService} from './keyring-service';

const KEY_PREFIX = 'vaultcrypt';

/**
 * Returns true when the error is a kdbxweb InvalidKey error (wrong password).
 * Uses a duck-type check so we avoid importing kdbxweb here.
 */
function isInvalidKeyError(err: unknown): boolean {
	return (
		err instanceof Error &&
		'code' in err &&
		(err as Error & {code: string}).code === 'InvalidKey'
	);
}

/**
 * Wrapper around Obsidian's SecretStorage (added in 1.11.4) for VaultCrypt's
 * "remember password" feature.
 *
 * Key naming convention (lowercase alphanumeric + dashes, per API requirements):
 *   Profile password : vaultcrypt-profile-{profileId}
 *   Keyring password : vaultcrypt-keyring
 *
 * save/forget methods return true on success, false on failure so callers
 * can surface errors to the user if needed.  load methods return null on
 * any error so callers degrade gracefully on older Obsidian versions.
 */
export class SecretStorageService {
	constructor(private readonly app: App) {}

	saveProfilePassword(profileId: string, password: string): boolean {
		try {
			this.app.secretStorage.setSecret(`${KEY_PREFIX}-profile-${profileId}`, password);
			return true;
		} catch (err) {
			console.error('[VaultCrypt] Failed to save profile password to secret storage:', err);
			return false;
		}
	}

	loadProfilePassword(profileId: string): string | null {
		try {
			const val = this.app.secretStorage.getSecret(`${KEY_PREFIX}-profile-${profileId}`);
			return val ? val : null;
		} catch {
			return null;
		}
	}

	forgetProfilePassword(profileId: string): boolean {
		try {
			this.app.secretStorage.setSecret(`${KEY_PREFIX}-profile-${profileId}`, '');
			return true;
		} catch (err) {
			console.error('[VaultCrypt] Failed to clear profile password from secret storage:', err);
			return false;
		}
	}

	saveKeyringPassword(password: string): boolean {
		try {
			this.app.secretStorage.setSecret(`${KEY_PREFIX}-keyring`, password);
			return true;
		} catch (err) {
			console.error('[VaultCrypt] Failed to save keyring password to secret storage:', err);
			return false;
		}
	}

	loadKeyringPassword(): string | null {
		try {
			const val = this.app.secretStorage.getSecret(`${KEY_PREFIX}-keyring`);
			return val ? val : null;
		} catch {
			return null;
		}
	}

	forgetKeyringPassword(): boolean {
		try {
			this.app.secretStorage.setSecret(`${KEY_PREFIX}-keyring`, '');
			return true;
		} catch (err) {
			console.error('[VaultCrypt] Failed to clear keyring password from secret storage:', err);
			return false;
		}
	}

	hasProfilePassword(profileId: string): boolean {
		return this.loadProfilePassword(profileId) !== null;
	}

	hasKeyringPassword(): boolean {
		return this.loadKeyringPassword() !== null;
	}

	/**
	 * Attempts to auto-unlock all profiles in `lockedProfileIds` using saved
	 * passwords.  Successfully unlocked profile IDs are removed from the set so
	 * the caller only needs to prompt for what remains.
	 *
	 * Saved credentials are forgotten only when a wrong-password error is
	 * confirmed (kdbxweb InvalidKey).  Transient I/O or corruption errors leave
	 * the saved password intact so the user isn't unexpectedly logged out.
	 */
	async autoUnlockProfiles(
		settings: DeepReadonly<VaultCryptSettings>,
		lockedProfileIds: Set<string>,
		sessionService: UnlockSessionService,
		keyringService: KeyringService,
	): Promise<void> {
		// Try keyring first (unlocks all managed profiles in one KDBX open)
		if (settings.keyringEnabled) {
			const savedKeyringPw = this.loadKeyringPassword();
			if (savedKeyringPw) {
				const managedLocked = [...lockedProfileIds].filter(
					id => settings.profiles[id]?.managedByKeyring
				);
				if (managedLocked.length > 0) {
					try {
						const passwords = await keyringService.getProfilePasswords(
							settings.masterKeyringPath, savedKeyringPw, managedLocked,
						);
						for (const [profileId, profilePassword] of passwords) {
							if (sessionService.isUnlocked(profileId)) continue;
							const config = settings.profiles[profileId];
							if (!config) continue;
							try {
								await sessionService.unlockProfile(profileId, config, profilePassword);
								lockedProfileIds.delete(profileId);
							} catch {
								// Stale keyring entry — leave in locked set to prompt manually
							}
						}
					} catch (err) {
						if (isInvalidKeyError(err)) {
							this.forgetKeyringPassword();
						}
						// I/O / corruption: leave saved password intact, fall through to prompt
					}
				}
			}
		}

		// Try individual saved passwords for non-keyring profiles
		for (const profileId of [...lockedProfileIds]) {
			if (settings.profiles[profileId]?.managedByKeyring) continue;
			const savedPw = this.loadProfilePassword(profileId);
			if (!savedPw) continue;
			try {
				const config = settings.profiles[profileId]!;
				await sessionService.unlockProfile(profileId, config, savedPw);
				lockedProfileIds.delete(profileId);
			} catch (err) {
				if (isInvalidKeyError(err)) {
					this.forgetProfilePassword(profileId);
				}
				// I/O / corruption: leave saved password intact
			}
		}
	}
}
