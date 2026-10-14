'use strict';
// One experiment run = one fresh SQLite file in its own temporary directory.
//
//   const run = createRunDatabase();          // new directory, database file must not exist yet
//   ... start the app with run.dbPath ...      // the app creates and initializes the file
//   const reader = run.openReader();           // separate read-only connection, 5 s busy timeout
//   ... read state through `reader` only ...
//   run.closeReaders();                        // before the app stops
//   ... stop the app ...
//   run.cleanup({ keep: failed && debugging }) // removes only files this module knows about
//
// Cleanup never deletes recursively. It removes the database file and SQLite's own side files
// (-wal, -shm, -journal), then the directory only if it is empty. Anything else found in the
// directory is reported and left in place, so unrelated files are never deleted.
// Paths returned here are local and absolute: redact them before any public-facing output.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DEFAULT_PREFIX = 'payprobe-run-';
const DEFAULT_FILE = 'target.db';
const SIDE_SUFFIXES = ['', '-wal', '-shm', '-journal'];
const BUSY_TIMEOUT_MS = 5000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createRunDatabase({ tmpRoot = os.tmpdir(), prefix = DEFAULT_PREFIX, fileName = DEFAULT_FILE } = {}) {
  if (!/^[A-Za-z0-9._-]+$/.test(prefix)) throw new Error(`run-db: unsafe prefix ${JSON.stringify(prefix)}`);
  if (path.basename(fileName) !== fileName) throw new Error('run-db: fileName must be a bare file name');
  const root = fs.realpathSync(tmpRoot);
  const dir = fs.mkdtempSync(path.join(root, prefix)); // unique, created by this call
  const dbPath = path.join(dir, fileName);
  const ownFiles = SIDE_SUFFIXES.map((s) => `${fileName}${s}`);
  const existing = ownFiles.filter((f) => fs.existsSync(path.join(dir, f)));
  if (existing.length) throw new Error(`run-db: ${existing.join(', ')} already exist in ${dir}; refusing to reuse a database`);

  const createdAt = new Date().toISOString();
  const runId = crypto.randomBytes(6).toString('hex');
  const readers = new Set();
  let state = 'open'; // open -> removed | kept | cleanup_failed

  function closeReaders() {
    for (const r of readers) {
      try {
        if (r.isOpen) r.close();
      } catch {
        // already closed by its user
      }
    }
    readers.clear();
  }

  return {
    runId,
    dir,
    dbPath,

    // A separate read-only connection. The app must already have created the database.
    openReader({ busyTimeoutMs = BUSY_TIMEOUT_MS } = {}) {
      if (state !== 'open') throw new Error(`run-db: run is ${state}`);
      if (!fs.existsSync(dbPath)) throw new Error('run-db: database file does not exist yet; open readers after the app has initialized it');
      const reader = new DatabaseSync(dbPath, { readOnly: true });
      reader.exec(`PRAGMA busy_timeout = ${Number(busyTimeoutMs) | 0}`);
      readers.add(reader);
      return reader;
    },

    closeReaders,

    get openReaders() {
      return [...readers].filter((r) => r.isOpen).length;
    },

    get state() {
      return state;
    },

    // Metadata for run records. `path` and `directory` are local absolute paths (see header).
    describe() {
      return {
        runId,
        path: dbPath,
        directory: dir,
        fileName,
        createdAt,
        existedBefore: false, // enforced at creation: the directory is new and held no database files
        createdBy: 'harness/run-db.js',
        reader: { separateConnection: true, readOnly: true, busyTimeoutMs: BUSY_TIMEOUT_MS },
      };
    },

    // Closes readers, then removes this run's files. Never throws for filesystem errors; returns
    // { removed, kept, leftover, error }. keep: true preserves everything for debugging.
    async cleanup({ keep = false, retries = 10, retryDelayMs = 100 } = {}) {
      closeReaders();
      if (state === 'removed' || state === 'kept') return { removed: state === 'removed', kept: state === 'kept' ? dir : null, leftover: [], error: null };
      if (keep) {
        state = 'kept';
        return { removed: false, kept: dir, leftover: [], error: null };
      }
      // Re-check that the directory is still what we created: a real directory, directly in the
      // temp root, with our prefix. Anything else is left alone.
      let st;
      try {
        st = fs.lstatSync(dir);
      } catch {
        state = 'removed';
        return { removed: true, kept: null, leftover: [], error: null };
      }
      if (!st.isDirectory() || st.isSymbolicLink() || path.dirname(dir) !== root || !path.basename(dir).startsWith(prefix)) {
        state = 'cleanup_failed';
        return { removed: false, kept: null, leftover: [], error: `run-db: ${dir} is not the directory this run created; not touched` };
      }
      let lastError = null;
      for (let attempt = 0; attempt <= retries; attempt++) {
        lastError = null;
        for (const f of ownFiles) {
          try {
            fs.rmSync(path.join(dir, f), { force: true });
          } catch (err) {
            lastError = err; // typically EBUSY/EPERM on Windows while a connection is still open
          }
        }
        if (!lastError) break;
        await sleep(retryDelayMs);
      }
      const leftover = fs.readdirSync(dir);
      if (lastError || leftover.length) {
        state = 'cleanup_failed';
        const unrelated = leftover.filter((f) => !ownFiles.includes(f));
        return {
          removed: false,
          kept: null,
          leftover,
          error: lastError
            ? `run-db: could not remove database files (${lastError.code ?? lastError.message}); is a connection still open?`
            : `run-db: directory holds files this run did not create (${unrelated.join(', ')}); left in place`,
        };
      }
      try {
        fs.rmdirSync(dir); // non-recursive: fails rather than deleting anything unexpected
      } catch (err) {
        state = 'cleanup_failed';
        return { removed: false, kept: null, leftover: fs.readdirSync(dir), error: `run-db: ${err.code ?? err.message}` };
      }
      state = 'removed';
      return { removed: true, kept: null, leftover: [], error: null };
    },
  };
}

module.exports = { createRunDatabase, BUSY_TIMEOUT_MS, DEFAULT_PREFIX };
