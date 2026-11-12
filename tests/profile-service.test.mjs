import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from 'esbuild';

// Bundle the real service in memory: Obsidian supplies these classes at runtime,
// but its npm package only supplies types. No vault files or build artifacts are used.
const {outputFiles} = await build({
	stdin: {
		contents: `
			export {ProfileService} from './src/profile-service.ts';
			export {signal} from '@maverick-js/signals';
			export {TFile, TFolder, Notice} from 'obsidian';
		`,
		resolveDir: process.cwd(),
	},
	bundle: true,
	write: false,
	format: 'esm',
	platform: 'node',
	plugins: [{
		name: 'obsidian-test-runtime',
		setup(builder) {
			builder.onResolve({filter: /^obsidian$/}, () => ({path: 'obsidian', namespace: 'test'}));
			builder.onLoad({filter: /.*/, namespace: 'test'}, () => ({contents: `
				export class TFile {}
				export class TFolder {}
				export class Notice {
					static messages = [];
					constructor(message) { Notice.messages.push(message); }
				}
			`}));
		},
	}],
});
const {ProfileService, signal, TFile, TFolder, Notice} = await import(
	`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`
);

function fixture(t, {path = '_VaultCrypt', indexed = {}, disk = {}, create, stat} = {}) {
	t.mock.method(console, 'error', () => {});
	Notice.messages.length = 0;
	const created = [];
	const checked = [];
	const vault = {
		getAbstractFileByPath: path => indexed[path] ?? null,
		adapter: {
			async stat(path) {
				checked.push(path);
				return stat ? stat(path) : (disk[path] ? {type: disk[path]} : null);
			},
		},
		async createFolder(path) {
			created.push(path);
			if (create) return create(path, disk);
			disk[path] = 'folder';
		},
	};
	const service = new ProfileService(
		signal({general: {vaultCryptDir: path}}), {vault}, null, signal({}), () => {}, () => {},
	);
	return {service, created, checked};
}

test('an indexed folder needs no disk check or creation', async t => {
	const {service, created, checked} = fixture(t, {indexed: {_VaultCrypt: new TFolder()}});
	await service.ensureVaultCryptDir();
	assert.deepEqual(created, []);
	assert.deepEqual(checked, []);
});

for (const path of ['VaultCrypt', '_VaultCrypt', '.vaultcrypt', 'private/secrets']) {
	test(`startup accepts an unindexed folder on disk: ${path}`, async t => {
		const disk = {};
		const segments = path.split('/');
		for (let i = 1; i <= segments.length; i++) disk[segments.slice(0, i).join('/')] = 'folder';
		const {service, created} = fixture(t, {path, disk});
		await service.ensureVaultCryptDir();
		await service.ensureVaultCryptDir();
		assert.deepEqual(created, []);
		assert.deepEqual(Notice.messages, []);
	});
}

test('missing nested directories are created once, parent first', async t => {
	const {service, created} = fixture(t, {path: 'private/secrets/nested'});
	await service.ensureVaultCryptDir();
	await service.ensureVaultCryptDir();
	assert.deepEqual(created, ['private', 'private/secrets', 'private/secrets/nested']);
});

for (const source of ['index', 'disk']) {
	for (const collision of ['private', 'private/secrets']) {
		test(`a file in the ${source} at ${collision} prevents creation`, async t => {
			const indexed = source === 'index' ? {[collision]: new TFile()} : {};
			const disk = {private: 'folder', [collision]: 'file'};
			const {service, created} = fixture(t, {path: 'private/secrets', indexed, disk});
			await assert.rejects(service.ensureVaultCryptDir(), error => error.message.includes(`"${collision}"`));
			assert.deepEqual(created, []);
			assert.equal(Notice.messages.length, 1);
		});
	}
}

test('a folder created concurrently is accepted without depending on error text', async t => {
	const {service, created} = fixture(t, {
		create(path, disk) {
			disk[path] = 'folder';
			throw new Error('An arbitrary adapter error');
		},
	});
	await service.ensureVaultCryptDir();
	assert.deepEqual(created, ['_VaultCrypt']);
	assert.deepEqual(Notice.messages, []);
});

for (const stateAfterFailure of [null, 'file', 'stat-error']) {
	test(`creation errors survive a recheck returning ${stateAfterFailure}`, async t => {
		const original = new Error('Permission denied');
		let failed = false;
		const {service} = fixture(t, {
			create() { failed = true; throw original; },
			stat() {
				if (!failed) return null;
				if (stateAfterFailure === 'stat-error') throw new Error('Read failed');
				return stateAfterFailure ? {type: stateAfterFailure} : null;
			},
		});
		await assert.rejects(service.ensureVaultCryptDir(), error => error === original);
		assert.match(Notice.messages[0], /Permission denied/);
	});
}

