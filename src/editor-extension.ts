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

function flattenTreeToCompletions(node: DbTreeNode, profileId: string, profileName: string, out: Completion[]): void {
	for (const entry of node.entries) {
		out.push({
			label: `{{vc:${profileId}/${entry.path}}}`,
			displayLabel: entry.path,
			detail: profileName,
			type: 'variable',
		});
	}
	for (const group of node.groups) {
		flattenTreeToCompletions(group, profileId, profileName, out);
	}
}

function vcCompletionSource(plugin: VaultCryptPlugin) {
	return (context: CompletionContext): CompletionResult | null => {
		const before = context.matchBefore(/\{\{vc:[a-zA-Z0-9_\-/]*/);
		if (!before || (before.from === before.to && !context.explicit)) return null;

		const options: Completion[] = [];
		const unlockedProfiles = plugin.vaultCryptState.profiles.filter(p => !p.isLocked);
		for (const profile of unlockedProfiles) {
			const tree = plugin.sessionService.getEntryTree(profile.id);
			if (!tree) continue;
			flattenTreeToCompletions(tree, profile.id, profile.name, options);
		}

		if (options.length === 0) return null;

		return {
			from: before.from,
			options,
			validFor: /^\{\{vc:[a-zA-Z0-9_\-/]*/,
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

	return [viewPlugin, copyHandler, autocompletion({override: [vcCompletionSource(plugin)]})];
}
