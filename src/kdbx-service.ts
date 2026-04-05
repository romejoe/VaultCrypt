import { App } from 'obsidian';
import { getVaultFile } from './utils';
import * as kdbxweb from 'kdbxweb';
import { Int64 } from "kdbxweb";
import { argon2d, argon2id } from '@noble/hashes/argon2.js';

export type KdbxVersion = 3 | 4;

export interface KdfConfig {
	iterations?: number;
	memory?: number;      // Argon2 only (kibibytes), default 65536
	parallelism?: number; // Argon2 only, default 2
}

export interface EntryFields {
	UserName?: string;
	Password?: string;
	URL?: string;
	Notes?: string;
	[key: string]: string | undefined;
}

export interface EntryRecord {
	path: string;
	fields: EntryFields;
}

const DEFAULT_KDF_V4: Required<KdfConfig> = { iterations: 3, memory: 65536, parallelism: 2 };
const DEFAULT_KDF_V3: Required<KdfConfig> = { iterations: 600000, memory: 0, parallelism: 1 };

// Protected field names — values are wrapped in ProtectedValue when stored
const PROTECTED_FIELDS = new Set(['Password']);

export class KdbxService {
	private db: kdbxweb.Kdbx | null = null;
	private currentPath: string | null = null;

	constructor(private app: App) {
		kdbxweb.CryptoEngine.setArgon2Impl((password, salt, memory, iterations, length, parallelism, type, version) => {
			const argon2 = type === 0 ? argon2d : argon2id;

			const bytes = argon2(
				new Uint8Array(password),
				new Uint8Array(salt),
				{
					t: iterations,
					m: memory,
					p: parallelism,
					dkLen: length,
					version,
				},
			);

			return Promise.resolve(bytes.buffer);
		});
	}

	async createDatabase(
		path: string,
		password: string,
		version: KdbxVersion = 4,
		kdfConfig?: KdfConfig
	): Promise<void> {
		const credentials = new kdbxweb.KdbxCredentials(
			kdbxweb.ProtectedValue.fromString(password)
		);
		const name = path.split('/').pop()?.replace(/\.kdbx$/i, '') ?? 'VaultCrypt';
		const db = kdbxweb.Kdbx.create(credentials, name);

		if (version === 3) {
			db.setVersion(3);
			const cfg = { ...DEFAULT_KDF_V3, ...kdfConfig };
			db.setKdf(kdbxweb.Consts.KdfId.Aes);
			db.header.kdfParameters?.set('R', kdbxweb.VarDictionary.ValueType.UInt64, Int64.from(cfg.iterations));
		} else {
			db.setVersion(4);
			const cfg = { ...DEFAULT_KDF_V4, ...kdfConfig };
			db.setKdf(kdbxweb.Consts.KdfId.Argon2id);
			const kdfParams = db.header.kdfParameters;
			if (kdfParams) {
				kdfParams.set('I', kdbxweb.VarDictionary.ValueType.UInt64, Int64.from(cfg.iterations));
				kdfParams.set('M', kdbxweb.VarDictionary.ValueType.UInt64, Int64.from(cfg.memory * 1024));
				kdfParams.set('P', kdbxweb.VarDictionary.ValueType.UInt32, cfg.parallelism);
			}
		}
		
		this.db = db;
		this.currentPath = path;

		await this.saveDatabase(path);
	}

	async openDatabase(path: string, password: string): Promise<void> {
		const credentials = new kdbxweb.KdbxCredentials(
			kdbxweb.ProtectedValue.fromString(password)
		);
		const file = getVaultFile(this.app, path);
		if (!file) throw new Error(`KDBX file not found: ${path}`);
		const buffer = await this.app.vault.readBinary(file);
		this.db = await kdbxweb.Kdbx.load(buffer, credentials);
		this.currentPath = path;
	}

	async saveDatabase(path?: string): Promise<void> {
		if (!this.db) throw new Error('No database is open');
		const savePath = path ?? this.currentPath;
		if (!savePath) throw new Error('No path specified and no current path');
		const buffer = await this.db.save();
		const existing = getVaultFile(this.app, savePath);
		if (existing) {
			await this.app.vault.modifyBinary(existing, buffer);
		} else {
			await this.app.vault.createBinary(savePath, buffer);
		}
		this.currentPath = savePath;
	}

	closeDatabase(): void {
		this.db = null;
		this.currentPath = null;
	}

	/**
	 * Updates the cached current-path if it lives under oldPrefix, remapping it
	 * to the equivalent path under newPrefix.  Call this after physically moving
	 * the vault directory so that any subsequent saveDatabase() targets the
	 * correct location.
	 */
	remapPathPrefix(oldPrefix: string, newPrefix: string): void {
		if (this.currentPath?.startsWith(`${oldPrefix}/`)) {
			this.currentPath = `${newPrefix}/${this.currentPath.substring(oldPrefix.length + 1)}`;
		}
	}

