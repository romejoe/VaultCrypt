import { Notice, Plugin } from 'obsidian';
import { DEFAULT_SETTINGS, ProfileConfig, VaultCryptSettings, VaultCryptSettingTab } from "./settings";
import { KdbxService, KdbxVersion } from "./kdbx-service";

export interface VaultCryptProfile {
	id: string;
	name: string;
	path: string;
	kdbxVersion: KdbxVersion;
	autoLockMinutes: number;
	isLocked: boolean;
	lastUnlock: Date | null;
}

export interface VaultCryptState {
	profiles: VaultCryptProfile[];
	currentProfile: VaultCryptProfile | null;
	isLocked: boolean;
}

export default class VaultCryptPlugin extends Plugin {
	settings: VaultCryptSettings;
	statusBarItem: HTMLElement;
	vaultCryptState: VaultCryptState;
	kdbxService: KdbxService;

	async onload() {
		await this.loadSettings();
		this.vaultCryptState = {
			profiles: [],
			currentProfile: null,
			isLocked: true
		};
		this.kdbxService = new KdbxService(this.app.vault.adapter);

		// Ensure the .vaultcrypt directory exists
		await this.ensureVaultCryptDir();

		// This creates an icon in the left ribbon.
		// eslint-disable-next-line obsidianmd/ui/sentence-case
		this.addRibbonIcon('lock', 'VaultCrypt', (evt: MouseEvent) => {
			// Called when the user clicks the icon.
			new Notice('Vaultcrypt ribbon icon clicked');
		});

		// This adds a status bar item to the bottom of the app. Does not work on mobile apps.
		this.statusBarItem = this.addStatusBarItem();
		this.updateStatusBar();

		// Register commands
		this.addCommand({
			id: 'vault-crypt-unlock-profile',
			name: 'Unlock profile',
			callback: () => {
				new Notice('Unlock profile command executed');
				// Stub implementation
			}
		});

		this.addCommand({
			id: 'vault-crypt-unlock-all',
			name: 'Unlock all profiles',
			callback: () => {
				new Notice('Unlock all command executed');
				// Stub implementation
			}
		});

		this.addCommand({
			id: 'vault-crypt-lock-profile',
			name: 'Lock profile',
			callback: () => {
				new Notice('Lock profile command executed');
				// Stub implementation
			}
		});

		this.addCommand({
			id: 'vault-crypt-lock-all',
			name: 'Lock all profiles',
			callback: () => {
				new Notice('Lock all command executed');
				// Stub implementation
			}
		});

		this.addCommand({
			id: 'vault-crypt-insert-secret',
			name: 'Insert secret',
			callback: () => {
				new Notice('Insert secret command executed');
				// Stub implementation
			}
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new VaultCryptSettingTab(this.app, this));

		// If the plugin hooks up any global DOM events (on parts of the app that doesn't belong to this plugin)
		// Using this function will automatically remove the event listener when this plugin is disabled.
		this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
			// new Notice("Click"); // Remove notice for cleaner interface
		});

