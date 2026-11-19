import assert from 'node:assert/strict';
import {test} from 'node:test';
import {loadObsidianRuntime} from './helpers/obsidian-runtime.mjs';

const {VaultImportFlow, ProfileService, KdbxService, UnlockSessionService, signal, Modal, Notice, TFile, scanForVaults, kdbxweb} =
	await loadObsidianRuntime(`
		export { VaultImportFlow } from './src/modals/vault-import-modal.ts';
		export { ProfileService } from './src/profile-service.ts';
		export { KdbxService } from './src/kdbx-service.ts';
		export { UnlockSessionService } from './src/unlock-session.ts';
		export { scanForVaults } from './src/vault-import.ts';
		export * as kdbxweb from 'kdbxweb';
		export { signal } from '@maverick-js/signals';
		export { Modal, Notice, TFile } from 'obsidian';
	`, {obsidian: `
		class Element {
			rows = [];
			setText(text) { this.text = text; }
			setAttribute() {}
			addClass() {}
			toggleClass() {}
			createEl() { return new Element(); }
			empty() { this.rows = []; }
		}
		class Control {
			inputEl = new Element();
			setValue(value) { this.value = value; return this; }
			setTooltip() { return this; }
			setCta() { return this; }
			setDisabled(disabled) { this.disabled = disabled; return this; }
			setButtonText(text) { this.text = text; return this; }
			onChange(change) { this.change = change; return this; }
			onClick(click) { this.click = click; return this; }
		}
		export class Setting {
			settingEl = new Element();
			controls = [];
			constructor(parent) { parent.rows.push(this); }
			setName(name) { this.name = name; return this; }
			setDesc(desc) { this.desc = desc; return this; }
			addText(callback) { return this.addButton(callback); }
			addToggle(callback) { return this.addButton(callback); }
			addButton(callback) {
				const control = new Control();
				this.controls.push(control);
				callback(control);
				return this;
			}
		}
		export class Modal {
			static current;
			contentEl = new Element(); titleEl = new Element();
			open() { Modal.current = this; this.onOpen(); }
			close() { Modal.current = undefined; this.onClose(); }
		}
		export class Notice {
			static messages = [];
			constructor(message) { Notice.messages.push(message); }
		}
		export class TFile { constructor(path) { this.path = path; } }
		export class TFolder {}
	`});

function fixture(t, directory = '.private/vaults') {
	const settings = signal({general: {vaultCryptDir: directory}, profiles: {}, masterKeyringPath: `${directory}/master.kdbx`});
	const disk = new Map();
	const reads = [];
	const writes = [];
	const listCalls = [];
	let layoutReady;
	const cleanup = [];
	Notice.messages.length = 0;
	const app = {
		workspace: {onLayoutReady: callback => { layoutReady = callback; }},
		vault: {
			getAbstractFileByPath: path => !path.startsWith('.') && disk.has(path) ? new TFile(path) : null,
			readBinary: file => app.vault.adapter.readBinary(file.path),
			createBinary: (path, data) => app.vault.adapter.writeBinary(path, data),
			adapter: {
				async list(folder) {
					listCalls.push(folder);
					const children = [...disk.keys()].filter(path => path.startsWith(`${folder}/`));
					const files = children.filter(path => !path.slice(folder.length + 1).includes('/'));
					const folders = children.filter(path => !files.includes(path))
						.map(path => `${folder}/${path.slice(folder.length + 1).split('/')[0]}`);
					return {files, folders: [...new Set(folders)]};
				},
				async stat(path) {
					const file = disk.get(path);
					return file ? {type: 'file', size: file.byteLength, ctime: 1, mtime: 1} : null;
				},
				async readBinary(path) {
					reads.push(path);
					return disk.get(path).slice(0);
				},
				async writeBinary(path, data) {
					writes.push(path);
					disk.set(path, data.slice(0));
				},
			},
		},
	};
	const patch = patcher => {
		const current = structuredClone(settings());
		patcher(current);
		settings.set(current);
	};
	const kdbx = new KdbxService(app);
	const service = new ProfileService(settings, app, kdbx, signal({}), patch, () => {});
	const flow = new VaultImportFlow({
		app,
		get settings() { return settings(); },
		register: callback => cleanup.push(callback),
		patchSettings: patch,
		importVaults: service.importVaults.bind(service),
	});
	t.after(() => cleanup.forEach(callback => callback()));
	return {
		app, directory, settings, disk, reads, writes, listCalls, patch, flow,
		addProfile: service.addProfile.bind(service),
		async makeDatabase(path, version) {
			await kdbx.createDatabase(path, 'existing password', version, {iterations: 2, memory: 32, parallelism: 1});
			kdbx.closeDatabase();
		},
		async start() {
			flow.registerStartupScan();
			layoutReady();
			await new Promise(resolve => setImmediate(resolve));
		},
		importVaults: (selections, signal = new AbortController().signal) => service.importVaults(directory, selections, signal),
	};
}

