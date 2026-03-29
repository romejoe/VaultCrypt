import {App, PluginSettingTab, Setting} from "obsidian";
import VaultCryptPlugin from "./main";
import {KdbxVersion} from "./kdbx-service";
import {
	AddProfileModal, EditProfileModal, RenameProfileModal, DeleteProfileModal,
	SetupKeyringModal, AddToKeyringModal, RemoveFromKeyringModal,
	ChangeKeyringPasswordModal, DeleteKeyringModal,
} from "./modals";

export interface ProfileConfig {
	path: string;
	kdbxVersion: KdbxVersion;
	autoLockMinutes: number;
	defaultField: string;
	managedByKeyring: boolean;
}

export interface VaultCryptSettings {
	profiles: Record<string, ProfileConfig>;
	masterKeyringPath: string;
	keyringEnabled: boolean;
	security: {
		autoLockTimeout: number;
		clipboardClearSeconds: number;
	};
	general: {
		vaultCryptDir: string;
		defaultProfile: string;
		compactChips: boolean;
		autoUnmask: boolean;
		saveOnBlur: boolean;
	};
}

export const DEFAULT_SETTINGS: VaultCryptSettings = {
	profiles: {},
	masterKeyringPath: ".vaultcrypt/_keyring.kdbx",
	keyringEnabled: false,
	security: {
		autoLockTimeout: 300,
		clipboardClearSeconds: 30
	},
	general: {
		vaultCryptDir: ".vaultcrypt",
		defaultProfile: "",
		compactChips: false,
		autoUnmask: false,
		saveOnBlur: true,
	}
};

export function validateProfileName(name: string, existingNames: string[]): string | null {
	if (!name) return "Profile name is required.";
	if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(name)) return "Name must start with alphanumeric and contain only letters, numbers, and hyphens.";
	if (name.length > 64) return "Name must be 64 characters or fewer.";
	if (existingNames.some(n => n.toLowerCase() === name.toLowerCase())) return "A profile with this name already exists.";
	return null;
}

export class VaultCryptSettingTab extends PluginSettingTab {
	plugin: VaultCryptPlugin;

