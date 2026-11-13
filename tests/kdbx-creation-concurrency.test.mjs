import assert from 'node:assert/strict';
import {test} from 'node:test';
import {KdbxService, KdbxFileError, fixture} from './helpers/kdbx-storage.mjs';

const testKdf = {iterations: 2, memory: 32, parallelism: 1};
const path = '.vaultcrypt/concurrent.kdbx';

function deferred() {
	let resolve;
	const promise = new Promise(done => { resolve = done; });
	return {promise, resolve};
}

test('same-path creations across service instances reject before checking disk', async t => {
	const {app, disk} = fixture();
	const enteredWrite = deferred();
	const releaseWrite = deferred();
	const originalWrite = app.vault.adapter.writeBinary;
	let firstWrite = true;
	t.mock.method(app.vault.adapter, 'writeBinary', async (...args) => {
		if (firstWrite) {
			firstWrite = false;
			enteredWrite.resolve();
			await releaseWrite.promise;
		}
		return originalWrite(...args);
	});
	const first = new KdbxService(app);
	const pending = first.createDatabase(path, 'first password', 4, testKdf);
	try {
		await enteredWrite.promise;
		const stat = t.mock.method(app.vault.adapter, 'stat');
		for (let attempt = 0; attempt < 2; attempt++) {
			await assert.rejects(new KdbxService(app).createDatabase(path, 'second password', 4, testKdf),
				error => error instanceof KdbxFileError && /already being created/.test(error.message) && error.message.includes(path));
		}
		assert.equal(stat.mock.calls.length, 0);
		assert.equal(disk.has(path), false);
	} finally {
		releaseWrite.resolve();
		await pending;
		first.closeDatabase();
	}
	const reopened = new KdbxService(app);
	await reopened.openDatabase(path, 'first password');
	reopened.closeDatabase();
	await assert.rejects(reopened.openDatabase(path, 'second password'));
	// Successful creation releases the guard: a later attempt reaches the disk check.
	await assert.rejects(reopened.createDatabase(path, 'third password', 4, testKdf), /path already exists/);
});

for (const failure of ['stat', 'writeBinary']) {
	test(`creation can be retried after ${failure} fails`, async t => {
		const {app, disk} = fixture();
		const error = new Error('Storage unavailable');
		const operation = t.mock.method(app.vault.adapter, failure, async () => { throw error; });
		await assert.rejects(new KdbxService(app).createDatabase(path, 'password', 4, testKdf),
			caught => caught === error || caught.originalError === error);
		assert.equal(disk.has(path), false);
		operation.mock.restore();
		await new KdbxService(app).createDatabase(path, 'password', 4, testKdf);
		assert.equal(disk.has(path), true);
	});
}

test('different paths and separate vaults can create while another creation is pending', async t => {
	const firstVault = fixture();
	const secondVault = fixture();
	const enteredStat = deferred();
	const releaseStat = deferred();
	const originalStat = firstVault.app.vault.adapter.stat;
	t.mock.method(firstVault.app.vault.adapter, 'stat', async checkedPath => {
		if (checkedPath === path) {
			enteredStat.resolve();
			await releaseStat.promise;
		}
		return originalStat(checkedPath);
	});
	const pending = new KdbxService(firstVault.app).createDatabase(path, 'password', 4, testKdf);
	try {
		await enteredStat.promise;
		const otherPath = '.vaultcrypt/other.kdbx';
		await new KdbxService(firstVault.app).createDatabase(otherPath, 'password', 4, testKdf);
		await new KdbxService(secondVault.app).createDatabase(path, 'password', 4, testKdf);
		assert.equal(firstVault.disk.has(otherPath), true);
		assert.equal(secondVault.disk.has(path), true);
	} finally {
		releaseStat.resolve();
		await pending;
	}
});
