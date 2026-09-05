'use strict';

/**
 * Downloads FFmpeg/FFprobe static builds for every supported platform into
 * `runtime/bin/<platform>-<arch>/`. Set SERPENT_MEDIA_CONVERTER_FFMPEG to a
 * local ffmpeg/ffprobe pair directory to skip the download.
 */

const { execFileSync } = require('node:child_process');
const { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const process = require('node:process');
const { fileURLToPath } = require('node:url');

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDirectory = path.join(root, 'runtime', 'bin');

const FFMPEG_VERSION = '7.1.1';

const BUILDS = {
  'win32-x64': {
    kind: 'zip',
    files: ['ffmpeg.exe', 'ffprobe.exe'],
    sources: [
      `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl.zip`,
    ],
  },
  'linux-x64': {
    kind: 'tar',
    files: ['ffmpeg', 'ffprobe'],
    sources: [
      `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-lgpl.tar.xz`,
    ],
  },
  'darwin-arm64': {
    kind: 'zip-single',
    files: ['ffmpeg', 'ffprobe'],
    sources: [
      `https://evermeet.cx/ffmpeg/get/ffmpeg/${FFMPEG_VERSION}/zip`,
      `https://evermeet.cx/ffmpeg/get/ffprobe/${FFMPEG_VERSION}/zip`,
    ],
  },
};

async function fetchBytes(url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(600_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  throw new Error(`Download failed for ${url}: ${lastError instanceof Error ? lastError.message : lastError}`);
}

function extract(archivePath, kind, destination) {
  mkdirSync(destination, { recursive: true });
  if (kind === 'zip') {
    if (process.platform === 'win32') {
      execFileSync('powershell', [
        '-NoProfile', '-Command',
        `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${destination}' -Force`,
      ], { stdio: 'inherit' });
    } else {
      execFileSync('unzip', ['-o', archivePath, '-d', destination], { stdio: 'inherit' });
    }
    return;
  }
  if (kind === 'tar') {
    execFileSync('tar', ['-xf', archivePath, '-C', destination], { stdio: 'inherit' });
    return;
  }
  throw new Error(`Unknown archive kind ${kind}`);
}

function findFile(startDirectory, fileName) {
  const queue = [startDirectory];
  while (queue.length > 0) {
    const current = queue.shift();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(entryPath);
      else if (entry.name === fileName) return entryPath;
    }
  }
  return null;
}

function copyFromLocalDirectory(localDirectory, destination, files) {
  if (!existsSync(localDirectory)) return false;
  let copied = true;
  for (const file of files) {
    const source = findFile(localDirectory, file);
    if (source === null) { copied = false; continue; }
    copyFileSync(source, path.join(destination, file));
    if (process.platform !== 'win32' && !file.endsWith('.exe')) {
      chmodSync(path.join(destination, file), 0o755);
    }
  }
  return copied;
}

async function installPlatform(platform, build) {
  const destination = path.join(runtimeDirectory, platform);
  mkdirSync(destination, { recursive: true });
  const localOverride = process.env.SERPENT_MEDIA_CONVERTER_FFMPEG;
  if (localOverride && copyFromLocalDirectory(localOverride, destination, build.files)) {
    console.log(`[build] ${platform}: copied FFmpeg binaries from ${localOverride}`);
    return;
  }
  if (build.files.every((file) => existsSync(path.join(destination, file)))) {
    console.log(`[build] ${platform}: binaries already present`);
    return;
  }
  for (const source of build.sources) {
    const temporaryRoot = mkdtempSync(path.join(tmpdir(), 'media-converter-ffmpeg-'));
    try {
      const archivePath = path.join(temporaryRoot, path.basename(source).split('?')[0]);
      console.log(`[build] ${platform}: downloading ${source}`);
      writeFileSync(archivePath, await fetchBytes(source));
      const extractDirectory = path.join(temporaryRoot, 'extracted');
      extract(archivePath, build.kind, extractDirectory);
      let copied = true;
      for (const file of build.files) {
        const found = findFile(extractDirectory, file);
        if (found === null) { copied = false; continue; }
        copyFileSync(found, path.join(destination, file));
        if (process.platform !== 'win32' && !file.endsWith('.exe')) {
          chmodSync(path.join(destination, file), 0o755);
        }
      }
      if (copied) {
        console.log(`[build] ${platform}: installed ${build.files.join(', ')}`);
        return;
      }
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }
  throw new Error(`Failed to obtain FFmpeg binaries for ${platform}.`);
}

async function main() {
  const platformFilter = process.env.SERPENT_MEDIA_CONVERTER_PLATFORMS;
  const selected = platformFilter === undefined
    ? Object.entries(BUILDS)
    : Object.entries(BUILDS).filter(([platform]) => platformFilter.split(',').includes(platform));
  if (selected.length === 0) {
    throw new Error(`No platforms matched SERPENT_MEDIA_CONVERTER_PLATFORMS=${platformFilter}`);
  }
  for (const [platform, build] of selected) {
    await installPlatform(platform, build);
  }
  writeFileSync(
    path.join(runtimeDirectory, 'README.md'),
    `FFmpeg ${FFMPEG_VERSION}-based static builds, fetched by scripts/build.mjs.\nSources: BtbN/FFmpeg-Builds (LGPL), evermeet.cx (LGPL/GPL mix — review before distribution).\n`,
  );
  console.log('[build] runtime binaries ready.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
