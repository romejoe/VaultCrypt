import {App, ButtonComponent, DropdownComponent, Editor, Modal, Notice, Setting, TextComponent} from 'obsidian';
import VaultCryptPlugin, {VaultCryptProfile} from '../main';
import {DbTreeNode} from '../unlock-session';
import {computed, effect, peek, ReadSignal, signal, StopEffect} from '@maverick-js/signals';
import {UnlockModal} from './unlock-modal';
import {GeneratePasswordModal} from './generate-password-modal';
import {DeepReadonly} from "../utils";
import {html, render, nothing, TemplateResult} from 'lit-html';
import {ref} from 'lit-html/directives/ref.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Characters allowed in a single path segment (group name or entry title) per inline-parser. */
const VALID_PATH_SEGMENT = /^[a-zA-Z0-9_-]+$/;
/** Characters allowed in a field name per inline-parser. */
const VALID_FIELD_NAME = /^[a-zA-Z0-9_-]+$/;

// ── Insert Secret Modal ───────────────────────────────────────────────────────

export class InsertSecretModal extends Modal {
	private plugin: VaultCryptPlugin;
	private editor?: Editor;

	// Selection state
	private readonly selectedProfileId$ = signal<string>('');
	private selectedEntryPath: string | null = null;
	private newEntryGroupPath: string | null = null;

	// New-entry form values
	private entryName = '';
	private fieldUserName = '';
	private fieldPassword = '';
	private fieldURL = '';
	private customFields: { key: string; value: string }[] = [];

	// Reference field choice
	private referenceField = '';

	// DOM refs
	private lockedWarningEl!: HTMLElement;
	private treeContainerEl!: HTMLElement;
	private entryFieldsSectionEl!: HTMLElement;
	private customFieldsContainerEl!: HTMLElement;
	private fieldRefDropdown?: DropdownComponent;
	private tokenPreviewEl!: HTMLElement;
	private errorEl!: HTMLParagraphElement;
	private insertBtn!: ButtonComponent;
	private entryNameTextComponent?: TextComponent;
	private userNameTextComponent?: TextComponent;
	private passwordTextComponent?: TextComponent;
	private urlTextComponent?: TextComponent;
	private pendingAttachments: { filename: string; data: ArrayBuffer; size: number }[] = [];
	private pendingAttachmentsContainerEl!: HTMLElement;
	private isSubmitting = false;
	private isOpen = false;
	private stopLockEffect?: StopEffect;
	private virtualGroupPaths = new Set<string>();
	private expandedPaths = new Set<string>();
	private inlineGroupCreatePath: string | null = null;
	private inlineGroupCreateSession = 0;
	private entryNameErrorEl!: HTMLElement;
	private effects: StopEffect[] = [];
	selectedProfile$: ReadSignal<DeepReadonly<VaultCryptProfile> | null>;
	selectedProfileLocked$: ReadSignal<boolean>;

	constructor(app: App, plugin: VaultCryptPlugin, editor?: Editor) {
		super(app);
		this.plugin = plugin;
		this.editor = editor;

		const settings = plugin.settings;
		const profileIds = Object.keys(settings.profiles);
		this.selectedProfileId$.set(
			(plugin.lastUsedProfileId && settings.profiles[plugin.lastUsedProfileId])
				? plugin.lastUsedProfileId
				: settings.general.defaultProfile && settings.profiles[settings.general.defaultProfile]
					? settings.general.defaultProfile
					: profileIds[0] ?? ''
		);

		this.selectedProfile$ = computed(() => {
			const state = this.plugin.vaultCryptState$();
			const selectedProfileId = this.selectedProfileId$();
			return state.profiles.find(p => p.id === selectedProfileId) ?? null;
		});

		this.selectedProfileLocked$ = computed(() => {
			const profile = this.selectedProfile$();
			return profile?.isLocked ?? true;
		});
	}

