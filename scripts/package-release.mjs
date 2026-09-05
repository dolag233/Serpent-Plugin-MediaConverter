'use strict';

/**
 * Packages per-platform release zips:
 * `Serpent-Plugin-MediaConverter-<version>-<platform>-<arch>.zip`
 * containing serpent-plugin.json, entry/, src/, runtime/bin/<platform>-<arch>/,
 * README.md, LICENSE, and THIRD-PARTY-NOTICES.md.
 */

const { execFileSync } = require('node:child_process');
const { cpSync, existsSync, mkdirSync, rmSync } = require('node:fs');
const path = require('node:path');
const process = require('node:process');
const { fileURLToPath } = require('node:url');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(require('node:fs').readFileSync(path.join(root, 'serpent-plugin.json'), 'utf8'));
const { releaseAssetName } = require('./release-asset-name.js');

const outDirectory = path.join(root, 'out');
const platforms = ['win32-x64', 'darwin-arm64', 'linux-x64'];
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

for (const platform of platforms) {
  const runtimeDirectory = path.join(root, 'runtime', 'bin', platform);
  if (!existsSync(runtimeDirectory)) {
    console.log(`[package] skipping ${platform}: no runtime binaries (run npm run build).`);
    continue;
  }
  const arch = platform.split('-')[1];
  const stagingDirectory = path.join(outDirectory, `staging-${platform}`);
  rmSync(stagingDirectory, { recursive: true, force: true });
  mkdirSync(stagingDirectory, { recursive: true });
  for (const entry of sharedEntries) {
    cpSync(path.join(root, entry), path.join(stagingDirectory, entry), { recursive: true });
  }
  cpSync(runtimeDirectory, path.join(stagingDirectory, 'runtime', 'bin', platform), { recursive: true });
  const destination = path.join(outDirectory, releaseAssetName(manifest.version, platform, arch));
  rmSync(destination, { force: true });
  zip(stagingDirectory, destination);
  rmSync(stagingDirectory, { recursive: true, force: true });
  console.log(`[package] wrote ${destination}`);
}
