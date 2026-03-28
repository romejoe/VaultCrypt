import {App, ButtonComponent, DropdownComponent, Editor, Modal, Notice, Setting, TextComponent} from 'obsidian';
import VaultCryptPlugin, {VaultCryptProfile} from '../main';
import {DbTreeNode} from '../unlock-session';
import {computed, effect, peek, ReadSignal, signal, StopEffect} from '@maverick-js/signals';
import {UnlockModal} from './unlock-modal';
import {DeepReadonly} from "../utils";

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Characters allowed in a single path segment (group name or entry title) per inline-parser. */
const VALID_PATH_SEGMENT = /^[a-zA-Z0-9_-]+$/;
/** Characters allowed in a field name per inline-parser. */
const VALID_FIELD_NAME = /^[a-zA-Z0-9_-]+$/;

function generatePassword(
	length = 20,
	opts: { upper: boolean; lower: boolean; digits: boolean; symbols: boolean } = {
		upper: true, lower: true, digits: true, symbols: true,
	},
): string {
	let charset = '';
	if (opts.upper) charset += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
	if (opts.lower) charset += 'abcdefghijklmnopqrstuvwxyz';
	if (opts.digits) charset += '0123456789';
	if (opts.symbols) charset += '!@#$%^&*()-_=+[]{}|;:,.<>?';
	if (!charset) throw new Error('Enable at least one character set');

	const result: string[] = [];
	const max = Math.floor(0xffffffff / charset.length) * charset.length;
	while (result.length < length) {
		const buf = new Uint32Array(length * 2);
		crypto.getRandomValues(buf);
		for (const val of buf) {
			if (result.length >= length) break;
			if (val < max) result.push(charset[val % charset.length]!);
		}
	}
	return result.join('');
}

// ── Generate Password Modal ───────────────────────────────────────────────────

class GeneratePasswordModal extends Modal {
	private onApply: (pw: string) => void;
	private length = 20;
	private opts = {upper: true, lower: true, digits: true, symbols: true};
	private currentPassword: string;
	private previewEl!: HTMLElement;
	private errorEl!: HTMLElement;
	private applyBtn!: ButtonComponent;

	constructor(app: App, onApply: (pw: string) => void) {
		super(app);
		this.onApply = onApply;
		this.currentPassword = generatePassword(this.length, this.opts);
	}

	onOpen() {
		const {contentEl} = this;
		this.titleEl.setText('Generate password');

		new Setting(contentEl)
			.setName('Length')
			.addSlider(slider => slider
				.setLimits(8, 64, 1)
				.setValue(this.length)
				.setDynamicTooltip()
				.onChange(v => {
					this.length = v;
					this.refreshPreview();
				}));

		new Setting(contentEl)
			// eslint-disable-next-line obsidianmd/ui/sentence-case
			.setName('Uppercase letters (A–Z)')
			.addToggle(t => t.setValue(this.opts.upper).onChange(v => {
				this.opts.upper = v;
				this.refreshPreview();
			}));

		new Setting(contentEl)
			.setName('Lowercase letters (a–z)')
			.addToggle(t => t.setValue(this.opts.lower).onChange(v => {
				this.opts.lower = v;
				this.refreshPreview();
			}));

		new Setting(contentEl)
			.setName('Digits (0–9)')
			.addToggle(t => t.setValue(this.opts.digits).onChange(v => {
				this.opts.digits = v;
				this.refreshPreview();
			}));

		new Setting(contentEl)
			.setName('Symbols')
			.addToggle(t => t.setValue(this.opts.symbols).onChange(v => {
				this.opts.symbols = v;
				this.refreshPreview();
			}));

		const previewSetting = new Setting(contentEl).setName('Preview');
		this.previewEl = previewSetting.controlEl.createEl('code', {
			text: this.currentPassword,
			cls: 'vaultcrypt-password-preview',
		});
		previewSetting.addButton(btn => btn
			.setIcon('refresh-cw')
			.setTooltip('Regenerate')
			.onClick(() => this.refreshPreview()));

		this.errorEl = contentEl.createEl('p', {cls: 'mod-warning vaultcrypt-hidden'});

		new Setting(contentEl)
			.addButton(btn => btn.setButtonText('Cancel').onClick(() => this.close()))
			.addButton(btn => {
				this.applyBtn = btn;
				btn.setButtonText('Apply')
					.setCta()
					.onClick(() => {
						this.onApply(this.currentPassword);
						this.close();
					});
			});
	}

