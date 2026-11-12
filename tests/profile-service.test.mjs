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
