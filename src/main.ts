import { Notice, Plugin } from 'obsidian';
import { DEFAULT_SETTINGS, ProfileConfig, VaultCryptSettings, VaultCryptSettingTab } from './settings';
import { KdbxService, KdbxVersion } from './kdbx-service';
import { ProfileService } from './profile-service';
import { VaultCryptProfile, VaultCryptState } from './types';

export type { VaultCryptProfile, VaultCryptState };

export default class VaultCryptPlugin extends Plugin {
	settings: VaultCryptSettings;
	statusBarItem: HTMLElement;
	vaultCryptState: VaultCryptState;
	kdbxService: KdbxService;
	profileService: ProfileService;

	async onload() {
		await this.loadSettings();
		this.vaultCryptState = {
			profiles: [],
			currentProfile: null,
			isLocked: true,
		};
		this.kdbxService = new KdbxService(this.app.vault.adapter);
		this.profileService = new ProfileService(
			this.settings,
			this.app.vault.adapter,
			this.kdbxService,
			this.vaultCryptState,
			() => this.saveSettings(),
		);

		// Ensure the .vaultcrypt directory exists
		await this.profileService.ensureVaultCryptDir();

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
				new Notice('Profile paths from the old format were removed. Please re-add your profiles.');
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

	// ── Profile delegation ────────────────────────────────────────────────────

	async addProfile(name: string, password: string, version: KdbxVersion): Promise<void> {
		await this.profileService.addProfile(name, password, version);
	}

	async editProfile(name: string, updates: Partial<Pick<ProfileConfig, 'autoLockMinutes' | 'defaultField'>>): Promise<void> {
		await this.profileService.editProfile(name, updates);
	}

	async renameProfile(oldName: string, newName: string): Promise<void> {
		await this.profileService.renameProfile(oldName, newName);
		this.updateStatusBar();
	}

	async deleteProfile(name: string, deleteFile: boolean): Promise<void> {
		await this.profileService.deleteProfile(name, deleteFile);
		this.updateStatusBar();
	}

	// ── UI helpers ────────────────────────────────────────────────────────────

	updateStatusBar() {
		let statusText = '🔒 VaultCrypt';
		if (this.vaultCryptState.currentProfile) {
			statusText = this.vaultCryptState.isLocked ? '🔒 ' : '🔓 ';
			statusText += this.vaultCryptState.currentProfile.name;
		}
		this.statusBarItem.setText(statusText);
	}
}
