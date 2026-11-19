import {MarkdownRenderChild} from 'obsidian';
import {computed, effect, untrack} from '@maverick-js/signals';
import type VaultCryptPlugin from './main';
import type {ParsedVcToken} from './inline-parser';
import {buildChipElement, CHIP_DESTROY_EVENT} from './chip-component';
import {getEntryTableFields} from './entry-table';
import {LIVE_TABLE_LANGUAGE, parseLiveTableReference} from './live-table-reference';
import {EditSecretModal} from './modals/edit-secret-modal';
import {UnlockModal} from './modals/unlock-modal';

export function registerLiveEntryTables(plugin: VaultCryptPlugin): void {
	const tables = new Set<LiveEntryTable>();
	plugin.registerMarkdownCodeBlockProcessor(LIVE_TABLE_LANGUAGE, (source, el, ctx) => {
		const token = parseLiveTableReference(source);
		if (!token) {
			el.createEl('p', {text: 'Invalid VaultCrypt entry reference. Use profile/group/entry.'});
			return;
		}
		const table = new LiveEntryTable(el, plugin, token);
		tables.add(table);
		table.register(() => tables.delete(table));
		ctx.addChild(table);
	});
	plugin.register(() => {
		for (const table of tables) table.unload();
	});
}

class LiveEntryTable extends MarkdownRenderChild {
	private body!: HTMLTableSectionElement;
	private readonly rows = new Map<string, {row: HTMLTableRowElement; chip: HTMLElement}>();

	constructor(el: HTMLElement, private readonly plugin: VaultCryptPlugin, private readonly token: ParsedVcToken) {
		super(el);
	}

	onload(): void {
		const {containerEl, plugin, token} = this;
		const profileId = token.profileId.toLowerCase();
		const {entryPath} = token;
		const contents = containerEl.createDiv({cls: 'vaultcrypt-live-table'});
		const message = contents.createEl('p', {attr: {role: 'status'}});
		const unlock = contents.createEl('button', {text: 'Unlock profile'});
		const edit = contents.createEl('button', {text: 'Edit entry'});
		for (const button of [unlock, edit]) {
			this.registerDomEvent(button, 'pointerdown', event => event.stopPropagation());
		}
		this.registerDomEvent(unlock, 'click', event => {
			event.stopPropagation();
			new UnlockModal(plugin.app, plugin, profileId).open();
		});
		this.registerDomEvent(edit, 'click', event => {
			event.stopPropagation();
			new EditSecretModal(plugin.app, plugin, profileId, entryPath, token, {sourceReference: false}).open();
		});

		const table = contents.createEl('table');
		const header = table.createEl('thead').createEl('tr');
		header.createEl('th', {text: 'Field', attr: {scope: 'col'}});
		header.createEl('th', {text: 'Value', attr: {scope: 'col'}});
		this.body = table.createEl('tbody');

		const configured = computed(() => Object.prototype.hasOwnProperty.call(plugin.settings$().profiles, profileId));
		const session = plugin.sessionService;
		this.register(effect(() => {
			const knownProfile = configured();
			const names = knownProfile ? session.getEntryNames(profileId, entryPath) : null;
			const unlocked = knownProfile && session.isUnlocked(profileId);
			const fields = names ? getEntryTableFields(names.fields, names.attachments) : [];

			unlock.hidden = !knownProfile || unlocked;
			edit.hidden = !unlocked;
			edit.setText(names ? 'Edit entry' : 'Create entry');
			table.hidden = fields.length === 0;
			message.hidden = fields.length > 0;
			message.setText(!knownProfile ? 'Profile not found.'
				: !unlocked ? 'This profile is locked.'
					: !names ? 'Entry not found.'
						: fields.length === 0 ? 'This entry has no referenceable fields or attachments.' : '');
			// Each retained row owns its chip effects across table refreshes.
			untrack(() => this.updateRows(fields));
		}));
	}

	private updateRows(fields: readonly string[]): void {
		const current = new Set(fields);
		for (const [name, {row, chip}] of this.rows) {
			if (current.has(name)) continue;
			chip.dispatchEvent(new CustomEvent(CHIP_DESTROY_EVENT));
			row.remove();
			this.rows.delete(name);
		}

		let next = this.body.firstElementChild;
		for (const fieldName of fields) {
			let item = this.rows.get(fieldName);
			if (!item) {
				const {profileId, entryPath} = this.token;
				const raw = `{{vc:${profileId}/${entryPath}#${fieldName}}}`;
				const token = {profileId, entryPath, fieldName, raw, from: 0, to: raw.length};
				const chip = buildChipElement(token, this.plugin, {sourceReference: false});
				const row = this.body.ownerDocument.createElement('tr');
				row.createEl('td', {text: fieldName});
				row.createEl('td').appendChild(chip);
				item = {row, chip};
				this.rows.set(fieldName, item);
			}
			if (item.row === next) {
				next = next.nextElementSibling;
			} else {
				this.body.insertBefore(item.row, next);
			}
		}
	}

	onunload(): void {
		this.updateRows([]);
		this.containerEl.empty();
	}
}
