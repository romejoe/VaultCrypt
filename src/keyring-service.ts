import {DataAdapter} from 'obsidian';
import {KdbxService} from './kdbx-service';

/** Hardened KDF parameters for the keyring (protects all profile passwords). */
const KEYRING_KDF = {iterations: 4, memory: 131072, parallelism: 4};

/**
 * Manages a Key-Encrypting-Key (KEK) keyring — a KDBX 4.x database that
 * stores per-profile passwords so a single master password unlocks everything.
 *
 * The keyring is never held open in memory; each operation opens the file,
 * performs the action, then closes it immediately.
 */
export class KeyringService {
	constructor(private adapter: DataAdapter) {}

	/** Checks whether the keyring file exists on disk. */
	async keyringExists(path: string): Promise<boolean> {
		return this.adapter.exists(path);
	}

	/** Creates a new KDBX 4.x keyring with hardened KDF parameters. */
	async createKeyring(path: string, masterPassword: string): Promise<void> {
		const svc = new KdbxService(this.adapter);
		await svc.createDatabase(path, masterPassword, 4, KEYRING_KDF);
		svc.closeDatabase();
	}

	/**
	 * Opens the keyring and reads stored passwords for the given profile IDs.
	 * Returns a Map of profileId → password (only for profiles that have entries).
	 */
	async getProfilePasswords(
		path: string,
		masterPassword: string,
		profileIds: string[],
	): Promise<Map<string, string>> {
		const svc = new KdbxService(this.adapter);
		await svc.openDatabase(path, masterPassword);
		try {
			const result = new Map<string, string>();
			for (const id of profileIds) {
				const entry = svc.getEntry(id);
				if (entry?.fields.Password) {
					result.set(id, entry.fields.Password);
				}
			}
			return result;
		} finally {
			svc.closeDatabase();
		}
	}

	/** Stores (or updates) a profile's password in the keyring. */
	async setProfilePassword(
		path: string,
		masterPassword: string,
		profileId: string,
		profilePassword: string,
	): Promise<void> {
		const svc = new KdbxService(this.adapter);
		await svc.openDatabase(path, masterPassword);
		try {
			await svc.setEntry(profileId, {Password: profilePassword});
			await svc.saveDatabase();
		} finally {
			svc.closeDatabase();
		}
	}

	/** Removes a profile's entry from the keyring. */
	async removeProfilePassword(
		path: string,
		masterPassword: string,
		profileId: string,
	): Promise<void> {
		const svc = new KdbxService(this.adapter);
		await svc.openDatabase(path, masterPassword);
		try {
			svc.deleteEntry(profileId);
			await svc.saveDatabase();
		} finally {
			svc.closeDatabase();
		}
	}

	/** Renames a profile entry in the keyring (copies password to new ID, deletes old). */
	async renameProfileEntry(
		path: string,
		masterPassword: string,
		oldId: string,
		newId: string,
	): Promise<void> {
		const svc = new KdbxService(this.adapter);
		await svc.openDatabase(path, masterPassword);
		try {
			const entry = svc.getEntry(oldId);
			if (!entry?.fields.Password) {
				throw new Error(`No keyring entry found for profile "${oldId}"`);
			}
			await svc.setEntry(newId, {Password: entry.fields.Password});
			svc.deleteEntry(oldId);
			await svc.saveDatabase();
		} finally {
			svc.closeDatabase();
		}
	}

	/** Changes the keyring's master password. */
	async changeMasterPassword(
		path: string,
		currentPassword: string,
		newPassword: string,
	): Promise<void> {
		const svc = new KdbxService(this.adapter);
		await svc.openDatabase(path, currentPassword);
		try {
			svc.changePassword(newPassword);
			await svc.saveDatabase();
		} finally {
			svc.closeDatabase();
		}
	}

	/** Deletes the keyring file from disk. */
	async deleteKeyring(path: string): Promise<void> {
		try {
			await this.adapter.remove(path);
		} catch {
			// File may already be gone — acceptable
		}
	}

	/** Opens the keyring and returns the Title of every entry (i.e. managed profile IDs). */
	async listManagedProfileIds(
		path: string,
		masterPassword: string,
	): Promise<string[]> {
		const svc = new KdbxService(this.adapter);
		await svc.openDatabase(path, masterPassword);
		try {
			const entries = svc.listEntries();
			return entries
				.map(e => e.fields.Title)
				.filter((t): t is string => !!t);
		} finally {
			svc.closeDatabase();
		}
	}
}
