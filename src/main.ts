import {App, Editor, MarkdownView, Modal, Notice, Plugin} from 'obsidian';
import {DEFAULT_SETTINGS, VaultCryptSettings, VaultCryptSettingTab} from "./settings";
import {KdbxService} from "./kdbx-service";

export interface VaultCryptProfile {
	id: string;
	name: string;
	path: string;
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
			console.log('VaultCrypt interval check');
		}, 5 * 60 * 1000));

	}

	onunload() {
		// Cleanup operations here
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() as Partial<VaultCryptSettings>);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async ensureVaultCryptDir() {
		const dirPath = this.settings.general.vaultCryptDir;
		try {
			await this.app.vault.adapter.mkdir(dirPath);
			// Create config file if it doesn't exist
			const configPath = `${dirPath}/vaultcrypt.config.json`;
			if (!(await this.app.vault.adapter.exists(configPath))) {
				await this.app.vault.adapter.write(configPath, JSON.stringify({
					profiles: [],
					security: this.settings.security,
					general: {
						vaultCryptDir: this.settings.general.vaultCryptDir,
						defaultProfile: this.settings.general.defaultProfile
					}
				}, null, 2));
			}
		} catch (e) {
			console.error('Error creating VaultCrypt directory:', e);
			new Notice(`Error creating VaultCrypt directory: ${e}`);
		}
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

class VaultCryptModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen() {
		let {contentEl} = this;
		contentEl.setText('Vaultcrypt modal');
	}

	onClose() {
		const {contentEl} = this;
		contentEl.empty();
	}
}