	onOpen() {
		this.isOpen = true;
		const {contentEl} = this;
		this.titleEl.setText('Insert secret');

		const profileIds = Object.keys(this.plugin.settings.profiles);
		if (profileIds.length === 0) {
			contentEl.createEl('p', {text: 'No profiles configured. Create a profile first.'});
			new Setting(contentEl).addButton(btn => btn.setButtonText('Close').setCta().onClick(() => this.close()));
			return;
		}

		// Profile dropdown
		new Setting(contentEl)
			.setName('Profile')
			.addDropdown(dd => {
				for (const id of profileIds) dd.addOption(id, id);
				dd.setValue(peek(this.selectedProfileId$)).onChange(value => {
					this.selectedProfileId$.set(value);
					this.selectedEntryPath = null;
					this.newEntryGroupPath = null;
					this.virtualGroupPaths.clear();
					this.expandedPaths.clear();
					this.referenceField = '';

				});
			});

		// Locked warning + unlock button
		const lockedDiv = contentEl.createDiv({cls: 'vaultcrypt-insert-locked-warning vaultcrypt-hidden'});
		lockedDiv.createEl('p', {cls: 'mod-warning', text: 'This profile is locked.'});
		new ButtonComponent(lockedDiv)
			.setButtonText('Unlock profile')
			.onClick(() => {
				new UnlockModal(this.app, this.plugin, peek(this.selectedProfileId$)).open();
			});
		this.lockedWarningEl = lockedDiv;

		// Tree label + container
		contentEl.createEl('p', {cls: 'setting-item-name', text: 'Select group or entry'});
		this.treeContainerEl = contentEl.createDiv({cls: 'vaultcrypt-tree-container'});

		// Entry fields section (hidden until "New entry here" is clicked)
		this.entryFieldsSectionEl = contentEl.createDiv({cls: 'vaultcrypt-hidden'});
		this.buildEntryFieldsSection(this.entryFieldsSectionEl);

		// Field reference + token preview
		const fieldRefContainer = contentEl.createDiv();
		this.buildFieldRefSection(fieldRefContainer);

		// Error message
		this.errorEl = contentEl.createEl('p', {cls: 'mod-warning vaultcrypt-hidden'});

		// Cancel / Insert buttons
		new Setting(contentEl)
			.addButton(btn => btn.setButtonText('Cancel').onClick(() => this.close()))
			.addButton(btn => {
				this.insertBtn = btn;
				btn.setButtonText('Insert').setCta().setDisabled(true)
					.onClick(() => {
						this.submit().catch(e => console.error('[VaultCrypt] InsertSecretModal error', e));
					});
			});

		this.effects = [
			// Locked status changed
			effect(() => {
				const isLocked = this.selectedProfileLocked$();
				if (!this.isOpen) {
					return;
				}
				this.onLockStateChanged(isLocked);
			}),
			//Profile changed
			effect(() => {
				const profile = this.selectedProfile$();
				this.onProfileChanged(profile);
			}),
			// Tree selection changed
		];
	}

	private onProfileChanged(profile: DeepReadonly<VaultCryptProfile> | null) {
		this.selectedEntryPath = null;
		this.newEntryGroupPath = null;
		this.inlineGroupCreatePath = null;
		this.virtualGroupPaths.clear();
		this.expandedPaths.clear();

		// Reset new-entry draft so it doesn't leak into a different profile
		this.entryName = '';
		this.fieldUserName = '';
		this.fieldPassword = '';
		this.fieldURL = '';
		this.customFields = [];
		this.referenceField = '';
		this.entryNameTextComponent?.setValue('');
		this.userNameTextComponent?.setValue('');
		this.passwordTextComponent?.setValue('');
		this.urlTextComponent?.setValue('');
		this.customFieldsContainerEl?.empty();
		this.pendingAttachments = [];
		this.pendingAttachmentsContainerEl?.empty();
		this.entryNameErrorEl?.addClass('vaultcrypt-hidden');

		this.entryFieldsSectionEl.addClass('vaultcrypt-hidden');
		this.renderTree();
		this.refreshFieldDropdown();
		this.updateInsertButtonState();
	}


