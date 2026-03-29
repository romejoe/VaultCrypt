import {SecretStorage} from 'obsidian';

const PREFIX_PROFILE = 'vc-profile-';
const KEY_KEYRING = 'vc-keyring';

/**
 * Thin wrapper around Obsidian's SecretStorage for caching profile and keyring
 * passwords.  On desktop, SecretStorage uses Electron's safeStorage (OS-level
 * encryption).  On mobile the implementation details are less certain, but it
 * is the best available option.
 */
export class CredentialCacheService {
	constructor(private storage: SecretStorage) {}

	saveProfilePassword(profileId: string, password: string): void {
		this.storage.setSecret(`${PREFIX_PROFILE}${profileId}`, password);
	}

	getProfilePassword(profileId: string): string | null {
		return this.storage.getSecret(`${PREFIX_PROFILE}${profileId}`);
	}

	clearProfilePassword(profileId: string): void {
		this.storage.setSecret(`${PREFIX_PROFILE}${profileId}`, '');
	}

	saveKeyringPassword(password: string): void {
		this.storage.setSecret(KEY_KEYRING, password);
	}

	getKeyringPassword(): string | null {
		return this.storage.getSecret(KEY_KEYRING);
	}

	clearKeyringPassword(): void {
		this.storage.setSecret(KEY_KEYRING, '');
	}

	clearAll(): void {
		for (const id of this.storage.listSecrets()) {
			if (id.startsWith(PREFIX_PROFILE) || id === KEY_KEYRING) {
				this.storage.setSecret(id, '');
			}
		}
	}

	/** Returns true if a non-empty password is cached for the given profile. */
	hasProfilePassword(profileId: string): boolean {
		const pw = this.getProfilePassword(profileId);
		return pw !== null && pw !== '';
	}

	/** Returns true if a non-empty keyring password is cached. */
	hasKeyringPassword(): boolean {
		const pw = this.getKeyringPassword();
		return pw !== null && pw !== '';
	}
}
