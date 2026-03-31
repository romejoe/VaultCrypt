import {App, ButtonComponent, DropdownComponent, Modal, Notice, Setting, TFile, TextComponent} from 'obsidian';
import VaultCryptPlugin from '../main';
import {GeneratePasswordModal} from './generate-password-modal';
import type {ParsedVcToken} from '../inline-parser';
import {ATTACHMENT_PREFIX} from '../attachment-chip';

/** Characters allowed in a field name per inline-parser. */
const VALID_FIELD_NAME = /^[a-zA-Z0-9_-]+$/;

/** Standard KeePass field names that are rendered as dedicated rows. */
const STANDARD_FIELDS = new Set(['Title', 'UserName', 'Password', 'URL', 'Notes']);

export class EditSecretModal extends Modal {
	private plugin: VaultCryptPlugin;
	private profileId: string;
	private entryPath: string;
	private token: ParsedVcToken;

	// Field values
	private fieldUserName = '';
	private fieldPassword = '';
	private fieldURL = '';
	private fieldNotes = '';
	private customFields: { key: string; value: string }[] = [];

	// Reference field
	private referenceField = '';
	private originalReferenceField = '';
	private fieldRefDropdown?: DropdownComponent;
	private tokenPreviewEl!: HTMLElement;

	// The file that was active when the modal opened — used for token replacement
	private sourceFile: TFile | null = null;

	// Attachment state
	private existingAttachmentNames: string[] = [];
	private toAdd: { filename: string; data: ArrayBuffer; size: number }[] = [];
	private toRemove = new Set<string>();
	private attachmentsSectionEl!: HTMLElement;

	// DOM refs
	private customFieldsContainerEl!: HTMLElement;
	private errorEl!: HTMLParagraphElement;
	private saveBtn!: ButtonComponent;
	private passwordTextComponent?: TextComponent;
	private isSubmitting = false;

	constructor(app: App, plugin: VaultCryptPlugin, profileId: string, entryPath: string, token: ParsedVcToken) {
		super(app);
		this.plugin = plugin;
		this.profileId = profileId;
		this.entryPath = entryPath;
		this.token = token;
		this.sourceFile = this.app.workspace.getActiveFile();
	}