	/** Called when the current profile's lock state changes without a profile switch. */
	private onLockStateChanged(locked: boolean) {
		if (locked) {
			this.lockedWarningEl.removeClass('vaultcrypt-hidden');
			this.lockedWarningEl.addClass('vaultcrypt-flex');
			this.selectedEntryPath = null;
			this.newEntryGroupPath = null;
			this.inlineGroupCreatePath = null;
			this.virtualGroupPaths.clear();
			this.entryFieldsSectionEl.addClass('vaultcrypt-hidden');
		} else {
			this.lockedWarningEl.addClass('vaultcrypt-hidden');
			this.lockedWarningEl.removeClass('vaultcrypt-flex');
		}
		this.renderTree();
		this.refreshFieldDropdown();
		this.updateInsertButtonState();
	}

	private renderTree() {
		const locked = !this.plugin.sessionService.isUnlocked(peek(this.selectedProfileId$));
		if (locked) {
			render(html`<p class="setting-item-description">Unlock the profile to browse the database.</p>`, this.treeContainerEl);
			return;
		}
		const rawTree = this.plugin.sessionService.getEntryTree(peek(this.selectedProfileId$));
		if (!rawTree) {
			render(nothing, this.treeContainerEl);
			return;
		}
		const tree = this.augmentTreeWithVirtualGroups(rawTree);
		render(html`
			<ul class="vaultcrypt-tree-ul vaultcrypt-tree-root" role="tree">
				${this.renderGroupChildren(tree)}
			</ul>
		`, this.treeContainerEl);
	}

	private renderGroupChildren(node: DbTreeNode): TemplateResult {
		return html`
			${node.groups.map(childGroup => {
				const isExpanded = this.expandedPaths.has(childGroup.path);
				return html`
					<li role="treeitem"
						tabindex="0"
						aria-expanded=${String(isExpanded)}
						@click=${(e: Event) => this.toggleGroup(e, childGroup.path)}
						@keydown=${(e: KeyboardEvent) => {
							if (e.key === 'Enter' || e.key === ' ') {
								e.preventDefault();
								this.toggleGroup(e, childGroup.path);
							}
						}}>
						<span class=${'vaultcrypt-tree-caret' + (isExpanded ? ' vaultcrypt-tree-caret-open' : '')}
							>${childGroup.name || '(unnamed)'}</span>
						<ul class=${'vaultcrypt-tree-ul vaultcrypt-tree-nested' + (isExpanded ? ' vaultcrypt-tree-active' : '')}
							role="group">
							${this.renderGroupChildren(childGroup)}
						</ul>
					</li>
				`;
			})}
			${node.entries.map(entry => html`
				<li class=${'vaultcrypt-tree-entry' + (this.selectedEntryPath === entry.path ? ' is-active' : '')}
					tabindex="0"
					role="treeitem"
					@click=${(e: Event) => {
						e.stopPropagation();
						this.selectEntry(entry.path);
					}}
					@keydown=${(e: KeyboardEvent) => {
						if (e.key === 'Enter' || e.key === ' ') {
							e.preventDefault();
							e.stopPropagation();
							this.selectEntry(entry.path);
						}
					}}>${entry.name || '(untitled)'}</li>
			`)}
			<li class=${'vaultcrypt-tree-new-entry' + (this.newEntryGroupPath === node.path && this.selectedEntryPath === null ? ' is-active' : '')}
				tabindex="0"
				role="treeitem"
				@click=${(e: Event) => {
					e.stopPropagation();
					this.selectNewEntry(node.path);
				}}
				@keydown=${(e: KeyboardEvent) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						e.stopPropagation();
						this.selectNewEntry(node.path);
					}
				}}>New entry here</li>
			${this.inlineGroupCreatePath === node.path
				? html`
					<li class="vaultcrypt-tree-new-entry" role="treeitem"
						@click=${(e: Event) => e.stopPropagation()}>
						<input ${ref((el) => {
								if (el instanceof HTMLInputElement && document.activeElement !== el) el.focus();
							})}
							class="vaultcrypt-tree-group-input"
							type="text"
							placeholder="Group name"
							@keydown=${(e: KeyboardEvent) => {
								const input = e.target as HTMLInputElement;
								if (e.key === 'Enter') {
									e.stopPropagation();
									this.confirmInlineGroupCreate(input.value.trim(), node.path);
								}
								if (e.key === 'Escape') {
									e.stopPropagation();
									this.cancelInlineGroupCreate();
								}
							}}
							@blur=${(e: FocusEvent) => {
								const input = e.target as HTMLInputElement;
								const valueTrimmed = input.value.trim();
								const session = this.inlineGroupCreateSession;
								window.setTimeout(() => {
									if (this.inlineGroupCreatePath === node.path && this.inlineGroupCreateSession === session) {
										this.confirmInlineGroupCreate(valueTrimmed, node.path);
									}
								}, 100);
							}}>
					</li>
				`
				: html`
					<li class="vaultcrypt-tree-new-entry"
						tabindex="0"
						role="treeitem"
						@click=${(e: Event) => {
							e.stopPropagation();
							this.startInlineGroupCreate(node.path);
						}}
						@keydown=${(e: KeyboardEvent) => {
							if (e.key === 'Enter' || e.key === ' ') {
								e.preventDefault();
								e.stopPropagation();
								this.startInlineGroupCreate(node.path);
							}
						}}>New group here</li>
				`}
		`;
	}

