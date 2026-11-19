import assert from 'node:assert/strict';
import {test} from 'node:test';
import {loadObsidianRuntime} from './helpers/obsidian-runtime.mjs';

const {EditSecretModal, InsertSecretModal, UnlockSessionService, parseVcTokens, Setting, Notice, TFile, kdbxweb, signal, tick} =
	await loadObsidianRuntime(`
		export {EditSecretModal} from './src/modals/edit-secret-modal.ts';
		export {InsertSecretModal} from './src/modals/insert-secret-modal.ts';
		export {UnlockSessionService} from './src/unlock-session.ts';
		export {parseVcTokens} from './src/inline-parser.ts';
		export {Setting, Notice, TFile} from 'obsidian';
		export * as kdbxweb from 'kdbxweb';
		export {signal, tick} from '@maverick-js/signals';
	`, {
		'./generate-password-modal': 'export class GeneratePasswordModal {}',
		'./unlock-modal': 'export class UnlockModal {}',
		'lit-html': 'export const html = (strings, ...values) => ({strings, values}); export const nothing = ""; export const render = () => {};',
		'lit-html/directives/ref.js': 'export const ref = () => {};',
		obsidian: `
			class Element {
				children = []; textContent = ''; classes = new Set();
				setText(text) { this.textContent = text; }
				createEl(tag, options = {}) {
					const el = new Element(); el.textContent = options.text ?? '';
					el.classes = new Set((options.cls ?? '').split(' '));
					this.children.push(el); return el;
				}
				createDiv(options) { return this.createEl('div', options); }
				empty() { this.children = []; }
				addClass(cls) { this.classes.add(cls); }
				removeClass(cls) { this.classes.delete(cls); }
			}
			class Control {
				inputEl = {}; selectEl = {empty: () => {this.options = Object.create(null);}}; value = ''; options = Object.create(null);
				setValue(value) { this.value = value; return this; }
				setPlaceholder() { return this; }
				setDisabled(value) { this.disabled = value; return this; }
				setButtonText(text) { this.text = text; return this; }
				setCta() { return this; } setWarning() { return this; }
				setIcon() { return this; } setTooltip() { return this; }
				onChange(callback) { this.change = value => {this.value = value; callback(value);}; return this; }
				onClick(callback) { this.click = callback; return this; }
				addOption(key, text) { this.options[key] = text; return this; }
			}
			export class Setting {
				static instances = []; controls = []; name = '';
				constructor(parent) { this.parent = parent; Setting.instances.push(this); }
				setName(name) { this.name = name; return this; }
				setDesc() { return this; }
				add(callback) { const control = new Control(); this.controls.push(control); callback(control); return this; }
				addText(callback) { return this.add(callback); }
				addTextArea(callback) { return this.add(callback); }
				addButton(callback) { return this.add(callback); }
				addDropdown(callback) { return this.add(callback); }
			}
			export class Modal {
				contentEl = new Element(); titleEl = new Element(); closed = false;
				constructor(app) { this.app = app; }
				open() { this.onOpen(); }
				close() { this.closed = true; this.onClose(); }
			}
			export class ButtonComponent extends Control {}
			export class Notice {
				static messages = [];
				constructor(message) { Notice.messages.push(message); }
			}
			export class TFile { constructor(path) { this.path = path; } }
			export class TFolder {}
		`,
	});

