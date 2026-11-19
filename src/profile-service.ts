import {App, Notice, TFolder} from 'obsidian';
import {getVaultFile} from './utils';
import {moveVaultFile, removeEmptyVaultFolder} from './vault-file-operations';
import {ProfileConfig, VaultCryptSettings} from './settings';
import {KdbxService, KdbxVersion} from './kdbx-service';
import {VaultCryptState} from './types';
import {peek, ReadSignal} from "@maverick-js/signals";
import {DeepReadonly} from "./utils";
import {validateProfileName} from './profile-name';
import {isImportableVaultPath, readVaultVersion, type VaultImportSelection} from './vault-import';

/**
 * Encapsulates all profile and config-file orchestration.
 * main.ts delegates CRUD operations here, keeping the plugin class
 * focused on the Obsidian lifecycle (onload / onunload / commands).
 */
export class ProfileService {
	private movingVaultDir = false;
	private pendingProfileNames = new Set<string>();

	constructor(
		private settings: ReadSignal<DeepReadonly<VaultCryptSettings>>,
		private app: App,
		private kdbxService: KdbxService,
		private state: ReadSignal<DeepReadonly<VaultCryptState>>,
		private patchSettings: (patcher: (settings: VaultCryptSettings) => void) => void,
		private mutateState: (mutator: (state: VaultCryptState) => void) => void,
	) {
	}