	private augmentTreeWithVirtualGroups(root: DbTreeNode): DbTreeNode {
		if (this.virtualGroupPaths.size === 0) return root;
		const cloneNode = (node: DbTreeNode): DbTreeNode => ({
			name: node.name,
			path: node.path,
			groups: node.groups.map(cloneNode),
			entries: [...node.entries],
		});
		const cloned = cloneNode(root);
		for (const vPath of this.virtualGroupPaths) {
			const segments = vPath.split('/');
			let current = cloned;
			for (let i = 0; i < segments.length; i++) {
				const seg = segments[i]!;
				const segPath = segments.slice(0, i + 1).join('/');
				let child = current.groups.find(g => g.path === segPath);
				if (!child) {
					child = {name: seg, path: segPath, groups: [], entries: []};
					current.groups.push(child);
				}
				current = child;
			}
		}
		return cloned;
	}

	private toggleGroup(e: Event, path: string) {
		e.stopPropagation();
		// Only toggle when the click/key originated on the <li> itself or its
		// direct caret <span>, not on descendants (nested <ul>, entries, etc.).
		const li = e.currentTarget as HTMLElement;
		const target = e.target as HTMLElement;
		if (target !== li && !(target.tagName === 'SPAN' && target.classList.contains('vaultcrypt-tree-caret'))) return;
		if (this.expandedPaths.has(path)) {
			this.expandedPaths.delete(path);
		} else {
			this.expandedPaths.add(path);
		}
		this.renderTree();
	}

	private startInlineGroupCreate(parentPath: string) {
		this.inlineGroupCreateSession++;
		this.inlineGroupCreatePath = parentPath;
		this.selectedEntryPath = null;
		this.newEntryGroupPath = null;
		this.entryFieldsSectionEl.addClass('vaultcrypt-hidden');
		this.renderTree();
		this.updateInsertButtonState();
	}

	private confirmInlineGroupCreate(name: string, parentPath: string) {
		this.inlineGroupCreateSession++;
		this.inlineGroupCreatePath = null;
		if (name && VALID_PATH_SEGMENT.test(name)) {
			this.addVirtualGroup(parentPath, name);
		} else if (name) {
			new Notice('Group name can only contain letters, digits, hyphens, and underscores');
			this.renderTree();
		} else {
			this.renderTree();
		}
	}