async function fixture(t, {raw = '{{vc:test/NewGroup/Nested/Entry}}', defaultField = 'Password', existing, sourceReference} = {}) {
	t.mock.method(console, 'error', () => {});
	Setting.instances.length = 0;
	Notice.messages.length = 0;
	const db = kdbxweb.Kdbx.create(new kdbxweb.KdbxCredentials(kdbxweb.ProtectedValue.fromString('test')), 'test');
	t.mock.method(kdbxweb.Kdbx, 'load', async () => db);
	t.mock.method(db, 'save', async () => new ArrayBuffer(0));
	let writes = 0, note = raw;
	const app = {
		workspace: {getActiveFile: () => new TFile('note.md')},
		vault: {
			getAbstractFileByPath: path => new TFile(path),
			readBinary: async () => new ArrayBuffer(0),
			modifyBinary: async () => { writes++; },
			read: async () => note,
			modify: async (_file, content) => { note = content; },
		},
	};
	const service = new UnlockSessionService(app);
	const config = {path: 'test.kdbx', defaultField, autoLockMinutes: 0};
	await service.unlockProfile('test', config, 'test');
	const token = parseVcTokens(raw)[0];
	if (existing) await service.createEntryWithFields('test', token.entryPath, existing, config.path);
	writes = 0;
	const plugin = {sessionService: service, settings: {profiles: {test: config}, general: {defaultProfile: ''}},
		vaultCryptState$: signal({profiles: [{id: 'test', isLocked: false}]}),
		refreshChips() { this.refreshes++; }, refreshes: 0};
	const modal = new EditSecretModal(app, plugin, 'test', token.entryPath, token, {sourceReference});
	modal.open();
	const row = name => Setting.instances.find(setting => setting.name === name);
	const edit = (name, value) => row(name).controls[0].change(value);
	const inserted = [];
	const openInsert = (mode, {lines = [''], cursor = {line: 0, ch: 0}} = {}) => {
		modal.close();
		Setting.instances.length = 0;
		const editor = {
			getCursor: () => cursor,
			getLine: line => lines[line],
			lineCount: () => lines.length,
			replaceRange: text => inserted.push(text),
		};
		const insert = new InsertSecretModal(app, plugin, editor, mode);
		insert.open();
		tick();
		t.after(() => insert.close());
		return insert;
	};
	return {modal, service, app, db, plugin, row, edit, token, openInsert, inserted, writes: () => writes, note: () => note};
}

test('inserts a standalone table of explicit secret and attachment references without reading values', async t => {
	const entryPath = 'Accounts/_Work_/Mail';
	const f = await fixture(t, {
		raw: `{{vc:test/${entryPath}}}`, defaultField: 'Api_Key',
		existing: {Password: 'secret', Api_Key: '', 'Unsupported|Field': 'private'},
	});
	await f.service.setAttachment('test', entryPath, 'guide.txt', new ArrayBuffer(4), 'test.kdbx');
	await f.service.setAttachment('test', entryPath, 'guide draft.txt', new ArrayBuffer(4), 'test.kdbx');
	const writesBeforeInsert = f.writes();
	const readValue = t.mock.method(f.service, 'getFieldValue', () => { throw new Error('Read a secret value'); });
	const insert = f.openInsert('table', {lines: ['Before', '', 'After'], cursor: {line: 1, ch: 0}});
	assert.equal(insert.insertBtn.disabled, true);
	assert.equal(f.row('Reference field'), undefined);
	insert.selectEntry(entryPath);
	assert.equal(insert.insertBtn.disabled, false);
	await insert.submit();

	assert.equal(f.inserted.length, 1);
	const [markdown] = f.inserted;
	assert.ok(markdown.startsWith('\n| Field | Value |\n| --- | --- |\n'));
	assert.ok(markdown.endsWith(' |\n'));
	assert.ok(markdown.includes('| Api\\_Key |'));
	assert.ok(markdown.includes(`\`{{vc:test/${entryPath}#Api_Key}}\``));
	assert.deepEqual(parseVcTokens(markdown).map(token => [token.entryPath, token.fieldName]), [
		[entryPath, 'UserName'], [entryPath, 'Password'], [entryPath, 'URL'],
		[entryPath, 'Notes'], [entryPath, 'Api_Key'], [entryPath, 'attachment:guide.txt'],
	]);
	assert.doesNotMatch(markdown, /secret|private|Unsupported|draft/);
	assert.equal(readValue.mock.callCount(), 0);
	assert.equal(f.writes(), writesBeforeInsert);
	assert.equal(f.plugin.lastUsedProfileId, 'test');
	assert.equal(insert.closed, true);
});

test('an entry that becomes unavailable while selecting it leaves the note unchanged', async t => {
	const f = await fixture(t, {raw: '{{vc:test/Entry}}', existing: {Password: 'secret'}});
	const insert = f.openInsert('table');
	insert.selectEntry(f.token.entryPath);
	f.service.lockProfile('test');
	await insert.submit();
	assert.equal(f.inserted.length, 0);
	assert.equal(insert.closed, false);
	assert.match(insert.errorEl.textContent, /no longer available/);
	assert.equal(f.writes(), 0);
});

