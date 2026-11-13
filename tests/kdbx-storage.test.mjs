import assert from 'node:assert/strict';
import {test} from 'node:test';
import {loadObsidianRuntime} from './helpers/obsidian-runtime.mjs';

// Real KDBX encryption and service code, with only the Obsidian host mocked.
const {KdbxService, ProfileService, KeyringService, signal, UnlockSessionService, UnlockModal, KdbxFileError, readKdbxFile, writeKdbxFile, TFile, TFolder} = await loadObsidianRuntime(`
	export {KdbxService} from './src/kdbx-service.ts';
	export {ProfileService} from './src/profile-service.ts';
	export {KeyringService} from './src/keyring-service.ts';
	export {signal} from '@maverick-js/signals';
	export {UnlockSessionService} from './src/unlock-session.ts';
	export {UnlockModal} from './src/modals/unlock-modal.ts';
	export {KdbxFileError, readKdbxFile, writeKdbxFile} from './src/kdbx-file.ts';
	export {TFile, TFolder} from 'obsidian';
`);

function fixture({indexed = false} = {}) {
	const disk = new Map();
	const index = new Map();
	const folders = new Set();
	const calls = [];
	const app = {vault: {
		getAbstractFileByPath: path => index.get(path) ?? null,
		adapter: {
			async stat(path) {
				if (folders.has(path)) return {type: 'folder'};
				return disk.has(path) ? {type: 'file'} : null;
			},
			async readBinary(path) {
				calls.push('adapter.read');
				if (!disk.has(path)) throw new Error('ENOENT');
				return disk.get(path).slice(0);
			},
			async writeBinary(path, buffer) {
				calls.push('adapter.write');
				disk.set(path, buffer.slice(0));
			},
		},
		async readBinary(file) { calls.push('vault.read'); return disk.get(file.path).slice(0); },
		async modifyBinary(file, buffer) { calls.push('vault.modify'); disk.set(file.path, buffer.slice(0)); },
		async createBinary(path, buffer) {
			calls.push('vault.create');
			if (disk.has(path)) throw new Error('File already exists');
			disk.set(path, buffer.slice(0));
			if (indexed) index.set(path, new TFile(path));
		},
	}};
	return {app, disk, index, folders, calls};
}

function creationFixture(t, kind, path, indexed) {
	const storage = fixture({indexed});
	const settings = {general: {vaultCryptDir: path.slice(0, path.lastIndexOf('/'))}, profiles: {}};
	const database = new KdbxService(storage.app);
	const profiles = new ProfileService(signal(settings), storage.app, database, signal({}), patch => patch(settings), () => {});
	const originalCreate = KdbxService.prototype.createDatabase;
	// Exercise the real creation code with inexpensive test-only encryption.
	t.mock.method(KdbxService.prototype, 'createDatabase', function(path, password, version) {
		return originalCreate.call(this, path, password, version, {iterations: 2, memory: 32, parallelism: 1});
	});
	const create = password => kind === 'profile'
		? profiles.addProfile('whee', password, 4)
		: new KeyringService(storage.app).createKeyring(path, password);
	return {...storage, settings, create};
}

const creationLocations = [
	['.vaultcrypt/whee.kdbx', false],
	['private/.secrets/whee.kdbx', false],
	['VaultCrypt/whee.kdbx', false],
	['VaultCrypt/whee.kdbx', true],
];

for (const kind of ['profile', 'keyring']) {
	for (const [path, indexed] of creationLocations) {
		for (const collision of ['file', 'folder']) {
			test(`${kind} creation preserves an existing ${collision}: ${path}, indexed=${indexed}`, async t => {
				const {disk, index, folders, calls, settings, create} = creationFixture(t, kind, path, indexed);
				const original = new Uint8Array([1, 2, 3, 4]).buffer;
				if (collision === 'folder') folders.add(path);
				else disk.set(path, original.slice(0));
				if (indexed) index.set(path, collision === 'folder' ? new TFolder() : new TFile(path));
				await assert.rejects(create('new password'), error => /already exists/.test(error.message) && error.message.includes(path));
				if (collision === 'file') assert.deepEqual(disk.get(path), original);
				else assert.equal(folders.has(path) && !disk.has(path), true);
				assert.deepEqual(calls, []);
				assert.deepEqual(settings.profiles, {});
			});
		}

		test(`${kind} creation succeeds at an unused path: ${path}, indexed=${indexed}`, async t => {
			const {app, settings, create} = creationFixture(t, kind, path, indexed);
			await create('new password');
			const reopened = new KdbxService(app);
			await reopened.openDatabase(path, 'new password');
			assert.deepEqual(reopened.listEntries(), []);
			reopened.closeDatabase();
			if (kind === 'profile') assert.equal(settings.profiles.whee.path, path);
		});
	}

	test(`${kind} creation fails safely when the destination cannot be checked`, async t => {
		const path = '.vaultcrypt/whee.kdbx';
		const {app, disk, calls, settings, create} = creationFixture(t, kind, path, false);
		const original = new Uint8Array([1, 2, 3, 4]).buffer;
		disk.set(path, original.slice(0));
		const error = new Error('Disk unavailable');
		t.mock.method(app.vault.adapter, 'stat', async () => { throw error; });
		await assert.rejects(create('new password'), failure => failure === error);
		assert.deepEqual(disk.get(path), original);
		assert.deepEqual(calls, []);
		assert.deepEqual(settings.profiles, {});
	});
}

