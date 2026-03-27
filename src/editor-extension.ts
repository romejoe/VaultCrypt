import {editorLivePreviewField} from 'obsidian';
import {Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType} from '@codemirror/view';
import {Extension, RangeSetBuilder, StateEffect} from '@codemirror/state';
import {parseVcTokens, ParsedVcToken} from './inline-parser';
import {buildChipElement, CHIP_DESTROY_EVENT} from './chip-component';
import type VaultCryptPlugin from './main';

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

export function buildEditorExtension(plugin: VaultCryptPlugin): Extension {
	return ViewPlugin.fromClass(
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
}
