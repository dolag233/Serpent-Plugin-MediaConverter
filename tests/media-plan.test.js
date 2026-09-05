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

test('percent-mode video args compute bitrate from duration and target', () => {
  const sourceByteSize = 100 * 1024 * 1024; // 100 MiB
  const args = buildVideoArgs({
    inputPath: 'in.mp4',
    outputPath: 'out.mp4',
    durationMicros: 100_000_000, // 100 s
    sourceByteSize,
    options: { targetMode: 'percent', percent: 50, videoFormat: 'mp4', videoCodec: 'h264', audioMode: 'aac' },
  });
  const targetBytes = sourceByteSize / 2;
  const totalBits = targetBytes * 8;
  const audioBits = Math.min(192_000, Math.max(32_000, Math.round(totalBits * 0.12)));
  const videoBits = Math.floor(totalBits - audioBits);
  const bvIndex = args.indexOf('-b:v');
  assert.equal(args[bvIndex + 1], String(videoBits));
  const maxrateIndex = args.indexOf('-maxrate');
  assert.equal(args[maxrateIndex + 1], String(Math.round(videoBits * 1.45)));
});

test('absolute-size video args honor the requested byte budget', () => {
  const targetBytes = 20 * 1024 * 1024;
  const args = buildVideoArgs({
    inputPath: 'in.mov',
    outputPath: 'out.mov',
    durationMicros: 200_000_000,
    sourceByteSize: 400 * 1024 * 1024,
    options: { targetMode: 'size', targetBytes, videoFormat: 'mov', videoCodec: 'h264', audioMode: 'none' },
  });
  const totalBits = targetBytes * 8;
  const bvIndex = args.indexOf('-b:v');
  assert.equal(args[bvIndex + 1], String(Math.max(64_000, totalBits)));
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
