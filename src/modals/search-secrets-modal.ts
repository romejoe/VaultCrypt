import {App, Editor, FuzzyMatch, FuzzySuggestModal} from 'obsidian';
import type VaultCryptPlugin from '../main';
import type {DbTreeNode} from '../unlock-session';

interface SearchItem {
	profileId: string;
	profileName: string;
	entryPath: string;
	fieldNames: string[];
}

export class SearchSecretsModal extends FuzzySuggestModal<SearchItem> {
	constructor(
		app: App,
		private readonly plugin: VaultCryptPlugin,
		private readonly editor: Editor,
	) {
		super(app);
		this.setPlaceholder('Search entries across unlocked profiles…');
	}

	getItems(): SearchItem[] {
		const items: SearchItem[] = [];
		const unlockedProfiles = this.plugin.vaultCryptState.profiles.filter(p => !p.isLocked);
		for (const profile of unlockedProfiles) {
			const tree = this.plugin.sessionService.getEntryTree(profile.id);
			if (!tree) continue;
			this.flattenTree(tree, profile.id, profile.name, items);
		}
		return items;
	}

	private flattenTree(node: DbTreeNode, profileId: string, profileName: string, items: SearchItem[]): void {
		for (const entry of node.entries) {
			const fieldNames = this.plugin.sessionService.getEntryFieldNames(profileId, entry.path) ?? [];
			items.push({profileId, profileName, entryPath: entry.path, fieldNames});
		}
		for (const group of node.groups) {
			this.flattenTree(group, profileId, profileName, items);
		}
	}

	getItemText(item: SearchItem): string {
		const displayFields = item.fieldNames.filter(f => f !== 'Title');
		return `${item.profileName} ${item.entryPath} ${displayFields.join(' ')}`;
	}

	renderSuggestion(match: FuzzyMatch<SearchItem>, el: HTMLElement): void {
		const {profileName, entryPath, fieldNames} = match.item;
		const entryName = entryPath.split('/').pop() ?? entryPath;
		const displayFields = fieldNames.filter(f => f !== 'Title');

		el.createDiv({cls: 'vc-search-title', text: entryName});
		el.createDiv({cls: 'vc-search-path', text: entryPath});

		const metaEl = el.createDiv({cls: 'vc-search-meta'});
		metaEl.createSpan({cls: 'vc-search-profile', text: profileName});
		if (displayFields.length > 0) {
			metaEl.createSpan({cls: 'vc-search-fields', text: displayFields.join(', ')});
		}
	}

	onChooseItem(item: SearchItem): void {
		const token = `{{vc:${item.profileId}/${item.entryPath}}}`;
		this.editor.replaceSelection(token);
	}
}
