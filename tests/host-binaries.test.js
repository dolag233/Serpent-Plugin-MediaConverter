'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeHostBinaries, resolveHostBinaries } = require('../src/host-binaries');
const { unwrapDialogResult } = require('../src/plugin');
const { withProgressArgs } = require('../src/ffmpeg-runner');
const { normalizeAssetSummary } = require('../src/library-media');

test('normalizes host ffmpegPath/ffprobePath into the pipeline shape', () => {
  assert.deepEqual(
    normalizeHostBinaries({ ffmpegPath: '/host/ffmpeg', ffprobePath: '/host/ffprobe' }),
    { ffmpeg: '/host/ffmpeg', ffprobe: '/host/ffprobe' },
  );
  assert.equal(normalizeHostBinaries({ ffmpegPath: '/host/ffmpeg' }), null);
  assert.equal(normalizeHostBinaries(null), null);
});

test('resolveHostBinaries requires the host media API', async () => {
  await assert.rejects(
    () => resolveHostBinaries({}),
    /未提供 FFmpeg 接口/,
  );
  const binaries = await resolveHostBinaries({
    media: {
      async getBinaryPaths() {
        return { ffmpegPath: 'C:\\Serpent\\ffmpeg.exe', ffprobePath: 'C:\\Serpent\\ffprobe.exe' };
      },
    },
  });
  assert.equal(binaries.ffmpeg, 'C:\\Serpent\\ffmpeg.exe');
  assert.equal(binaries.ffprobe, 'C:\\Serpent\\ffprobe.exe');
});

test('unwraps dialog results from either the payload or the gateway wrapper', () => {
  assert.equal(unwrapDialogResult(null), null);
  assert.deepEqual(unwrapDialogResult({ result: null }), null);
  assert.deepEqual(
    unwrapDialogResult({ result: { videoFormat: 'mp4', crf: 23 } }),
    { videoFormat: 'mp4', crf: 23 },
  );
  assert.deepEqual(
    unwrapDialogResult({ videoFormat: 'mov', targetMode: 'quality' }),
    { videoFormat: 'mov', targetMode: 'quality' },
  );
});

test('injects ffmpeg progress flags once', () => {
  const withFlags = withProgressArgs(['-y', '-i', 'in.mp4', 'out.mp4']);
  assert.deepEqual(withFlags.slice(0, 4), ['-hide_banner', '-nostats', '-progress', 'pipe:1']);
  assert.deepEqual(withProgressArgs(withFlags), withFlags);
});

test('normalizes guest-projected asset list items', () => {
  const summary = normalizeAssetSummary({
    id: 'asset-a',
    name: 'shot.jpg',
    folderId: 'folder-a',
    locationKind: 'managed',
  });
  assert.equal(summary.assetId, 'asset-a');
  assert.equal(summary.displayName, 'shot.jpg');
  assert.equal(summary.managedFolderId, 'folder-a');
  assert.equal(summary.relativeFilePath, '');
});
