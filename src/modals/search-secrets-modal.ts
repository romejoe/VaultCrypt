import {App, Editor, FuzzyMatch, FuzzySuggestModal} from 'obsidian';
import type VaultCryptPlugin from '../main';
import type {DbTreeNode} from '../unlock-session';
import {VALID_TOKEN_SEGMENT} from '../inline-parser';

interface SearchItem {
	profileId: string;
	profileName: string;
	entryPath: string;
	/** null → uses profile's default field; otherwise a specific field reference. */
	fieldName: string | null;
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
			const displayFields = fieldNames.filter(f => f !== 'Title');

			// Entry-level item (uses the profile's default field)
			items.push({profileId, profileName, entryPath: entry.path, fieldName: null});

			// One item per non-Title, token-safe field
			for (const field of displayFields) {
				if (!VALID_TOKEN_SEGMENT.test(field)) continue;
				items.push({profileId, profileName, entryPath: entry.path, fieldName: field});
			}
		}
		for (const group of node.groups) {
			this.flattenTree(group, profileId, profileName, items);
		}
	}

	getItemText(item: SearchItem): string {
		const suffix = item.fieldName ? `#${item.fieldName}` : '';
		return `${item.profileName} ${item.entryPath}${suffix}`;
	}

	renderSuggestion(match: FuzzyMatch<SearchItem>, el: HTMLElement): void {
		const {profileName, entryPath, fieldName} = match.item;
		const suffix = fieldName ? `#${fieldName}` : '';

		el.createDiv({cls: 'vc-search-path', text: `${entryPath}${suffix}`});

		const metaEl = el.createDiv({cls: 'vc-search-meta'});
		metaEl.createSpan({cls: 'vc-search-profile', text: profileName});
	}

	onChooseItem(item: SearchItem): void {
		const fieldSuffix = item.fieldName ? `#${item.fieldName}` : '';

		// If }} already follows the cursor, omit them from the inserted token.
		const cursor = this.editor.getCursor();
		const lineText = this.editor.getLine(cursor.line);
		const hasClosingBraces = lineText.slice(cursor.ch).startsWith('}}');
		const closing = hasClosingBraces ? '' : '}}';

		const token = `{{vc:${item.profileId}/${item.entryPath}${fieldSuffix}${closing}`;
		this.editor.replaceSelection(token);
	}
}
