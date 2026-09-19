'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WORK_CACHE_DIR_NAME = 'serpent-media-converter';
const JOB_DIR_PREFIX = 'job-';
const OWNER_FILE_NAME = '.owner';
/** Directories without an owner file newer than this are treated as in-flight. */
const OWNERLESS_GRACE_MS = 2 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

function defaultWorkRoot() {
  return path.join(os.tmpdir(), WORK_CACHE_DIR_NAME);
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function writeOwnerFile(directory, pid = process.pid, startedAt = Date.now()) {
  fs.writeFileSync(
    path.join(directory, OWNER_FILE_NAME),
    JSON.stringify({ pid, startedAt }),
    { mode: 0o600 },
  );
}

function readOwnerFile(directory) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(directory, OWNER_FILE_NAME), 'utf8'));
    const pid = Number(parsed?.pid);
    return {
      pid: Number.isInteger(pid) ? pid : null,
      startedAt: Number.isFinite(Number(parsed?.startedAt)) ? Number(parsed.startedAt) : null,
    };
  } catch {
    return null;
  }
}

function ensureWorkRoot(workRoot) {
  fs.mkdirSync(workRoot, { recursive: true, mode: 0o700 });
  return workRoot;
}

function createJobWorkDirectory(workRoot) {
  ensureWorkRoot(workRoot);
  const workDirectory = fs.mkdtempSync(path.join(workRoot, JOB_DIR_PREFIX));
  writeOwnerFile(workDirectory);
  return workDirectory;
}

function removeDirectory(directory) {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function shouldKeepJobDirectory(entryPath, { keep, now, graceMs }) {
  if (keep.has(entryPath) || keep.has(path.basename(entryPath))) return true;
  const owner = readOwnerFile(entryPath);
  if (owner?.pid != null && isProcessAlive(owner.pid)) return true;
  if (owner === null) {
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(entryPath).mtimeMs;
    } catch {
      return true;
    }
    if (now - mtimeMs < graceMs) return true;
  }
  return false;
}

/**
 * Remove leftover `job-*` directories under the shared temp cache.
 * Live owners (alive pid) and paths in `keep` are left alone so a second
 * Serpent instance can keep encoding.
 */
function cleanupStaleWorkCache(workRoot, options = {}) {
  const keep = new Set(options.keep ?? []);
  const now = options.now ?? Date.now();
  const graceMs = options.graceMs ?? OWNERLESS_GRACE_MS;
  let removed = 0;
  let entries;
  try {
    entries = fs.readdirSync(workRoot, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(JOB_DIR_PREFIX)) continue;
    const entryPath = path.join(workRoot, entry.name);
    if (shouldKeepJobDirectory(entryPath, { keep, now, graceMs })) continue;
    if (removeDirectory(entryPath)) removed += 1;
  }
  return removed;
}

function startWorkCacheSweeper(workRoot, options = {}) {
  const intervalMs = options.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const keep = options.keep;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return () => undefined;
  }
  const timer = setInterval(() => {
    cleanupStaleWorkCache(workRoot, { keep: keep instanceof Set ? keep : keep?.() });
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

module.exports = {
  DEFAULT_SWEEP_INTERVAL_MS,
  JOB_DIR_PREFIX,
  OWNER_FILE_NAME,
  OWNERLESS_GRACE_MS,
  WORK_CACHE_DIR_NAME,
  cleanupStaleWorkCache,
  createJobWorkDirectory,
  defaultWorkRoot,
  ensureWorkRoot,
  isProcessAlive,
  startWorkCacheSweeper,
  writeOwnerFile,
};
