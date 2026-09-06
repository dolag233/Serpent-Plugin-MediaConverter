'use strict';

/**
 * Real host FFmpeg coverage. Fake runners cannot catch FFmpeg 8 rejecting
 * `-print-format` or the LGPL bundle lacking libx264.
 *
 * Looks for the sibling Serpent checkout's bundled binaries, or
 * SERPENT_FFMPEG_DIR. Skips when those files are not present.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const { listFfmpegEncoders, pickVideoEncoders, probeMedia } = require('../src/ffmpeg-runner');
const { processAsset } = require('../src/convert-pipeline');

function bundledFfmpegDir() {
  if (typeof process.env.SERPENT_FFMPEG_DIR === 'string' && process.env.SERPENT_FFMPEG_DIR.length > 0) {
    return process.env.SERPENT_FFMPEG_DIR;
  }
  const platformDir = process.platform === 'darwin'
    ? (process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64')
    : 'win32-x64';
  const candidate = path.resolve(__dirname, '../../Serpent/resources/ffmpeg', platformDir);
  return fs.existsSync(candidate) ? candidate : null;
}

function binaryName(name) {
  return process.platform === 'win32' ? `${name}.exe` : name;
}

const ffmpegDir = bundledFfmpegDir();
const binaries = ffmpegDir === null ? null : {
  ffmpeg: path.join(ffmpegDir, binaryName('ffmpeg')),
  ffprobe: path.join(ffmpegDir, binaryName('ffprobe')),
};
const skip = binaries === null
  || !fs.existsSync(binaries.ffmpeg)
  || !fs.existsSync(binaries.ffprobe);

function generateClip(destinationPath) {
  const result = spawnSync(binaries.ffmpeg, [
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-f', 'lavfi',
    '-i', 'testsrc2=size=320x240:rate=24:duration=3',
    '-c:v', 'libopenh264',
    '-pix_fmt', 'yuv420p',
    '-b:v', '1500k',
    destinationPath,
  ], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`failed to generate test clip: ${result.stderr || result.stdout}`);
  }
}

test('bundled ffprobe rejects hyphen print-format and accepts -output_format json', { skip }, () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'serpent-host-ffmpeg-probe-'));
  try {
    const clip = path.join(work, 'clip.mp4');
    generateClip(clip);
    const rejected = spawnSync(binaries.ffprobe, [
      '-v', 'error',
      '-print-format', 'json',
      '-show_format',
      clip,
    ], { encoding: 'utf8', windowsHide: true });
    assert.notEqual(rejected.status, 0);
    assert.match(`${rejected.stderr}\n${rejected.stdout}`, /print-format|Option not found/i);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('bundled ffmpeg compresses and transcodes a generated clip', { skip }, async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'serpent-host-ffmpeg-job-'));
  const libraryRoot = path.join(work, 'library');
  fs.mkdirSync(path.join(libraryRoot, 'Assets'), { recursive: true });
  const sourcePath = path.join(libraryRoot, 'Assets', 'clip.mp4');
  generateClip(sourcePath);
  const workCompress = path.join(work, 'compress');
  const workConvert = path.join(work, 'convert');
  fs.mkdirSync(workCompress, { recursive: true });
  fs.mkdirSync(workConvert, { recursive: true });
  const available = await listFfmpegEncoders(binaries.ffmpeg);
  const encoders = pickVideoEncoders(available);
  assert.equal(available.has('libopenh264'), true);
  assert.equal(encoders.h264, 'libopenh264');

  const probed = await probeMedia(binaries.ffprobe, sourcePath);
  assert.ok(probed.streams.some((stream) => stream.codec_type === 'video'));
  assert.ok(Number(probed.format.duration) > 0 || probed.streams.some((stream) => Number(stream.duration) > 0));

  const jobBinaries = { ...binaries, encoders };
  const assetSummary = {
    assetId: 'asset-1',
    displayName: 'clip.mp4',
    locationKind: 'managed',
    relativeFilePath: 'clip.mp4',
    mediaType: 'video',
    byteSize: fs.statSync(sourcePath).size,
  };
  const signal = new AbortController().signal;

  const compressed = await processAsset({
    scoped: {},
    libraryRoot,
    linkedFolders: [],
    assetSummary,
    request: {
      kind: 'compress',
      options: { targetMode: 'percent', percent: 50, videoCodec: 'h264', audioMode: 'copy' },
    },
    binaries: jobBinaries,
    workDirectory: workCompress,
    signal,
  });
  assert.ok(fs.existsSync(compressed.output.path));
  assert.ok(compressed.output.byteSize > 0);
  assert.ok(
    compressed.output.byteSize < compressed.source.byteSize,
    `50% compress grew the file: ${compressed.source.byteSize} → ${compressed.output.byteSize}`,
  );

  const converted = await processAsset({
    scoped: {},
    libraryRoot,
    linkedFolders: [],
    assetSummary,
    request: {
      kind: 'convert',
      options: { targetMode: 'quality', crf: 32, videoFormat: 'webm', videoCodec: 'vp9', audioMode: 'none' },
    },
    binaries: jobBinaries,
    workDirectory: workConvert,
    signal,
  });
  assert.equal(converted.output.extension, 'webm');
  assert.equal(path.extname(converted.output.path), '.webm');
  const webmProbe = await probeMedia(binaries.ffprobe, converted.output.path);
  assert.match(String(webmProbe.format.format_name), /webm/i);
  assert.ok(webmProbe.streams.some((stream) => stream.codec_name === 'vp9'));
  assert.ok(fs.statSync(converted.output.path).size > 0);

  fs.rmSync(work, { recursive: true, force: true });
});
