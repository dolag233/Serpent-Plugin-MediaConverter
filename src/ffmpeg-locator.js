'use strict';

/**
 * Resolves the plugin's FFmpeg/FFprobe executables. Lookup order:
 * 1. the `ffmpegPath` plugin setting (explicit user override),
 * 2. binaries bundled under `runtime/bin/<platform>-<arch>/`,
 * 3. the system PATH (`ffmpeg` / `ffprobe`).
 */

const fs = require('node:fs');
const path = require('node:path');

const PACKAGE_ROOT = path.resolve(__dirname, '..');

function executableName(baseName) {
  return process.platform === 'win32' ? `${baseName}.exe` : baseName;
}

function exists(filePath) {
  try {
    const entry = fs.lstatSync(filePath);
    return entry.isFile() && !entry.isSymbolicLink();
  } catch {
    return false;
  }
}

function ensureUnixExecutable(filePath) {
  if (process.platform === 'win32') return;
  try {
    const { mode } = fs.statSync(filePath);
    if ((mode & 0o111) !== 0) return;
    fs.chmodSync(filePath, 0o755);
  } catch {
    // Spawn surfaces EACCES if the file remains non-executable.
  }
}

/**
 * @param {string | undefined} settingsPath explicit override from plugin settings
 * @returns {{ ffmpeg: string, ffprobe: string, source: string }}
 */
function resolveFfmpegBinaries(settingsPath) {
  const platformDirectory = `${process.platform}-${process.arch}`;
  const bundledDirectory = path.join(PACKAGE_ROOT, 'runtime', 'bin', platformDirectory);
  const candidates = [];
  if (typeof settingsPath === 'string' && settingsPath.trim().length > 0) {
    const trimmed = settingsPath.trim();
    const base = trimmed.replace(/\.(exe)$/i, '');
    candidates.push(
      { ffmpeg: trimmed, ffprobe: `${base}probe${path.extname(trimmed)}`, source: 'settings' },
      { ffmpeg: trimmed, ffprobe: path.join(path.dirname(trimmed), executableName('ffprobe')), source: 'settings' },
    );
  }
  candidates.push(
    {
      ffmpeg: path.join(bundledDirectory, executableName('ffmpeg')),
      ffprobe: path.join(bundledDirectory, executableName('ffprobe')),
      source: 'bundled',
    },
    { ffmpeg: executableName('ffmpeg'), ffprobe: executableName('ffprobe'), source: 'path' },
  );
  for (const candidate of candidates) {
    if (candidate.ffmpeg === executableName('ffmpeg')) {
      // Only accept PATH lookups; resolving a directory-local bare name would
      // be a silent mistake.
      continue;
    }
    if (exists(candidate.ffmpeg) && exists(candidate.ffprobe)) {
      ensureUnixExecutable(candidate.ffmpeg);
      ensureUnixExecutable(candidate.ffprobe);
      return candidate;
    }
  }
  throw new Error(
    `FFmpeg was not found for ${platformDirectory}. Bundle binaries under runtime/bin, set the ffmpegPath setting, or install FFmpeg on the system PATH.`,
  );
}

module.exports = {
  PACKAGE_ROOT,
  resolveFfmpegBinaries,
};
