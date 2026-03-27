import {App, PluginSettingTab, Setting} from "obsidian";
import VaultCryptPlugin from "./main";
import {KdbxVersion} from "./kdbx-service";
import {AddProfileModal, EditProfileModal, RenameProfileModal, DeleteProfileModal} from "./modals";

export interface ProfileConfig {
	path: string;
	kdbxVersion: KdbxVersion;
	autoLockMinutes: number;
	defaultField: string;
}

export interface VaultCryptSettings {
	profiles: Record<string, ProfileConfig>;
	masterKeyringPath: string;
	security: {
		autoLockTimeout: number;
		clipboardClearSeconds: number;
	};
	general: {
		vaultCryptDir: string;
		defaultProfile: string;
		compactChips: boolean;
		autoUnmask: boolean;
	};
}

export const DEFAULT_SETTINGS: VaultCryptSettings = {
	profiles: {},
	masterKeyringPath: ".vaultcrypt/_keyring.kdbx",
	security: {
		autoLockTimeout: 300,
		clipboardClearSeconds: 30
	},
	general: {
		vaultCryptDir: ".vaultcrypt",
		defaultProfile: "",
		compactChips: false,
		autoUnmask: false,
	}
}

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
				new Setting(containerEl)
					.setName(name)
					.setDesc(`${config.path}  •  KDBX v${config.kdbxVersion}`)
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
			}
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
					this.plugin.patchSettings(s => { s.security.autoLockTimeout = value; });
				}));

		new Setting(containerEl)
			.setName('Clipboard clear timer')
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setDesc('How long after copying before the clipboard is cleared. Set to Disabled to turn off.')
			.addDropdown(drop => drop
				.addOption('0',   'Disabled')
				.addOption('15',  '15 seconds')
				.addOption('30',  '30 seconds')
				.addOption('60',  '60 seconds')
				.addOption('120', '120 seconds')
				.setValue(String(this.plugin.settings.security.clipboardClearSeconds))
				.onChange((value) => {
					this.plugin.patchSettings(s => { s.security.clipboardClearSeconds = Number(value); });
				}));

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
					this.plugin.patchSettings(s => { s.general.vaultCryptDir = value; });
				}));

		new Setting(containerEl)
			.setName('Compact chips')
			.setDesc('Show only the icon and dots in inline chips, omitting the path text')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.general.compactChips)
				.onChange((value) => {
					this.plugin.patchSettings(s => { s.general.compactChips = value; });
				}));

		new Setting(containerEl)
			.setName('Auto unmask chips')
			.setDesc('Automatically unmask secrets in chips on unlock (not recommended for high-security environments)')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.general.autoUnmask)
				.onChange((value) => {
					this.plugin.patchSettings(s => { s.general.autoUnmask = value; });
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
						this.plugin.patchSettings(s => { s.general.defaultProfile = value; });
					});
			});
	}
}

