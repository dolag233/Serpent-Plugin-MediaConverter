'use strict';

/**
 * Packages a platform-independent release zip:
 * `{pluginId}-{version}-any.zip`
 *
 * FFmpeg is provided by the Serpent host, so the plugin zip has no native binaries.
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { releaseAssetName } from './release-asset-name.js';

const require = createRequire(import.meta.url);
const { listZipLocalNames, writePosixZip } = require('./posix-zip.js');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'serpent-plugin.json'), 'utf8'));

const outDirectory = path.join(root, 'out');
const sharedEntries = ['serpent-plugin.json', 'entry', 'src', 'README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md'];

function zip(stagingDirectory, destination) {
  const names = writePosixZip(stagingDirectory, destination);
  const illegal = names.find((name) => name.includes('\\') || name.startsWith('./') || name.startsWith('/') || name.includes('..'));
  if (illegal) {
    throw new Error(`Release zip contains a non-POSIX path: ${illegal}`);
  }
  const listed = listZipLocalNames(readFileSync(destination));
  if (listed.some((name) => name.includes('\\') || name.startsWith('./'))) {
    throw new Error('Release zip local headers are not POSIX paths.');
  }
}

const stagingDirectory = path.join(outDirectory, 'staging-any');
rmSync(stagingDirectory, { recursive: true, force: true });
mkdirSync(stagingDirectory, { recursive: true });
for (const entry of sharedEntries) {
  cpSync(path.join(root, entry), path.join(stagingDirectory, entry), { recursive: true });
}
const destination = path.join(outDirectory, releaseAssetName(manifest.id, manifest.version, 'any'));
rmSync(destination, { force: true });
mkdirSync(outDirectory, { recursive: true });
zip(stagingDirectory, destination);
if (!existsSync(destination)) {
  throw new Error(`Release zip was not created: ${destination}`);
}
rmSync(stagingDirectory, { recursive: true, force: true });
const digest = createHash('sha256').update(readFileSync(destination)).digest('hex');
console.log(`[package] wrote ${destination}`);
console.log(`[package] sha256 ${digest}`);
