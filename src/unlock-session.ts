import {DataAdapter} from 'obsidian';
import * as kdbxweb from 'kdbxweb';
import {ProfileConfig} from './settings';

type LockCallback = (profileId: string) => void;
type UnlockCallback = (profileId: string) => void;

/**
 * Manages the in-memory session of unlocked KDBX databases.
 * Holds a Map<profileId, Kdbx> and per-profile auto-lock timers.
 * Fires onLock / onUnlock callbacks so the UI can react.
 *
 * Note: kdbxweb's Argon2 implementation must be registered globally
 * (done in KdbxService constructor) before unlockProfile() is called.
 */
export class UnlockSessionService {
	private openDbs = new Map<string, kdbxweb.Kdbx>();
	private timers = new Map<string, number>();
	private lockCallbacks: LockCallback[] = [];
	private unlockCallbacks: UnlockCallback[] = [];

	constructor(private adapter: DataAdapter) {
	}

	/** Opens a KDBX database and stores it in the session. Throws on wrong password. */
	async unlockProfile(profileId: string, config: ProfileConfig, password: string): Promise<void> {
		// If already unlocked, lock first to cleanup the old session
		if (this.openDbs.has(profileId)) {
			this.lockProfile(profileId);
		}
		const buffer = await this.adapter.readBinary(config.path);
		const credentials = new kdbxweb.KdbxCredentials(
			kdbxweb.ProtectedValue.fromString(password)
		);
		const db = await kdbxweb.Kdbx.load(buffer, credentials);
		this.openDbs.set(profileId, db);
		this.scheduleAutoLock(profileId, config.autoLockMinutes);
		this.emitUnlock(profileId);
	}

	/** Removes a profile's database from memory and clears its timer. */
	lockProfile(profileId: string): void {
		if (this.openDbs.has(profileId)) {
			this.openDbs.get(profileId)?.cleanup();
			this.openDbs.delete(profileId);
		}
		const timer = this.timers.get(profileId);
		if (timer !== undefined) {
			window.clearTimeout(timer);
			this.timers.delete(profileId);
		}
		this.emitLock(profileId);
	}

	/** Locks all currently unlocked profiles. */
	lockAll(): void {
		for (const profileId of [...this.openDbs.keys()]) {
			this.lockProfile(profileId);
		}
	}

	/** Returns the open Kdbx database for a profile, or null if locked. */
	getDatabase(profileId: string): kdbxweb.Kdbx | null {
		return this.openDbs.get(profileId) ?? null;
	}

	isUnlocked(profileId: string): boolean {
		return this.openDbs.has(profileId);
	}

	/**
	 * Resets the auto-lock timer for a profile.
	 * Call this on any user interaction (reveal, copy, edit) to defer locking.
	 */
	resetTimer(profileId: string, autoLockMinutes: number): void {
		const timer = this.timers.get(profileId);
		if (timer !== undefined) {
			window.clearTimeout(timer);
			this.timers.delete(profileId);
		}
		this.scheduleAutoLock(profileId, autoLockMinutes);
	}

	/**
	 * Reads a single field value from an open profile's database.
	 * Returns the plaintext string, or null if the profile is locked or the
	 * entry/field cannot be found.
	 */
	getFieldValue(profileId: string, entryPath: string, fieldName: string): string | null {
		const db = this.getDatabase(profileId);
		if (!db) return null;

		const segments = entryPath.split('/');
		const title = segments[segments.length - 1];
		const groupSegments = segments.slice(0, -1);

		// Walk the group hierarchy
		let group = db.getDefaultGroup();
		for (const seg of groupSegments) {
			const child = group.groups.find(g => (g.name ?? '').toLowerCase() === seg.toLowerCase());
			if (!child) return null;
			group = child;
		}

		const entry = group.entries.find(e => {
			const t = e.fields.get('Title');
			const text = t instanceof kdbxweb.ProtectedValue ? t.getText() : t;
			return text === title;
		});
		if (!entry) return null;

		const fieldVal = entry.fields.get(fieldName);
		if (fieldVal === undefined) return null;
		return fieldVal instanceof kdbxweb.ProtectedValue ? fieldVal.getText() : (fieldVal ?? null);
	}

	/** Register a callback to be called when any profile is locked. */
	onLock(cb: LockCallback): void {
		this.lockCallbacks.push(cb);
	}

	/** Register a callback to be called when any profile is unlocked. */
	onUnlock(cb: UnlockCallback): void {
		this.unlockCallbacks.push(cb);
	}

	private scheduleAutoLock(profileId: string, autoLockMinutes: number): void {
		if (autoLockMinutes <= 0) return; // 0 = "until Obsidian closes"
		const ms = autoLockMinutes * 60 * 1000;
		const timer = window.setTimeout(() => {
			this.lockProfile(profileId);
		}, ms);
		this.timers.set(profileId, timer);
	}

	private emitLock(profileId: string): void {
		for (const cb of this.lockCallbacks) {
			try {
				cb(profileId);
			} catch (err) {
				console.error('[VaultCrypt] lock callback failed', err);
			}
		}
	}

	private emitUnlock(profileId: string): void {
		for (const cb of this.unlockCallbacks) {
			try {
				cb(profileId);
			} catch (err) {
				console.error('[VaultCrypt] unlock callback failed', err);
			}
		}
	}
}