	constructor(app: App, plugin: VaultCryptPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		// Profiles section
		new Setting(containerEl)
			.setName("Profiles")
			.setHeading()
			.addButton(btn => btn
				.setButtonText("Add profile")
				.setCta()
				.onClick(() => new AddProfileModal(this.app, this.plugin, () => this.display()).open()));

		const profiles = this.plugin.settings.profiles;
		const profileNames = Object.keys(profiles);

		if (profileNames.length === 0) {
			new Setting(containerEl)
				.setName("No profiles configured")
				.setDesc("Click 'add profile' to get started.");
		} else {
			for (const name of profileNames) {
				const config = profiles[name]!;
				const desc = config.managedByKeyring
					? `${config.path}  •  KDBX v${config.kdbxVersion}  •  keyring`
					: `${config.path}  •  KDBX v${config.kdbxVersion}`;
				const setting = new Setting(containerEl)
					.setName(name)
					.setDesc(desc)
					.addButton(btn => btn
						.setButtonText("Edit")
						.onClick(() => new EditProfileModal(this.app, name, config, this.plugin, () => this.display()).open()))
					.addButton(btn => btn
						.setButtonText("Rename")
						.onClick(() => new RenameProfileModal(this.app, name, this.plugin, () => this.display()).open()))
					.addButton(btn => btn
						.setButtonText("Delete")
						.setWarning()
						.onClick(() => new DeleteProfileModal(this.app, name, config, this.plugin, () => this.display()).open()));

				if (config.managedByKeyring) {
					setting.addButton(btn => btn
						.setButtonText("Remove from keyring")
						.onClick(() => new RemoveFromKeyringModal(this.app, this.plugin, name, () => this.display()).open()));
				}
			}
		}

		// Keyring section
		new Setting(containerEl).setName("Keyring").setHeading();

		if (!this.plugin.settings.keyringEnabled) {
			new Setting(containerEl)
				.setName("Set up a keyring")
				.setDesc("A keyring encrypts all your profile passwords under a single master password, so one unlock opens everything.")
				.addButton(btn => btn
					.setButtonText("Set up keyring")
					.setCta()
					.onClick(() => new SetupKeyringModal(this.app, this.plugin, () => this.display()).open()));
		} else {
			new Setting(containerEl)
				.setName("Keyring active")
				.setDesc(`Keyring file: ${this.plugin.settings.masterKeyringPath}`);

			new Setting(containerEl)
				.addButton(btn => btn
					.setButtonText("Add profile to keyring")
					.onClick(() => new AddToKeyringModal(this.app, this.plugin, () => this.display()).open()))
				.addButton(btn => btn
					.setButtonText("Change master password")
					.onClick(() => new ChangeKeyringPasswordModal(this.app, this.plugin, () => this.display()).open()))
				.addButton(btn => btn
					.setButtonText("Delete keyring")
					.setWarning()
					.onClick(() => new DeleteKeyringModal(this.app, this.plugin, () => this.display()).open()));
		}

		// Security section
		new Setting(containerEl).setName("Security").setHeading();

		new Setting(containerEl)
			.setName('Auto-lock timeout (seconds)')
			.setDesc('Time in seconds before automatically locking the vault')
			.addSlider(slider => slider
				.setLimits(30, 1800, 30)
				.setValue(this.plugin.settings.security.autoLockTimeout)
				.setDynamicTooltip()
				.onChange((value) => {
					this.plugin.patchSettings(s => {
						s.security.autoLockTimeout = value;
					});
				}));

		new Setting(containerEl)
			.setName('Clipboard clear timer')
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setDesc('How long after copying before the clipboard is cleared. Set to Disabled to turn off.')
			.addDropdown(drop => {
				const allowed = new Set([0, 15, 30, 60, 120]);
				const current = this.plugin.settings.security.clipboardClearSeconds;
				const normalized = allowed.has(current) ? current : DEFAULT_SETTINGS.security.clipboardClearSeconds;

				drop
					.addOption('0', 'Disabled')
					.addOption('15', '15 seconds')
					.addOption('30', '30 seconds')
					.addOption('60', '60 seconds')
					.addOption('120', '120 seconds')
					.setValue(String(normalized))
					.onChange((value) => {
						const parsed = Number(value);
						this.plugin.patchSettings(s => {
							s.security.clipboardClearSeconds = allowed.has(parsed) ? parsed : DEFAULT_SETTINGS.security.clipboardClearSeconds;
						});
					});
			});

		// General section
		// eslint-disable-next-line obsidianmd/settings-tab/no-problematic-settings-headings
		new Setting(containerEl).setName("General").setHeading();

		new Setting(containerEl)
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setName('VaultCrypt directory path')
			.setDesc('Path to the .vaultcrypt directory where configuration and databases are stored')
			.addText(text => text
				.setPlaceholder('.vaultcrypt')
				.setValue(this.plugin.settings.general.vaultCryptDir)
				.onChange((value) => {
					this.plugin.patchSettings(s => {
						s.general.vaultCryptDir = value;
					});
				}));

		new Setting(containerEl)
			.setName('Compact chips')
			.setDesc('Show only the icon and dots in inline chips, omitting the path text')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.general.compactChips)
				.onChange((value) => {
					this.plugin.patchSettings(s => {
						s.general.compactChips = value;
					});
				}));

		new Setting(containerEl)
			.setName('Auto unmask chips')
			.setDesc('Automatically unmask secrets in chips on unlock (not recommended for high-security environments)')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.general.autoUnmask)
				.onChange((value) => {
					this.plugin.patchSettings(s => {
						s.general.autoUnmask = value;
					});
				}));

		new Setting(containerEl)
			.setName('Save on blur')
			.setDesc('When editing a secret inline, save changes when the input loses focus. When off, blur discards changes.')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.general.saveOnBlur)
				.onChange((value) => {
					this.plugin.patchSettings(s => {
						s.general.saveOnBlur = value;
					});
				}));

		new Setting(containerEl)
			.setName('Default profile')
			.setDesc('The default profile to use for unlocking')
			.addDropdown(dropdown => {
				dropdown.addOption("", "— none —");
				for (const name of profileNames) {
					dropdown.addOption(name, name);
				}
				dropdown
					.setValue(this.plugin.settings.general.defaultProfile)
					.onChange((value) => {
						this.plugin.patchSettings(s => {
							s.general.defaultProfile = value;
						});
					});
			});
	}
}

