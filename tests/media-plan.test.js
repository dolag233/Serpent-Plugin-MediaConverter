'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildImageArgs,
  buildVideoArgs,
  searchImageQuality,
  tokenizeAdvancedArgs,
} = require('../src/media-plan');

test('tokenizes advanced args honoring quotes', () => {
  assert.deepEqual(tokenizeAdvancedArgs('  -vf scale=1920:-2 '), ['-vf', 'scale=1920:-2']);
  assert.deepEqual(
    tokenizeAdvancedArgs("-metadata title='My Video \"Cut\"' -an"),
    ['-metadata', 'title=My Video "Cut"', '-an'],
  );
  assert.deepEqual(tokenizeAdvancedArgs(''), []);
});

test('quality-mode video args use CRF directly', () => {
  const args = buildVideoArgs({
    inputPath: 'in.mp4',
    outputPath: 'out.mp4',
    durationMicros: 60_000_000,
    sourceByteSize: 100 * 1024 * 1024,
    options: { targetMode: 'quality', crf: 23, videoFormat: 'mp4', videoCodec: 'h264', audioMode: 'aac' },
  });
  const crfIndex = args.indexOf('-crf');
  assert.equal(args[crfIndex + 1], '23');
  assert.ok(!args.includes('-b:v'));
  const movflags = args.indexOf('-movflags');
  assert.equal(args[movflags + 1], '+faststart');
  assert.equal(args[args.length - 1], 'out.mp4');
});

test('quality mode maps CRF to bitrate for encoders without CRF', () => {
  const args = buildVideoArgs({
    inputPath: 'in.mp4',
    outputPath: 'out.mp4',
    durationMicros: 10_000_000,
    sourceByteSize: 20 * 1024 * 1024,
    encoders: { h264: 'libopenh264' },
    options: { targetMode: 'quality', crf: 23, videoFormat: 'mp4', videoCodec: 'h264', audioMode: 'aac' },
  });
  assert.ok(args.includes('libopenh264'));
  assert.ok(!args.includes('libx264'));
  assert.ok(!args.includes('-crf'));
  assert.ok(!args.includes('-preset'));
  // 20 MiB / 10s ≈ 16,777 kbps; CRF 23 keeps 66.25% → 11,115 kbps, not a fixed 3100k.
  assert.equal(args[args.indexOf('-b:v') + 1], '11115k');
});

test('webm copy remuxes audio instead of copying AAC', () => {
  const args = buildVideoArgs({
    inputPath: 'in.mp4',
    outputPath: 'out.webm',
    durationMicros: 10_000_000,
    sourceByteSize: 20 * 1024 * 1024,
    options: { targetMode: 'quality', crf: 23, videoFormat: 'webm', videoCodec: 'h264', audioMode: 'copy' },
  });
  assert.ok(args.includes('libopus'));
  assert.ok(!args.includes('copy'));
});

test('missing audio streams drop the copy flag', () => {
  const args = buildVideoArgs({
    inputPath: 'in.mp4',
    outputPath: 'out.mp4',
    durationMicros: 10_000_000,
    sourceByteSize: 20 * 1024 * 1024,
    hasAudio: false,
    options: { targetMode: 'quality', crf: 23, videoFormat: 'mp4', videoCodec: 'h264', audioMode: 'copy' },
  });
  assert.ok(args.includes('-an'));
  assert.ok(!args.includes('copy'));
});

test('percent-mode video args use bits-per-second from duration, not total file bits', () => {
  const args = buildVideoArgs({
    inputPath: 'in.mp4',
    outputPath: 'out.mp4',
    durationMicros: 100_000_000, // 100 s
    sourceByteSize: 100 * 1024 * 1024, // 100 MiB
    options: { targetMode: 'percent', percent: 50, videoFormat: 'mp4', videoCodec: 'h264', audioMode: 'aac' },
  });
  // 50 MiB over 100s = 4,194,304 bit/s; minus 192 kbps audio = 4,002,304.
  // The old formula fed 50 MiB * 8 = 419,430,400 into -b:v and made files larger.
  const bvIndex = args.indexOf('-b:v');
  assert.equal(args[bvIndex + 1], '4002304');
  assert.notEqual(args[bvIndex + 1], '419238400');
  const maxrateIndex = args.indexOf('-maxrate');
  assert.equal(args[maxrateIndex + 1], '5803341');
});

test('absolute-size video args honor the requested byte budget as bits per second', () => {
  const args = buildVideoArgs({
    inputPath: 'in.mov',
    outputPath: 'out.mov',
    durationMicros: 200_000_000,
    sourceByteSize: 400 * 1024 * 1024,
    options: { targetMode: 'size', targetBytes: 20 * 1024 * 1024, videoFormat: 'mov', videoCodec: 'h264', audioMode: 'none' },
  });
  // 20 MiB over 200s = 838,860 bit/s. The old formula used 167,772,160.
  const bvIndex = args.indexOf('-b:v');
  assert.equal(args[bvIndex + 1], '838860');
  assert.notEqual(args[bvIndex + 1], '167772160');
  assert.ok(args.includes('-an'));
  assert.ok(!args.includes('+faststart') || args[args.indexOf('-movflags') + 1] !== '+faststart');
});