test('live insertion writes a single entry reference and edits leave the note intact', async t => {
	const raw = '{{vc:test/Group/Entry#ApiKey}}';
	const f = await fixture(t, {raw, existing: {ApiKey: 'private'}, sourceReference: false});
	assert.equal(f.row('Reference field'), undefined);
	Setting.instances.find(row => row.controls[0]?.value === 'ApiKey').controls[2].click();
	t.mock.method(f.app.vault, 'modify', async () => { throw new Error('Tried to rewrite the note'); });
	await f.modal.submit();
	assert.equal(f.modal.closed, true);
	assert.equal(f.service.getFieldValue('test', f.token.entryPath, 'ApiKey'), null);
	assert.equal(f.note(), raw);
	const writes = f.writes();

	const insert = f.openInsert('live-table', {lines: ['Before', '', 'After'], cursor: {line: 1, ch: 0}});
	insert.selectEntry(f.token.entryPath);
	await insert.submit();
	assert.deepEqual(f.inserted, ['\n```vaultcrypt-table\ntest/Group/Entry\n```\n']);
	assert.equal(f.writes(), writes);
});

test('creation keeps blank standard and custom fields and their selected reference', async t => {
	const f = await fixture(t, {raw: '{{vc:test/Entry#ApiKey}}'});
	const dropdown = f.row('Reference field').controls[0];
	assert.equal(dropdown.value, 'ApiKey');
	for (const name of ['Password', 'UserName', 'URL', 'Notes', 'ApiKey']) assert.ok(name in dropdown.options);
	await f.modal.submit();
	for (const name of ['Password', 'UserName', 'URL', 'Notes', 'ApiKey']) {
		assert.equal(f.service.getFieldValue('test', 'Entry', name), '');
		assert.ok(f.service.getEntryFieldNames('test', 'Entry').includes(name));
	}
	assert.equal(f.note(), f.token.raw);
});

test('clearing existing fields saves empty strings while removing a custom row deletes that field', async t => {
	const f = await fixture(t, {raw: '{{vc:test/Entry#ApiKey}}', existing: {
		Password: 'before', UserName: 'user', URL: 'url', Notes: 'notes', ApiKey: 'key', Removed: 'remove',
	}});
	for (const name of ['Password', 'Username', 'URL', 'Notes']) f.edit(name, '');
	const custom = Setting.instances.find(row => row.controls[0]?.value === 'ApiKey');
	custom.controls[1].change('');
	const removed = Setting.instances.find(row => row.controls[0]?.value === 'Removed');
	removed.controls[2].click();
	assert.equal(f.row('Reference field').controls[0].value, 'ApiKey');
	await f.modal.submit();
	for (const name of ['Password', 'UserName', 'URL', 'Notes', 'ApiKey']) assert.equal(f.service.getFieldValue('test', 'Entry', name), '');
	assert.equal(f.service.getFieldValue('test', 'Entry', 'Removed'), null);
	assert.equal(f.note(), f.token.raw);
});

test('insert form offers and saves named custom fields with empty values', async t => {
	const f = await fixture(t);
	const insert = f.openInsert();
	insert.selectNewEntry('Group');
	f.edit('Entry name (required)', 'Blank');
	Setting.instances.flatMap(row => row.controls).find(control => control.text === 'Add custom field').click();
	const custom = Setting.instances.find(row => row.parent === insert.customFieldsContainerEl);
	custom.controls[0].change('ApiKey');
	const dropdown = f.row('Reference field').controls[0];
	assert.ok('ApiKey' in dropdown.options);
	dropdown.change('ApiKey');
	await insert.submit();
	assert.equal(insert.closed, true);
	assert.deepEqual(f.inserted, ['{{vc:test/Group/Blank#ApiKey}}']);
	for (const name of ['Password', 'UserName', 'URL', 'ApiKey']) assert.equal(f.service.getFieldValue('test', 'Group/Blank', name), '');
});

test('insert form offers empty fields on existing entries', async t => {
	const f = await fixture(t, {raw: '{{vc:test/Entry}}', existing: {Password: '', UserName: '', ApiKey: ''}});
	const insert = f.openInsert();
	insert.selectEntry('Entry');
	const dropdown = f.row('Reference field').controls[0];
	for (const name of ['Password', 'UserName', 'ApiKey']) assert.ok(name in dropdown.options);
	dropdown.change('ApiKey');
	await insert.submit();
	assert.deepEqual(f.inserted, ['{{vc:test/Entry#ApiKey}}']);
	assert.equal(f.writes(), 0);
});