test('first run prompts for selected files and a later settings rescan finds copied vaults', async t => {
	const f = fixture(t);
	const first = `${f.directory}/Work Vault.KDBX`;
	const second = `${f.directory}/nested/work-vault.kdbx`;
	await f.makeDatabase(first, 3);
	await f.makeDatabase(second, 4);
	const original = f.disk.get(first).slice(0);
	f.writes.length = 0;
	await f.start();
	assert.equal(f.settings().general.hasScannedForVaults, true);
	assert.deepEqual(f.settings().profiles, {});
	const [firstRow, firstPassword, secondRow, , actions] = Modal.current.contentEl.rows;
	assert.equal(firstRow.name, first);
	assert.equal(firstRow.controls[0].value, 'work-vault');
	assert.equal(secondRow.name, second);
	assert.equal(secondRow.controls[0].value, 'work-vault-2');
	const submit = actions.controls[1];
	assert.equal(submit.disabled, true);
	firstRow.controls[0].change('Restored');
	firstRow.controls[1].change(true);
	firstPassword.controls[0].inputEl.value = 'existing password';
	await submit.click();
	assert.equal(firstPassword.controls[0].inputEl.value, '');
	assert.deepEqual(f.settings().profiles, {restored: {
		path: first, kdbxVersion: 3, autoLockMinutes: 0, defaultField: 'password', managedByKeyring: false,
	}});
	assert.deepEqual(f.writes, []);
	assert.deepEqual(f.disk.get(first), original);
	const session = new UnlockSessionService(f.app);
	await session.unlockProfile('restored', f.settings().profiles.restored, 'existing password');
	assert.equal(session.isUnlocked('restored'), true);
	session.lockAll();

	const copied = `${f.directory}/New-.kdbx`;
	f.disk.set(copied, f.disk.get(second).slice(0));
	const startupLists = f.listCalls.length;
	await f.start();
	assert.equal(f.listCalls.length, startupLists);
	assert.equal(Modal.current, undefined);
	let settingsRefreshed = false;
	await f.flow.open(() => { settingsRefreshed = true; });
	const [copiedRow, copiedPassword, remainingRow, , rescanActions] = Modal.current.contentEl.rows;
	assert.deepEqual([copiedRow.name, remainingRow.name], [copied, second]);
	copiedRow.controls[1].change(true);
	copiedPassword.controls[0].inputEl.value = 'existing password';
	await rescanActions.controls[1].click();
	assert.equal(settingsRefreshed, true);
	assert.equal(f.settings().profiles['new-'].kdbxVersion, 4);
	assert.equal(f.settings().profiles['new-'].path, copied);
});

test('scan excludes registered files, keyrings, and invalid or unsupported databases', async t => {
	const f = fixture(t, 'VaultCrypt');
	const candidate = 'VaultCrypt/Valid.kdbx';
	await f.makeDatabase(candidate, 4);
	for (const path of ['VaultCrypt/registered.kdbx', 'VaultCrypt/_KEYRING.KDBX', 'VaultCrypt/Master.kdbx', 'elsewhere/Other.kdbx']) {
		f.disk.set(path, f.disk.get(candidate).slice(0));
	}
	f.patch(settings => { settings.profiles.valid = {path: 'VaultCrypt/registered.kdbx'}; });
	f.disk.set('VaultCrypt/fake.kdbx', new ArrayBuffer(12));
	const unsupported = f.disk.get(candidate).slice(0);
	new DataView(unsupported).setUint16(10, 5, true);
	f.disk.set('VaultCrypt/unsupported.kdbx', unsupported);
	f.disk.set('VaultCrypt/truncated.kdbx', f.disk.get(candidate).slice(0, 12));
	const {candidates, unreadable} = await scanForVaults(f.app, f.settings(), new AbortController().signal);
	assert.deepEqual(candidates, [{path: candidate, version: 4, name: 'valid-2'}]);
	assert.equal(unreadable, 0);
	assert.deepEqual(f.reads.sort(), [candidate, 'VaultCrypt/fake.kdbx', 'VaultCrypt/truncated.kdbx', 'VaultCrypt/unsupported.kdbx']);
});