test('image args map quality search values onto format flags', () => {
  const jpg = buildImageArgs({
    inputPath: 'in.jpg',
    outputPath: 'out.jpg',
    options: { imageFormat: 'jpg', qualityArg: 12 },
  });
  const qv = jpg.indexOf('-q:v');
  assert.equal(jpg[qv + 1], '12');

  const webp = buildImageArgs({
    inputPath: 'in.png',
    outputPath: 'out.webp',
    options: { imageFormat: 'webp', qualityArg: 30 },
  });
  const webpQv = webp.indexOf('-quality');
  assert.equal(webp[webpQv + 1], '70'); // 100 - 30
});

test('image quality search finds the best quality under the target', async () => {
  // Simulated encoder: size shrinks as the quality value grows (worse).
  const encodes = [];
  const sizeFor = (value) => 1000 - value * 10;
  const result = await searchImageQuality({
    format: 'jpg',
    targetBytes: sizeFor(20), // values >= 20 fit; 20 keeps the best quality
    encodeAndGetBytes: async (value) => {
      encodes.push(value);
      return sizeFor(value);
    },
  });
  assert.ok(result !== null);
  assert.equal(result.qualityArg, 20);
  assert.equal(result.bytes, 800);
  assert.ok(encodes.length <= 7);
});

test('image quality search returns null when nothing fits', async () => {
  const result = await searchImageQuality({
    format: 'jpg',
    targetBytes: 10, // impossibly small
    encodeAndGetBytes: async () => 5000,
  });
  assert.equal(result, null);
});

test('bitrate-mode video args use an explicit kbps target', () => {
  const args = buildVideoArgs({
    inputPath: 'in.mp4',
    outputPath: 'out.mp4',
    durationMicros: 60_000_000,
    sourceByteSize: 100 * 1024 * 1024,
    options: { targetMode: 'bitrate', videoBitrateKbps: 1800, videoFormat: 'mp4', videoCodec: 'h264', audioMode: 'copy' },
  });
  const bvIndex = args.indexOf('-b:v');
  assert.equal(args[bvIndex + 1], '1800k');
  assert.ok(!args.includes('-crf'));
  assert.ok(args.includes('copy'));
});

test('convert-style video args without targetMode use CRF', () => {
  const args = buildVideoArgs({
    inputPath: 'in.mp4',
    outputPath: 'out.mp4',
    durationMicros: 10_000_000,
    sourceByteSize: 50 * 1024 * 1024,
    options: { videoFormat: 'mp4', videoCodec: 'h264', audioMode: 'copy' },
  });
  assert.equal(args[args.indexOf('-crf') + 1], '23');
  assert.ok(!args.includes('-b:v'));
});

test('webm conversion uses VP9 and Opus', () => {
  const args = buildVideoArgs({
    inputPath: 'in.mp4',
    outputPath: 'out.webm',
    durationMicros: 10_000_000,
    sourceByteSize: 50 * 1024 * 1024,
    options: { videoFormat: 'webm', videoCodec: 'h264', audioMode: 'aac', targetMode: 'quality', crf: 32 },
  });
  assert.ok(args.includes('libvpx-vp9'));
  assert.ok(args.includes('libopus'));
  assert.ok(!args.includes('libx264'));
});

test('mp4 can encode VP9 and AV1', () => {
  const vp9 = buildVideoArgs({
    inputPath: 'in.mp4',
    outputPath: 'out.mp4',
    durationMicros: 10_000_000,
    sourceByteSize: 10 * 1024 * 1024,
    encoders: { h264: 'libopenh264', vp9: 'libvpx-vp9', av1: 'libsvtav1' },
    options: { videoFormat: 'mp4', videoCodec: 'vp9', targetMode: 'quality', crf: 32, audioMode: 'none' },
  });
  assert.ok(vp9.includes('libvpx-vp9'));
  assert.equal(vp9[vp9.indexOf('-tag:v') + 1], 'vp09');
  assert.ok(!vp9.includes('libopenh264'));

  const av1 = buildVideoArgs({
    inputPath: 'in.mp4',
    outputPath: 'out.mp4',
    durationMicros: 10_000_000,
    sourceByteSize: 10 * 1024 * 1024,
    encoders: { h264: 'libopenh264', av1: 'libsvtav1' },
    options: { videoFormat: 'mp4', videoCodec: 'av1', targetMode: 'quality', crf: 32, audioMode: 'none' },
  });
  assert.ok(av1.includes('libsvtav1'));
  assert.equal(av1[av1.indexOf('-tag:v') + 1], 'av01');
});

test('webm AV1 uses the AV1 encoder, not H.264', () => {
  const args = buildVideoArgs({
    inputPath: 'in.mp4',
    outputPath: 'out.webm',
    durationMicros: 10_000_000,
    sourceByteSize: 10 * 1024 * 1024,
    encoders: { h264: 'libopenh264', vp9: 'libvpx-vp9', av1: 'libsvtav1' },
    options: { videoFormat: 'webm', videoCodec: 'av1', targetMode: 'quality', crf: 32, audioMode: 'none' },
  });
  assert.ok(args.includes('libsvtav1'));
  assert.ok(!args.includes('libopenh264'));
});
