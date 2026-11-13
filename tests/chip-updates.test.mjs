import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {build} from 'esbuild';

// Exercise the real session, signals and chip templates with an in-memory KDBX.
// Only Obsidian and DOM/template plumbing are replaced; no vault files are used.
const require = createRequire(import.meta.url);
const kdbxPath = require.resolve('kdbxweb');
const mocks = {
	obsidian: `
		export class TFile {}
		export class TFolder {}
		export class Notice {}
		export class Menu {}
		export const Platform = {isDesktop: false};
		export const editorLivePreviewField = Symbol();
	`,
	'@codemirror/view': `
		export class WidgetType {}
		export const Decoration = {replace: value => value};
		export const EditorView = {domEventHandlers: () => []};
		export const ViewPlugin = {fromClass: value => value};
	`,
	'@codemirror/state': `
		export class RangeSetBuilder {
			values = [];
			add(from, to, value) { this.values.push(value); }
			finish() { return this.values; }
		}
		export const StateEffect = {define() {
			const type = {of: () => ({is: other => other === type})};
			return type;
		}};
	`,
	'@codemirror/autocomplete': 'export const autocompletion = () => [];',
	'./modals': 'export class UnlockModal {} export class EditSecretModal {} export class DeleteSecretModal {}',
	'./attachment-chip': 'export const ATTACHMENT_PREFIX = "@"; export function buildAttachmentChipElement() {}',
	'lit-html': `
		export const nothing = '';
		export function html(strings, ...values) { return {strings, values}; }
		export function render(template, root) {
			root.template = template;
			root.renders = (root.renders ?? 0) + 1;
			for (const value of template.values) {
				if (value?.reference) {
					value.reference.value = {value: '', focus() {}, select() {}};
				}
			}
		}
	`,
	'lit-html/directives/ref.js': 'export const createRef = () => ({}); export const ref = reference => ({reference});',
};
const {outputFiles} = await build({
	stdin: {
		sourcefile: 'chip-test-runtime.mjs',
		contents: `
			export {UnlockSessionService} from './src/unlock-session.ts';
			export {buildChipElement, CHIP_DESTROY_EVENT} from './src/chip-component.ts';
			export {parseVcTokens} from './src/inline-parser.ts';
			export {buildEditorExtension, refreshChipsEffect} from './src/editor-extension.ts';
			export {signal, tick} from '@maverick-js/signals';
			export {TFile} from 'obsidian';
			import kdbxweb from 'kdbxweb';
			export const {Kdbx, KdbxCredentials, ProtectedValue} = kdbxweb;
		`,
		resolveDir: process.cwd(),
	},
	bundle: true,
	write: false,
	format: 'cjs',
	platform: 'node',
	plugins: [{
		name: 'chip-test-runtime',
		setup(builder) {
			builder.onResolve({filter: /^kdbxweb$/}, () => ({path: kdbxPath, external: true}));
			builder.onResolve({filter: /.*/}, args => args.path in mocks
				? {path: args.path, namespace: 'test'} : undefined);
			builder.onLoad({filter: /.*/, namespace: 'test'}, args => ({contents: mocks[args.path]}));
		},
	}],
});
const module = {exports: {}};
new Function('require', 'module', 'exports', outputFiles[0].text)(require, module, module.exports);
const {UnlockSessionService, buildChipElement, CHIP_DESTROY_EVENT, parseVcTokens, buildEditorExtension, refreshChipsEffect,
	signal, tick, TFile, Kdbx, KdbxCredentials, ProtectedValue} = module.exports;

globalThis.document = {
	created: 0,
	createElement() {
		this.created++;
		return Object.assign(new EventTarget(), {dataset: {}, className: ''});
	},
};
globalThis.requestAnimationFrame = () => 0;

function templateText(template) {
	if (typeof template === 'string') return template;
	if (!template?.strings) return '';
	return template.strings.map((part, i) => part + templateText(template.values[i])).join('');
}

function handler(template, precedingText) {
	for (let i = 0; i < template.values.length; i++) {
		const value = template.values[i];
		if (typeof value === 'function' && template.strings[i].includes(precedingText)) return value;
		if (value?.strings) {
			const nested = handler(value, precedingText);
			if (nested) return nested;
		}
	}
	return undefined;
}

