import assert from 'node:assert/strict';
import {test} from 'node:test';
import {loadObsidianRuntime} from './helpers/obsidian-runtime.mjs';

const {UnlockSessionService, TFile, kdbxweb} = await loadObsidianRuntime(`
	export {UnlockSessionService} from './src/unlock-session.ts';
	export {TFile} from 'obsidian';
	export * as kdbxweb from 'kdbxweb';
`);

function deferred() {
	let resolve, reject;
	const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
	return {promise, resolve, reject};
}

async function fixture(t) {
	const databases = new Map();
	const persisted = new Map();
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();
	let write = async (path, buffer) => { persisted.set(path, JSON.parse(decoder.decode(buffer))); };
	const app = {vault: {
		getAbstractFileByPath: path => new TFile(path),
		readBinary: async file => encoder.encode(file.path).buffer,
		modifyBinary: async (file, buffer) => write(file.path, buffer),
	}};
	const service = new UnlockSessionService(app);
	t.mock.method(kdbxweb.Kdbx, 'load', async buffer => databases.get(decoder.decode(buffer)));
	for (const id of ['test', 'other']) {
		const db = kdbxweb.Kdbx.create(new kdbxweb.KdbxCredentials(kdbxweb.ProtectedValue.fromString('test')), id);
		databases.set(`${id}.kdbx`, db);
		t.mock.method(db, 'save', async () => encoder.encode(JSON.stringify({
			fields: service.getEntryFields(id, 'Entry'),
			attachments: service.getEntryAttachmentNames(id, 'Entry'),
		})).buffer);
		await service.unlockProfile(id, {path: `${id}.kdbx`, autoLockMinutes: 0}, 'test');
		await service.createEntryWithFields(id, 'Entry', {Password: 'before', Notes: 'old notes'}, `${id}.kdbx`);
	}
	return {service, persisted, databases, setWrite: callback => { write = callback; }};
}

for (const failure of ['save', 'write']) {
	test(`a failed ${failure} rolls back before the next mutation and never persists stale values`, async t => {
		const {service, persisted, databases, setWrite} = await fixture(t);
		const pending = deferred();
		const started = deferred();
		let saves = 0;
		const db = databases.get('test.kdbx');
		const originalSave = db.save;
		t.mock.method(db, 'save', async () => {
			saves++;
			if (failure === 'save' && saves === 1) {
				started.resolve();
				await pending.promise;
			}
			return originalSave();
		});
		let writes = 0;
		setWrite(async (path, buffer) => {
			writes++;
			if (failure === 'write' && writes === 1) {
				started.resolve();
				await pending.promise;
			}
			persisted.set(path, JSON.parse(new TextDecoder().decode(buffer)));
		});
		const first = service.setFieldValue('test', 'Entry', 'Password', 'rejected', 'test.kdbx');
		const rejected = assert.rejects(first);
		await started.promise;
		const second = service.setFieldValue('test', 'Entry', 'Password', 'saved later', 'test.kdbx');
		await Promise.resolve();
		assert.equal(saves, 1);
		assert.equal(service.getFieldValue('test', 'Entry', 'Password'), 'rejected');
		pending.reject(new Error('Storage failed'));
		await rejected;
		await second;
		assert.equal(service.getFieldValue('test', 'Entry', 'Password'), 'saved later');
		assert.equal(persisted.get('test.kdbx').fields.Password, 'saved later');
		await service.setFieldValue('test', 'Entry', 'Notes', 'next save', 'test.kdbx');
		assert.equal(persisted.get('test.kdbx').fields.Password, 'saved later');
	});
}

const mutations = {
	field: service => service.setFieldValue('test', 'Entry', 'Password', 'later', 'test.kdbx'),
	entry: service => service.updateEntryFields('test', 'Entry', {Password: 'later'}, 'test.kdbx'),
	create: service => service.createEntryWithFields('test', 'NewEntry', {Password: 'new'}, 'test.kdbx'),
	delete: service => service.deleteEntry('test', 'Entry', 'test.kdbx'),
	attachment: service => service.setAttachment('test', 'Entry', 'new.txt', new ArrayBuffer(1), 'test.kdbx'),
	deleteAttachment: service => service.deleteAttachment('test', 'Entry', 'old.txt', 'test.kdbx'),
};

for (const [name, mutate] of Object.entries(mutations)) {
	test(`${name} waits for the previous profile write while other profiles can save`, async t => {
		const {service, persisted, setWrite} = await fixture(t);
		await service.setAttachment('test', 'Entry', 'old.txt', new ArrayBuffer(1), 'test.kdbx');
		const pending = deferred();
		const started = deferred();
		let writes = 0;
		setWrite(async (path, buffer) => {
			if (path === 'test.kdbx' && ++writes === 1) {
				started.resolve();
				await pending.promise;
			}
			persisted.set(path, JSON.parse(new TextDecoder().decode(buffer)));
		});
		const first = service.setFieldValue('test', 'Entry', 'Notes', 'first', 'test.kdbx');
		await started.promise;
		const second = mutate(service);
		await service.setFieldValue('other', 'Entry', 'Password', 'independent', 'other.kdbx');
		assert.equal(writes, 1);
		assert.equal(service.getFieldValue('test', 'Entry', 'Password'), 'before');
		assert.equal(service.getEntryFields('test', 'NewEntry'), null);
		assert.deepEqual(service.getEntryAttachmentNames('test', 'Entry'), ['old.txt']);
		assert.equal(persisted.get('other.kdbx').fields.Password, 'independent');
		pending.resolve();
		await Promise.all([first, second]);
		assert.equal(writes, 2);
	});
}

