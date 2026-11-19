import assert from 'node:assert/strict';
import {test} from 'node:test';
import {loadObsidianRuntime} from './helpers/obsidian-runtime.mjs';

const {registerNoteUnlock, SecretStorageService, Notice} = await loadObsidianRuntime(`
	export {registerNoteUnlock} from './src/note-unlock.ts';
	export {SecretStorageService} from './src/secret-storage-service.ts';
	export {Notice} from 'obsidian';
`, {
	'./modals': 'export class UnlockModal {} export class KeyringUnlockModal {}',
	obsidian: `
		export class Notice {
			static instances = [];
			buttons = []; hidden = false;
			messageEl = {createEl: (tag, options) => {
				const button = {text: options.text, addEventListener() {}};
				this.buttons.push(button); return button;
			}};
			constructor(message) {this.message = message; Notice.instances.push(this);}
			hide() {this.hidden = true;}
		}
	`,
});

const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture(t, {autoUnlock = true, managed = true, keyringEnabled = true} = {}) {
	t.mock.method(console, 'error', () => {});
	Notice.instances.length = 0;
	const secrets = new Map(), unlocked = new Set(), unlocks = [], keyringReads = [], reads = [];
	let generation = 0;
	const events = new Map(), layoutCallbacks = [], cleanups = [];
	const activeFile = {path: 'active.md', extension: 'md'};
	const contents = new Map([['active.md', '{{vc:test/Entry}}']]);
	const settings = {
		profiles: {test: {path: 'test.kdbx', managedByKeyring: managed}},
		keyringEnabled, masterKeyringPath: 'keyring.kdbx', security: {autoUnlock},
	};
	const app = {
		secretStorage: {setSecret: (id, value) => secrets.set(id, value), getSecret: id => secrets.get(id) ?? null},
		workspace: {
			on: (event, callback) => {events.set(event, callback); return event;},
			onLayoutReady: callback => {layoutCallbacks.push(callback);},
			getActiveFile: () => activeFile,
		},
		vault: {read: async file => {reads.push(file.path); return contents.get(file.path) ?? ''; }},
	};
	const sessionService = {
		getLockGeneration: () => generation,
		lockAll: () => {generation++; unlocked.clear();},
		isUnlocked: id => unlocked.has(id),
		unlockProfile: async (id, config, password) => {
			unlocks.push(id);
			assert.equal(config, settings.profiles[id]);
			if (password !== 'profile-password') throw Object.assign(new Error('Wrong password'), {code: 'InvalidKey'});
			unlocked.add(id);
		},
	};
	const keyringService = {getProfilePasswords: async (path, password, ids) => {
		keyringReads.push([...ids]);
		assert.equal(path, settings.masterKeyringPath);
		if (password !== 'keyring-password') throw Object.assign(new Error('Wrong keyring password'), {code: 'InvalidKey'});
		return new Map(ids.map(id => [id, 'profile-password']));
	}};
	const saved = new SecretStorageService(app);
	const plugin = {
		app, settings, secretStorageService: saved, sessionService, keyringService,
		register: callback => cleanups.push(callback),
		registerEvent: event => cleanups.push(() => events.delete(event)),
	};
	registerNoteUnlock(plugin);
	const open = async (path = 'active.md', content) => {
		if (content !== undefined) contents.set(path, content);
		await events.get('file-open')?.({path, extension: path.split('.').pop()});
	};
	return {
		app, saved, settings, sessionService, keyringService, unlocked, unlocks, keyringReads, reads, open,
		async ready() { for (const callback of layoutCallbacks) callback(); await settle(); },
		unload() { for (const callback of cleanups) callback(); },
		buttons: () => Notice.instances.flatMap(notice => notice.buttons.map(button => button.text)),
	};
}

test('lockAll cancels a note check before its queued work starts', async t => {
	const f = fixture(t);
	f.saved.saveKeyringPassword('keyring-password');
	const opening = f.open();
	f.sessionService.lockAll();
	await opening;
	assert.deepEqual(f.reads, []);
	assert.deepEqual(f.unlocks, []);
	assert.deepEqual(Notice.instances, []);
});