for (const version of [3, 4]) {
	for (const [path, indexed] of [['.vaultcrypt/whee.kdbx', false], ['private/.secrets/whee.kdbx', false], ['VaultCrypt/whee.kdbx', false], ['VaultCrypt/whee.kdbx', true]]) {
		test(`v${version} create, unlock, edit, lock and reopen: ${path}, indexed=${indexed}`, async () => {
			const {app, calls} = fixture({indexed});
			const service = new KdbxService(app);
			// Small test KDF only; production defaults are unchanged.
			await service.createDatabase(path, 'correct password', version, {iterations: 2, memory: 32, parallelism: 1});
			service.closeDatabase();
			const config = {path, autoLockMinutes: 0};
			const session = new UnlockSessionService(app);
			await session.unlockProfile('whee', config, 'correct password');
			assert.equal(session.isUnlocked('whee'), true);
			await session.setFieldValue('whee', 'test', 'Password', 'saved secret', path);
			session.lockAll();
			assert.equal(session.isUnlocked('whee'), false);
			assert.equal(await session.checkProfilePassword(config, 'correct password'), true);
			assert.equal(await session.checkProfilePassword(config, 'wrong password'), false);
			await assert.rejects(session.unlockProfile('whee', config, 'wrong password'), error => !(error instanceof KdbxFileError));
			assert.equal(session.isUnlocked('whee'), false);
			await service.openDatabase(path, 'correct password');
			assert.equal(service.getEntry('test').fields.Password, 'saved secret');
			service.setEntry('test', {Password: 'updated secret'});
			await service.saveDatabase();
			service.closeDatabase();
			await session.unlockProfile('whee', config, 'correct password');
			assert.equal(session.getFieldValue('whee', 'test', 'Password'), 'updated secret');
			session.lockAll();
			if (indexed) {
				assert.ok(calls.includes('vault.modify'));
				assert.equal(calls.some(call => call.startsWith('adapter.')), false);
			} else {
				assert.ok(calls.includes('adapter.read'));
				assert.ok(calls.includes('adapter.write'));
				assert.equal(calls.filter(call => call === 'vault.create').length, path.startsWith('VaultCrypt/') ? 1 : 0);
			}
		});
	}
}

test('missing files fail before decryption without unlocking or writing', async () => {
	const {app, calls} = fixture();
	const session = new UnlockSessionService(app);
	const config = {path: '.vaultcrypt/missing.kdbx', autoLockMinutes: 0};
	for (const operation of [() => session.unlockProfile('missing', config, 'password'), () => session.checkProfilePassword(config, 'password'), () => new KdbxService(app).openDatabase(config.path, 'password')]) {
		await assert.rejects(operation(), error => error instanceof KdbxFileError && error.message === `KDBX file not found: ${config.path}`);
	}
	assert.equal(session.isUnlocked('missing'), false);
	assert.deepEqual(calls, []);
});

for (const operation of ['stat', 'readBinary', 'writeBinary']) {
	test(`adapter ${operation} failures remain storage errors`, async () => {
		const {app, disk} = fixture();
		const path = '.vaultcrypt/whee.kdbx';
		disk.set(path, new ArrayBuffer(8));
		const original = new Error('Permission denied');
		app.vault.adapter[operation] = async () => { throw original; };
		await assert.rejects(operation === 'writeBinary' ? writeKdbxFile(app, path, new ArrayBuffer(8)) : readKdbxFile(app, path), error => error instanceof KdbxFileError && error.originalError === original && error.message.includes(path));
	});
}

test('a folder at the database path is never overwritten', async () => {
	const {app, calls} = fixture();
	app.vault.adapter.stat = async () => ({type: 'folder'});
	await assert.rejects(writeKdbxFile(app, '.vaultcrypt/whee.kdbx', new ArrayBuffer(8)), KdbxFileError);
	assert.deepEqual(calls, []);
});

// Exercise the modal's submit handling without rendering an Obsidian window.
for (const mode of ['profile', 'keyring', 'stored profile']) {
	for (const storageError of [true, false]) {
		test(`${mode} unlock reports ${storageError ? 'file' : 'password'} errors`, async t => {
			t.mock.method(console, 'error', () => {});
			const previousWindow = globalThis.window;
			globalThis.window = {setInterval, clearInterval};
			t.after(() => {
				if (previousWindow === undefined) delete globalThis.window;
				else globalThis.window = previousWindow;
			});
			const error = storageError ? new KdbxFileError('KDBX file not found: .vaultcrypt/whee.kdbx') : new Error('InvalidKey');
			const plugin = {
				settings: {profiles: {whee: {path: '.vaultcrypt/whee.kdbx'}}, keyringEnabled: mode !== 'profile'},
				sessionService: {isUnlocked: () => false, async unlockProfile() { throw error; }},
				keyringService: {async getProfilePasswords() {
					if (mode === 'keyring') throw error;
					return new Map([['whee', 'password']]);
				}},
			};
			const modal = new UnlockModal({}, plugin, 'whee');
			modal.password = 'password';
			modal.useKeyring = mode !== 'profile';
			modal.errorEl = {removeClass() {}, textContent: ''};
			modal.progressEl = {setText() {}, removeClass() {}, addClass() {}};
			modal.submitBtn = {setDisabled() {}, setButtonText() {}};
			modal.cancelBtn = {setDisabled() {}};
			await modal.submit();
			assert.equal(modal.errorEl.textContent, storageError ? error.message : ({
				profile: 'Incorrect password or corrupted database.',
				keyring: 'Incorrect keyring master password or corrupted keyring.',
				'stored profile': 'Stored profile password is incorrect or corrupted.',
			})[mode]);
			assert.equal(modal.isSubmitting, false);
			assert.equal(modal.progressTimer, null);
		});
	}
}
