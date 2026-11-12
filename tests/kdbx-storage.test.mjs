import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {build} from 'esbuild';

// Real KDBX encryption and service code, with only the Obsidian host mocked.
const {outputFiles} = await build({
	stdin: {
		contents: `
			export {KdbxService} from './src/kdbx-service.ts';
			export {UnlockSessionService} from './src/unlock-session.ts';
			export {UnlockModal} from './src/modals/unlock-modal.ts';
			export {KdbxFileError, readKdbxFile, writeKdbxFile} from './src/kdbx-file.ts';
			export {TFile} from 'obsidian';
		`,
		resolveDir: process.cwd(),
	},
	bundle: true,
	write: false,
	format: 'cjs',
	platform: 'node',
	plugins: [{
		name: 'obsidian-test-runtime',
		setup(builder) {
			builder.onResolve({filter: /^obsidian$/}, () => ({path: 'obsidian', namespace: 'test'}));
			builder.onLoad({filter: /.*/, namespace: 'test'}, () => ({contents: `
				export class TFile { constructor(path) { this.path = path; } }
				export class TFolder {}
				export class Modal { constructor(app) { this.app = app; } }
				export class Notice {}
				export class Setting {}
			`}));
		},
	}],
});
const module = {exports: {}};
new Function('require', 'module', 'exports', outputFiles[0].text)(
	createRequire(import.meta.url), module, module.exports,
);
const {KdbxService, UnlockSessionService, UnlockModal, KdbxFileError, readKdbxFile, writeKdbxFile, TFile} = module.exports;

function fixture({indexed = false} = {}) {
	const disk = new Map();
	const index = new Map();
	const calls = [];
	const app = {vault: {
		getAbstractFileByPath: path => index.get(path) ?? null,
		adapter: {
			async stat(path) { return disk.has(path) ? {type: 'file'} : null; },
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
	return {app, disk, index, calls};
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
