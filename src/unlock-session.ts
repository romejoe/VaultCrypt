import {DataAdapter} from 'obsidian';
import * as kdbxweb from 'kdbxweb';
import {ProfileConfig} from './settings';

const PROTECTED_FIELDS = new Set(['Password']);

/** Characters allowed in a single path segment (group or entry name) for inline-token parsing. */
const VALID_PATH_SEGMENT = /^[a-zA-Z0-9_-]+$/;

type LockCallback = (profileId: string) => void;
type UnlockCallback = (profileId: string) => void;

/** A lightweight tree node representing a KeePass group for display purposes. */
export interface DbTreeNode {
	name: string;
	path: string;
	groups: DbTreeNode[];
	entries: DbTreeEntry[];
}

/** A lightweight representation of a KeePass entry for tree display. */
export interface DbTreeEntry {
	name: string;
	path: string;
}

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

	/**
	 * Verifies a password against a profile's KDBX file without mutating session state.
	 * Returns true if the password is correct, false if wrong.
	 * Throws on I/O errors or a corrupted database.
	 */
	async checkProfilePassword(config: ProfileConfig, password: string): Promise<boolean> {
		const buffer = await this.adapter.readBinary(config.path);
		const credentials = new kdbxweb.KdbxCredentials(
			kdbxweb.ProtectedValue.fromString(password)
		);
		try {
			const db = await kdbxweb.Kdbx.load(buffer, credentials);
			db.cleanup();
			return true;
		} catch {
			return false;
		}
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

		const entry = this.resolveEntry(db, entryPath);
		if (!entry) return null;

		const fieldVal = entry.fields.get(fieldName);
		if (fieldVal === undefined) return null;
		return fieldVal instanceof kdbxweb.ProtectedValue ? fieldVal.getText() : (fieldVal ?? null);
	}

	/**
	 * Updates a single field value in an open profile's database and saves to disk.
	 * Creates the entry (and any intermediate groups) if they don't already exist.
	 * Throws if the profile is locked.
	 */
	async setFieldValue(
		profileId: string,
		entryPath: string,
		fieldName: string,
		newValue: string,
		kdbxFilePath: string,
	): Promise<void> {
		const db = this.getDatabase(profileId);
		if (!db) throw new Error(`Profile "${profileId}" is not unlocked`);

		let entry = this.resolveEntry(db, entryPath);
		if (!entry) {
			entry = this.resolveOrCreateEntry(db, entryPath);
		}

		const fieldValue: kdbxweb.KdbxEntryField = PROTECTED_FIELDS.has(fieldName)
			? kdbxweb.ProtectedValue.fromString(newValue)
			: newValue;
		entry.fields.set(fieldName, fieldValue);
		entry.times.update();

		const buffer = await db.save();
		await this.adapter.writeBinary(kdbxFilePath, buffer);
	}

	/**
	 * Returns the group/entry hierarchy of an unlocked profile as a lightweight tree,
	 * or null if the profile is locked.
	 */
	getEntryTree(profileId: string): DbTreeNode | null {
		const db = this.getDatabase(profileId);
		if (!db) return null;
		return this.buildTreeNode(db.getDefaultGroup(), '');
	}

	/**
	 * Returns all field key-value pairs for an entry, or null if the profile is
	 * locked or the entry cannot be found.  ProtectedValue instances are unwrapped
	 * to plaintext strings.
	 */
	getEntryFields(profileId: string, entryPath: string): Record<string, string> | null {
		const db = this.getDatabase(profileId);
		if (!db) return null;
		const entry = this.resolveEntry(db, entryPath);
		if (!entry) return null;
		const result: Record<string, string> = {};
		for (const [key, value] of entry.fields) {
			if (value === undefined || value === null) continue;
			result[key] = value instanceof kdbxweb.ProtectedValue ? value.getText() : value;
		}
		return result;
	}

	/**
	 * Replaces all non-Title fields on an existing entry and saves the database.
	 * Fields present in `fields` are set (created or updated); fields absent from
	 * `fields` but present on the entry are removed.  The Title field is never
	 * modified.  Throws if the profile is locked or the entry does not exist.
	 */
	async updateEntryFields(
		profileId: string,
		entryPath: string,
		fields: Record<string, string>,
		kdbxFilePath: string,
	): Promise<void> {
		const db = this.getDatabase(profileId);
		if (!db) throw new Error(`Profile "${profileId}" is not unlocked`);

		const entry = this.resolveEntry(db, entryPath);
		if (!entry) throw new Error(`Entry not found at "${entryPath}"`);

		// Snapshot existing fields so we can restore on save failure.
		const snapshot = new Map(entry.fields);

		// Remove all non-Title fields, then re-set from the provided record.
		const keysToRemove = [...entry.fields.keys()].filter(k => k !== 'Title');
		for (const key of keysToRemove) {
			entry.fields.delete(key);
		}

		for (const [key, value] of Object.entries(fields)) {
			if (key === 'Title') continue;
			if (!value) continue;
			const fieldValue: kdbxweb.KdbxEntryField = PROTECTED_FIELDS.has(key)
				? kdbxweb.ProtectedValue.fromString(value)
				: value;
			entry.fields.set(key, fieldValue);
		}
		entry.times.update();

		try {
			const buffer = await db.save();
			await this.adapter.writeBinary(kdbxFilePath, buffer);
		} catch (err) {
			// Restore the entry to its pre-edit state so the in-memory session
			// does not serve unsaved changes.
			entry.fields.clear();
			for (const [k, v] of snapshot) entry.fields.set(k, v);
			throw err;
		}
	}

	/**
	 * Deletes an entry from an open profile's database and saves to disk.
	 * If persistence fails the profile is locked so the in-memory session
	 * cannot serve stale data.  Throws if the profile is locked or the entry
	 * does not exist.
	 */
	async deleteEntry(
		profileId: string,
		entryPath: string,
		kdbxFilePath: string,
	): Promise<void> {
		const db = this.getDatabase(profileId);
		if (!db) throw new Error(`Profile "${profileId}" is not unlocked`);

		const entry = this.resolveEntry(db, entryPath);
		if (!entry) throw new Error(`Entry not found at "${entryPath}"`);

		db.remove(entry);

		try {
			const buffer = await db.save();
			await this.adapter.writeBinary(kdbxFilePath, buffer);
		} catch (err) {
			// A delete cannot be trivially rolled back in kdbxweb, so lock the
			// profile to force a clean reload from disk on next unlock.
			this.lockProfile(profileId);
			throw err;
		}
	}

	/**
	 * Returns the field names present on an entry, or null if the profile is locked
	 * or the entry cannot be found.
	 */
	getEntryFieldNames(profileId: string, entryPath: string): string[] | null {
		const db = this.getDatabase(profileId);
		if (!db) return null;
		const entry = this.resolveEntry(db, entryPath);
		if (!entry) return null;
		return [...entry.fields.keys()];
	}

	/**
	 * Creates a new entry with all provided fields at once and saves the database.
	 * Throws if the profile is locked, or if an entry already exists at the given path.
	 */
	async createEntryWithFields(
		profileId: string,
		entryPath: string,
		fields: Record<string, string>,
		kdbxFilePath: string,
	): Promise<void> {
		const db = this.getDatabase(profileId);
		if (!db) throw new Error(`Profile "${profileId}" is not unlocked`);

		if (this.resolveEntry(db, entryPath)) {
			throw new Error(`An entry already exists at "${entryPath}"`);
		}

		const entry = this.resolveOrCreateEntry(db, entryPath);
		for (const [key, value] of Object.entries(fields)) {
			if (!value) continue;
			const fieldValue: kdbxweb.KdbxEntryField = PROTECTED_FIELDS.has(key)
				? kdbxweb.ProtectedValue.fromString(value)
				: value;
			entry.fields.set(key, fieldValue);
		}
		entry.times.update();

		const buffer = await db.save();
		await this.adapter.writeBinary(kdbxFilePath, buffer);
	}

	/** Register a callback to be called when any profile is locked. */
	onLock(cb: LockCallback): void {
		this.lockCallbacks.push(cb);
	}

	/** Register a callback to be called when any profile is unlocked. */
	onUnlock(cb: UnlockCallback): void {
		this.unlockCallbacks.push(cb);
	}

	private resolveEntry(db: kdbxweb.Kdbx, entryPath: string): kdbxweb.KdbxEntry | null {
		const segments = entryPath.split('/');
		const title = segments[segments.length - 1];
		const groupSegments = segments.slice(0, -1);

		let group = db.getDefaultGroup();
		for (const seg of groupSegments) {
			const child = group.groups.find(g => (g.name ?? '').toLowerCase() === seg.toLowerCase());
			if (!child) return null;
			group = child;
		}

		return group.entries.find(e => {
			const t = e.fields.get('Title');
			const text = t instanceof kdbxweb.ProtectedValue ? t.getText() : t;
			return text === title;
		}) ?? null;
	}

	/**
	 * Creates an entry (and any intermediate groups) at the given path.
	 * Sets the Title field to the last path segment.
	 */
	private resolveOrCreateEntry(db: kdbxweb.Kdbx, entryPath: string): kdbxweb.KdbxEntry {
		const segments = entryPath.split('/').filter(s => s.length > 0);
		if (segments.length === 0) {
			throw new Error(`Invalid entry path: "${entryPath}" — path must contain at least an entry name`);
		}
		const title = segments[segments.length - 1]!;
		const groupSegments = segments.slice(0, -1);

		let group = db.getDefaultGroup();
		for (const seg of groupSegments) {
			const existing = group.groups.find(g => (g.name ?? '').toLowerCase() === seg.toLowerCase());
			if (existing) {
				group = existing;
			} else {
				group = db.createGroup(group, seg);
			}
		}

		const entry = db.createEntry(group);
		entry.fields.set('Title', title);
		return entry;
	}

	private buildTreeNode(group: kdbxweb.KdbxGroup, groupPath: string): DbTreeNode {
		const childGroups: DbTreeNode[] = [];
		for (const g of group.groups) {
			const childName = g.name ?? '';
			// Skip groups whose names can't be represented in token syntax
			if (!childName || !VALID_PATH_SEGMENT.test(childName)) continue;
			const childPath = groupPath ? `${groupPath}/${childName}` : childName;
			childGroups.push(this.buildTreeNode(g, childPath));
		}
		const entries: DbTreeEntry[] = [];
		for (const e of group.entries) {
			const titleVal = e.fields.get('Title');
			const title = titleVal instanceof kdbxweb.ProtectedValue ? titleVal.getText() : (titleVal ?? '');
			// Skip entries whose titles can't be represented in token syntax
			if (!title || !VALID_PATH_SEGMENT.test(title)) continue;
			const entryPath = groupPath ? `${groupPath}/${title}` : title;
			entries.push({ name: title, path: entryPath });
		}
		return { name: group.name ?? '', path: groupPath, groups: childGroups, entries };
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