function click(root, precedingText) {
	const callback = handler(root.template, precedingText);
	assert.ok(callback, `Missing handler: ${precedingText}`);
	callback({stopPropagation() {}});
	tick();
}

async function fixture(t, {autoUnmask = true, write = async () => {}} = {}) {
	const db = Kdbx.create(new KdbxCredentials(ProtectedValue.fromString('test')), 'test');
	t.mock.method(Kdbx, 'load', async () => db);
	t.mock.method(db, 'save', async () => new ArrayBuffer(0));
	const app = {vault: {
		getAbstractFileByPath: () => new TFile(),
		readBinary: async () => new ArrayBuffer(0),
		modifyBinary: () => write(),
	}};
	const service = new UnlockSessionService(app);
	const config = {path: 'test.kdbx', defaultField: 'Password', autoLockMinutes: 0};
	await service.unlockProfile('test', config, 'test');
	await service.createEntryWithFields('test', 'Entry', {Password: 'before', Notes: 'old notes'}, config.path);
	const state = signal({profiles: [{id: 'test', isLocked: false}, {id: 'locked', isLocked: true}]});
	const plugin = {
		app, sessionService: service,
		settings$: signal({profiles: {test: config, locked: config}, general: {autoUnmask, compactChips: false}}),
		vaultCryptState$: state,
	};
	const chips = [];
	const chip = (raw = '{{vc:test/Entry}}') => {
		const root = buildChipElement(parseVcTokens(raw)[0], plugin);
		chips.push(root);
		tick();
		return root;
	};
	t.after(() => {
		for (const root of chips) root.dispatchEvent(new Event(CHIP_DESTROY_EVENT));
	});
	return {service, chip, state, plugin};
}

test('entry edits update every revealed reference, its display and selection-copy value', async t => {
	const {service, chip} = await fixture(t);
	const first = chip();
	const duplicate = chip('{{vc:test/Entry#Password}}');
	const notes = chip('{{vc:test/Entry#Notes}}');
	const locked = chip('{{vc:locked/Entry}}');
	await service.updateEntryFields('test', 'Entry', {Password: 'after', Notes: 'new notes'}, 'test.kdbx');
	tick();
	for (const root of [first, duplicate]) {
		assert.equal(root.dataset.vcCopyText, 'after');
		assert.ok(templateText(root.template).includes('after'));
		assert.equal(root.className, 'vaultcrypt-chip vaultcrypt-chip-revealed');
	}
	assert.equal(notes.dataset.vcCopyText, 'new notes');
	assert.equal(locked.dataset.vcCopyText, '[locked]');
});

test('single-field edits refresh truncation, tooltip and full selection-copy text', async t => {
	const {service, chip} = await fixture(t);
	const root = chip();
	const value = 'a'.repeat(45) + '\nsecond line';
	await service.setFieldValue('test', 'Entry', 'Password', value, 'test.kdbx');
	tick();
	assert.equal(root.dataset.vcCopyText, value);
	assert.ok(root.template.values.includes('a'.repeat(40) + '…'));
	assert.ok(root.template.values.includes(value));
});

test('a masked reference stays masked until the user reveals its updated value', async t => {
	const {service, chip} = await fixture(t, {autoUnmask: false});
	const root = chip();
	await service.setFieldValue('test', 'Entry', 'Password', 'after', 'test.kdbx');
	tick();
	assert.equal(root.dataset.vcCopyText, '[encrypted]');
	assert.equal(root.className, 'vaultcrypt-chip vaultcrypt-chip-masked');
	click(root, 'vaultcrypt-chip-icon-locked');
	assert.equal(root.dataset.vcCopyText, 'after');
});

test('removed fields clear stale plaintext and recover when restored', async t => {
	const {service, chip} = await fixture(t);
	const root = chip();
	await service.updateEntryFields('test', 'Entry', {Notes: 'only notes'}, 'test.kdbx');
	tick();
	assert.equal(root.className, 'vaultcrypt-chip vaultcrypt-chip-masked-error');
	assert.equal(root.dataset.vcCopyText, '[encrypted]');
	await service.setFieldValue('test', 'Entry', 'Password', 'restored', 'test.kdbx');
	tick();
	assert.equal(root.dataset.vcCopyText, 'restored');
});

