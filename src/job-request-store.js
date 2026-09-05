'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

/**
 * Job request files: the command handler freezes the user's settings into the
 * plugin data directory and the Job handler consumes them, so large payloads
 * never cross the Job envelope.
 */

function ensureJobsDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}

async function createJobRequest({ directory, request }) {
  ensureJobsDirectory(directory);
  const fileName = `request-${randomUUID()}.json`;
  const filePath = path.join(directory, fileName);
  const payload = JSON.stringify(request, null, 2);
  fs.writeFileSync(filePath, payload, { mode: 0o600 });
  return { fileName, filePath, bytes: Buffer.byteLength(payload) };
}

async function readJobRequest({ directory, fileName }) {
  if (typeof fileName !== 'string' || fileName.length === 0 || fileName.includes('/') || fileName.includes('\\')) {
    throw new Error('Invalid job request file name.');
  }
  const filePath = path.join(directory, fileName);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

async function deleteJobRequest({ directory, fileName }) {
  if (typeof fileName !== 'string' || fileName.length === 0 || fileName.includes('/') || fileName.includes('\\')) {
    return;
  }
  try {
    fs.rmSync(path.join(directory, fileName), { force: true });
  } catch {
    // A leftover request file is swept by cleanupStaleRequests.
  }
}

function cleanupStaleRequests(directory, maxAgeMs = 24 * 60 * 60 * 1000) {
  let removed = 0;
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith('request-') || !entry.name.endsWith('.json')) continue;
    const filePath = path.join(directory, entry.name);
    try {
      if (Date.now() - fs.statSync(filePath).mtimeMs > maxAgeMs) {
        fs.rmSync(filePath, { force: true });
        removed += 1;
      }
    } catch {
      // Ignore entries that disappear while sweeping.
    }
  }
  return removed;
}

module.exports = {
  cleanupStaleRequests,
  createJobRequest,
  deleteJobRequest,
  readJobRequest,
};
