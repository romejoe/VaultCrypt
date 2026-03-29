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

	/** Creates the .vaultcrypt directory if it doesn't exist and writes the initial config file. */
	async ensureVaultCryptDir(): Promise<void> {
		const dirPath = peek(this.settings).general.vaultCryptDir;
		try {
			await this.adapter.mkdir(dirPath);
			await this.writeConfigFile();
		} catch (e) {
			console.error('Error creating VaultCrypt directory:', e);
			if (e instanceof Error || typeof e === 'string') {
				new Notice(`Error creating VaultCrypt directory: ${e}`);
			}
		}
	}

	/** Serialises the current settings to vaultcrypt.config.json. */
	async writeConfigFile(): Promise<void> {
		const settings = peek(this.settings);
		const dirPath = settings.general.vaultCryptDir;
		const configPath = `${dirPath}/vaultcrypt.config.json`;
		const configData = {
			profiles: settings.profiles,
			masterKeyringPath: settings.masterKeyringPath,
			keyringEnabled: settings.keyringEnabled,
			clipboardClearSeconds: settings.security.clipboardClearSeconds,
		};
		await this.adapter.write(configPath, JSON.stringify(configData, null, 2));
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
				autoUnlock: false,
			};
		});
		await this.writeConfigFile();
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

		await this.writeConfigFile();
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

		await this.writeConfigFile();
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

		await this.writeConfigFile();
	}
}
