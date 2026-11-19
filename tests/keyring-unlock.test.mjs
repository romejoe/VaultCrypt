import assert from 'node:assert/strict';
import {test} from 'node:test';
import {loadObsidianRuntime} from './helpers/obsidian-runtime.mjs';

const {KeyringUnlockModal, UnlockSessionService, TFile, Notice, kdbxweb} = await loadObsidianRuntime(`
	export {KeyringUnlockModal} from './src/modals/keyring-modals.ts';
	export {UnlockSessionService} from './src/unlock-session.ts';
	export {TFile, Notice} from 'obsidian';
	export * as kdbxweb from 'kdbxweb';
`);

function deferred() {
	let resolve;
	const promise = new Promise(done => {resolve = done;});
	return {promise, resolve};
}

function fixture(t) {
	t.mock.method(console, 'error', () => {});
	Notice.messages.length = 0;
	const encoder = new TextEncoder(), decoder = new TextDecoder();
	const app = {vault: {
		getAbstractFileByPath: path => new TFile(path),
		readBinary: async file => encoder.encode(file.path).buffer,
	}};
	const session = new UnlockSessionService(app);
	const profiles = {}, databases = new Map(), opened = [], saved = [];
	for (const id of ['first', 'second', 'third']) {
		profiles[id] = {path: `${id}.kdbx`, managedByKeyring: true, autoLockMinutes: 0};
		databases.set(`${id}.kdbx`, kdbxweb.Kdbx.create(new kdbxweb.KdbxCredentials(kdbxweb.ProtectedValue.fromString('test')), id));
	}
	t.mock.method(kdbxweb.Kdbx, 'load', async buffer => {
		const path = decoder.decode(buffer); opened.push(path); return databases.get(path);
	});
	const passwords = new Map(Object.keys(profiles).map(id => [id, 'test']));
	const keyring = {getProfilePasswords: async () => passwords};
	const plugin = {settings: {profiles, masterKeyringPath: 'keyring.kdbx'}, sessionService: session,
		keyringService: keyring, secretStorageService: {
			saveKeyringPassword: () => {saved.push('save'); return true;},
			forgetKeyringPassword: () => {saved.push('forget'); return true;},
		},
	};
	let done = 0, closed = false;
	const modal = new KeyringUnlockModal(app, plugin, () => {done++;});
	modal.password = 'master'; modal.rememberPassword = true;
	modal.errorEl = {textContent: '', removeClass() {}};
	modal.submitBtn = {setDisabled() {}};
	modal.close = () => {closed = true;};
	return {session, modal, keyring, databases, passwords, opened, saved, done: () => done, closed: () => closed};
}

test('keyring unlocking counts successful profiles and skips unknown configurations', async t => {
	const f = fixture(t);
	f.passwords.set('unknown', 'test');
	await f.modal.submit();
	assert.equal(Notice.messages.includes('Unlocked 3 profiles via keyring.'), true);
	assert.deepEqual(f.saved, ['save']);
	assert.equal(f.done(), 1);
	assert.equal(f.closed(), true);
});

test('a failed profile does not prevent other keyring profiles from unlocking', async t => {
	const f = fixture(t);
	const load = kdbxweb.Kdbx.load;
	t.mock.method(kdbxweb.Kdbx, 'load', async (...args) => {
		if (new TextDecoder().decode(args[0]) === 'second.kdbx') throw new Error('InvalidKey');
		return load(...args);
	});
	await f.modal.submit();
	assert.equal(Notice.messages.includes('Unlocked 2 profiles via keyring.'), true);
	assert.ok(Notice.messages.some(message => message.startsWith('Failed to unlock: second.')));
});

test('lockAll during keyring reading cancels the entire batch', async t => {
	const f = fixture(t), gate = deferred(), started = deferred();
	t.mock.method(f.keyring, 'getProfilePasswords', async () => {
		started.resolve(); await gate.promise; return f.passwords;
	});
	const pending = f.modal.submit();
	await started.promise;
	f.session.lockAll();
	gate.resolve();
	await pending;
	assert.deepEqual(f.opened, []);
	assert.deepEqual(Notice.messages, []);
	assert.deepEqual(f.saved, []);
	assert.equal(f.done(), 0);
	assert.match(f.modal.errorEl.textContent, /Unlock cancelled/);
});

for (const pendingProfile of ['first', 'second']) {
	test(`lockAll while ${pendingProfile} is decrypting stops later profiles and success callbacks`, async t => {
		const f = fixture(t), gate = deferred(), started = deferred();
		const load = kdbxweb.Kdbx.load;
		t.mock.method(kdbxweb.Kdbx, 'load', async (...args) => {
			if (new TextDecoder().decode(args[0]) === `${pendingProfile}.kdbx`) {
				started.resolve(); await gate.promise;
			}
			return load(...args);
		});
		const pending = f.modal.submit();
		await started.promise;
		f.session.lockAll();
		gate.resolve();
		await pending;
		assert.equal(f.session.isUnlocked('first'), false);
		assert.equal(f.session.isUnlocked('second'), false);
		assert.equal(f.session.isUnlocked('third'), false);
		assert.equal(f.opened.includes('third.kdbx'), false);
		if (pendingProfile === 'first') assert.equal(f.opened.includes('second.kdbx'), false);
		assert.deepEqual(Notice.messages, []);
		assert.deepEqual(f.saved, []);
		assert.equal(f.done(), 0);
		assert.equal(f.closed(), false);
		assert.equal(f.modal.isSubmitting, false);
		assert.match(f.modal.errorEl.textContent, /Unlock cancelled/);
	});
}
