'use strict';

/**
 * Host FFmpeg/ffprobe only. The plugin never asks the user for a path and
 * never ships its own binaries — Serpent already bundles them.
 */

function nonBlank(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
}

/**
 * Accepts the documented `{ ffmpegPath, ffprobePath }` shape and the shorter
 * `{ ffmpeg, ffprobe }` alias used inside this plugin.
 * @returns {{ ffmpeg: string, ffprobe: string } | null}
 */
function normalizeHostBinaries(value) {
  if (value === null || typeof value !== 'object') return null;
  const ffmpeg = nonBlank(value.ffmpegPath) || nonBlank(value.ffmpeg);
  const ffprobe = nonBlank(value.ffprobePath) || nonBlank(value.ffprobe);
  if (ffmpeg.length === 0 || ffprobe.length === 0) return null;
  return { ffmpeg, ffprobe };
}

async function resolveHostBinaries(serpent) {
  if (typeof serpent?.media?.getBinaryPaths !== 'function') {
    throw new Error('当前 Serpent 未提供 FFmpeg 接口。请升级宿主后再试。');
  }
  const binaries = normalizeHostBinaries(await serpent.media.getBinaryPaths());
  if (binaries === null) {
    throw new Error('宿主未提供可用的 FFmpeg/ffprobe。');
  }
  return binaries;
}

module.exports = {
  normalizeHostBinaries,
  resolveHostBinaries,
};