test('initial disk inspection errors propagate without attempting creation', async t => {
	const original = new Error('Disk unavailable');
	const {service, created} = fixture(t, {stat() { throw original; }});
	await assert.rejects(service.ensureVaultCryptDir(), error => error === original);
	assert.deepEqual(created, []);
});

function migrationFixture(t, {oldDir = '.vaultcrypt', indexed = false, failRename, beforeCleanup} = {}) {
	t.mock.method(console, 'warn', () => {});
	Notice.messages.length = 0;
	const disk = new Map([
		[oldDir, 'folder'],
		[`${oldDir}/whee.kdbx`, 'profile bytes'],
		[`${oldDir}/_keyring.kdbx`, 'keyring bytes'],
		[`${oldDir}/attachments`, 'folder'],
		[`${oldDir}/attachments/test.bin`, 'attachment bytes'],
	]);
	const index = new Map();
	const calls = [];
	const renames = [];
	function putInIndex(path) {
		if (!indexed || path.split('/').some(segment => segment.startsWith('.'))) return;
		const file = disk.get(path) === 'folder' ? new TFolder() : new TFile();
		file.path = path;
		index.set(path, file);
	}
	for (const path of disk.keys()) putInIndex(path);
	function list(path) {
		if (!disk.has(path)) throw new Error(`Directory not found: ${path}`);
		const children = [...disk.keys()].filter(key => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/'));
		return {files: children.filter(key => disk.get(key) !== 'folder'), folders: children.filter(key => disk.get(key) === 'folder')};
	}
	function rename(from, to, api) {
		renames.push({from, to, api});
		if (failRename) failRename(from, to, disk);
		if (!disk.has(from)) throw new Error(`File not found: ${from}`);
		// Deliberately allow replacement to catch missing collision checks.
		disk.set(to, disk.get(from));
		disk.delete(from);
		index.delete(from);
		putInIndex(to);
	}
	const app = {vault: {
		getAbstractFileByPath: path => index.get(path) ?? null,
		adapter: {
			async stat(path) { return disk.has(path) ? {type: disk.get(path) === 'folder' ? 'folder' : 'file'} : null; },
			async list(path) {
				if (beforeCleanup && renames.length >= 3) beforeCleanup(path, disk);
				return list(path);
			},
			async rename(from, to) { rename(from, to, 'adapter'); },
			async rmdir(path, recursive) {
				assert.equal(recursive, false);
				assert.deepEqual(list(path), {files: [], folders: []});
				calls.push(['rmdir', path]);
				disk.delete(path);
			},
		},
		async createFolder(path) {
			if (disk.has(path)) throw new Error('Folder already exists');
			disk.set(path, 'folder');
			putInIndex(path);
		},
		async rename(file, to) { rename(file.path, to, 'vault'); },
	}, fileManager: {
		async trashFile(folder) {
			assert.deepEqual(list(folder.path), {files: [], folders: []});
			calls.push(['trash', folder.path]);
			disk.delete(folder.path);
			index.delete(folder.path);
		},
	}};
	const settings = {
		general: {vaultCryptDir: oldDir},
		profiles: {whee: {path: `${oldDir}/whee.kdbx`}, external: {path: 'other/external.kdbx'}},
		masterKeyringPath: `${oldDir}/_keyring.kdbx`,
	};
	const state = {profiles: [{id: 'whee', path: `${oldDir}/whee.kdbx`}], currentProfile: {id: 'whee', path: `${oldDir}/whee.kdbx`}};
	const remaps = [];
	const service = new ProfileService(signal(settings), app, {
		remapPathPrefix(from, to) { remaps.push([from, to]); },
	}, signal(state), patch => patch(settings), mutate => mutate(state));
	return {service, disk, settings, state, remaps, renames, calls};
}

for (const [oldDir, newDir, indexed, api] of [
	['.vaultcrypt', 'VaultCrypt', false, 'adapter'],
	['VaultCrypt', '.vaultcrypt', true, 'vault'],
	['VaultCrypt', 'private/secrets', true, 'vault'],
	['VaultCrypt', 'Secrets', false, 'adapter'],
]) {
	test(`move ${oldDir} to ${newDir}, indexed=${indexed}`, async t => {
		const {service, disk, settings, state, remaps, renames} = migrationFixture(t, {oldDir, indexed});
		await service.moveVaultDir(newDir);
		assert.equal(disk.get(`${newDir}/whee.kdbx`), 'profile bytes');
		assert.equal(disk.get(`${newDir}/_keyring.kdbx`), 'keyring bytes');
		assert.equal(disk.get(`${newDir}/attachments/test.bin`), 'attachment bytes');
		assert.equal([...disk.keys()].some(path => path === oldDir || path.startsWith(`${oldDir}/`)), false);
		assert.equal(settings.general.vaultCryptDir, newDir);
		assert.equal(settings.profiles.whee.path, `${newDir}/whee.kdbx`);
		assert.equal(settings.profiles.external.path, 'other/external.kdbx');
		assert.equal(settings.masterKeyringPath, `${newDir}/_keyring.kdbx`);
		assert.equal(state.profiles[0].path, `${newDir}/whee.kdbx`);
		assert.equal(state.currentProfile.path, `${newDir}/whee.kdbx`);
		assert.deepEqual(remaps, [[oldDir, newDir]]);
		assert.ok(renames.every(rename => rename.api === api));
	});
}

test('a failed move rolls back unindexed destination files and preserves settings', async t => {
	const {service, disk, settings, state, remaps, renames} = migrationFixture(t, {
		failRename(from) { if (from === '.vaultcrypt/attachments/test.bin') throw new Error('Move denied'); },
	});
	await assert.rejects(service.moveVaultDir('VaultCrypt'), /Move denied/);
	assert.equal(disk.get('.vaultcrypt/whee.kdbx'), 'profile bytes');
	assert.equal(disk.get('.vaultcrypt/_keyring.kdbx'), 'keyring bytes');
	assert.equal(disk.get('.vaultcrypt/attachments/test.bin'), 'attachment bytes');
	assert.equal(disk.has('VaultCrypt/whee.kdbx'), false);
	assert.equal(disk.has('VaultCrypt/_keyring.kdbx'), false);
	assert.equal(settings.general.vaultCryptDir, '.vaultcrypt');
	assert.equal(settings.profiles.whee.path, '.vaultcrypt/whee.kdbx');
	assert.equal(settings.masterKeyringPath, '.vaultcrypt/_keyring.kdbx');
	assert.equal(state.currentProfile.path, '.vaultcrypt/whee.kdbx');
	assert.deepEqual(remaps, []);
	assert.deepEqual(renames.slice(-2).map(rename => rename.from), ['VaultCrypt/_keyring.kdbx', 'VaultCrypt/whee.kdbx']);
});

for (const collision of ['file', 'folder']) {
	test(`a destination ${collision} is preserved and earlier moves are rolled back`, async t => {
		const {service, disk, settings} = migrationFixture(t);
		disk.set('VaultCrypt', 'folder');
		disk.set('VaultCrypt/_keyring.kdbx', collision === 'folder' ? 'folder' : 'existing destination bytes');
		await assert.rejects(service.moveVaultDir('VaultCrypt'), /already exists/);
		assert.equal(disk.get('VaultCrypt/_keyring.kdbx'), collision === 'folder' ? 'folder' : 'existing destination bytes');
		assert.equal(disk.get('.vaultcrypt/whee.kdbx'), 'profile bytes');
		assert.equal(disk.get('.vaultcrypt/_keyring.kdbx'), 'keyring bytes');
		assert.equal(settings.general.vaultCryptDir, '.vaultcrypt');
	});
}

test('cleanup preserves files created in the source directory during migration', async t => {
	const {service, disk} = migrationFixture(t, {
		beforeCleanup(path, disk) {
			if (path === '.vaultcrypt') disk.set('.vaultcrypt/new.kdbx', 'new bytes');
		},
	});
	await service.moveVaultDir('VaultCrypt');
	assert.equal(disk.get('.vaultcrypt/new.kdbx'), 'new bytes');
	assert.equal(disk.get('VaultCrypt/whee.kdbx'), 'profile bytes');
});

test('rollback uses the adapter when an indexed file was moved into a hidden folder', async t => {
	const {service, disk, settings, renames} = migrationFixture(t, {
		oldDir: 'VaultCrypt', indexed: true,
		failRename(from) { if (from === 'VaultCrypt/attachments/test.bin') throw new Error('Move denied'); },
	});
	await assert.rejects(service.moveVaultDir('.vaultcrypt'), /Move denied/);
	assert.equal(disk.get('VaultCrypt/whee.kdbx'), 'profile bytes');
	assert.equal(disk.get('VaultCrypt/_keyring.kdbx'), 'keyring bytes');
	assert.equal(settings.general.vaultCryptDir, 'VaultCrypt');
	assert.ok(renames.slice(-2).every(rename => rename.api === 'adapter'));
});

test('rollback reports files it cannot restore and preserves conflicting files', async t => {
	const {service, disk, settings} = migrationFixture(t, {
		failRename(from, to, disk) {
			if (from === '.vaultcrypt/attachments/test.bin') {
				disk.set('.vaultcrypt/whee.kdbx', 'concurrently created bytes');
				throw new Error('Move denied');
			}
		},
	});
	await assert.rejects(service.moveVaultDir('VaultCrypt'), /Move denied/);
	assert.equal(disk.get('.vaultcrypt/whee.kdbx'), 'concurrently created bytes');
	assert.equal(disk.get('VaultCrypt/whee.kdbx'), 'profile bytes');
	assert.equal(disk.get('.vaultcrypt/_keyring.kdbx'), 'keyring bytes');
	assert.equal(settings.general.vaultCryptDir, '.vaultcrypt');
	assert.match(Notice.messages.at(-1), /Could not restore these files: VaultCrypt\/whee.kdbx/);
});
