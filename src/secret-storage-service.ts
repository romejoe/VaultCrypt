import {App} from 'obsidian';

const KEY_PREFIX = 'vaultcrypt';

/**
 * Thin wrapper around Obsidian's SecretStorage (added in 1.11.4) for VaultCrypt's
 * "remember password" feature.  All methods are synchronous and swallow errors
 * so that callers degrade gracefully on older Obsidian versions.
 *
 * Key naming convention (lowercase alphanumeric + dashes, per API requirements):
 *   Profile password : vaultcrypt-profile-{profileId}
 *   Keyring password : vaultcrypt-keyring
 */
export class SecretStorageService {
	constructor(private readonly app: App) {}

	saveProfilePassword(profileId: string, password: string): void {
		try {
			this.app.secretStorage.setSecret(`${KEY_PREFIX}-profile-${profileId}`, password);
		} catch {
			// SecretStorage unavailable (Obsidian < 1.11.4)
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

	forgetProfilePassword(profileId: string): void {
		try {
			this.app.secretStorage.setSecret(`${KEY_PREFIX}-profile-${profileId}`, '');
		} catch {
			// ignore
		}
	}

	saveKeyringPassword(password: string): void {
		try {
			this.app.secretStorage.setSecret(`${KEY_PREFIX}-keyring`, password);
		} catch {
			// ignore
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

	forgetKeyringPassword(): void {
		try {
			this.app.secretStorage.setSecret(`${KEY_PREFIX}-keyring`, '');
		} catch {
			// ignore
		}
	}

	hasProfilePassword(profileId: string): boolean {
		return this.loadProfilePassword(profileId) !== null;
	}

	hasKeyringPassword(): boolean {
		return this.loadKeyringPassword() !== null;
	}
}