		// When registering intervals, this function will automatically clear the interval when the plugin is disabled.
		this.registerInterval(window.setInterval(() => {
			// Auto-lock functionality would go here
			// eslint-disable-next-line no-console
			console.log('VaultCrypt interval check');
		}, 5 * 60 * 1000));

	}

	onunload() {
		// Cleanup operations here
	}

	async loadSettings() {
		const loaded = await this.loadData() as Partial<VaultCryptSettings> & { profiles?: unknown };
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);

		// Migrate old profiles format (string array) to new Record<string, ProfileConfig>
		if (Array.isArray(this.settings.profiles)) {
			const oldPaths = this.settings.profiles as unknown as string[];
			this.settings.profiles = {};
			if (oldPaths.length > 0) {
				new Notice("Profile paths from the old format were removed. Please re-add your profiles.");
			}
		}

		// Migrate old clipboardClearTimer to clipboardClearSeconds
		const security = this.settings.security as VaultCryptSettings['security'] & { clipboardClearTimer?: number };
		if (security.clipboardClearTimer !== undefined && security.clipboardClearSeconds === DEFAULT_SETTINGS.security.clipboardClearSeconds) {
			security.clipboardClearSeconds = security.clipboardClearTimer;
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async ensureVaultCryptDir() {
		const dirPath = this.settings.general.vaultCryptDir;
		try {
			await this.app.vault.adapter.mkdir(dirPath);
			await this.writeConfigFile();
		} catch (e) {
			console.error('Error creating VaultCrypt directory:', e);
			if (e instanceof Error || typeof e === 'string') {
				new Notice(`Error creating VaultCrypt directory: ${e}`);
			}
		}
	}

	async writeConfigFile() {
		const dirPath = this.settings.general.vaultCryptDir;
		const configPath = `${dirPath}/vaultcrypt.config.json`;
		const configData = {
			profiles: this.settings.profiles,
			masterKeyringPath: this.settings.masterKeyringPath,
			clipboardClearSeconds: this.settings.security.clipboardClearSeconds
		};
		await this.app.vault.adapter.write(configPath, JSON.stringify(configData, null, 2));
	}

	async addProfile(name: string, password: string, version: KdbxVersion): Promise<void> {
		const key = name.toLowerCase();
		const path = `${this.settings.general.vaultCryptDir}/${key}.kdbx`;
		await this.kdbxService.createDatabase(path, password, version);
		this.kdbxService.closeDatabase();
		this.settings.profiles[key] = {
			path,
			kdbxVersion: version,
			autoLockMinutes: 0,
			defaultField: "password"
		};
		await this.saveSettings();
		await this.writeConfigFile();
	}

	async editProfile(name: string, updates: Partial<Pick<ProfileConfig, 'autoLockMinutes' | 'defaultField'>>): Promise<void> {
		const key = name.toLowerCase();
		if (!this.settings.profiles[key]) throw new Error(`Profile '${name}' not found.`);
		Object.assign(this.settings.profiles[key], updates);
		// Update runtime state if present
		const runtimeProfile = this.vaultCryptState.profiles.find(p => p.id === key);
		if (runtimeProfile) {
			if (updates.autoLockMinutes !== undefined) runtimeProfile.autoLockMinutes = updates.autoLockMinutes;
		}
		await this.saveSettings();
		await this.writeConfigFile();
	}

	async renameProfile(oldName: string, newName: string): Promise<void> {
		const oldKey = oldName.toLowerCase();
		const newKey = newName.toLowerCase();
		if (!this.settings.profiles[oldKey]) throw new Error(`Profile '${oldName}' not found.`);
		// Copy config under new key, remove old key
		this.settings.profiles[newKey] = { ...this.settings.profiles[oldKey] };
		delete this.settings.profiles[oldKey];
		// Update defaultProfile if it pointed to the old name
		if (this.settings.general.defaultProfile.toLowerCase() === oldKey) {
			this.settings.general.defaultProfile = newKey;
		}
		// Update runtime state
		const runtimeProfile = this.vaultCryptState.profiles.find(p => p.id === oldKey);
		if (runtimeProfile) {
			runtimeProfile.id = newKey;
			runtimeProfile.name = newKey;
		}
		if (this.vaultCryptState.currentProfile?.id === oldKey) {
			this.vaultCryptState.currentProfile.id = newKey;
			this.vaultCryptState.currentProfile.name = newKey;
		}
		await this.saveSettings();
		await this.writeConfigFile();
	}

	async deleteProfile(name: string, deleteFile: boolean): Promise<void> {
		const key = name.toLowerCase();
		const config = this.settings.profiles[key];
		if (!config) throw new Error(`Profile '${name}' not found.`);
		if (deleteFile) {
			try {
				await this.app.vault.adapter.remove(config.path);
			} catch (e) {
				// File may not exist — log but don't abort
				console.warn(`VaultCrypt: could not delete file ${config.path}:`, e);
			}
		}
		delete this.settings.profiles[key];
		if (this.settings.general.defaultProfile.toLowerCase() === key) {
			this.settings.general.defaultProfile = "";
		}
		// Update runtime state
		this.vaultCryptState.profiles = this.vaultCryptState.profiles.filter(p => p.id !== key);
		if (this.vaultCryptState.currentProfile?.id === key) {
			this.vaultCryptState.currentProfile = null;
		}
		await this.saveSettings();
		await this.writeConfigFile();
		this.updateStatusBar();
	}

	updateStatusBar() {
		let statusText = '🔒 VaultCrypt';
		if (this.vaultCryptState.currentProfile) {
			statusText = this.vaultCryptState.isLocked ? '🔒 ' : '🔓 ';
			statusText += this.vaultCryptState.currentProfile.name;
		}
		this.statusBarItem.setText(statusText);
	}
}