for (const options of [
	{},
	{raw: '{{vc:test/Entry#UserName}}'},
	{raw: '{{vc:test/Entry#Api.Token}}'},
	{raw: '{{vc:test/Entry#Api:Token}}'},
	{raw: '{{vc:test/Entry#__proto__}}'},
	{raw: '{{vc:test/Entry}}', defaultField: 'ApiKey'},
]) {
	test(`creates the referenced entry and field: ${JSON.stringify(options)}`, async t => {
		const f = await fixture(t, options);
		assert.equal(f.modal.titleEl.textContent, `Create entry: ${f.token.entryPath}`);
		assert.equal(f.row('Entry name').controls[0].disabled, true);
		const field = f.token.fieldName ?? options.defaultField ?? 'Password';
		assert.equal(f.row('Reference field').controls[0].value, field);
		if (field === 'Password' || field === 'UserName') {
			f.edit(field === 'Password' ? 'Password' : 'Username', 'new value');
		} else {
			const custom = Setting.instances.find(row => row.controls[0]?.value === field);
			custom.controls[1].change('new value');
		}
		await f.modal.submit();
		assert.equal(f.service.getFieldValue('test', f.token.entryPath, field), 'new value');
		assert.equal(f.service.getFieldValue('test', f.token.entryPath, 'Title'), 'Entry');
		assert.equal(f.writes(), 1);
		assert.equal(f.note(), f.token.raw);
		assert.equal(f.modal.closed, true);
		assert.equal(f.plugin.refreshes, 1);
		assert.ok(Notice.messages.includes('Entry created'));
	});
}

for (const key of ['Api.Token', 'Api:Token', '__proto__']) {
	test(`custom field ${key} can be inserted, selected and reopened in the edit form`, async t => {
		const f = await fixture(t);
		const insert = f.openInsert();
		insert.selectNewEntry('Group');
		f.edit('Entry name (required)', 'Entry');
		Setting.instances.flatMap(row => row.controls).find(control => control.text === 'Add custom field').click();
		const custom = Setting.instances.find(row => row.parent === insert.customFieldsContainerEl);
		custom.controls[0].change(key);
		custom.controls[1].change('value');
		f.row('Reference field').controls[0].change(key);
		await insert.submit();
		assert.equal(insert.closed, true);
		assert.equal(f.service.getFieldValue('test', 'Group/Entry', key), 'value');
		const fields = f.service.getEntryFields('test', 'Group/Entry');
		assert.equal(Object.prototype.hasOwnProperty.call(fields, key), true);
		assert.equal(fields[key], 'value');
		Setting.instances.length = 0;
		const reference = parseVcTokens(f.inserted[0])[0];
		const edit = new EditSecretModal(f.app, f.plugin, 'test', reference.entryPath, reference);
		edit.open();
		assert.ok(Setting.instances.some(row => row.controls[0]?.value === key && row.controls[1]?.value === 'value'));
		await edit.submit();
		assert.equal(f.service.getFieldValue('test', 'Group/Entry', key), 'value');
		Setting.instances.length = 0;
		const picker = f.openInsert();
		picker.selectEntry('Group/Entry');
		assert.equal(Object.prototype.hasOwnProperty.call(f.row('Reference field').controls[0].options, key), true);
	});
}

for (const form of ['edit', 'insert']) {
	test(`${form} rejects the reserved attachment prefix in custom field names`, async t => {
		const f = await fixture(t, {raw: '{{vc:test/Entry#ApiKey}}'});
		let modal = f.modal;
		if (form === 'insert') {
			modal = f.openInsert();
			modal.selectNewEntry('');
			f.edit('Entry name (required)', 'Entry');
			Setting.instances.flatMap(row => row.controls).find(control => control.text === 'Add custom field').click();
		}
		const custom = Setting.instances.find(row => row.parent === modal.customFieldsContainerEl);
		custom.controls[0].change('attachment:ApiKey');
		custom.controls[1].change('must not save');
		await modal.submit();
		assert.match(modal.errorEl.textContent, /reserved for attachment references/);
		assert.equal(modal.closed, false);
		assert.equal(f.writes(), 0);
	});
}

test('adds a missing custom field to an existing entry while preserving other fields and attachments', async t => {
	const f = await fixture(t, {raw: '{{vc:test/Entry#ApiKey}}', existing: {Password: 'keep', Notes: 'keep notes'}});
	await f.service.setAttachment('test', 'Entry', 'keep.txt', new ArrayBuffer(4), 'test.kdbx');
	assert.equal(f.modal.titleEl.textContent, 'Edit entry: Entry');
	const custom = Setting.instances.find(row => row.controls[0]?.value === 'ApiKey');
	custom.controls[1].change('added');
	await f.modal.submit();
	assert.equal(f.service.getFieldValue('test', 'Entry', 'Password'), 'keep');
	assert.equal(f.service.getFieldValue('test', 'Entry', 'Notes'), 'keep notes');
	assert.equal(f.service.getFieldValue('test', 'Entry', 'ApiKey'), 'added');
	assert.equal(f.service.getAttachment('test', 'Entry', 'keep.txt').byteLength, 4);
	assert.ok(Notice.messages.includes('Entry updated'));
	assert.equal(f.note(), f.token.raw);
});