	/** Creates the VaultCrypt directory if it doesn't exist. */
	async ensureVaultCryptDir(): Promise<void> {
		const dirPath = peek(this.settings).general.vaultCryptDir;
		try {
			await this.ensureFolderPath(dirPath);
		} catch (e) {
			console.error('Error creating VaultCrypt directory:', e);
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`Error creating VaultCrypt directory: ${msg}`);
			throw e;
		}
	}

	/**
	 * Ensures every segment of a vault-relative path exists as a folder,
	 * creating any missing intermediate directories. Equivalent to mkdir -p.
	 */
	private async ensureFolderPath(path: string): Promise<void> {
		const segments = path.split('/').filter(Boolean);
		for (let i = 1; i <= segments.length; i++) {
			const partial = segments.slice(0, i).join('/');
			const indexed = this.app.vault.getAbstractFileByPath(partial);
			if (indexed) {
				if (!(indexed instanceof TFolder)) {
					throw new Error(`Cannot create folder "${partial}": a file already exists at this path.`);
				}
				continue;
			}

			// The vault index may still be loading, and hidden folders may never be indexed.
			const stat = await this.app.vault.adapter.stat(partial);
			if (stat) {
				if (stat.type !== 'folder') {
					throw new Error(`Cannot create folder "${partial}": a file already exists at this path.`);
				}
				continue;
			}

			try {
				await this.app.vault.createFolder(partial);
			} catch (error) {
				// Another operation may have created it since the check. Preserve genuine errors.
				try {
					if ((await this.app.vault.adapter.stat(partial))?.type === 'folder') continue;
				} catch {
					// Report the original creation error if the recheck also fails.
				}
				throw error;
			}
		}
	}

	/**
	 * Moves the vault directory to a new location, migrating all files and
	 * updating profile paths and the vaultCryptDir setting.
	 *
	 * Sub-directories are preserved, a full rollback is attempted on any
	 * rename failure, and both persisted settings and in-memory runtime
	 * state are updated atomically after a successful migration.
	 */
	async moveVaultDir(newDir: string): Promise<void> {
		if (this.movingVaultDir) throw new Error('The storage directory is already being moved.');
		this.movingVaultDir = true;
		try {
			await this.migrateVaultDir(newDir);
		} finally {
			this.movingVaultDir = false;
		}
	}

	private async migrateVaultDir(newDir: string): Promise<void> {
		const settings = peek(this.settings);
		const oldDir = settings.general.vaultCryptDir;
		if (oldDir === newDir) return;
		if (newDir.startsWith(`${oldDir}/`)) {
			throw new Error(`Target path "${newDir}" cannot be inside the current vault directory "${oldDir}".`);
		}

		// Gather a recursive listing of everything under oldDir
		const allFiles: string[] = [];
		const allFolders: string[] = [];
		try {
			await this.collectListing(oldDir, allFiles, allFolders);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`VaultCrypt: failed to read directory — ${msg}`);
			throw e;
		}

		// Create destination root and any sub-directories (in discovery order
		// so parents are created before their children)
		try {
			await this.ensureFolderPath(newDir);
			for (const folderPath of allFolders) {
				const rel = folderPath.substring(oldDir.length + 1);
				await this.ensureFolderPath(`${newDir}/${rel}`);
			}
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`VaultCrypt: failed to create target directories — ${msg}`);
			throw e;
		}

		// Move files; on any failure roll back already-moved files
		const moved: Array<{ from: string; to: string }> = [];
		try {
			for (const filePath of allFiles) {
				const rel = filePath.substring(oldDir.length + 1);
				const target = `${newDir}/${rel}`;
				await moveVaultFile(this.app, filePath, target);
				moved.push({ from: filePath, to: target });
			}
		} catch (e) {
			const failedRollbacks: string[] = [];
			for (const { from, to } of [...moved].reverse()) {
				try {
					await moveVaultFile(this.app, to, from);
				} catch {
					failedRollbacks.push(to);
					console.warn(`VaultCrypt: rollback failed for ${to} → ${from}`);
				}
			}
			const msg = e instanceof Error ? e.message : String(e);
			const rollbackMsg = failedRollbacks.length
				? ` Could not restore these files: ${failedRollbacks.join(', ')}.` : '';
			new Notice(`VaultCrypt: failed to move directory — ${msg}${rollbackMsg}`);
			throw e;
		}

		// Remove empty old sub-directories deepest-first, then the root. Hidden
		// folders need adapter access, just like the files that were moved.
		const failedCleanup: string[] = [];
		for (const folderPath of [...allFolders].reverse().concat(oldDir)) {
			try {
				await removeEmptyVaultFolder(this.app, folderPath);
			} catch (error) {
				failedCleanup.push(folderPath);
				console.warn(`VaultCrypt: could not remove empty folder ${folderPath}:`, error);
			}
		}

		// Helper to remap a path prefix
		const remap = (p: string) =>
			p.startsWith(`${oldDir}/`) ? `${newDir}/${p.substring(oldDir.length + 1)}` : p;

		// Keep the KdbxService's cached current-path in sync so any pending
		// saveDatabase() call targets the new location, not the old one.
		this.kdbxService.remapPathPrefix(oldDir, newDir);

		// Update persisted settings
		this.patchSettings(s => {
			s.general.vaultCryptDir = newDir;
			for (const profile of Object.values(s.profiles)) {
				profile.path = remap(profile.path);
			}
			s.masterKeyringPath = remap(s.masterKeyringPath);
		});

		// Keep in-memory runtime state in sync with the new paths
		this.mutateState(state => {
			for (const profile of state.profiles) {
				profile.path = remap(profile.path);
			}
			if (state.currentProfile) {
				state.currentProfile.path = remap(state.currentProfile.path);
			}
		});
		if (failedCleanup.length) {
			new Notice(`VaultCrypt: files moved, but could not remove empty folders: ${failedCleanup.join(', ')}.`);
		}
	}

	/** Recursively collects all files and folders under a directory. */
	private async collectListing(dir: string, files: string[], folders: string[]): Promise<void> {
		const listing = await this.app.vault.adapter.list(dir);
		files.push(...listing.files);
		for (const folder of listing.folders) {
			folders.push(folder);
			await this.collectListing(folder, files, folders);
		}
	}

	/** Creates a new KDBX database on disk and registers the profile in settings. */
	async addProfile(name: string, password: string, version: KdbxVersion): Promise<void> {
		const key = name.toLowerCase();
		const settings = peek(this.settings);
		const nameError = validateProfileName(key, [...Object.keys(settings.profiles), ...this.pendingProfileNames]);
		if (nameError) throw new Error(nameError);
		const path = `${settings.general.vaultCryptDir}/${key}.kdbx`;
		this.pendingProfileNames.add(key);
		try {
			await this.kdbxService.createDatabase(path, password, version);
			this.kdbxService.closeDatabase();
			this.patchSettings(settings => {
				settings.profiles[key] = profileConfig(path, version);
			});
		} finally {
			this.pendingProfileNames.delete(key);
		}
	}

	/** Register existing databases together after verifying the selected files. */
	async importVaults(directory: string, selections: VaultImportSelection[], signal: AbortSignal): Promise<void> {
		this.validateVaultImport(directory, selections);
		const imported: Record<string, ProfileConfig> = {};
		for (const {path, name} of selections) {
			signal.throwIfAborted();
			const version = await readVaultVersion(this.app, path);
			if (version === null) throw new Error(`Unsupported or invalid KDBX database: ${path}`);
			imported[name.toLowerCase()] = profileConfig(path, version);
		}
		signal.throwIfAborted();
		// Files and settings can change while the picker is open or while reading a header.
		this.validateVaultImport(directory, selections);
		this.patchSettings(settings => {
			Object.assign(settings.profiles, imported);
		});
	}

	private validateVaultImport(directory: string, selections: VaultImportSelection[]): void {
		const settings = peek(this.settings);
		if (this.movingVaultDir || directory !== settings.general.vaultCryptDir) {
			throw new Error('The storage directory is changing or has changed. Scan again to import vaults.');
		}
		const names = [...Object.keys(settings.profiles), ...this.pendingProfileNames];
		const paths = new Set(Object.values(settings.profiles).map(profile => profile.path));
		for (const {name, path} of selections) {
			const nameError = validateProfileName(name, names);
			if (nameError) throw new Error(`${path}: ${nameError}`);
			if (!isImportableVaultPath(path, directory, settings.masterKeyringPath)) {
				throw new Error(`This file cannot be imported: ${path}`);
			}
			if (paths.has(path)) throw new Error(`This file is already selected or registered: ${path}`);
			names.push(name);
			paths.add(path);
		}
	}

	/** Updates mutable profile settings (auto-lock timeout, default field). */
	editProfile(
		name: string,
		updates: Partial<Pick<ProfileConfig, 'autoLockMinutes' | 'defaultField'>>,
	): void {
		const key = name.toLowerCase();
		const settings = peek(this.settings);
		if (!settings.profiles[key]) throw new Error(`Profile '${name}' not found.`);
		this.patchSettings((newSettings: VaultCryptSettings) => {
			const profile = newSettings.profiles[key];
			if (!profile) return;
			profile.autoLockMinutes = updates.autoLockMinutes ?? profile.autoLockMinutes;
			profile.defaultField = updates.defaultField ?? profile.defaultField;
		});

		// Sync runtime state if the profile is currently loaded
		this.mutateState((state) => {
			const runtimeProfile = state.profiles.find(p => p.id === key);
			if (runtimeProfile && updates.autoLockMinutes !== undefined) {
				runtimeProfile.autoLockMinutes = updates.autoLockMinutes;
			}
		});
	}

	/** Renames a profile key in settings and updates any runtime references. */
	renameProfile(oldName: string, newName: string): void {
		const oldKey = oldName.toLowerCase();
		const newKey = newName.toLowerCase();
		const settings = peek(this.settings);
		if (!settings.profiles[oldKey]) throw new Error(`Profile '${oldName}' not found.`);
		if (oldKey === newKey) return;
		const nameError = validateProfileName(newKey, [...Object.keys(settings.profiles), ...this.pendingProfileNames]);
		if (nameError) throw new Error(nameError);

		this.patchSettings((newSettings: VaultCryptSettings) => {
			const oldProfile = newSettings.profiles[oldKey];
			if (!oldProfile) return;
			newSettings.profiles[newKey] = {...oldProfile};

			delete newSettings.profiles[oldKey];
			if (newSettings.general.defaultProfile.toLowerCase() === oldKey) {
				newSettings.general.defaultProfile = newKey;
			}
		});

		this.mutateState((state) => {
			// Update runtime state
			const runtimeProfile = state.profiles.find(p => p.id === oldKey);
			if (runtimeProfile) {
				runtimeProfile.id = newKey;
				runtimeProfile.name = newKey;
			}
			if (state.currentProfile?.id === oldKey) {
				state.currentProfile.id = newKey;
				state.currentProfile.name = newKey;
			}
		});
	}

	/**
	 * Removes a profile from settings and optionally deletes the .kdbx file.
	 * The caller is responsible for refreshing any UI that depends on the profile list
	 * (e.g. the status bar).
	 */
	async deleteProfile(name: string, deleteFile: boolean): Promise<void> {
		const key = name.toLowerCase();
		const settings = peek(this.settings);

		const config = settings.profiles[key];
		if (!config) throw new Error(`Profile '${name}' not found.`);

		this.patchSettings((newSettings: VaultCryptSettings) => {
			delete newSettings.profiles[key];
			if (newSettings.general.defaultProfile.toLowerCase() === key) {
				newSettings.general.defaultProfile = '';
			}
		});

		if (deleteFile) {
			try {
				const file = getVaultFile(this.app, config.path);
				if (file) await this.app.fileManager.trashFile(file);
			} catch (e) {
				// File may not exist — log but don't abort
				console.warn(`VaultCrypt: could not delete file ${config.path}:`, e);
			}
		}
		this.mutateState(state => {
			// Update runtime state
			state.profiles = state.profiles.filter(p => p.id !== key);
			if (state.currentProfile?.id === key) {
				state.currentProfile = null;
			}
		});
	}
}

function profileConfig(path: string, kdbxVersion: KdbxVersion): ProfileConfig {
	return {path, kdbxVersion, autoLockMinutes: 0, defaultField: 'password', managedByKeyring: false};
}