	private cancelInlineGroupCreate() {
		this.inlineGroupCreateSession++;
		this.inlineGroupCreatePath = null;
		this.renderTree();
	}

	private addVirtualGroup(parentPath: string, name: string) {
		const fullPath = parentPath ? `${parentPath}/${name}` : name;
		this.virtualGroupPaths.add(fullPath);
		this.expandedPaths.add(fullPath);
		if (parentPath) this.expandedPaths.add(parentPath);
		this.renderTree();
	}

	private selectEntry(entryPath: string) {
		this.cancelInlineGroupCreate();
		this.selectedEntryPath = entryPath;
		this.newEntryGroupPath = null;
		this.entryFieldsSectionEl.addClass('vaultcrypt-hidden');
		this.renderTree();
		this.refreshFieldDropdown();
		this.updateInsertButtonState();
	}

	private selectNewEntry(groupPath: string) {
		this.cancelInlineGroupCreate();
		this.newEntryGroupPath = groupPath;
		this.selectedEntryPath = null;
		this.entryFieldsSectionEl.removeClass('vaultcrypt-hidden');
		this.renderTree();
		this.refreshFieldDropdown();
		this.updateInsertButtonState();
	}

	private buildEntryFieldsSection(container: HTMLElement) {
		container.createEl('hr');

		new Setting(container)
			.setName('Entry name (required)')
			.setDesc('Becomes the entry title in the database')
			.addText(text => {
				this.entryNameTextComponent = text;
				text.setPlaceholder('Enter entry name')
					.onChange(value => {
						this.entryName = value;
						if (value && !VALID_PATH_SEGMENT.test(value)) {
							this.entryNameErrorEl.textContent = 'Entry name can only contain letters, digits, hyphens, and underscores';
							this.entryNameErrorEl.removeClass('vaultcrypt-hidden');
						} else {
							this.entryNameErrorEl.addClass('vaultcrypt-hidden');
						}
						this.refreshFieldDropdown();
						this.updateTokenPreview();
						this.updateInsertButtonState();
					});
			});
		this.entryNameErrorEl = container.createEl('p', {cls: 'mod-warning vaultcrypt-hidden'});

		new Setting(container)
			.setName('Username')
			.addText(text => {
				this.userNameTextComponent = text;
				text.setPlaceholder('Optional')
					.onChange(value => {
						this.fieldUserName = value;
						this.refreshFieldDropdown();
					});
			});

		new Setting(container)
			.setName('Password')
			.addText(text => {
				text.inputEl.type = 'password';
				text.setPlaceholder('Optional')
					.onChange(value => {
						this.fieldPassword = value;
						this.refreshFieldDropdown();
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

		new Setting(container)
			.setName('URL')
			.addText(text => {
				this.urlTextComponent = text;
				text.setPlaceholder('Optional')
					.onChange(value => {
						this.fieldURL = value;
						this.refreshFieldDropdown();
					});
			});

		this.customFieldsContainerEl = container.createDiv();

		new Setting(container)
			.addButton(btn => btn
				.setButtonText('Add custom field')
				.onClick(() => {
					this.customFields.push({key: '', value: ''});
					this.renderCustomFields();
					this.refreshFieldDropdown();
				}));

		this.pendingAttachmentsContainerEl = container.createDiv();

		new Setting(container)
			.addButton(btn => btn
				.setButtonText('Add attachment')
				.onClick(() => this.triggerAttachmentFileInput()));
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
						this.updateInsertButtonState();
					}))
				.addText(text => text
					.setPlaceholder('Value')
					.setValue(field.value)
					.onChange(v => {
						field.value = v;
						this.refreshFieldDropdown();
					}))
				.addButton(btn => btn
					.setButtonText('×')
					.onClick(() => {
						this.customFields.splice(i, 1);
						this.renderCustomFields();
						this.refreshFieldDropdown();
					}));
		}
	}

