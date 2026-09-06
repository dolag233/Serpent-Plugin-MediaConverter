'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  durationMicrosFromProbe,
  parseListedEncoders,
  pickVideoEncoders,
} = require('../src/ffmpeg-runner');

test('parses ffmpeg -encoders listing lines', () => {
  const available = parseListedEncoders([
    'Encoders:',
    ' V....D libopenh264        OpenH264',
    ' V..... h264_qsv           Quick Sync',
    ' V....D libvpx-vp9         libvpx VP9',
    ' V....D libkvazaar         Kvazaar H.265',
    ' A..... aac                AAC',
  ].join('\n'));
  assert.equal(available.has('libopenh264'), true);
  assert.equal(available.has('h264_qsv'), true);
  assert.equal(available.has('libvpx-vp9'), true);
  assert.equal(available.has('libkvazaar'), true);
  assert.equal(available.has('libx264'), false);
});

test('prefers software H.264 encoders over hardware names', () => {
  const picked = pickVideoEncoders(parseListedEncoders([
    ' V..... h264_qsv',
    ' V....D libopenh264',
    ' V....D libvpx-vp9',
    ' V....D libkvazaar',
  ].join('\n')));
  assert.equal(picked.h264, 'libopenh264');
  assert.equal(picked.hevc, 'libkvazaar');
  assert.equal(picked.vp9, 'libvpx-vp9');
  assert.equal(picked.av1, null);
});

test('prefers software AV1 encoders', () => {
  const picked = pickVideoEncoders(parseListedEncoders([
    ' V..... av1_nvenc',
    ' V....D libsvtav1',
    ' V....D libaom-av1',
  ].join('\n')));
  assert.equal(picked.av1, 'libsvtav1');
});

test('reads duration from a video stream when format duration is missing', () => {
  assert.equal(durationMicrosFromProbe({
    format: { duration: 'N/A' },
    streams: [{ codec_type: 'video', duration: '1.5' }],
  }), 1_500_000);
  assert.equal(durationMicrosFromProbe({
    format: { duration: '2' },
    streams: [],
  }), 2_000_000);
});