	private refreshPreview() {
		const hasCharset = this.opts.upper || this.opts.lower || this.opts.digits || this.opts.symbols;
		if (!hasCharset) {
			this.currentPassword = '';
			this.previewEl?.setText('');
			this.errorEl.textContent = 'Enable at least one character set';
			this.errorEl.removeClass('vaultcrypt-hidden');
			this.applyBtn?.setDisabled(true);
			return;
		}
		this.errorEl.addClass('vaultcrypt-hidden');
		this.applyBtn?.setDisabled(false);
		this.currentPassword = generatePassword(this.length, this.opts);
		this.previewEl?.setText(this.currentPassword);
	}

	onClose() {
		this.contentEl.empty();
	}
}

// ── Insert Secret Modal ───────────────────────────────────────────────────────

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
	private isSubmitting = false;
	private isOpen = false;
	private stopLockEffect?: StopEffect;
	private virtualGroupPaths = new Set<string>();
	private expandedPaths = new Set<string>();
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

		this.selectedProfileLocked$ = computed(() =>{
			const profile = this.selectedProfile$();
			return profile?.isLocked ?? true;
		})
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
				if (!this.isOpen){
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
		this.treeContainerEl.empty();
		const locked = !this.plugin.sessionService.isUnlocked(peek(this.selectedProfileId$));
		if (locked) {
			this.treeContainerEl.createEl('p', {
				cls: 'setting-item-description',
				text: 'Unlock the profile to browse the database.',
			});
			return;
		}
		const rawTree = this.plugin.sessionService.getEntryTree(peek(this.selectedProfileId$));
		if (!rawTree) return;
		const tree = this.augmentTreeWithVirtualGroups(rawTree);
		const ul = this.buildGroupUl(tree);
		ul.addClass('vaultcrypt-tree-root');
		ul.setAttribute('role', 'tree');
		this.treeContainerEl.appendChild(ul);
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

	private buildGroupUl(node: DbTreeNode): HTMLUListElement {
		const ul = document.createElement('ul');
		ul.addClass('vaultcrypt-tree-ul');
		ul.setAttribute('role', 'group');

		for (const childGroup of node.groups) {
			const li = ul.createEl('li');
			li.setAttribute('role', 'treeitem');
			const isExpanded = this.expandedPaths.has(childGroup.path);
			const caretCls = 'vaultcrypt-tree-caret' + (isExpanded ? ' vaultcrypt-tree-caret-open' : '');
			const caret = li.createEl('span', {cls: caretCls, text: childGroup.name || '(unnamed)'});
			caret.tabIndex = 0;
			caret.setAttribute('role', 'button');
			caret.setAttribute('aria-expanded', String(isExpanded));
			const nestedCls = 'vaultcrypt-tree-ul vaultcrypt-tree-nested' + (isExpanded ? ' vaultcrypt-tree-active' : '');
			const nested = li.createEl('ul', {cls: nestedCls});
			nested.setAttribute('role', 'group');

			const childUl = this.buildGroupUl(childGroup);
			for (const child of Array.from(childUl.children)) {
				nested.appendChild(child);
			}

			const toggleCaret = (e: Event) => {
				e.stopPropagation();
				const nowOpen = caret.classList.toggle('vaultcrypt-tree-caret-open');
				nested.classList.toggle('vaultcrypt-tree-active', nowOpen);
				caret.setAttribute('aria-expanded', String(nowOpen));
				if (nowOpen) this.expandedPaths.add(childGroup.path);
				else this.expandedPaths.delete(childGroup.path);
			};
			caret.addEventListener('click', toggleCaret);
			caret.addEventListener('keydown', (e: KeyboardEvent) => {
				if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCaret(e); }
			});
			li.appendChild(nested);
		}

		for (const entry of node.entries) {
			const li = ul.createEl('li', {cls: 'vaultcrypt-tree-entry', text: entry.name || '(untitled)'});
			li.tabIndex = 0;
			li.setAttribute('role', 'treeitem');
			li.addEventListener('click', () => this.selectEntry(entry.path, li));
			li.addEventListener('keydown', (e: KeyboardEvent) => {
				if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.selectEntry(entry.path, li); }
			});
		}

		const newEntryLi = ul.createEl('li', {cls: 'vaultcrypt-tree-new-entry', text: 'New entry here'});
		newEntryLi.tabIndex = 0;
		newEntryLi.setAttribute('role', 'button');
		newEntryLi.addEventListener('click', () => this.selectNewEntry(node.path, newEntryLi));
		newEntryLi.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.selectNewEntry(node.path, newEntryLi); }
		});

		const newGroupLi = ul.createEl('li', {cls: 'vaultcrypt-tree-new-entry', text: 'New group here'});
		newGroupLi.tabIndex = 0;
		newGroupLi.setAttribute('role', 'button');
		newGroupLi.addEventListener('click', (e) => {
			e.stopPropagation();
			this.startInlineGroupCreate(newGroupLi, node.path);
		});
		newGroupLi.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); this.startInlineGroupCreate(newGroupLi, node.path); }
		});

		return ul;
	}

	private startInlineGroupCreate(li: HTMLElement, parentPath: string) {
		li.empty();
		const input = li.createEl('input', {cls: 'vaultcrypt-tree-group-input'});
		input.type = 'text';
		input.placeholder = 'Group name';
		input.focus();

		const restore = () => {
			li.empty();
			li.textContent = 'New group here';
		};
		const confirm = () => {
			const name = input.value.trim();
			if (name && VALID_PATH_SEGMENT.test(name)) this.addVirtualGroup(parentPath, name);
			else if (name) { new Notice('Group name can only contain letters, digits, hyphens, and underscores'); restore(); }
			else restore();
		};
		input.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter') { e.stopPropagation(); confirm(); }
			if (e.key === 'Escape') { e.stopPropagation(); restore(); }
		});
		// defer blur so Enter/Escape fire first
		input.addEventListener('blur', () => window.setTimeout(confirm, 100));
	}

	private addVirtualGroup(parentPath: string, name: string) {
		const fullPath = parentPath ? `${parentPath}/${name}` : name;
		this.virtualGroupPaths.add(fullPath);
		this.expandedPaths.add(fullPath);
		if (parentPath) this.expandedPaths.add(parentPath);
		this.renderTree();
	}

	private clearTreeSelections() {
		this.treeContainerEl.querySelectorAll<HTMLElement>('.is-active').forEach(el => el.removeClass('is-active'));
	}

	private selectEntry(entryPath: string, clickedEl: HTMLElement) {
		this.clearTreeSelections();
		clickedEl.addClass('is-active');
		this.selectedEntryPath = entryPath;
		this.newEntryGroupPath = null;
		this.entryFieldsSectionEl.addClass('vaultcrypt-hidden');
		this.refreshFieldDropdown();
		this.updateInsertButtonState();
	}

	private selectNewEntry(groupPath: string, clickedEl: HTMLElement) {
		this.clearTreeSelections();
		clickedEl.addClass('is-active');
		this.newEntryGroupPath = groupPath;
		this.selectedEntryPath = null;
		this.entryFieldsSectionEl.removeClass('vaultcrypt-hidden');
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
					// Only offer fields that have a non-empty value
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
		for (const stop of this.effects) stop();
		this.stopLockEffect?.();
		this.contentEl.empty();
	}
}