test('stale and concurrent selections cannot partially import or register the same file twice', async t => {
	const f = fixture(t);
	const first = {name: 'one', path: `${f.directory}/first.kdbx`, password: 'existing password'};
	const gone = {name: 'two', path: `${f.directory}/gone.kdbx`, password: 'existing password'};
	await f.makeDatabase(first.path, 3);
	await assert.rejects(f.importVaults([first, gone]), /file not found/);
	assert.deepEqual(f.settings().profiles, {});
	const results = await Promise.allSettled([
		f.importVaults([first]),
		f.importVaults([{...first, name: 'other'}]),
	]);
	assert.deepEqual(results.map(result => result.status).sort(), ['fulfilled', 'rejected']);
	assert.match(results.find(result => result.status === 'rejected').reason.message, /already selected or registered/);
	assert.equal(Object.keys(f.settings().profiles).length, 1);
	await assert.rejects(f.importVaults([{...first, name: 'outside', path: `${f.directory}/../other.kdbx`}]), /cannot be imported/);
	f.patch(settings => { settings.general.vaultCryptDir = 'elsewhere'; });
	await assert.rejects(f.importVaults([first]), /storage directory is changing or has changed/);
});

test('import verifies a password alone and rejects a key-file database before registering any profiles', async t => {
	const f = fixture(t);
	const first = {name: 'one', path: `${f.directory}/first.kdbx`, password: 'existing password'};
	const second = {...first, name: 'two', path: `${f.directory}/with-key.kdbx`};
	await f.makeDatabase(first.path, 3);
	const key = new Uint8Array(32).fill(7).buffer;
	const credentials = new kdbxweb.KdbxCredentials(kdbxweb.ProtectedValue.fromString(second.password), key);
	const db = kdbxweb.Kdbx.create(credentials, 'key file');
	db.setVersion(3);
	const bytes = await db.save();
	f.disk.set(second.path, bytes);
	assert.equal((await kdbxweb.Kdbx.load(bytes, credentials)).versionMajor, 3);

	await assert.rejects(f.importVaults([first, second]), /with-key\.kdbx.*only credential/);
	await assert.rejects(f.importVaults([{...first, password: 'wrong password'}]), /Check the password/);
	assert.deepEqual(f.settings().profiles, {});
	await f.importVaults([first]);
	assert.equal(f.settings().profiles.one.path, first.path);
});

test('import rejects a database written by a profile creation that has yet to register its path', async t => {
	const f = fixture(t);
	const path = `${f.directory}/one.kdbx`;
	let written, resume;
	const waitingForWrite = new Promise(resolve => { written = resolve; });
	const finishWrite = new Promise(resolve => { resume = resolve; });
	const adapter = f.app.vault.adapter;
	const write = adapter.writeBinary;
	t.mock.method(adapter, 'writeBinary', async (path, data) => {
		await write(path, data);
		written();
		await finishWrite;
	});
	const creating = f.addProfile('one', 'existing password', 3);
	try {
		await Promise.race([waitingForWrite, creating]);
		assert.equal(f.disk.has(path), true);
		assert.deepEqual(f.settings().profiles, {});
		await assert.rejects(f.importVaults([{path, name: 'another', password: 'existing password'}]), /being created at this path/);
	} finally {
		resume();
		await creating;
	}
	assert.deepEqual(Object.keys(f.settings().profiles), ['one']);
});

for (const change of ['removed', 'modified']) {
	test(`import rejects the batch if an earlier file is ${change} while verifying a later file`, async t => {
		const f = fixture(t);
		const first = {name: 'one', path: `${f.directory}/first.kdbx`, password: 'existing password'};
		const second = {...first, name: 'two', path: `${f.directory}/second.kdbx`};
		await f.makeDatabase(first.path, 3);
		await f.makeDatabase(second.path, 4);
		const original = f.disk.get(first.path);
		const adapter = f.app.vault.adapter;
		const {stat, readBinary} = adapter;
		let modified = false;
		const statMock = t.mock.method(adapter, 'stat', async path => {
			const info = await stat(path);
			return modified && path === first.path ? {...info, mtime: info.mtime + 1} : info;
		});
		const readMock = t.mock.method(adapter, 'readBinary', path => {
			if (path === second.path) {
				if (change === 'removed') f.disk.delete(first.path);
				else modified = true;
			}
			return readBinary(path);
		});
		await assert.rejects(f.importVaults([first, second]), /changed or was removed during import/);
		assert.deepEqual(f.settings().profiles, {});
		statMock.mock.restore();
		readMock.mock.restore();
		f.disk.set(first.path, original);
		await f.importVaults([first, second]);
		assert.deepEqual(Object.keys(f.settings().profiles), ['one', 'two']);
	});
}
