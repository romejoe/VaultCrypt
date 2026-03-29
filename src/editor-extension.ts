import {editorLivePreviewField} from 'obsidian';
import {Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType} from '@codemirror/view';
import {Extension, RangeSetBuilder, StateEffect} from '@codemirror/state';
import {autocompletion, Completion, CompletionContext, CompletionResult} from '@codemirror/autocomplete';
import {parseVcTokens, ParsedVcToken} from './inline-parser';
import {buildChipElement, CHIP_DESTROY_EVENT} from './chip-component';
import {buildCopyTextFromEditorSelection} from './clipboard-intercept';
import type VaultCryptPlugin from './main';
import type {DbTreeNode} from './unlock-session';

/** Dispatching this effect on an EditorView forces chip decorations to rebuild. */
export const refreshChipsEffect = StateEffect.define<void>();
export type VcTokenEvent = { type: 'profile-lock', profileId: string };

class VcTokenWidget extends WidgetType {
	private readonly el: HTMLElement;

	constructor(
		private readonly token: ParsedVcToken,
		private readonly plugin: VaultCryptPlugin,
	) {
		super();
		this.el = buildChipElement(this.token, this.plugin);
	}

	toDOM(): HTMLElement {
		return this.el;
	}

	eq(other: VcTokenWidget): boolean {
		return this.token.raw === other.token.raw && this.plugin.sessionService === other.plugin.sessionService;
	}

	/** Return true so that CodeMirror doesn't steal click events for cursor placement. */
	ignoreEvent(): boolean {
		return true;
	}

	destroy(dom: HTMLElement): void {
		const event = new CustomEvent(CHIP_DESTROY_EVENT);
		dom.dispatchEvent(event);
	}
}

function buildDecorations(view: EditorView, plugin: VaultCryptPlugin): DecorationSet {
	const isLivePreview = view.state.field(editorLivePreviewField, false) ?? false;
	const builder = new RangeSetBuilder<Decoration>();
	const cursorPos = view.state.selection.main.head;

	for (const {from, to} of view.visibleRanges) {
		const text = view.state.doc.sliceString(from, to);
		const tokens = parseVcTokens(text);

		for (const token of tokens) {
			const absFrom = from + token.from;
			const absTo = from + token.to;
			const tokenSelected = cursorPos >= absFrom && cursorPos <= absTo;
			if (tokenSelected) continue;

			if (isLivePreview) {
				builder.add(
					absFrom,
					absTo,
					Decoration.replace({widget: new VcTokenWidget(token, plugin)}),
				);
			} else {
				builder.add(
					absFrom,
					absTo,
					Decoration.mark({class: 'vaultcrypt-token'}),
				);
			}
		}
	}

	return builder.finish();
}

function flattenTreeToCompletions(
	node: DbTreeNode, profileId: string, profileName: string,
	plugin: VaultCryptPlugin, out: Completion[],
): void {
	for (const entry of node.entries) {
		// Entry-level completion (uses the profile's default field)
		out.push({
			label: `{{vc:${profileId}/${entry.path}}}`,
			displayLabel: `${profileName}/${entry.path}`,
			type: 'variable',
		});

		// Field-level completions
		const fieldNames = plugin.sessionService.getEntryFieldNames(profileId, entry.path);
		if (fieldNames) {
			for (const field of fieldNames) {
				if (field === 'Title') continue;
				out.push({
					label: `{{vc:${profileId}/${entry.path}#${field}}}`,
					displayLabel: `${profileName}/${entry.path}#${field}`,
					type: 'property',
				});
			}
		}
	}
	for (const group of node.groups) {
		flattenTreeToCompletions(group, profileId, profileName, plugin, out);
	}
}

function vcCompletionSource(plugin: VaultCryptPlugin) {
	return (context: CompletionContext): CompletionResult | null => {
		const before = context.matchBefore(/\{\{vc:[a-zA-Z0-9_\-/]*(?:#[a-zA-Z0-9_-]*)?\w*/);
		if (!before || (before.from === before.to && !context.explicit)) return null;

		let options: Completion[] = [];
		const unlockedProfiles = plugin.vaultCryptState.profiles.filter(p => !p.isLocked);
		for (const profile of unlockedProfiles) {
			const tree = plugin.sessionService.getEntryTree(profile.id);
			if (!tree) continue;
			const profileOptions:Completion[] = [];
			flattenTreeToCompletions(tree, profile.id, profile.name, plugin, profileOptions);
			options.push(...profileOptions.filter(o => o.label.startsWith(before.text)));
		}

		if (options.length === 0) return null;

		options = options.sort((a, b) => (a.displayLabel ?? "").localeCompare(b.displayLabel ?? ""));

		// If }} already exists after the cursor, extend the replacement range to
		// cover them so we don't end up with duplicate closing braces.
		const afterCursor = context.state.doc.sliceString(context.pos, context.pos + 2);
		const to = afterCursor === '}}' ? context.pos + 2 : undefined;

		return {
			filter: false,
			from: before.from,
			to,
			options,
		};
	};
}

export function buildEditorExtension(plugin: VaultCryptPlugin): Extension {
	const viewPlugin = ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;

			constructor(view: EditorView) {
				this.decorations = buildDecorations(view, plugin);
			}

			update(update: ViewUpdate) {
				const hasRefreshEffect = update.transactions.some(tr =>
					tr.effects.some(e => e.is(refreshChipsEffect))
				);
				if (update.docChanged || update.viewportChanged || update.selectionSet || hasRefreshEffect) {
					this.decorations = buildDecorations(update.view, plugin);
				}
			}
		},
		{decorations: v => v.decorations},
	);

	const copyHandler = EditorView.domEventHandlers({
		copy(event: ClipboardEvent, view: EditorView) {
			const copyText = buildCopyTextFromEditorSelection(view, plugin);
			if (copyText === null) return false;

			event.clipboardData?.setData('text/plain', copyText);
			event.preventDefault();
			return true;
		},
	});

	return [viewPlugin, copyHandler, autocompletion({
		filterStrict: true,
		override: [vcCompletionSource(plugin)]
	})];
}