test('live tables participate in note auto-unlock', async t => {
	const f = fixture(t, {managed: false});
	f.saved.saveProfilePassword('test', 'profile-password');
	const table = '```vaultcrypt-table\ntest/Group/Entry\n```';
	await f.open('example.md', '````markdown\n' + table + '\n````');
	await f.open('invalid.md', table.replace('Group/Entry', 'Group/Entry#Password'));
	assert.deepEqual(f.unlocks, []);
	await f.open('table.md', table.replaceAll('\n', '\r\n'));
	assert.deepEqual(f.unlocks, ['test']);
});

for (const queued of [false, true]) {
	test(`lockAll during a note read cancels ${queued ? 'that read and an already queued note' : 'that check'}`, async t => {
		const f = fixture(t);
		f.saved.saveKeyringPassword('keyring-password');
		let finish, started;
		const gate = new Promise(resolve => {finish = resolve;});
		const beginning = new Promise(resolve => {started = resolve;});
		t.mock.method(f.app.vault, 'read', async file => {
			f.reads.push(file.path); started(); await gate; return '{{vc:test/Entry}}';
		});
		const opening = f.open();
		await beginning;
		const next = queued ? f.open('next.md', '{{vc:test/Entry}}') : Promise.resolve();
		f.sessionService.lockAll();
		finish();
		await Promise.all([opening, next]);
		assert.deepEqual(f.reads, ['active.md']);
		assert.deepEqual(f.unlocks, []);
		assert.deepEqual(f.keyringReads, []);
		assert.deepEqual(Notice.instances, []);
	});
}

test('a new same-file request after lockAll runs independently and keeps its own deduplication', async t => {
	const f = fixture(t);
	f.saved.saveKeyringPassword('keyring-password');
	const gates = [], beginnings = [];
	for (let i = 0; i < 2; i++) {
		let finish, started;
		const gate = new Promise(resolve => {finish = resolve;});
		const beginning = new Promise(resolve => {started = resolve;});
		gates.push({gate, finish}); beginnings.push({beginning, started});
	}
	let reads = 0;
	t.mock.method(f.app.vault, 'read', async () => {
		const index = reads++;
		if (index < 2) {beginnings[index].started(); await gates[index].gate;}
		return '{{vc:test/Entry}}';
	});
	const stale = f.open();
	await beginnings[0].beginning;
	f.sessionService.lockAll();
	const fresh = f.open();
	gates[0].finish();
	await beginnings[1].beginning;
	const duplicate = f.open();
	gates[1].finish();
	await Promise.all([stale, fresh, duplicate]);
	assert.equal(reads, 2);
	assert.deepEqual(f.unlocks, ['test']);
	assert.deepEqual(f.buttons(), []);
});

test('auto-unlocks the restored active note using the remembered keyring password', async t => {
	const f = fixture(t);
	f.saved.saveKeyringPassword('keyring-password');
	await f.ready();
	assert.deepEqual(f.unlocks, ['test']);
	assert.deepEqual(f.keyringReads, [['test']]);
	assert.deepEqual(f.buttons(), []);
	assert.equal(Notice.instances.find(notice => notice.message === 'Unlocking saved profiles...').hidden, true);
});

for (const keyringEnabled of [true, false]) {
	test(`managed profiles use their remembered profile password on note open, keyring=${keyringEnabled}`, async t => {
		const f = fixture(t, {keyringEnabled});
		f.saved.saveProfilePassword('test', 'profile-password');
		await f.open('next.md', '{{vc:TEST/Group/Entry#Password}} {{vc:test/Entry}}');
		assert.deepEqual(f.unlocks, ['test']);
		assert.deepEqual(f.buttons(), []);
		assert.deepEqual(f.keyringReads, []);
	});
}

test('managed profiles use their remembered profile password after reload', async t => {
	const f = fixture(t);
	f.saved.saveProfilePassword('test', 'profile-password');
	await f.ready();
	assert.deepEqual(f.unlocks, ['test']);
});