test('deleting and recreating an entry updates existing chips', async t => {
	const {service, chip} = await fixture(t);
	const root = chip();
	await service.deleteEntry('test', 'Entry', 'test.kdbx');
	tick();
	assert.equal(root.dataset.vcCopyText, '[encrypted]');
	await service.createEntryWithFields('test', 'Entry', {Password: 'recreated'}, 'test.kdbx');
	tick();
	assert.equal(root.dataset.vcCopyText, 'recreated');
});

test('updates leave an active inline editor intact and cancel reads the latest value', async t => {
	const {service, chip} = await fixture(t);
	const root = chip();
	click(root, 'title="Edit"');
	const editingTemplate = root.template;
	await service.setFieldValue('test', 'Entry', 'Password', 'updated elsewhere', 'test.kdbx');
	tick();
	assert.equal(root.template, editingTemplate);
	const keydown = handler(root.template, '@keydown=');
	keydown({key: 'Escape', stopPropagation() {}, preventDefault() {}});
	tick();
	assert.equal(root.dataset.vcCopyText, 'updated elsewhere');
});

test('saving through the inline editor updates duplicate references', async t => {
	const {service, chip} = await fixture(t);
	const root = chip();
	const duplicate = chip();
	click(root, 'title="Edit"');
	const input = root.template.values.find(value => value?.reference)?.reference.value;
	input.value = 'saved inline';
	handler(root.template, '@keydown=')({key: 'Enter', stopPropagation() {}, preventDefault() {}});
	// Wait for the real asynchronous save and editing-state transition to finish.
	await new Promise(resolve => setImmediate(resolve));
	tick();
	assert.equal(service.getFieldValue('test', 'Entry', 'Password'), 'saved inline');
	assert.equal(root.dataset.vcCopyText, 'saved inline');
	assert.equal(duplicate.dataset.vcCopyText, 'saved inline');
});

test('equal editor widgets keep their live chip without creating unmounted chip effects', async t => {
	const {service, plugin} = await fixture(t);
	const raw = '{{vc:test/Entry}}';
	const view = {
		visibleRanges: [{from: 0, to: raw.length}],
		state: {field: () => true, selection: {main: {head: -1}}, doc: {sliceString: () => raw}},
	};
	const [WidgetView] = buildEditorExtension(plugin);
	const widgets = new WidgetView(view);
	const first = widgets.decorations[0].widget;
	const root = first.toDOM();
	t.after(() => first.destroy(root));
	const created = document.created;
	widgets.update({view, transactions: [{effects: [refreshChipsEffect.of(undefined)]}]});
	const replacement = widgets.decorations[0].widget;
	assert.equal(first.eq(replacement), true);
	assert.equal(document.created, created);
	assert.equal(first.toDOM(), root);
	await service.updateEntryFields('test', 'Entry', {Password: 'after'}, 'test.kdbx');
	tick();
	assert.equal(root.dataset.vcCopyText, 'after');
});

test('an entry edit refreshes only after persistence succeeds; failed saves retain the old display', async t => {
	let persist = () => Promise.resolve();
	const {service, chip} = await fixture(t, {write: () => persist()});
	const root = chip();
	let complete;
	persist = () => new Promise(resolve => { complete = resolve; });
	const saving = service.updateEntryFields('test', 'Entry', {Password: 'after'}, 'test.kdbx');
	await Promise.resolve();
	tick();
	assert.equal(root.dataset.vcCopyText, 'before');
	complete();
	await saving;
	tick();
	assert.equal(root.dataset.vcCopyText, 'after');
	persist = () => Promise.reject(new Error('Disk unavailable'));
	await assert.rejects(service.updateEntryFields('test', 'Entry', {Password: 'unsaved'}, 'test.kdbx'));
	tick();
	assert.equal(service.getFieldValue('test', 'Entry', 'Password'), 'after');
	assert.equal(root.dataset.vcCopyText, 'after');
});

