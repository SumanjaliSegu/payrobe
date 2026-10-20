'use strict';
// Benchmark reports are evidence: saved at the start and after every app (so completed apps survive a later
// crash or kill), with a real start time, a completion time, and a file name that never replaces another
// run's report.
const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runBenchmark, createReportWriter } = require('../harness/bench');

const ROOT = path.join(__dirname, '..');
const fakeResult = (app) => ({ app, role: 'control', status: 'completed', handwritten: { scenarios: 0, violations: 0, clean: 0, inconclusive: 0, detail: [] }, ai: null, falsePositives: 0, reproducedViolations: 0 });
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const tick = () => new Promise((r) => setTimeout(r, 5));

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'payprobe-bench-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('benchmark report persistence', () => {
  it('saves at the start and after each app; a mid-run read sees the completed apps only', async () => {
    const writer = createReportWriter(dir);
    const statuses = [];
    const seenOnDisk = {};
    const report = await runBenchmark({
      apps: ['reference', 'unseen2', 'vulnerable'], scenarios: [], startTargetFor: () => null,
      onProgress: (r) => { statuses.push(r.status); writer.write(r); },
      benchAppImpl: async (app) => {
        // What a kill at this moment would leave behind.
        seenOnDisk[app] = read(writer.file);
        await tick();
        return fakeResult(app);
      },
    });
    assert.deepEqual(statuses, ['running', 'partial', 'partial', 'completed']);
    assert.equal(seenOnDisk.reference.status, 'running');
    assert.deepEqual(seenOnDisk.reference.results, []);
    assert.equal(seenOnDisk.vulnerable.status, 'partial');
    assert.deepEqual(seenOnDisk.vulnerable.appsCompleted, ['reference', 'unseen2']);
    assert.deepEqual(seenOnDisk.vulnerable.appsRequested, ['reference', 'unseen2', 'vulnerable']);
    assert.equal(seenOnDisk.vulnerable.completedAt, null, 'a partial report has no completion time');

    const final = read(writer.file);
    assert.deepEqual(final, JSON.parse(JSON.stringify(report)));
    assert.equal(final.status, 'completed');
    assert.deepEqual(final.appsCompleted, ['reference', 'unseen2', 'vulnerable']);
    assert.deepEqual(fs.readdirSync(dir), [path.basename(writer.file)], 'one file per run, no temp file left');
  });

  it('startedAt is the real start time and completedAt the end; the file is named by the start', async () => {
    const writer = createReportWriter(dir);
    const before = new Date().toISOString();
    let firstAppAt = null;
    let lastAppDoneAt = null;
    const report = await runBenchmark({
      apps: ['reference', 'unseen2'], scenarios: [], startTargetFor: () => null, onProgress: (r) => writer.write(r),
      benchAppImpl: async (app) => { firstAppAt ??= new Date().toISOString(); await tick(); lastAppDoneAt = new Date().toISOString(); return fakeResult(app); },
    });
    const after = new Date().toISOString();
    assert.ok(before <= report.startedAt && report.startedAt <= firstAppAt, 'startedAt precedes the first app');
    assert.ok(lastAppDoneAt <= report.completedAt && report.completedAt <= after, 'completedAt follows the last app');
    assert.ok(report.startedAt < report.completedAt);
    assert.equal(path.basename(writer.file), `benchmark-${report.startedAt.replace(/[:.]/g, '-')}.json`);
  });

  it('an app that throws leaves a failed report with the earlier apps intact, and the error propagates', async () => {
    const writer = createReportWriter(dir);
    await assert.rejects(runBenchmark({
      apps: ['reference', 'unseen', 'vulnerable'], scenarios: [], startTargetFor: () => null, onProgress: (r) => writer.write(r),
      benchAppImpl: async (app) => { if (app === 'unseen') throw new Error('target crashed'); return fakeResult(app); },
    }), (err) => {
      assert.match(err.message, /target crashed/);
      assert.equal(err.report.status, 'failed');
      return true;
    });
    const saved = read(writer.file);
    assert.equal(saved.status, 'failed');
    assert.deepEqual(saved.error, { app: 'unseen', message: 'target crashed' });
    assert.deepEqual(saved.appsCompleted, ['reference']);
    assert.equal(saved.results[0].app, 'reference');
    assert.equal(saved.completedAt, null);
  });

  it('never overwrites another run\'s report: a name clash gets a suffix and the old file is byte-identical', () => {
    const startedAt = '2026-10-19T09:10:06.439Z';
    const existing = path.join(dir, 'benchmark-2026-10-19T09-10-06-439Z.json');
    fs.writeFileSync(existing, '{"historical":"evidence"}');
    const a = createReportWriter(dir);
    const b = createReportWriter(dir);
    a.write({ startedAt, status: 'running', n: 1 });
    b.write({ startedAt, status: 'running', n: 2 });
    a.write({ startedAt, status: 'completed', n: 3 });
    assert.equal(fs.readFileSync(existing, 'utf8'), '{"historical":"evidence"}');
    assert.equal(path.basename(a.file), 'benchmark-2026-10-19T09-10-06-439Z-1.json');
    assert.equal(path.basename(b.file), 'benchmark-2026-10-19T09-10-06-439Z-2.json');
    assert.equal(read(a.file).n, 3, 'a run updates only its own file');
    assert.equal(read(b.file).n, 2);
  });

  it('a save that fails part-way keeps the previous save of the same run', () => {
    const w = createReportWriter(dir);
    w.write({ startedAt: '2026-10-19T10:00:00.000Z', status: 'partial', appsCompleted: ['reference'] });
    assert.throws(() => w.write({ startedAt: '2026-10-19T10:00:00.000Z', status: 'completed', bad: 1n }));
    assert.deepEqual(read(w.file).appsCompleted, ['reference']);
  });

  it('the CLI rejects an unknown app name before running anything or writing a report', () => {
    const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'bin/payprobe-bench.js', '--apps', 'reference,refrence', '--out', dir], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown app\(s\): refrence/);
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});