test('keyring unlock on note switching opens only referenced managed profiles', async t => {
	const f = fixture(t);
	f.settings.profiles.other = {path: 'other.kdbx', managedByKeyring: true};
	f.saved.saveKeyringPassword('keyring-password');
	await f.open('next.md', '{{vc:test/Entry#attachment:file.txt}}');
	assert.deepEqual(f.keyringReads, [['test']]);
	assert.deepEqual(f.unlocks, ['test']);
});

test('an invalid saved keyring password falls back to the saved profile password', async t => {
	const f = fixture(t);
	f.saved.saveKeyringPassword('stale-keyring-password');
	f.saved.saveProfilePassword('test', 'profile-password');
	await f.open();
	assert.deepEqual(f.unlocks, ['test']);
	assert.equal(f.saved.loadKeyringPassword(), null);
	assert.equal(f.saved.loadProfilePassword('test'), 'profile-password');
	assert.deepEqual(f.buttons(), []);
});

test('keyring storage errors retain the master password and allow profile-password fallback', async t => {
	const f = fixture(t);
	f.saved.saveKeyringPassword('keyring-password');
	f.saved.saveProfilePassword('test', 'profile-password');
	t.mock.method(f.keyringService, 'getProfilePasswords', async () => {throw new Error('Disk unavailable');});
	await f.open();
	assert.deepEqual(f.unlocks, ['test']);
	assert.equal(f.saved.loadKeyringPassword(), 'keyring-password');
});

test('stale keyring entries fall back to the saved profile password', async t => {
	const f = fixture(t);
	f.saved.saveKeyringPassword('keyring-password');
	f.saved.saveProfilePassword('test', 'profile-password');
	t.mock.method(f.keyringService, 'getProfilePasswords', async () => new Map([['test', 'stale-profile-password']]));
	await f.open();
	assert.equal(f.unlocked.has('test'), true);
	assert.equal(f.saved.loadKeyringPassword(), 'keyring-password');
	assert.deepEqual(f.buttons(), []);
});

test('invalid profile passwords are forgotten and leave a manual keyring unlock action', async t => {
	const f = fixture(t);
	f.saved.saveProfilePassword('test', 'stale-profile-password');
	await f.open();
	assert.equal(f.unlocked.has('test'), false);
	assert.equal(f.saved.loadProfilePassword('test'), null);
	assert.deepEqual(f.buttons(), ['Unlock with keyring']);
});

test('profile storage errors preserve remembered passwords', async t => {
	const f = fixture(t, {managed: false});
	f.saved.saveProfilePassword('test', 'profile-password');
	t.mock.method(f.sessionService, 'unlockProfile', async () => {throw new Error('Disk unavailable');});
	await f.open();
	assert.equal(f.saved.loadProfilePassword('test'), 'profile-password');
	assert.deepEqual(f.buttons(), ['Unlock']);
});

test('disabled auto-unlock skips startup and keeps manual unlock actions on note open', async t => {
	const f = fixture(t, {autoUnlock: false});
	f.saved.saveKeyringPassword('keyring-password');
	await f.ready();
	assert.deepEqual(f.reads, []);
	await f.open();
	assert.deepEqual(f.unlocks, []);
	assert.deepEqual(f.keyringReads, []);
	assert.deepEqual(f.buttons(), ['Unlock with keyring']);
});

test('unlocked profiles, non-markdown files, unknown and malformed references are ignored', async t => {
	const f = fixture(t);
	f.saved.saveKeyringPassword('keyring-password');
	await f.open('image.png', '{{vc:test/Entry}}');
	assert.deepEqual(f.reads, []);
	await f.open('unknown.md', '{{vc:unknown/Entry}} {{vc:test/unfinished');
	f.unlocked.add('test');
	await f.open();
	assert.deepEqual(f.unlocks, []);
	assert.deepEqual(f.keyringReads, []);
	assert.deepEqual(f.buttons(), []);
});

