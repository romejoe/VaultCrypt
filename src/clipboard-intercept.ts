import {VC_TOKEN_REGEX, parseVcTokens} from './inline-parser';
import type VaultCryptPlugin from './main';
import type {EditorView} from '@codemirror/view';

const PARAGRAPH_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'BLOCKQUOTE', 'TABLE']);
const LINE_TAGS = new Set(['DIV', 'LI', 'UL', 'OL', 'TR']);
const TABLE_TAGS = new Set(['TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR']);
const CELL_TAGS = new Set(['TD', 'TH']);
type CopyPiece = {text: string; boundary?: boolean};

function isLayoutNode(node: Node | null): boolean {
	if (node?.nodeType !== Node.ELEMENT_NODE) return false;
	const tag = (node as Element).tagName;
	return PARAGRAPH_TAGS.has(tag) || LINE_TAGS.has(tag) || TABLE_TAGS.has(tag) || CELL_TAGS.has(tag);
}

/**
 * Builds a clipboard-safe string from the current browser selection by
 * replacing VaultCrypt chip elements with their appropriate copy text
 * (plaintext when revealed, placeholder otherwise).
 *
 * Used for reading mode where chips are standard DOM elements.
 * Returns `null` when the selection contains no VaultCrypt chips,
 * signalling the caller should let the default copy behaviour proceed.
 */
export function buildCopyTextFromSelection(
	selection: Selection,
	plugin: VaultCryptPlugin,
): string | null {
	if (selection.rangeCount === 0) return null;

	let containsChip = false;
	let result = '';

	for (let i = 0; i < selection.rangeCount; i++) {
		const range = selection.getRangeAt(i);
		const fragment = range.cloneContents();
		const pieces: CopyPiece[] = [];
		walkNode(fragment, pieces);
		// Drop only structural edges, preserving newlines inside secret values.
		if (pieces[0]?.boundary) pieces.shift();
		if (pieces[pieces.length - 1]?.boundary) pieces.pop();
		result += pieces.map(piece => piece.text).join('');
	}

	if (!containsChip) return null;
	return result;

	// ── recursive walk ──────────────────────────────────────────────────

	function boundary(pieces: CopyPiece[], text: string): void {
		const last = pieces[pieces.length - 1];
		if (last?.boundary) {
			if (text.length > last.text.length) last.text = text;
		} else {
			pieces.push({text, boundary: true});
		}
	}

	function walkNode(node: Node, pieces: CopyPiece[]): void {
		// Text node — include content, with safety-net replacement of raw tokens
		if (node.nodeType === Node.TEXT_NODE) {
			const text = node.textContent ?? '';
			const re = new RegExp(VC_TOKEN_REGEX.source, 'g');
			if (re.test(text)) containsChip = true;
			pieces.push({text});
			return;
		}

		// Element node
		if (node.nodeType === Node.ELEMENT_NODE) {
			const el = node as HTMLElement;

			// VaultCrypt chip — use stored copy text, skip children
			if (el.dataset.vcChip !== undefined) {
				containsChip = true;
				pieces.push({text: el.dataset.vcCopyText ?? '[encrypted]'});
				return;
			}
			if (el.tagName === 'BR') {
				pieces.push({text: '\n'});
				return;
			}
		}

		const tag = node.nodeType === Node.ELEMENT_NODE ? (node as Element).tagName : '';
		const separator = PARAGRAPH_TAGS.has(tag) ? '\n\n' : LINE_TAGS.has(tag) ? '\n' : '';
		if (separator) boundary(pieces, separator);
		let previousCell = false;
		for (let j = 0; j < node.childNodes.length; j++) {
			const child = node.childNodes[j]!;
			// Formatting whitespace between blocks isn't a rendered line break.
			if (child.nodeType === Node.TEXT_NODE && !child.textContent?.trim()
				&& (TABLE_TAGS.has(tag) || (!child.parentElement?.closest('pre')
					&& (isLayoutNode(child.previousSibling) || isLayoutNode(child.nextSibling))))) continue;
			const cell = child.nodeType === Node.ELEMENT_NODE && CELL_TAGS.has((child as Element).tagName);
			if (previousCell && cell) pieces.push({text: '\t'});
			walkNode(child, pieces);
			previousCell = cell;
		}
		if (separator) boundary(pieces, separator);
	}
}

/**
 * Builds a clipboard-safe string from a CM6 editor view's selection by
 * parsing the document text for vc tokens and replacing each with the
 * appropriate copy text from the chip widget's DOM element.
 *
 * Returns `null` when the selection contains no VaultCrypt tokens.
 */
export function buildCopyTextFromEditorSelection(
	view: EditorView,
	plugin: VaultCryptPlugin,
): string | null {
	const {state} = view;
	const ranges = state.selection.ranges;

	let hasToken = false;
	const parts: string[] = [];

	for (const range of ranges) {
		if (range.empty) continue;
		const text = state.sliceDoc(range.from, range.to);
		const tokens = parseVcTokens(text);

		if (tokens.length === 0) {
			parts.push(text);
			continue;
		}

		hasToken = true;
		let cursor = 0;
		let result = '';

		for (const token of tokens) {
			result += text.slice(cursor, token.from);

			// Try to find the chip widget element in the editor DOM
			const absFrom = range.from + token.from;
			const chipEl = findChipAtPos(view, absFrom);
			if (chipEl) {
				result += chipEl.dataset.vcCopyText ?? '[encrypted]';
			} else {
				// Token is visible as raw text (e.g. cursor inside it) — copy it literally
				result += token.raw;
			}

			cursor = token.to;
		}

		result += text.slice(cursor);
		parts.push(result);
	}

	if (!hasToken) return null;
	return parts.join(state.lineBreak);
}

/**
 * Locates the chip widget DOM element rendered at a given document position.
 */
function findChipAtPos(view: EditorView, pos: number): HTMLElement | null {
	try {
		const domPos = view.domAtPos(pos);
		const node = domPos.node;
		const el = node instanceof HTMLElement ? node : node.parentElement;
		if (!el) return null;
		return el.closest<HTMLElement>('[data-vc-chip]') ??
			el.querySelector<HTMLElement>('[data-vc-chip]') ??
			null;
	} catch {
		return null;
	}
}