	/** Changes the master password (credentials) of the currently open database. */
	changePassword(newPassword: string): void {
		if (!this.db) throw new Error('No database is open');
		this.db.credentials = new kdbxweb.KdbxCredentials(
			kdbxweb.ProtectedValue.fromString(newPassword)
		);
	}

	getEntry(entryPath: string): EntryRecord | null {
		if (!this.db) throw new Error('No database is open');
		const entry = this.resolveEntry(entryPath);
		if (!entry) return null;
		return this.toEntryRecord(entryPath, entry);
	}

	async setEntry(entryPath: string, fields: EntryFields): Promise<void> {
		if (!this.db) throw new Error('No database is open');
		const segments = entryPath.split('/');
		const title = segments[segments.length - 1] ?? entryPath;
		const groupSegments = segments.slice(0, -1);

		const group = this.resolveOrCreateGroup(groupSegments);
		let entry = group.entries.find(
			e => this.fieldText(e.fields.get('Title')) === title
		) ?? null;

		if (!entry) {
			entry = this.db.createEntry(group);
		}

		for (const [key, value] of Object.entries(fields)) {
			if (key.toLowerCase() === 'title') continue; // Title is determined by the path segment, ignore field value
			if (value === undefined) continue;
			const fieldValue: kdbxweb.KdbxEntryField = PROTECTED_FIELDS.has(key)
				? kdbxweb.ProtectedValue.fromString(value)
				: value;
			entry.fields.set(key, fieldValue);
		}
		// Ensure Title reflects the path segment
		if (!fields.Title) {
			entry.fields.set('Title', title);
		}
		entry.times.update();
	}

	deleteEntry(entryPath: string): boolean {
		if (!this.db) throw new Error('No database is open');
		const entry = this.resolveEntry(entryPath);
		if (!entry) return false;
		this.db.remove(entry);
		return true;
	}

	listEntries(groupPath?: string): EntryRecord[] {
		if (!this.db) throw new Error('No database is open');
		if (!groupPath) {
			return this.collectEntries(this.db.getDefaultGroup(), '');
		}
		const segments = groupPath.split('/').filter(Boolean);
		const group = this.findGroup(this.db.getDefaultGroup(), segments);
		if (!group) return [];
		return group.entries.map(e =>
			this.toEntryRecord(
				`${groupPath}/${this.fieldText(e.fields.get('Title')) ?? ''}`,
				e
			)
		);
	}

	// ── Private helpers ──────────────────────────────────────────────────────

	private resolveEntry(entryPath: string): kdbxweb.KdbxEntry | null {
		const segments = entryPath.split('/');
		const title = segments[segments.length - 1];
		const groupSegments = segments.slice(0, -1);
		const group = groupSegments.length
			? this.findGroup(this.db!.getDefaultGroup(), groupSegments)
			: this.db!.getDefaultGroup();
		if (!group) return null;
		return (
			group.entries.find(e => this.fieldText(e.fields.get('Title')) === title) ?? null
		);
	}

	private findGroup(
		root: kdbxweb.KdbxGroup,
		segments: string[]
	): kdbxweb.KdbxGroup | null {
		if (segments.length === 0) return root;
		const head = segments[0]!;
		const rest = segments.slice(1);
		const child = root.groups.find(
			g => (g.name ?? '').toLowerCase() === head.toLowerCase()
		);
		if (!child) return null;
		return this.findGroup(child, rest);
	}

	private resolveOrCreateGroup(segments: string[]): kdbxweb.KdbxGroup {
		let current = this.db!.getDefaultGroup();
		for (const seg of segments) {
			const existing = current.groups.find(
				g => (g.name ?? '').toLowerCase() === seg.toLowerCase()
			);
			if (existing) {
				current = existing;
			} else {
				current = this.db!.createGroup(current, seg.toLowerCase());
			}
		}
		return current;
	}

	private collectEntries(
		group: kdbxweb.KdbxGroup,
		prefix: string
	): EntryRecord[] {
		const result: EntryRecord[] = [];
		for (const entry of group.entries) {
			const title = this.fieldText(entry.fields.get('Title')) ?? '';
			const path = prefix ? `${prefix}/${title}` : title;
			result.push(this.toEntryRecord(path, entry));
		}
		for (const child of group.groups) {
			const childPrefix = prefix
				? `${prefix}/${child.name ?? ''}`
				: (child.name ?? '');
			result.push(...this.collectEntries(child, childPrefix));
		}
		return result;
	}

	private toEntryRecord(path: string, entry: kdbxweb.KdbxEntry): EntryRecord {
		const fields: EntryFields = {};
		for (const [key, value] of entry.fields) {
			fields[key] =
				value instanceof kdbxweb.ProtectedValue ? value.getText() : value;
		}
		return { path, fields };
	}

	private fieldText(
		value: string | kdbxweb.ProtectedValue | undefined
	): string | undefined {
		if (value === undefined) return undefined;
		if (value instanceof kdbxweb.ProtectedValue) return value.getText();
		return value;
	}
}
