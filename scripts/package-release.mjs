'use strict';

/**
 * Packages a platform-independent release zip:
 * `Serpent-Plugin-MediaConverter-<version>-any.zip`
 *
 * FFmpeg is provided by the Serpent host, so the plugin zip has no native binaries.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { releaseAssetName } from './release-asset-name.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'serpent-plugin.json'), 'utf8'));

const outDirectory = path.join(root, 'out');
const sharedEntries = ['serpent-plugin.json', 'entry', 'src', 'README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md'];

function zip(stagingDirectory, destination) {
  if (process.platform === 'win32') {
    execFileSync('powershell', [
      '-NoProfile', '-Command',
      `Compress-Archive -LiteralPath '${stagingDirectory}\\*' -DestinationPath '${destination}' -Force`,
    ], { stdio: 'inherit' });
    return;
  }
  execFileSync('zip', ['-r', destination, '.'], { cwd: stagingDirectory, stdio: 'inherit' });
}

const stagingDirectory = path.join(outDirectory, 'staging-any');
rmSync(stagingDirectory, { recursive: true, force: true });
mkdirSync(stagingDirectory, { recursive: true });
for (const entry of sharedEntries) {
  cpSync(path.join(root, entry), path.join(stagingDirectory, entry), { recursive: true });
}
const destination = path.join(outDirectory, releaseAssetName(manifest.version, 'any'));
rmSync(destination, { force: true });
mkdirSync(outDirectory, { recursive: true });
zip(stagingDirectory, destination);
rmSync(stagingDirectory, { recursive: true, force: true });
console.log(`[package] wrote ${destination}`);