test('simultaneous note opens and startup share one in-flight unlock', async t => {
	const f = fixture(t);
	f.saved.saveKeyringPassword('keyring-password');
	let complete, started;
	const gate = new Promise(resolve => {complete = resolve;});
	const beginning = new Promise(resolve => {started = resolve;});
	let calls = 0;
	t.mock.method(f.keyringService, 'getProfilePasswords', async () => {
		calls++; started(); await gate; return new Map([['test', 'profile-password']]);
	});
	const first = f.open();
	await beginning;
	await f.ready();
	const second = f.open('next.md', '{{vc:test/Another}}');
	assert.equal(calls, 1);
	complete();
	await Promise.all([first, second]);
	assert.equal(calls, 1);
	assert.deepEqual(f.unlocks, ['test']);
});

test('failed note reads do not prevent later notes from auto-unlocking', async t => {
	const f = fixture(t);
	f.saved.saveKeyringPassword('keyring-password');
	const read = f.app.vault.read;
	t.mock.method(f.app.vault, 'read', async () => {throw new Error('Read failed');});
	await f.open();
	t.mock.method(f.app.vault, 'read', read);
	await f.open('next.md', '{{vc:test/Entry}}');
	assert.deepEqual(f.unlocks, ['test']);
});

test('unloading removes listeners and prevents the deferred startup check', async t => {
	const f = fixture(t);
	f.saved.saveKeyringPassword('keyring-password');
	f.unload();
	await f.ready();
	await f.open();
	assert.deepEqual(f.reads, []);
	assert.deepEqual(f.unlocks, []);
});

test('unloading during a note read prevents auto-unlock and notifications', async t => {
	const f = fixture(t);
	f.saved.saveKeyringPassword('keyring-password');
	let complete;
	t.mock.method(f.app.vault, 'read', () => new Promise(resolve => {complete = resolve;}));
	const opening = f.open();
	await settle();
	f.unload();
	complete('{{vc:test/Entry}}');
	await opening;
	assert.deepEqual(f.unlocks, []);
	assert.deepEqual(Notice.instances, []);
});

test('profiles relocked during another unlock get a manual action instead of a false success notice', async t => {
	const f = fixture(t, {managed: false});
	f.settings.profiles.other = {path: 'other.kdbx', managedByKeyring: false};
	f.saved.saveProfilePassword('test', 'profile-password');
	f.saved.saveProfilePassword('other', 'profile-password');
	const unlock = f.sessionService.unlockProfile;
	let finish, started;
	const gate = new Promise(resolve => {finish = resolve;});
	const beginning = new Promise(resolve => {started = resolve;});
	t.mock.method(f.sessionService, 'unlockProfile', async (...args) => {
		if (args[0] === 'other') {started(); await gate;}
		await unlock(...args);
	});
	const opening = f.open('two.md', '{{vc:test/Entry}} {{vc:other/Entry}}');
	await beginning;
	f.unlocked.delete('test');
	finish();
	await opening;
	assert.equal(Notice.instances.some(notice => notice.message === 'Profile "test" unlocked.'), false);
	assert.equal(Notice.instances.some(notice => notice.message === 'Profile "other" unlocked.'), true);
	assert.equal(Notice.instances.some(notice => notice.message === 'Profile "test" is locked. '), true);
	assert.deepEqual(f.buttons(), ['Unlock']);
});

for (const reason of ['unload', 'lockAll']) {
	test(`${reason} during keyring opening prevents profile unlocks and fallback`, async t => {
		const f = fixture(t);
		f.saved.saveKeyringPassword('keyring-password');
		f.saved.saveProfilePassword('test', 'profile-password');
		let finish, started, generation = 0;
		const gate = new Promise(resolve => {finish = resolve;});
		const beginning = new Promise(resolve => {started = resolve;});
		t.mock.method(f.sessionService, 'getLockGeneration', () => generation);
		t.mock.method(f.keyringService, 'getProfilePasswords', async () => {
			started(); await gate; return new Map([['test', 'profile-password']]);
		});
		const opening = f.open();
		await beginning;
		if (reason === 'unload') f.unload();
		else generation++;
		finish();
		await opening;
		assert.deepEqual(f.unlocks, []);
		assert.equal(f.saved.loadKeyringPassword(), 'keyring-password');
		assert.equal(f.saved.loadProfilePassword('test'), 'profile-password');
	});
}