for (const name of ['create', 'delete']) {
	test(`a failed ${name} locks the profile before queued changes can be persisted`, async t => {
		const {service, persisted, setWrite} = await fixture(t);
		const pending = deferred();
		const started = deferred();
		let writes = 0;
		setWrite(async () => { writes++; started.resolve(); await pending.promise; });
		const first = mutations[name](service);
		const firstRejected = assert.rejects(first);
		await started.promise;
		const second = service.setFieldValue('test', 'Entry', 'Password', 'must not save', 'test.kdbx');
		const secondRejected = assert.rejects(second, /session changed/);
		pending.reject(new Error('Disk unavailable'));
		await Promise.all([firstRejected, secondRejected]);
		assert.equal(service.isUnlocked('test'), false);
		assert.equal(writes, 1);
		assert.equal(persisted.get('test.kdbx').fields.Password, 'before');
	});
}

const lockingMutations = {
	newFieldEntry: service => service.setFieldValue('test', 'NewGroup/NewEntry', 'Password', 'new', 'test.kdbx'),
	delete: mutations.delete,
	deleteAttachment: mutations.deleteAttachment,
	create: mutations.create,
};

for (const [name, mutate] of Object.entries(lockingMutations)) {
	for (const failure of ['save', 'write']) {
		test(`a stale ${name} ${failure} failure preserves the replacement session and its queued edits`, async t => {
			const {service, databases, persisted, setWrite} = await fixture(t);
			await service.setAttachment('test', 'Entry', 'old.txt', new ArrayBuffer(1), 'test.kdbx');
			const pending = deferred();
			const started = deferred();
			if (failure === 'save') {
				t.mock.method(databases.get('test.kdbx'), 'save', async () => {
					started.resolve();
					await pending.promise;
				});
			}
			let firstWrite = true;
			setWrite(async (path, buffer) => {
				if (failure === 'write' && firstWrite) {
					firstWrite = false;
					started.resolve();
					await pending.promise;
				}
				persisted.set(path, JSON.parse(new TextDecoder().decode(buffer)));
			});
			const oldSave = mutate(service);
			await started.promise;
			const locks = [];
			service.onLock(id => locks.push(id));
			service.lockProfile('test');
			const replacement = kdbxweb.Kdbx.create(new kdbxweb.KdbxCredentials(kdbxweb.ProtectedValue.fromString('test')), 'replacement');
			const entry = replacement.createEntry(replacement.getDefaultGroup());
			entry.fields.set('Title', 'Entry');
			entry.fields.set('Password', kdbxweb.ProtectedValue.fromString('reopened'));
			databases.set('test.kdbx', replacement);
			t.mock.method(replacement, 'save', async () => new TextEncoder().encode(JSON.stringify({
				fields: service.getEntryFields('test', 'Entry'),
			})).buffer);
			await service.unlockProfile('test', {path: 'test.kdbx', autoLockMinutes: 0}, 'test');
			const replacementSave = service.setFieldValue('test', 'Entry', 'Password', 'saved in replacement', 'test.kdbx');
			const completed = Promise.allSettled([oldSave, replacementSave]);
			pending.reject(new Error('Old save failed'));
			const [oldResult, replacementResult] = await completed;
			assert.equal(oldResult.status, 'rejected');
			assert.equal(service.getDatabase('test'), replacement);
			assert.deepEqual(locks, ['test']);
			assert.equal(replacementResult.status, 'fulfilled');
			assert.equal(service.getFieldValue('test', 'Entry', 'Password'), 'saved in replacement');
			assert.equal(persisted.get('test.kdbx').fields.Password, 'saved in replacement');
		});
	}
}

test('queued mutations reject if the profile was locked and reopened', async t => {
	const {service, setWrite} = await fixture(t);
	const pending = deferred();
	const started = deferred();
	setWrite(async () => { started.resolve(); await pending.promise; });
	const first = service.setFieldValue('test', 'Entry', 'Notes', 'in flight', 'test.kdbx');
	await started.promise;
	const second = service.setFieldValue('test', 'Entry', 'Password', 'stale request', 'test.kdbx');
	const rejected = assert.rejects(second, /session changed/);
	service.lockProfile('test');
	const reopened = kdbxweb.Kdbx.create(new kdbxweb.KdbxCredentials(kdbxweb.ProtectedValue.fromString('test')), 'reopened');
	t.mock.method(kdbxweb.Kdbx, 'load', async () => reopened);
	await service.unlockProfile('test', {path: 'test.kdbx', autoLockMinutes: 0}, 'test');
	pending.resolve();
	await first;
	await rejected;
	assert.equal(service.getDatabase('test'), reopened);
	assert.equal(service.getEntryFields('test', 'Entry'), null);
});