	onOpen() {
		const {contentEl} = this;
		this.titleEl.setText(`Edit entry: ${this.entryPath}`);

		if (!this.plugin.sessionService.isUnlocked(this.profileId)) {
			contentEl.createEl('p', {cls: 'mod-warning', text: 'Profile is locked. Unlock it first.'});
			new Setting(contentEl).addButton(btn => btn.setButtonText('Close').setCta().onClick(() => this.close()));
			return;
		}

		const fields = this.plugin.sessionService.getEntryFields(this.profileId, this.entryPath);
		if (!fields) {
			contentEl.createEl('p', {cls: 'mod-warning', text: 'Entry not found.'});
			new Setting(contentEl).addButton(btn => btn.setButtonText('Close').setCta().onClick(() => this.close()));
			return;
		}

		// Pre-populate standard fields
		this.fieldUserName = fields['UserName'] ?? '';
		this.fieldPassword = fields['Password'] ?? '';
		this.fieldURL = fields['URL'] ?? '';
		this.fieldNotes = fields['Notes'] ?? '';

		// Collect custom fields (non-standard)
		for (const [key, value] of Object.entries(fields)) {
			if (!STANDARD_FIELDS.has(key)) {
				this.customFields.push({key, value});
			}
		}

		// Load current attachment names
		this.existingAttachmentNames =
			this.plugin.sessionService.getEntryAttachmentNames(this.profileId, this.entryPath) ?? [];

		// Entry name (read-only)
		new Setting(contentEl)
			.setName('Entry name')
			.setDesc('Cannot be changed (would break token references)')
			.addText(text => {
				text.setValue(fields['Title'] ?? this.entryPath.split('/').pop() ?? '');
				text.setDisabled(true);
			});

		// Username
		new Setting(contentEl)
			.setName('Username')
			.addText(text => {
				text.setPlaceholder('Optional')
					.setValue(this.fieldUserName)
					.onChange(value => {
						this.fieldUserName = value;
						this.refreshFieldDropdown();
					});
			});

		// Password
		new Setting(contentEl)
			.setName('Password')
			.addText(text => {
				text.inputEl.type = 'password';
				text.setPlaceholder('Optional')
					.setValue(this.fieldPassword)
					.onChange(value => {
						this.fieldPassword = value;
					});
				this.passwordTextComponent = text;
			})
			.addButton(btn => btn
				.setIcon('eye')
				.setTooltip('Show password')
				.onClick(() => {
					if (this.passwordTextComponent?.inputEl.type === 'password') {
						this.passwordTextComponent.inputEl.type = 'text';
						btn.setIcon('eye-off').setTooltip('Hide password');
					} else if (this.passwordTextComponent) {
						this.passwordTextComponent.inputEl.type = 'password';
						btn.setIcon('eye').setTooltip('Show password');
					}
				}))
			.addButton(btn => btn
				.setButtonText('Generate')
				.onClick(() => {
					new GeneratePasswordModal(this.app, (pw: string) => {
						this.passwordTextComponent?.setValue(pw);
						this.fieldPassword = pw;
						this.refreshFieldDropdown();
					}).open();
				}));

		// URL
		new Setting(contentEl)
			.setName('URL')
			.addText(text => {
				text.setPlaceholder('Optional')
					.setValue(this.fieldURL)
					.onChange(value => {
						this.fieldURL = value;
						this.refreshFieldDropdown();
					});
			});

		// Notes
		new Setting(contentEl)
			.setName('Notes')
			.addTextArea(text => {
				text.setPlaceholder('Optional')
					.setValue(this.fieldNotes)
					.onChange(value => {
						this.fieldNotes = value;
						this.refreshFieldDropdown();
					});
				text.inputEl.rows = 4;
			});

		// Custom fields
		this.customFieldsContainerEl = contentEl.createDiv();
		this.renderCustomFields();

		new Setting(contentEl)
			.addButton(btn => btn
				.setButtonText('Add custom field')
				.onClick(() => {
					this.customFields.push({key: '', value: ''});
					this.renderCustomFields();
					this.refreshFieldDropdown();
				}));

		// Attachments section
		contentEl.createEl('hr');
		contentEl.createEl('p', {cls: 'setting-item-name', text: 'Attachments'});
		this.attachmentsSectionEl = contentEl.createDiv();
		this.renderAttachments();

		new Setting(contentEl)
			.addButton(btn => btn
				.setButtonText('Add attachment')
				.onClick(() => this.triggerFileInput()));

		// Reference field dropdown
		contentEl.createEl('hr');

		const config = this.plugin.settings.profiles[this.profileId];
		const defaultField = config?.defaultField ?? 'Password';
		this.originalReferenceField = this.token.fieldName ?? defaultField;
		this.referenceField = this.originalReferenceField;

		new Setting(contentEl)
			.setName('Reference field')
			.setDesc('The field this chip resolves to when revealed')
			.addDropdown(dd => {
				this.fieldRefDropdown = dd;
				dd.onChange(value => {
					this.referenceField = value;
					this.updateTokenPreview();
				});
			});

		this.tokenPreviewEl = contentEl.createDiv({cls: 'vaultcrypt-token-preview-row'});
		this.refreshFieldDropdown();

		// Error message
		this.errorEl = contentEl.createEl('p', {cls: 'mod-warning vaultcrypt-hidden'});

		// Cancel / Save buttons
		new Setting(contentEl)
			.addButton(btn => btn.setButtonText('Cancel').onClick(() => this.close()))
			.addButton(btn => {
				this.saveBtn = btn;
				btn.setButtonText('Save').setCta()
					.onClick(() => {
						this.submit().catch(e => console.error('[VaultCrypt] EditSecretModal error', e));
					});
			});
	}

	private renderCustomFields() {
		this.customFieldsContainerEl.empty();
		for (let i = 0; i < this.customFields.length; i++) {
			const field = this.customFields[i]!;
			new Setting(this.customFieldsContainerEl)
				.addText(text => text
					.setPlaceholder('Key')
					.setValue(field.key)
					.onChange(v => {
						field.key = v;
						this.refreshFieldDropdown();
					}))
				.addText(text => text
					.setPlaceholder('Value')
					.setValue(field.value)
					.onChange(v => {
						field.value = v;
						this.refreshFieldDropdown();
					}))
				.addButton(btn => btn
					.setButtonText('\u00d7')
					.onClick(() => {
						this.customFields.splice(i, 1);
						this.renderCustomFields();
						this.refreshFieldDropdown();
					}));
		}
	}