test('cancelling creation does not create entries, groups, or writes', async t => {
	const f = await fixture(t);
	f.edit('Password', 'unsaved');
	f.modal.close();
	assert.equal(f.service.getEntryFields('test', f.token.entryPath), null);
	assert.equal(f.db.getDefaultGroup().groups.some(group => group.name === 'NewGroup'), false);
	assert.equal(f.writes(), 0);
});

for (const path of ['Group//Entry', '/Entry', 'Group/']) {
	test(`creation form rejects an entry path with empty segments: ${path}`, async t => {
		const f = await fixture(t, {raw: `{{vc:test/${path}}}`});
		f.edit('Password', 'unsaved');
		await f.modal.submit();
		assert.match(f.modal.errorEl.textContent, /Invalid entry path/);
		assert.equal(f.modal.closed, false);
		assert.equal(f.writes(), 0);
		assert.equal(f.db.getDefaultGroup().groups.some(group => group.name === 'Group'), false);
		assert.equal(f.db.getDefaultGroup().entries.length, 0);
		await f.modal.submit();
		assert.equal(f.writes(), 0);
	});
}

test('creation refuses to overwrite an entry added while the form was open', async t => {
	const f = await fixture(t);
	f.edit('Password', 'must not replace');
	await f.service.createEntryWithFields('test', f.token.entryPath, {Password: 'created elsewhere'}, 'test.kdbx');
	await f.modal.submit();
	assert.equal(f.service.getFieldValue('test', f.token.entryPath, 'Password'), 'created elsewhere');
	assert.match(f.modal.errorEl.textContent, /already exists/);
	assert.equal(f.modal.closed, false);
	assert.equal(f.writes(), 1);
});

test('a locked profile offers no creation form', async t => {
	const f = await fixture(t);
	f.modal.close();
	f.service.lockProfile('test');
	f.modal.open();
	assert.equal(f.modal.contentEl.children[0].textContent, 'Profile is locked. Unlock it first.');
	assert.equal(f.writes(), 0);
});

test('locking a profile while the form is open prevents creation', async t => {
	const f = await fixture(t);
	f.edit('Password', 'must not save');
	f.service.lockProfile('test');
	await f.modal.submit();
	assert.match(f.modal.errorEl.textContent, /not unlocked/);
	assert.equal(f.modal.closed, false);
	assert.equal(f.writes(), 0);
});

test('failed creation reports the error and locks the unsaved session', async t => {
	const f = await fixture(t);
	f.edit('Password', 'rejected');
	t.mock.method(f.app.vault, 'modifyBinary', async () => { throw new Error('Disk unavailable'); });
	await f.modal.submit();
	assert.match(f.modal.errorEl.textContent, /Could not save KDBX file: test.kdbx/);
	assert.equal(f.service.isUnlocked('test'), false);
	assert.equal(f.modal.closed, false);
	assert.equal(f.modal.saveBtn.disabled, false);
	assert.equal(f.plugin.refreshes, 0);
	assert.equal(Notice.messages.includes('Entry created'), false);
});

test('retry after a note update failure edits the created entry instead of creating twice', async t => {
	const f = await fixture(t);
	f.edit('Password', 'created');
	f.edit('Username', 'reference value');
	f.row('Reference field').controls[0].change('UserName');
	const modify = f.app.vault.modify;
	t.mock.method(f.app.vault, 'modify', async () => { throw new Error('Note unavailable'); });
	await f.modal.submit();
	assert.match(f.modal.errorEl.textContent, /Note unavailable/);
	assert.equal(f.modal.closed, false);
	assert.equal(f.service.getFieldValue('test', f.token.entryPath, 'Password'), 'created');
	t.mock.method(f.app.vault, 'modify', modify);
	await f.modal.submit();
	assert.equal(f.modal.closed, true);
	assert.equal(f.note(), '{{vc:test/NewGroup/Nested/Entry#UserName}}');
	assert.equal(f.writes(), 2);
});
