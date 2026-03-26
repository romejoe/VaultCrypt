import {editorLivePreviewField} from 'obsidian';
import {Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType} from '@codemirror/view';
import {Extension, RangeSetBuilder} from '@codemirror/state';
import {parseVcTokens, ParsedVcToken, resolveFieldName} from './inline-parser';
import type VaultCryptPlugin from './main';

class VcTokenWidget extends WidgetType {
	constructor(
		private readonly label: string,
		private readonly isValid: boolean,
	) {
		super();
	}

	toDOM(): HTMLElement {
		const span = document.createElement('span');
		span.className = this.isValid
			? 'vaultcrypt-chip'
			: 'vaultcrypt-chip vaultcrypt-chip-error';
		span.textContent = this.label;
		return span;
	}

	eq(other: VcTokenWidget): boolean {
		return this.label === other.label && this.isValid === other.isValid;
	}

	ignoreEvent(): boolean {
		return true;
	}
}

function buildLabel(token: ParsedVcToken, plugin: VaultCryptPlugin): { label: string; isValid: boolean } {
	const profileConfig = plugin.settings.profiles[token.profileId.toLowerCase()];
	if (!profileConfig) {
		return {label: `⚠ unknown profile: ${token.profileId}`, isValid: false};
	}
	const field = resolveFieldName(token, profileConfig.defaultField);
	return {label: `🔒 ${token.profileId}/${token.entryPath}/${field}`, isValid: true};
}

function buildDecorations(view: EditorView, plugin: VaultCryptPlugin): DecorationSet {
	const isLivePreview = view.state.field(editorLivePreviewField, false) ?? false;
	const builder = new RangeSetBuilder<Decoration>();

	for (const {from, to} of view.visibleRanges) {
		const text = view.state.doc.sliceString(from, to);
		const tokens = parseVcTokens(text);

		for (const token of tokens) {
			const absFrom = from + token.from;
			const absTo = from + token.to;

			if (isLivePreview) {
				const {label, isValid} = buildLabel(token, plugin);
				builder.add(
					absFrom,
					absTo,
					Decoration.replace({widget: new VcTokenWidget(label, isValid)}),
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

export function buildEditorExtension(plugin: VaultCryptPlugin): Extension {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;

			constructor(view: EditorView) {
				this.decorations = buildDecorations(view, plugin);
			}

			update(update: ViewUpdate) {
				if (update.docChanged || update.viewportChanged || update.selectionSet) {
					this.decorations = buildDecorations(update.view, plugin);
				}
			}
		},
		{decorations: v => v.decorations},
	);
}