	private renderAttachments() {
		this.attachmentsSectionEl.empty();

		// Existing attachments not queued for removal
		for (const name of this.existingAttachmentNames) {
			if (this.toRemove.has(name)) continue;
			const replacement = this.toAdd.find(a => a.filename === name);
			const displayName = replacement ? `${name} (replaced)` : name;
			new Setting(this.attachmentsSectionEl)
				.setName(displayName)
				.addButton(btn => btn
					.setButtonText('Replace')
					.onClick(() => this.triggerFileInput(name)))
				.addButton(btn => btn
					.setButtonText('Remove')
					.setWarning()
					.onClick(() => {
						this.toRemove.add(name);
						this.toAdd = this.toAdd.filter(a => a.filename !== name);
						this.renderAttachments();
					}));
		}

		// Pending new additions (filenames not in existingAttachmentNames)
		for (const pending of this.toAdd) {
			if (this.existingAttachmentNames.includes(pending.filename)) continue;
			const sizeKb = (pending.size / 1024).toFixed(1);
			new Setting(this.attachmentsSectionEl)
				.setName(`${pending.filename} (${sizeKb} KB) — pending`)
				.addButton(btn => btn
					.setButtonText('\u00d7')
					.onClick(() => {
						this.toAdd = this.toAdd.filter(a => a.filename !== pending.filename);
						this.renderAttachments();
					}));
		}

		// Items queued for removal (with undo)
		for (const name of this.toRemove) {
			new Setting(this.attachmentsSectionEl)
				.setName(`${name} — will be removed`)
				.addButton(btn => btn
					.setButtonText('Undo')
					.onClick(() => {
						this.toRemove.delete(name);
						this.renderAttachments();
					}));
		}
	}

	private triggerFileInput(replacingName?: string): void {
		const input = document.createElement('input');
		input.type = 'file';
		input.addClass('vaultcrypt-hidden');
		document.body.appendChild(input);
		input.addEventListener('change', () => {
			const file = input.files?.[0];
			document.body.removeChild(input);
			if (!file) return;
			const reader = new FileReader();
			reader.onload = () => {
				const data = reader.result as ArrayBuffer;
				const filename = replacingName ?? file.name;
				this.toAdd = this.toAdd.filter(a => a.filename !== filename);
				this.toAdd.push({filename, data, size: file.size});
				if (replacingName) this.toRemove.delete(replacingName);
				this.renderAttachments();
			};
			reader.onerror = () => {
				new Notice(`Failed to read file: ${file.name}`);
			};
			reader.readAsArrayBuffer(file);
		});
		input.click();
	}

	private refreshFieldDropdown() {
		const dd = this.fieldRefDropdown;
		if (!dd) return;

		const options: string[] = [];
		// Always offer Password
		options.push('Password');
		if (this.fieldUserName) options.push('UserName');
		if (this.fieldURL) options.push('URL');
		if (this.fieldNotes) options.push('Notes');
		for (const cf of this.customFields) {
			if (cf.key && cf.value && !options.includes(cf.key)) options.push(cf.key);
		}

		dd.selectEl.empty();
		for (const opt of options) dd.addOption(opt, opt);

		const preferred = options.includes(this.referenceField)
			? this.referenceField
			: options[0]!;
		dd.setValue(preferred);
		this.referenceField = preferred;

		this.updateTokenPreview();
	}

	private updateTokenPreview() {
		if (!this.tokenPreviewEl) return;
		this.tokenPreviewEl.setText(this.buildTokenString());
	}

	private buildTokenString(): string {
		const config = this.plugin.settings.profiles[this.profileId];
		const defaultField = config?.defaultField ?? 'Password';
		const field = this.referenceField || defaultField;

		return field === defaultField
			? `{{vc:${this.profileId}/${this.entryPath}}}`
			: `{{vc:${this.profileId}/${this.entryPath}#${field}}}`;
	}

