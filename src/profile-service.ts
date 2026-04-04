import {DataAdapter, Notice} from 'obsidian';
import {ProfileConfig, VaultCryptSettings} from './settings';
import {KdbxService, KdbxVersion} from './kdbx-service';
import {VaultCryptState} from './types';
import {peek, ReadSignal} from "@maverick-js/signals";
import {DeepReadonly} from "./utils";

/**
 * Encapsulates all profile and config-file orchestration.
 * main.ts delegates CRUD operations here, keeping the plugin class
 * focused on the Obsidian lifecycle (onload / onunload / commands).
 */
export class ProfileService {
	constructor(
		private settings: ReadSignal<DeepReadonly<VaultCryptSettings>>,
		private adapter: DataAdapter,
		private kdbxService: KdbxService,
		private state: ReadSignal<DeepReadonly<VaultCryptState>>,
		private patchSettings: (patcher: (settings: VaultCryptSettings) => void) => void,
		private mutateState: (mutator: (state: VaultCryptState) => void) => void,
	) {
	}

	/** Creates the .vaultcrypt directory if it doesn't exist. */
	async ensureVaultCryptDir(): Promise<void> {
		const dirPath = peek(this.settings).general.vaultCryptDir;
		try {
			await this.adapter.mkdir(dirPath);
		} catch (e) {
			console.error('Error creating VaultCrypt directory:', e);
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`Error creating VaultCrypt directory: ${msg}`);
			throw e;
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
		const settings = peek(this.settings);
		const oldDir = settings.general.vaultCryptDir;
		if (oldDir === newDir) return;

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
			await this.adapter.mkdir(newDir);
			for (const folderPath of allFolders) {
				const rel = folderPath.substring(oldDir.length + 1);
				await this.adapter.mkdir(`${newDir}/${rel}`);
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
				await this.adapter.rename(filePath, target);
				moved.push({ from: filePath, to: target });
			}
		} catch (e) {
			for (const { from, to } of [...moved].reverse()) {
				try {
					await this.adapter.rename(to, from);
				} catch {
					console.warn(`VaultCrypt: rollback failed for ${to} → ${from}`);
				}
			}
			const msg = e instanceof Error ? e.message : String(e);
			new Notice(`VaultCrypt: failed to move directory — ${msg}`);
			throw e;
		}

		// Remove old sub-directories deepest-first, then the root
		for (const folderPath of [...allFolders].reverse()) {
			try { await this.adapter.rmdir(folderPath, false); } catch { /* non-fatal */ }
		}
		try { await this.adapter.rmdir(oldDir, false); } catch { /* non-fatal */ }

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
	}

	/** Recursively collects all files and folders under a directory. */
	private async collectListing(dir: string, files: string[], folders: string[]): Promise<void> {
		const listing = await this.adapter.list(dir);
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
		const path = `${settings.general.vaultCryptDir}/${key}.kdbx`;
		await this.kdbxService.createDatabase(path, password, version);
		this.kdbxService.closeDatabase();
		this.patchSettings((newSettings: VaultCryptSettings) => {
			newSettings.profiles[key] = {
				path,
				kdbxVersion: version,
				autoLockMinutes: 0,
				defaultField: 'password',
				managedByKeyring: false,
			};
		});
	}

	/** Updates mutable profile settings (auto-lock timeout, default field). */
	async editProfile(
		name: string,
		updates: Partial<Pick<ProfileConfig, 'autoLockMinutes' | 'defaultField'>>,
	): Promise<void> {
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
	async renameProfile(oldName: string, newName: string): Promise<void> {
		const oldKey = oldName.toLowerCase();
		const newKey = newName.toLowerCase();
		const settings = peek(this.settings);
		if (!settings.profiles[oldKey]) throw new Error(`Profile '${oldName}' not found.`);

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
				await this.adapter.remove(config.path);
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
