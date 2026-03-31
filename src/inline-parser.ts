export const VC_TOKEN_REGEX = /\{\{vc:([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_\-/]+?)(?:#([a-zA-Z0-9_\-.:]+))?}}/g;

/** Matches a single valid token segment (profile id, path part, or field name). */
export const VALID_TOKEN_SEGMENT = /^[a-zA-Z0-9_\-.:]+$/;

export interface ParsedVcToken {
	raw: string;
	profileId: string;
	entryPath: string;
	fieldName: string | null;
	from: number;
	to: number;
}

export function parseVcTokens(text: string): ParsedVcToken[] {
	const tokens: ParsedVcToken[] = [];
	const re = new RegExp(VC_TOKEN_REGEX.source, 'g');
	let match: RegExpExecArray | null;
	while ((match = re.exec(text)) !== null) {
		tokens.push({
			raw: match[0],
			profileId: match[1]!,
			entryPath: match[2]!,
			fieldName: match[3] ?? null,
			from: match.index,
			to: match.index + match[0].length,
		});
	}
	return tokens;
}

export function resolveFieldName(token: ParsedVcToken, defaultField: string): string {
	return token.fieldName ?? defaultField;
}

/**
 * Walks all text nodes in `el`, finds `{{vc:...}}` tokens, and replaces each
 * with an inline chip span produced by `buildChip`. The underlying markdown is
 * never modified.
 */
export function processVcTokensInDom(
	el: HTMLElement,
	buildChip: (token: ParsedVcToken) => HTMLElement,
): void {
	const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
	const textNodes: Text[] = [];
	let node: Node | null;
	while ((node = walker.nextNode()) !== null) {
		textNodes.push(node as Text);
	}

	for (const textNode of textNodes) {
		const text = textNode.nodeValue ?? '';
		const tokens = parseVcTokens(text);
		if (tokens.length === 0) continue;

		const parent = textNode.parentNode;
		if (!parent) continue;

		const fragment = document.createDocumentFragment();
		let cursor = 0;

		for (const token of tokens) {
			if (token.from > cursor) {
				fragment.appendChild(document.createTextNode(text.slice(cursor, token.from)));
			}
			fragment.appendChild(buildChip(token));
			cursor = token.to;
		}

		if (cursor < text.length) {
			fragment.appendChild(document.createTextNode(text.slice(cursor)));
		}

		parent.replaceChild(fragment, textNode);
	}
}