	private validateCustomFields(): string | null {
		const reserved = new Set(['Title', 'UserName', 'Password', 'URL', 'Notes']);
		const seen = new Set<string>();
		for (const cf of this.customFields) {
			if (!cf.key) return 'Custom field key cannot be empty';
			if (!VALID_FIELD_NAME.test(cf.key)) return `"${cf.key}" can only contain letters, digits, hyphens, and underscores`;
			if (reserved.has(cf.key)) return `"${cf.key}" is a reserved field name`;
			if (seen.has(cf.key)) return `Duplicate custom field key: "${cf.key}"`;
			seen.add(cf.key);
		}
		return null;
	}

	private showError(msg: string) {
		this.errorEl.textContent = msg;
		this.errorEl.removeClass('vaultcrypt-hidden');
	}

	private async submit() {
		if (this.isSubmitting) return;
		this.isSubmitting = true;
		this.saveBtn.setDisabled(true);
		this.errorEl.addClass('vaultcrypt-hidden');

		try {
			const cfError = this.validateCustomFields();
			if (cfError) {
				this.showError(cfError);
				return;
			}

			const config = this.plugin.settings.profiles[this.profileId];
			if (!config) {
				this.showError('Profile not found.');
				return;
			}

			const fields: Record<string, string> = {};
			if (this.fieldUserName) fields['UserName'] = this.fieldUserName;
			if (this.fieldPassword) fields['Password'] = this.fieldPassword;
			if (this.fieldURL) fields['URL'] = this.fieldURL;
			if (this.fieldNotes) fields['Notes'] = this.fieldNotes;
			for (const cf of this.customFields) {
				if (cf.key && cf.value) fields[cf.key] = cf.value;
			}

			await this.plugin.sessionService.updateEntryFields(
				this.profileId,
				this.entryPath,
				fields,
				config.path,
			);

			// Apply attachment additions/replacements first, then removals.
			// Additions first so that a failure doesn't leave deletions already committed.
			const attachmentErrors: string[] = [];
			for (const {filename, data} of this.toAdd) {
				try {
					await this.plugin.sessionService.setAttachment(
						this.profileId, this.entryPath, filename, data, config.path,
					);
				} catch (e) {
					attachmentErrors.push(`add "${filename}": ${e instanceof Error ? e.message : String(e)}`);
				}
			}
			for (const filename of this.toRemove) {
				try {
					await this.plugin.sessionService.deleteAttachment(
						this.profileId, this.entryPath, filename, config.path,
					);
				} catch (e) {
					attachmentErrors.push(`remove "${filename}": ${e instanceof Error ? e.message : String(e)}`);
				}
			}
			if (attachmentErrors.length > 0) {
				new Notice(`Some attachment changes failed:\n${attachmentErrors.join('\n')}`, 8000);
			}

			// If the reference field changed, update the token in the source file.
			// Skip when the original token was an attachment reference — the dropdown
			// cannot represent attachment names, so it always differs spuriously.
			if (this.referenceField !== this.originalReferenceField
				&& !this.originalReferenceField.startsWith(ATTACHMENT_PREFIX)) {
				const newToken = this.buildTokenString();
				await this.replaceTokenInSourceFile(this.token.raw, newToken);
			}

			this.plugin.refreshChips();
			new Notice('Entry updated');
			this.close();
		} catch (e) {
			console.error('[VaultCrypt] EditSecretModal submit error', e);
			this.showError(`Error: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			this.isSubmitting = false;
			this.saveBtn.setDisabled(false);
		}
	}

	/**
	 * Finds the old token string in the source file (captured at modal open)
	 * and replaces it with the new token string.  Uses the Vault API so it
	 * works regardless of view mode.
	 */
	private async replaceTokenInSourceFile(oldToken: string, newToken: string): Promise<void> {
		if (!this.sourceFile) return;
		const content = await this.app.vault.read(this.sourceFile);
		if (!content.includes(oldToken)) return;
		const updated = content.split(oldToken).join(newToken);
		await this.app.vault.modify(this.sourceFile, updated);
	}

	onClose() {
		this.contentEl.empty();
	}
}