	private renderPendingAttachments() {
		this.pendingAttachmentsContainerEl.empty();
		for (let i = 0; i < this.pendingAttachments.length; i++) {
			const att = this.pendingAttachments[i]!;
			const sizeKb = (att.size / 1024).toFixed(1);
			new Setting(this.pendingAttachmentsContainerEl)
				.setName(`${att.filename} (${sizeKb} KB)`)
				.addButton(btn => btn
					.setButtonText('\u00d7')
					.onClick(() => {
						this.pendingAttachments.splice(i, 1);
						this.renderPendingAttachments();
					}));
		}
	}

	private triggerAttachmentFileInput(): void {
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
				const idx = this.pendingAttachments.findIndex(a => a.filename === file.name);
				if (idx >= 0) {
					this.pendingAttachments[idx] = {filename: file.name, data, size: file.size};
				} else {
					this.pendingAttachments.push({filename: file.name, data, size: file.size});
				}
				this.renderPendingAttachments();
			};
			reader.onerror = () => {
				new Notice(`Failed to read file: ${file.name}`);
			};
			reader.readAsArrayBuffer(file);
		});
		input.click();
	}

	private buildFieldRefSection(container: HTMLElement) {
		new Setting(container)
			.setName('Reference field')
			.setDesc('The field whose value will be resolved when the chip is revealed')
			.addDropdown(dd => {
				this.fieldRefDropdown = dd;
				dd.onChange(value => {
					this.referenceField = value;
					this.updateTokenPreview();
				});
			});

		this.tokenPreviewEl = container.createDiv({cls: 'vaultcrypt-token-preview-row'});
	}

	private refreshFieldDropdown() {
		const dd = this.fieldRefDropdown;
		if (!dd) return;

		const options: string[] = [];

		if (this.selectedEntryPath) {
			const profileId = peek(this.selectedProfileId$);
			const names = this.plugin.sessionService.getEntryFieldNames(
				profileId,
				this.selectedEntryPath,
			);
			if (names) {
				for (const name of names) {
					if (name === 'Title') continue;
					// Skip fields whose names can't be represented in token syntax
					if (!VALID_FIELD_NAME.test(name)) continue;
					const val = this.plugin.sessionService.getFieldValue(profileId, this.selectedEntryPath, name);
					if (val) options.push(name);
				}
			}
		} else if (this.newEntryGroupPath !== null) {
			// Always offer Password for new entries even if blank
			options.push('Password');
			if (this.fieldUserName) options.push('UserName');
			if (this.fieldURL) options.push('URL');
			for (const cf of this.customFields) {
				if (cf.key && cf.value && !options.includes(cf.key)) options.push(cf.key);
			}
		}

		// Rebuild the <select> options
		dd.selectEl.empty();
		if (options.length === 0) {
			dd.addOption('', '— select an entry first —');
			this.referenceField = '';
		} else {
			for (const opt of options) dd.addOption(opt, opt);
			const config = this.plugin.settings.profiles[peek(this.selectedProfileId$)];
			const defaultField = config?.defaultField ?? 'Password';
			const preferred = options.includes(this.referenceField)
				? this.referenceField
				: options.includes(defaultField)
					? defaultField
					: options[0]!;
			dd.setValue(preferred);
			this.referenceField = preferred;
		}

		this.updateTokenPreview();
	}

	private updateTokenPreview() {
		if (!this.tokenPreviewEl) return;
		const token = this.buildTokenString();
		this.tokenPreviewEl.setText(token ?? '');
	}

	private buildTokenString(): string | null {
		const profileId = peek(this.selectedProfileId$);
		let entryPath: string | null = null;

		if (this.selectedEntryPath) {
			entryPath = this.selectedEntryPath;
		} else if (this.newEntryGroupPath !== null && this.entryName) {
			entryPath = this.newEntryGroupPath
				? `${this.newEntryGroupPath}/${this.entryName}`
				: this.entryName;
		}

		if (!profileId || !entryPath) return null;

		const config = this.plugin.settings.profiles[profileId];
		const defaultField = config?.defaultField ?? 'Password';
		const field = this.referenceField || defaultField;

		return field === defaultField
			? `{{vc:${profileId}/${entryPath}}}`
			: `{{vc:${profileId}/${entryPath}#${field}}}`;
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

	private updateInsertButtonState() {
		const hasSelection = this.selectedEntryPath !== null || this.newEntryGroupPath !== null;
		const entryNameOk = this.newEntryGroupPath === null || (!!this.entryName && VALID_PATH_SEGMENT.test(this.entryName));
		const customFieldsOk = this.newEntryGroupPath === null || this.validateCustomFields() === null;
		const hasReferenceField = !!this.referenceField;
		this.insertBtn?.setDisabled(!hasSelection || !entryNameOk || !customFieldsOk || !hasReferenceField);
	}

	private showError(msg: string) {
		this.errorEl.textContent = msg;
		this.errorEl.removeClass('vaultcrypt-hidden');
	}

	private async submit() {
		if (this.isSubmitting) return;
		this.isSubmitting = true;
		this.insertBtn.setDisabled(true);
		this.errorEl.addClass('vaultcrypt-hidden');

		try {
			const token = this.buildTokenString();
			if (!token) {
				this.showError('Select a group or entry first.');
				return;
			}

			if (this.newEntryGroupPath !== null) {
				if (!this.entryName) {
					this.showError('Entry name is required.');
					return;
				}
				if (!VALID_PATH_SEGMENT.test(this.entryName)) {
					this.showError('Entry name can only contain letters, digits, hyphens, and underscores.');
					return;
				}
				const cfError = this.validateCustomFields();
				if (cfError) {
					this.showError(cfError);
					return;
				}
				const entryPath = this.newEntryGroupPath
					? `${this.newEntryGroupPath}/${this.entryName}`
					: this.entryName;
				const config = this.plugin.settings.profiles[peek(this.selectedProfileId$)];
				if (!config) {
					this.showError('Profile not found.');
					return;
				}

				const fields: Record<string, string> = {};
				if (this.fieldUserName) fields['UserName'] = this.fieldUserName;
				if (this.fieldPassword) fields['Password'] = this.fieldPassword;
				if (this.fieldURL) fields['URL'] = this.fieldURL;
				for (const cf of this.customFields) {
					if (cf.key && cf.value) fields[cf.key] = cf.value;
				}

				await this.plugin.sessionService.createEntryWithFields(
					peek(this.selectedProfileId$),
					entryPath,
					fields,
					config.path,
				);

				// Add any pending attachments to the newly created entry
				const attachmentErrors: string[] = [];
				for (const {filename, data} of this.pendingAttachments) {
					try {
						await this.plugin.sessionService.setAttachment(
							peek(this.selectedProfileId$),
							entryPath,
							filename,
							data,
							config.path,
						);
					} catch (e) {
						attachmentErrors.push(`"${filename}": ${e instanceof Error ? e.message : String(e)}`);
					}
				}
				if (attachmentErrors.length > 0) {
					new Notice(`Entry created but some attachments failed:\n${attachmentErrors.join('\n')}`, 8000);
				}
			}

			this.editor?.replaceRange(token, this.editor.getCursor());
			this.plugin.lastUsedProfileId = peek(this.selectedProfileId$);
			new Notice('Secret inserted');
			this.close();
		} catch (e) {
			console.error('[VaultCrypt] InsertSecretModal submit error', e);
			this.showError(`Error: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			this.isSubmitting = false;
			this.insertBtn.setDisabled(false);
		}
	}

	onClose() {
		this.isOpen = false;
		this.inlineGroupCreatePath = null;
		for (const stop of this.effects) stop();
		this.stopLockEffect?.();
		this.contentEl.empty();
	}
}
