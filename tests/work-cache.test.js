'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  OWNER_FILE_NAME,
  cleanupStaleWorkCache,
  createJobWorkDirectory,
  defaultWorkRoot,
  writeOwnerFile,
} = require('../src/work-cache');

function makeCacheRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'media-converter-cache-'));
}

test('default cache root is under the OS temp directory', () => {
  const root = defaultWorkRoot();
  assert.equal(path.basename(root), 'serpent-media-converter');
  assert.equal(path.dirname(root), os.tmpdir());
});

test('creates a job directory with a live owner marker', () => {
  const root = makeCacheRoot();
  const workDirectory = createJobWorkDirectory(root);
  assert.ok(workDirectory.startsWith(root));
  assert.match(path.basename(workDirectory), /^job-/);
  const owner = JSON.parse(fs.readFileSync(path.join(workDirectory, OWNER_FILE_NAME), 'utf8'));
  assert.equal(owner.pid, process.pid);
});

test('keeps job directories owned by a live process', () => {
  const root = makeCacheRoot();
  const live = createJobWorkDirectory(root);
  fs.writeFileSync(path.join(live, 'chunk.bin'), 'x'.repeat(32));
  assert.equal(cleanupStaleWorkCache(root), 0);
  assert.equal(fs.existsSync(live), true);
});

test('removes job directories whose owner process is gone', () => {
  const root = makeCacheRoot();
  const stale = fs.mkdtempSync(path.join(root, 'job-'));
  writeOwnerFile(stale, 1_000_000_000, Date.now() - 60_000);
  fs.writeFileSync(path.join(stale, 'huge.bin'), 'leftover');
  assert.equal(isLikelyDeadPid(1_000_000_000), true);
  assert.equal(cleanupStaleWorkCache(root), 1);
  assert.equal(fs.existsSync(stale), false);
});

test('keeps explicitly reserved directories even with a dead owner', () => {
  const root = makeCacheRoot();
  const reserved = fs.mkdtempSync(path.join(root, 'job-'));
  writeOwnerFile(reserved, 1_000_000_000, Date.now() - 60_000);
  assert.equal(cleanupStaleWorkCache(root, { keep: new Set([reserved]) }), 0);
  assert.equal(fs.existsSync(reserved), true);
});

test('removes ownerless directories after the grace period', () => {
  const root = makeCacheRoot();
  const stale = fs.mkdtempSync(path.join(root, 'job-'));
  const now = Date.now();
  fs.utimesSync(stale, new Date(now - 10 * 60 * 1000), new Date(now - 10 * 60 * 1000));
  assert.equal(cleanupStaleWorkCache(root, { now, graceMs: 2 * 60 * 1000 }), 1);
  assert.equal(fs.existsSync(stale), false);
});

test('does not remove a brand-new ownerless directory', () => {
  const root = makeCacheRoot();
  const fresh = fs.mkdtempSync(path.join(root, 'job-'));
  assert.equal(cleanupStaleWorkCache(root, { now: Date.now(), graceMs: 2 * 60 * 1000 }), 0);
  assert.equal(fs.existsSync(fresh), true);
});

function isLikelyDeadPid(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}
