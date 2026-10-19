'use strict';
// Isolated per-run databases (harness/run-db.js). Each test uses its own temp root, so nothing here
// can touch files outside it.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRunDatabase } = require('../harness/run-db');
const { startMerchant } = require('./helpers');
const { takeSnapshot } = require('../harness/snapshot');
const v1 = require('../harness/mappings/reference');

let tmpRoot;
beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'payprobe-rundb-test-'));
});
afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

// Starts the reference app on a fresh run database and opens one reader after initialization.
async function startRun() {
  const run = createRunDatabase({ tmpRoot });
  const m = await startMerchant('reference', { dbPath: run.dbPath });
  const reader = run.openReader();
  return { run, m, reader };
}

describe('run-db: isolated per-run SQLite databases', () => {
  it('creates a new directory under the temp root; the database path does not exist beforehand', () => {
    const run = createRunDatabase({ tmpRoot });
    assert.equal(path.dirname(run.dir), fs.realpathSync(tmpRoot));
    assert.ok(path.basename(run.dir).startsWith('payprobe-run-'));
    assert.equal(fs.existsSync(run.dbPath), false);
    assert.deepEqual(fs.readdirSync(run.dir), []);
    const d = run.describe();
    assert.equal(d.existedBefore, false);
    assert.equal(d.path, run.dbPath);
    assert.equal(d.reader.busyTimeoutMs, 5000);
    assert.notEqual(createRunDatabase({ tmpRoot }).dir, run.dir, 'every run gets its own directory');
  });

  it('refuses unsafe names and readers before the app has created the database', () => {
    assert.throws(() => createRunDatabase({ tmpRoot, prefix: '../x' }), /unsafe prefix/);
    assert.throws(() => createRunDatabase({ tmpRoot, fileName: 'sub/target.db' }), /bare file name/);
    const run = createRunDatabase({ tmpRoot });
    assert.throws(() => run.openReader(), /does not exist yet/);
  });

  it('independent runs do not share state', async () => {
    const a = await startRun();
    const b = await startRun();
    try {
      a.m.db.exec(`UPDATE products SET stock = 1 WHERE sku = 'TSHIRT'`);
      assert.notEqual(a.run.dbPath, b.run.dbPath);
      assert.equal(takeSnapshot(a.reader, v1).stock.TSHIRT, 1);
      assert.equal(takeSnapshot(b.reader, v1).stock.TSHIRT, 100);
    } finally {
      for (const x of [a, b]) {
        x.run.closeReaders();
        await x.m.close();
        await x.run.cleanup();
      }
    }
  });

  it('a reader is a separate read-only connection: it rejects writes and sees committed app writes', async () => {
    const { run, m, reader } = await startRun();
    try {
      assert.notEqual(reader, m.db);
      assert.throws(() => reader.exec(`UPDATE products SET stock = 0`), /readonly/i);
      assert.throws(() => reader.exec(`CREATE TABLE x (y)`), /readonly/i);
      assert.equal(reader.prepare('PRAGMA busy_timeout').get().timeout, 5000);
      assert.equal(takeSnapshot(reader, v1).stock.TSHIRT, 100);
      m.db.exec(`UPDATE products SET stock = stock - 3 WHERE sku = 'TSHIRT'`);
      assert.equal(takeSnapshot(reader, v1).stock.TSHIRT, 97, 'committed write visible to the next read');
    } finally {
      run.closeReaders();
      await m.close();
      await run.cleanup();
    }
  });

  it('cleanup closes readers and removes the directory; a second cleanup is a no-op', async () => {
    const { run, m, reader } = await startRun();
    run.openReader();
    assert.equal(run.openReaders, 2);
    await m.close();
    const res = await run.cleanup();
    assert.equal(run.openReaders, 0);
    assert.equal(reader.isOpen, false);
    assert.deepEqual(res, { removed: true, kept: null, leftover: [], error: null });
    assert.equal(fs.existsSync(run.dir), false);
    assert.equal((await run.cleanup()).removed, true);
    assert.throws(() => run.openReader(), /run is removed/);
  });

  it('keep: true preserves a failed run for debugging', async () => {
    const { run, m } = await startRun();
    run.closeReaders();
    await m.close();
    const res = await run.cleanup({ keep: true });
    assert.equal(res.kept, run.dir);
    assert.equal(run.state, 'kept');
    assert.ok(fs.existsSync(run.dbPath));
  });

  it('never deletes files it did not create: an unrelated file stops directory removal', async () => {
    const { run, m } = await startRun();
    run.closeReaders();
    await m.close();
    const unrelated = path.join(run.dir, 'notes.txt');
    fs.writeFileSync(unrelated, 'keep me');
    const sibling = path.join(tmpRoot, 'sibling.txt');
    fs.writeFileSync(sibling, 'keep me too');
    const res = await run.cleanup();
    assert.equal(res.removed, false);
    assert.match(res.error, /did not create \(notes\.txt\)/);
    assert.deepEqual(res.leftover, ['notes.txt']);
    assert.equal(fs.readFileSync(unrelated, 'utf8'), 'keep me');
    assert.equal(fs.readFileSync(sibling, 'utf8'), 'keep me too');
    assert.equal(fs.existsSync(run.dbPath), false, 'its own database file is still removed');
  });

  it('a directory replaced after creation is not touched', async () => {
    const run = createRunDatabase({ tmpRoot });
    fs.rmdirSync(run.dir);
    fs.writeFileSync(run.dir, 'a file now occupies the run path');
    const res = await run.cleanup();
    assert.equal(res.removed, false);
    assert.match(res.error, /not the directory this run created/);
    assert.equal(fs.readFileSync(run.dir, 'utf8'), 'a file now occupies the run path');
  });

  it('cleanup while the app still holds the database fails safely or succeeds, and never throws', async () => {
    const { run, m } = await startRun();
    const res = await run.cleanup({ retries: 2, retryDelayMs: 10 }); // app connection deliberately still open
    if (process.platform === 'win32') {
      assert.equal(res.removed, false, 'Windows keeps open SQLite files locked');
      assert.match(res.error, /is a connection still open/);
      assert.ok(fs.existsSync(run.dir));
    } else {
      assert.equal(typeof res.removed, 'boolean');
    }
    await m.close();
    assert.equal((await run.cleanup()).removed, true, 'a later cleanup succeeds once the app has stopped');
  });
});