test('failed entry saves restore chips refreshed by another profile during persistence', async t => {
	let persist = () => Promise.resolve();
	const {service, chip, plugin} = await fixture(t, {write: () => persist()});
	const otherDb = Kdbx.create(new KdbxCredentials(ProtectedValue.fromString('test')), 'other');
	t.mock.method(Kdbx, 'load', async () => otherDb);
	t.mock.method(otherDb, 'save', async () => new ArrayBuffer(0));
	await service.unlockProfile('other', {...plugin.settings$().profiles.test, path: 'other.kdbx'}, 'test');
	const root = chip();
	let rejectWrite;
	persist = () => new Promise((resolve, reject) => { rejectWrite = reject; });
	const saving = service.updateEntryFields('test', 'Entry', {Password: 'unsaved'}, 'test.kdbx');
	const failedSave = assert.rejects(saving, /Could not save KDBX file/);
	await Promise.resolve();
	assert.equal(typeof rejectWrite, 'function');
	persist = () => Promise.resolve();
	await service.createEntryWithFields('other', 'Entry', {Password: 'other value'}, 'other.kdbx');
	tick();
	rejectWrite(new Error('Disk unavailable'));
	await failedSave;
	tick();
	assert.equal(service.getFieldValue('test', 'Entry', 'Password'), 'before');
	assert.equal(root.dataset.vcCopyText, 'before');
	assert.ok(!templateText(root.template).includes('unsaved'));
});

for (const failure of ['save', 'write']) {
	for (const fieldName of ['Password', 'NewField']) {
		test(`failed single-field ${failure} restores ${fieldName} before another profile refreshes chips`, async t => {
			let persist = () => Promise.resolve();
			const {service, chip, plugin} = await fixture(t, {write: () => persist()});
			const otherDb = Kdbx.create(new KdbxCredentials(ProtectedValue.fromString('test')), 'other');
			t.mock.method(Kdbx, 'load', async () => otherDb);
			t.mock.method(otherDb, 'save', async () => new ArrayBuffer(0));
			await service.unlockProfile('other', {...plugin.settings$().profiles.test, path: 'other.kdbx'}, 'test');
			const root = chip(`{{vc:test/Entry#${fieldName}}}`);
			const fail = async () => { throw new Error('Save failed'); };
			const dbSave = service.getDatabase('test').save;
			if (failure === 'save') service.getDatabase('test').save = fail;
			else persist = fail;
			await assert.rejects(service.setFieldValue('test', 'Entry', fieldName, 'unsaved', 'test.kdbx'));
			service.getDatabase('test').save = dbSave;
			persist = () => Promise.resolve();
			await service.createEntryWithFields('other', 'Entry', {Password: 'other value'}, 'other.kdbx');
			tick();
			assert.equal(service.getFieldValue('test', 'Entry', fieldName), fieldName === 'Password' ? 'before' : null);
			assert.equal(root.dataset.vcCopyText, fieldName === 'Password' ? 'before' : '[encrypted]');
			assert.ok(!templateText(root.template).includes('unsaved'));
		});
	}

	test(`failed single-field ${failure} locks a profile when it created an entry`, async t => {
		let persist = () => Promise.resolve();
		const {service} = await fixture(t, {write: () => persist()});
		const locked = [];
		service.onLock(id => locked.push(id));
		const fail = async () => { throw new Error('Save failed'); };
		if (failure === 'save') t.mock.method(service.getDatabase('test'), 'save', fail);
		else persist = fail;
		await assert.rejects(service.setFieldValue('test', 'NewGroup/NewEntry', 'Password', 'unsaved', 'test.kdbx'));
		assert.equal(service.isUnlocked('test'), false);
		assert.equal(service.getFieldValue('test', 'NewGroup/NewEntry', 'Password'), null);
		assert.deepEqual(locked, ['test']);
	});
}

test('destroyed chips stop observing field changes', async t => {
	const {service, chip} = await fixture(t);
	const root = chip();
	root.dispatchEvent(new Event(CHIP_DESTROY_EVENT));
	const renders = root.renders;
	await service.setFieldValue('test', 'Entry', 'Password', 'after', 'test.kdbx');
	tick();
	assert.equal(root.renders, renders);
});
