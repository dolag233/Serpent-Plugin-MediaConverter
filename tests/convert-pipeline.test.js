'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  commitOutput,
  isImageAsset,
  isVideoAsset,
  outputExtension,
  processAsset,
  sanitizeStem,
} = require('../src/convert-pipeline');
const { createPluginRuntime } = require('../src/plugin');

function assetSummary(overrides = {}) {
  return {
    assetId: 'asset-1',
    locationKind: 'managed',
    managedFolderId: 'folder-1',
    linkedFolderId: null,
    relativeFilePath: '项目/clip.mp4',
    displayName: 'clip.mp4',
    currentRevisionId: 'rev-1',
    byteSize: 100 * 1024 * 1024,
    availability: 'available',
    deletedAt: null,
    ...overrides,
  };
}

function fakeBinaries() {
  return { ffmpeg: 'ffmpeg-fake', ffprobe: 'ffprobe-fake' };
}

test('classifies assets by extension', () => {
  assert.equal(isVideoAsset(assetSummary()), true);
  assert.equal(isImageAsset(assetSummary({ relativeFilePath: 'a/shot.jpg', displayName: 'shot.jpg' })), true);
  assert.equal(isVideoAsset(assetSummary({ relativeFilePath: 'a/shot.jpg', displayName: 'shot.jpg' })), false);
});

test('output extension follows the request kind', () => {
  const summary = assetSummary();
  assert.equal(
    outputExtension({ kind: 'convert', options: { videoFormat: 'webm', imageFormat: 'webp' } }, summary),
    'webm',
  );
  assert.equal(
    outputExtension({ kind: 'convert', options: { videoFormat: 'mp4' } }, summary),
    'mp4',
  );
  assert.equal(
    outputExtension({ kind: 'compress', options: {} }, summary),
    'mp4',
  );
  assert.throws(
    () => outputExtension(
      { kind: 'convert', options: { videoFormat: 'mov' } },
      assetSummary({ relativeFilePath: 'a/shot.jpg', displayName: 'shot.jpg' }),
    ),
    /仅支持视频/,
  );
});

test('sanitizes output stems', () => {
  assert.equal(sanitizeStem('my clip: "final".mp4'), 'my clip_ _final_');
  assert.equal(sanitizeStem(''), 'asset');
});

test('processes a video asset through the fake ffmpeg runner', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-converter-pipeline-'));
  fs.mkdirSync(path.join(temporaryRoot, 'Assets'), { recursive: true });
  const sourcePath = path.join(temporaryRoot, 'Assets', 'clip.mp4');
  fs.writeFileSync(sourcePath, 'fake-video');
  const workDirectory = path.join(temporaryRoot, 'work');
  fs.mkdirSync(workDirectory);

  const runArgs = [];
  const processed = await processAsset({
    scoped: {},
    libraryRoot: temporaryRoot,
    linkedFolders: [],
    assetSummary: assetSummary({ relativeFilePath: 'clip.mp4' }),
    request: {
      kind: 'convert',
      options: { videoFormat: 'mp4', videoCodec: 'h264', audioMode: 'copy', targetMode: 'quality', crf: 23 },
    },
    binaries: fakeBinaries(),
    workDirectory,
    signal: new AbortController().signal,
    onPercent: () => undefined,
    probe: async () => ({
      format: { duration: '10', size: String(100 * 1024 * 1024) },
      streams: [{ codec_type: 'video', codec_name: 'h264' }],
    }),
    runProcess: async ({ args }) => {
      runArgs.push(args);
      fs.writeFileSync(args[args.length - 1], 'fake-mov-output');
      return { stderrTail: '' };
    },
  });

  const output = processed.output;
  assert.ok(output.path.startsWith(workDirectory));
  assert.equal(output.extension, 'mp4');
  assert.equal(output.suggestedName, 'clip.mp4');
  assert.equal(fs.readFileSync(output.path, 'utf8'), 'fake-mov-output');
  assert.ok(runArgs[0].includes(sourcePath));
  assert.ok(runArgs[0].includes('-crf'));
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

test('convert to webm writes a .webm output path', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-converter-webm-'));
  fs.mkdirSync(path.join(temporaryRoot, 'Assets'), { recursive: true });
  fs.writeFileSync(path.join(temporaryRoot, 'Assets', 'clip.mp4'), 'fake-video');
  const workDirectory = path.join(temporaryRoot, 'work');
  fs.mkdirSync(workDirectory);
  const processed = await processAsset({
    scoped: {},
    libraryRoot: temporaryRoot,
    linkedFolders: [],
    assetSummary: assetSummary({ relativeFilePath: 'clip.mp4' }),
    request: {
      kind: 'convert',
      options: { videoFormat: 'webm', videoCodec: 'h264', audioMode: 'copy', targetMode: 'quality', crf: 23 },
    },
    binaries: fakeBinaries(),
    workDirectory,
    signal: new AbortController().signal,
    probe: async () => ({
      format: { duration: '4', size: '1000' },
      streams: [{ codec_type: 'video' }],
    }),
    runProcess: async ({ args }) => {
      fs.writeFileSync(args[args.length - 1], 'fake-webm');
      return { stderrTail: '' };
    },
  });
  assert.equal(processed.output.extension, 'webm');
  assert.equal(processed.output.suggestedName, 'clip.webm');
  assert.equal(path.extname(processed.output.path), '.webm');
  assert.equal(processed.source.extension, 'mp4');
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

test('percent compress feeds duration-based bitrate to ffmpeg', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-converter-percent-'));
  fs.mkdirSync(path.join(temporaryRoot, 'Assets'), { recursive: true });
  fs.writeFileSync(path.join(temporaryRoot, 'Assets', 'clip.mp4'), 'fake-video');
  const workDirectory = path.join(temporaryRoot, 'work');
  fs.mkdirSync(workDirectory);
  const runArgs = [];
  await processAsset({
    scoped: {},
    libraryRoot: temporaryRoot,
    linkedFolders: [],
    assetSummary: assetSummary({ relativeFilePath: 'clip.mp4', byteSize: 100 * 1024 * 1024 }),
    request: {
      kind: 'compress',
      options: { videoTargetMode: 'percent', videoPercent: 50, videoCodec: 'h264', audioMode: 'aac' },
    },
    binaries: fakeBinaries(),
    workDirectory,
    signal: new AbortController().signal,
    probe: async () => ({
      format: { duration: '100', size: String(100 * 1024 * 1024) },
      streams: [{ codec_type: 'video' }, { codec_type: 'audio' }],
    }),
    runProcess: async ({ args }) => {
      runArgs.push(args);
      fs.writeFileSync(args[args.length - 1], 'tiny');
      return { stderrTail: '' };
    },
  });
  assert.equal(runArgs[0][runArgs[0].indexOf('-b:v') + 1], '4002304');
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

test('convert without a compression target still uses CRF', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-converter-pipeline-'));
  fs.mkdirSync(path.join(temporaryRoot, 'Assets'), { recursive: true });
  fs.writeFileSync(path.join(temporaryRoot, 'Assets', 'clip.mp4'), 'fake-video');
  const workDirectory = path.join(temporaryRoot, 'work');
  fs.mkdirSync(workDirectory);
  const runArgs = [];
  await processAsset({
    scoped: {},
    libraryRoot: temporaryRoot,
    linkedFolders: [],
    assetSummary: assetSummary({ relativeFilePath: 'clip.mp4' }),
    request: {
      kind: 'convert',
      options: { videoFormat: 'mp4', videoCodec: 'h264', audioMode: 'copy' },
    },
    binaries: fakeBinaries(),
    workDirectory,
    signal: new AbortController().signal,
    probe: async () => ({
      format: { duration: '4', size: '1000' },
      streams: [{ codec_type: 'video' }],
    }),
    runProcess: async ({ args }) => {
      runArgs.push(args);
      fs.writeFileSync(args[args.length - 1], 'out');
      return { stderrTail: '' };
    },
  });
  assert.ok(runArgs[0].includes('-crf'));
  assert.ok(!runArgs[0].includes('-b:v'));
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

test('classifies guest-projected summaries that only have id/name', () => {
  const summary = {
    id: 'asset-9',
    name: 'clip.mov',
    folderId: 'folder-2',
    locationKind: 'managed',
  };
  const { normalizeAssetSummary } = require('../src/library-media');
  const normalized = normalizeAssetSummary(summary);
  assert.equal(isVideoAsset(normalized), true);
  assert.equal(normalized.assetId, 'asset-9');
  assert.equal(normalized.displayName, 'clip.mov');
  assert.equal(normalized.managedFolderId, 'folder-2');
});

test('classifies invocation snapshots by mediaType without an extension', () => {
  const { normalizeAssetSummary } = require('../src/library-media');
  const video = normalizeAssetSummary({
    id: 'asset-v',
    name: 'clip',
    mediaType: 'video',
    relativeFilePath: '项目/clip',
  });
  const image = normalizeAssetSummary({
    id: 'asset-i',
    name: 'shot',
    mediaType: 'image',
    relativeFilePath: '项目/shot',
  });
  assert.equal(isVideoAsset(video), true);
  assert.equal(isImageAsset(image), true);
});

test('commit replaces the original when the suffix is empty', async () => {
  const replacements = [];
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-converter-commit-'));
  const outputPath = path.join(temporaryRoot, 'clip.mp4');
  fs.writeFileSync(outputPath, 'fake-mp4');
  const scoped = {
    assets: {
      async stageContent(assetId, dataBase64, options) {
        assert.equal(assetId, 'asset-1');
        return { assetId, stagingToken: 'token-1', byteSize: 42, complete: options.complete === true };
      },
      async replaceContentBatch(items) {
        replacements.push(items);
        return { operationId: 'op-1', items: [{ assetId: 'asset-1', revisionId: 'rev-2', byteSize: 42 }] };
      },
    },
  };
  const outcome = await commitOutput({
    scoped,
    processed: {
      assetId: 'asset-1',
      displayName: 'clip.mp4',
      managedFolderId: 'folder-1',
      expectedRevisionId: 'rev-1',
      output: {
        path: outputPath,
        extension: 'mp4',
        byteSize: 42,
        suggestedName: 'clip.mp4',
      },
      source: { byteSize: 100 },
    },
    request: { kind: 'convert', options: { suffix: '' } },
    signal: new AbortController().signal,
  });
  assert.equal(outcome.mode, 'replaced');
  assert.equal(outcome.assetId, 'asset-1');
  assert.equal(replacements.length, 1);
  assert.deepEqual(replacements[0][0], {
    assetId: 'asset-1',
    stagingToken: 'token-1',
    expectedRevisionId: 'rev-1',
  });
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

test('replace transcode to webm renames the file extension on the same asset', async () => {
  const replacements = [];
  const renames = [];
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-converter-rename-'));
  const outputPath = path.join(temporaryRoot, 'clip.webm');
  fs.writeFileSync(outputPath, 'fake-webm');
  const scoped = {
    assets: {
      async stageContent(assetId, dataBase64, options) {
        return { assetId, stagingToken: 'token-1', byteSize: 42, complete: options.complete === true };
      },
      async replaceContentBatch(items) {
        replacements.push(items);
        return { operationId: 'op-1', items: [{ assetId: 'asset-1', revisionId: 'rev-2', byteSize: 42 }] };
      },
      async renameFile(assetId, newBaseName, options) {
        renames.push({ assetId, newBaseName, options });
        return { assetId, name: options.fileName };
      },
    },
  };
  const outcome = await commitOutput({
    scoped,
    processed: {
      assetId: 'asset-1',
      displayName: 'clip.mp4',
      managedFolderId: 'folder-1',
      expectedRevisionId: 'rev-1',
      output: {
        path: outputPath,
        extension: 'webm',
        byteSize: 42,
        suggestedName: 'clip.webm',
      },
      source: { byteSize: 100, extension: 'mp4' },
    },
    request: { kind: 'convert', options: { suffix: '', videoFormat: 'webm' } },
    signal: new AbortController().signal,
  });
  assert.equal(outcome.mode, 'replaced');
  assert.equal(outcome.assetId, 'asset-1');
  assert.equal(replacements.length, 1);
  assert.deepEqual(renames, [{
    assetId: 'asset-1',
    newBaseName: 'clip',
    options: { fileName: 'clip.webm' },
  }]);
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

test('replace refuses a snapshot that has no revision id', async () => {
  await assert.rejects(
    () => commitOutput({
      scoped: { assets: {} },
      processed: {
        assetId: 'asset-1',
        displayName: 'clip.mp4',
        expectedRevisionId: null,
        output: {
          path: 'unused.mp4',
          extension: 'mp4',
          byteSize: 1,
          suggestedName: 'clip.mp4',
        },
      },
      request: { kind: 'compress', options: { suffix: '' } },
      signal: new AbortController().signal,
    }),
    /缺少修订版本/,
  );
});

test('commit imports a new asset when a suffix is set', async () => {
  const imports = [];
  const assigned = [];
  const metadataSets = [];
  const scoped = {
    files: {
      async import(input) {
        imports.push(input);
        return {
          status: 'completed',
          completion: {
            importedCount: 1,
            assets: [{ assetId: 'asset-new', displayName: 'clip-out.mp4' }],
          },
        };
      },
    },
    assets: {
      async getMetadata() {
        return {
          metadata: {
            tags: [{ id: 'tag-red', name: 'red' }],
            description: 'keep me',
            rating: 4,
            favorite: true,
            entityVersion: 3,
          },
        };
      },
      async setMetadata(input) {
        metadataSets.push(input);
        return input;
      },
    },
    tags: {
      async assign(assetIds, tagIds) {
        assigned.push({ assetIds, tagIds });
      },
    },
  };
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-converter-commit-'));
  const outputPath = path.join(temporaryRoot, 'clip-out.mp4');
  fs.writeFileSync(outputPath, 'fake-mp4');
  const outcome = await commitOutput({
    scoped,
    processed: {
      assetId: 'asset-1',
      displayName: 'clip.mp4',
      managedFolderId: 'folder-1',
      expectedRevisionId: 'rev-1',
      output: {
        path: outputPath,
        extension: 'mp4',
        byteSize: 42,
        suggestedName: 'clip-out.mp4',
      },
      source: { byteSize: 100 },
    },
    request: { kind: 'compress', options: { suffix: '-out' } },
    signal: new AbortController().signal,
  });
  assert.equal(outcome.mode, 'imported');
  assert.equal(imports.length, 1);
  assert.equal(imports[0].sourceKind, 'files');
  assert.deepEqual(imports[0].sourcePaths, [outputPath]);
  assert.equal(imports[0].targetFolderId, 'folder-1');
  assert.equal(imports[0].expandImageSequences, false);
  assert.equal(outcome.assetId, 'asset-new');
  assert.deepEqual(assigned, [{ assetIds: ['asset-new'], tagIds: ['tag-red'] }]);
  assert.equal(metadataSets[0].assetId, 'asset-new');
  assert.equal(metadataSets[0].description, 'keep me');
  assert.equal(metadataSets[0].rating, 4);
  assert.equal(metadataSets[0].favorite, true);
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

test('plugin setup registers commands and the media-convert handler', async () => {
  const commands = new Map();
  const handlers = new Map();
  const runtime = createPluginRuntime();
  await runtime.setup({
    pluginId: 'com.dolag.serpent.media-converter',
    serpent: {
      media: {
        async getBinaryPaths() { return { ffmpegPath: 'ffmpeg-fake', ffprobePath: 'ffprobe-fake' }; },
      },
      data: {
        async getDirectory({ scope }) {
          return { path: path.join(os.tmpdir(), `media-converter-data-${scope}`), scope };
        },
      },
      commands: {
        register(id, handler) { commands.set(id, handler); },
      },
      jobs: {
        registerHandler(id, handler) { handlers.set(id, handler); },
      },
    },
    signal: new AbortController().signal,
    subscriptions: { add() {} },
  });

  assert.ok(commands.has('mediaconverter.open-convert'));
  assert.ok(commands.has('mediaconverter.open-compress'));
  assert.ok(handlers.has('media-convert'));

  await runtime.dispose('test');
});

test('command targets prefer host invocation asset snapshots', () => {
  const { resolveCommandTargets, classifyAssets } = require('../src/plugin');
  const targets = resolveCommandTargets({
    targetLibraryId: 'library-1',
    assetIds: ['stale-id'],
    invocation: {
      libraryId: 'library-1',
      selection: {
        assetIds: ['asset-1'],
        assets: [{
          id: 'asset-1',
          name: 'clip.mp4',
          relativeFilePath: '项目/clip.mp4',
          mediaType: 'video',
          byteSize: 4096,
          currentRevisionId: 'rev-9',
          folderId: 'folder-1',
          locationKind: 'managed',
        }],
      },
    },
  });
  assert.deepEqual(targets.assetIds, ['asset-1']);
  assert.equal(targets.assets[0].displayName, 'clip.mp4');
  assert.equal(targets.assets[0].mediaType, 'video');
  assert.equal(targets.assets[0].currentRevisionId, 'rev-9');
  assert.equal(targets.assets[0].managedFolderId, 'folder-1');
  assert.deepEqual(classifyAssets(targets.assets), {
    imageCount: 0,
    videoCount: 1,
    total: 1,
  });
});

test('convert filters images out of the command targets before the dialog', () => {
  const { filterTargetsForCommand } = require('../src/plugin');
  const mixed = filterTargetsForCommand('convert', ['video-1', 'image-1', 'doc-1'], [
    { assetId: 'video-1', displayName: 'clip.mp4', mediaType: 'video' },
    { assetId: 'image-1', displayName: 'photo.jpg', mediaType: 'image' },
    { assetId: 'doc-1', displayName: 'notes.pdf', mediaType: 'document' },
  ]);
  assert.deepEqual(mixed.assetIds, ['video-1']);
  assert.equal(mixed.assets.length, 1);
  assert.equal(mixed.skippedImageCount, 1);
  assert.equal(mixed.skippedOtherCount, 1);

  const compress = filterTargetsForCommand('compress', ['video-1', 'image-1'], [
    { assetId: 'video-1', displayName: 'clip.mp4', mediaType: 'video' },
    { assetId: 'image-1', displayName: 'photo.jpg', mediaType: 'image' },
  ]);
  assert.deepEqual(compress.assetIds, ['video-1', 'image-1']);
  assert.equal(compress.skippedImageCount, 0);
});

test('convert command does not enqueue images from a mixed selection', async () => {
  const commands = new Map();
  const notes = [];
  let enqueuedRequest = null;
  const runtime = createPluginRuntime();
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-converter-filter-'));
  await runtime.setup({
    pluginId: 'com.dolag.serpent.media-converter',
    serpent: {
      media: {
        async getBinaryPaths() { return { ffmpegPath: 'ffmpeg-fake', ffprobePath: 'ffprobe-fake' }; },
      },
      data: {
        async getDirectory({ scope }) {
          return { path: temporaryRoot, scope };
        },
      },
      storage: {
        async set() {},
        async get() { return null; },
      },
      ui: {
        async openDialog({ render }) {
          const remembered = Object.create(null);
          const fakeUi = {
            state(initial) {
              let current = initial;
              return { get() { return current; }, set(value) { current = value; } };
            },
            column(...children) { return { type: 'column', children }; },
            note(text) { notes.push(String(text)); return { type: 'note', text: String(text) }; },
            select(spec) {
              remembered[spec.id] = spec.value;
              return spec;
            },
            slider(spec) { return spec; },
            text(spec) { return spec; },
            number(spec) { return spec; },
            row(...children) { return { type: 'row', children }; },
          };
          render(fakeUi);
          return {
            videoFormat: 'webm',
            videoCodec: 'vp9',
            audioMode: 'copy',
            targetMode: 'quality',
            crf: 23,
            suffix: '',
            advancedArgs: '',
          };
        },
      },
      commands: {
        register(id, handler) { commands.set(id, handler); },
      },
      jobs: {
        registerHandler() {},
      },
      forLibrary() {
        return {
          jobs: {
            async enqueue(input) {
              const requestFile = input?.payload?.requestFile;
              const filePath = path.join(temporaryRoot, 'jobs', requestFile);
              enqueuedRequest = JSON.parse(fs.readFileSync(filePath, 'utf8'));
              return { jobId: 'job-filter' };
            },
          },
          ui: { async notify() {} },
        };
      },
    },
    signal: new AbortController().signal,
    subscriptions: { add() {} },
  });

  await commands.get('mediaconverter.open-convert')({
    invocation: {
      libraryId: 'library-1',
      selection: {
        assetIds: ['video-1', 'image-1'],
        assets: [
          {
            id: 'video-1',
            name: 'clip.mp4',
            mediaType: 'video',
            relativeFilePath: 'clip.mp4',
            currentRevisionId: 'rev-1',
          },
          {
            id: 'image-1',
            name: 'photo.jpg',
            mediaType: 'image',
            relativeFilePath: 'photo.jpg',
            currentRevisionId: 'rev-2',
          },
        ],
      },
    },
  });

  assert.ok(notes.some((text) => text.includes('已跳过 1 张图片')));
  assert.ok(enqueuedRequest);
  assert.deepEqual(enqueuedRequest.assetIds, ['video-1']);
  assert.equal(enqueuedRequest.assets.length, 1);
  assert.equal(enqueuedRequest.assets[0].assetId, 'video-1');

  const imageOnlyNotes = [];
  let imageOnlyOpened = false;
  await runtime.dispose('test');
  const imageRuntime = createPluginRuntime();
  await imageRuntime.setup({
    pluginId: 'com.dolag.serpent.media-converter',
    serpent: {
      media: {
        async getBinaryPaths() { return { ffmpegPath: 'ffmpeg-fake', ffprobePath: 'ffprobe-fake' }; },
      },
      data: {
        async getDirectory({ scope }) {
          return { path: temporaryRoot, scope };
        },
      },
      storage: { async set() {}, async get() { return null; } },
      ui: {
        async openDialog() { imageOnlyOpened = true; return null; },
        async notify(input) { imageOnlyNotes.push(input.message); },
      },
      commands: {
        register(id, handler) { commands.set(id, handler); },
      },
      jobs: { registerHandler() {} },
      forLibrary() {
        return { jobs: { async enqueue() { throw new Error('must not enqueue'); } }, ui: { async notify(input) { imageOnlyNotes.push(input.message); } } };
      },
    },
    signal: new AbortController().signal,
    subscriptions: { add() {} },
  });
  await commands.get('mediaconverter.open-convert')({
    invocation: {
      libraryId: 'library-1',
      selection: {
        assetIds: ['image-1'],
        assets: [{ id: 'image-1', name: 'photo.jpg', mediaType: 'image' }],
      },
    },
  });
  assert.equal(imageOnlyOpened, false);
  assert.ok(imageOnlyNotes.some((message) => message.includes('没有可转码的视频')));
  await imageRuntime.dispose('test');
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

test('processes an image asset through quality and scale down to 50% and absolute target', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-converter-img-'));
  const workDirectory = path.join(temporaryRoot, 'work');
  fs.mkdirSync(workDirectory, { recursive: true });
  const assetsDirectory = path.join(temporaryRoot, 'Assets');
  fs.mkdirSync(assetsDirectory, { recursive: true });

  const imagePath = path.join(assetsDirectory, 'photo.jpg');
  fs.writeFileSync(imagePath, Buffer.alloc(1000 * 1024, 0x7f)); // 1000KB

  const runs = [];
  const fakeRunner = async ({ args }) => {
    runs.push(args);
    const out = args[args.length - 1];
    // 模拟编码器：如果带 scaleRatio 则体积显著减小
    const vfIndex = args.indexOf('-vf');
    if (vfIndex !== -1 && args[vfIndex + 1].includes('scale=')) {
      fs.writeFileSync(out, Buffer.alloc(50 * 1024, 0x11)); // 50KB
    } else {
      const qvIndex = args.indexOf('-q:v');
      const qv = qvIndex !== -1 ? Number(args[qvIndex + 1]) : 2;
      const size = Math.max(120 * 1024, (1000 - qv * 25) * 1024);
      fs.writeFileSync(out, Buffer.alloc(size, 0x11));
    }
  };

  const outcome50 = await processAsset({
    scoped: {},
    libraryRoot: temporaryRoot,
    linkedFolders: [],
    assetSummary: assetSummary({
      assetId: 'img-1',
      displayName: 'photo.jpg',
      relativeFilePath: 'photo.jpg',
      byteSize: 1000 * 1024,
      mediaType: 'image',
    }),
    request: {
      kind: 'compress',
      options: {
        imageTargetMode: 'percent',
        imagePercent: 50,
      },
    },
    binaries: fakeBinaries(),
    workDirectory,
    signal: new AbortController().signal,
    runProcess: fakeRunner,
  });

  assert.ok(outcome50.output.byteSize <= 500 * 1024, `output ${outcome50.output.byteSize} must be <= 500KB`);

  const outcome70k = await processAsset({
    scoped: {},
    libraryRoot: temporaryRoot,
    linkedFolders: [],
    assetSummary: assetSummary({
      assetId: 'img-1',
      displayName: 'photo.jpg',
      relativeFilePath: 'photo.jpg',
      byteSize: 1000 * 1024,
      mediaType: 'image',
    }),
    request: {
      kind: 'compress',
      options: {
        imageTargetMode: 'size',
        imageTargetBytes: 70 * 1024,
      },
    },
    binaries: fakeBinaries(),
    workDirectory,
    signal: new AbortController().signal,
    runProcess: fakeRunner,
  });

  assert.ok(outcome70k.output.byteSize <= 70 * 1024, `output ${outcome70k.output.byteSize} must be <= 70KB`);
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

test('compress applies user resolution before the size target', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-converter-res-'));
  const workDirectory = path.join(temporaryRoot, 'work');
  fs.mkdirSync(workDirectory, { recursive: true });
  fs.mkdirSync(path.join(temporaryRoot, 'Assets'), { recursive: true });
  fs.writeFileSync(path.join(temporaryRoot, 'Assets', 'photo.jpg'), Buffer.alloc(1000 * 1024, 0x7f));
  fs.writeFileSync(path.join(temporaryRoot, 'Assets', 'clip.mp4'), 'fake-video');

  const imageRuns = [];
  await processAsset({
    scoped: {},
    libraryRoot: temporaryRoot,
    linkedFolders: [],
    assetSummary: assetSummary({
      assetId: 'img-1',
      displayName: 'photo.jpg',
      relativeFilePath: 'photo.jpg',
      byteSize: 1000 * 1024,
      mediaType: 'image',
    }),
    request: {
      kind: 'compress',
      options: {
        imageTargetMode: 'percent',
        imagePercent: 10,
        imageResolutionMode: 'percent',
        imageResolutionPercent: 50,
      },
    },
    binaries: fakeBinaries(),
    workDirectory,
    signal: new AbortController().signal,
    runProcess: async ({ args }) => {
      imageRuns.push(args);
      const out = args[args.length - 1];
      fs.writeFileSync(out, Buffer.alloc(80 * 1024, 0x11));
    },
  });
  assert.ok(imageRuns.length > 0);
  for (const args of imageRuns) {
    const vf = args.indexOf('-vf');
    assert.ok(vf !== -1, 'every image encode must include the user scale');
    assert.match(args[vf + 1], /iw\*0\.5000/u);
  }

  const videoRuns = [];
  await processAsset({
    scoped: {},
    libraryRoot: temporaryRoot,
    linkedFolders: [],
    assetSummary: assetSummary({
      relativeFilePath: 'clip.mp4',
      displayName: 'clip.mp4',
      byteSize: 100 * 1024 * 1024,
    }),
    request: {
      kind: 'compress',
      options: {
        videoTargetMode: 'percent',
        videoPercent: 10,
        videoResolutionMode: 'max-edge',
        videoMaxEdge: 1920,
        videoCodec: 'h264',
        audioMode: 'aac',
      },
    },
    binaries: fakeBinaries(),
    workDirectory,
    signal: new AbortController().signal,
    probe: async () => ({
      format: { duration: '100', size: String(100 * 1024 * 1024) },
      streams: [{ codec_type: 'video' }, { codec_type: 'audio' }],
    }),
    runProcess: async ({ args }) => {
      videoRuns.push(args);
      fs.writeFileSync(args[args.length - 1], 'tiny');
    },
  });
  const videoArgs = videoRuns[0];
  const vf = videoArgs.indexOf('-vf');
  assert.ok(vf !== -1);
  assert.match(videoArgs[vf + 1], /min\(iw,1920\)/u);
  assert.equal(videoArgs[videoArgs.indexOf('-b:v') + 1], '738197');
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

test('commitOutput dynamically refreshes currentRevisionId when expectedRevisionId is stale', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-converter-refresh-rev-'));
  const outputPath = path.join(temporaryRoot, 'clip.mp4');
  fs.writeFileSync(outputPath, 'fake-mp4');

  const staged = [];
  const replacements = [];
  const scoped = {
    assets: {
      async list({ assetIds }) {
        assert.deepEqual(assetIds, ['asset-stale']);
        return {
          assets: [{
            assetId: 'asset-stale',
            currentRevisionId: 'rev-latest-999',
          }],
        };
      },
      async stageContent(assetId, dataBase64, options) {
        staged.push({ assetId, options });
        return { assetId, stagingToken: 'staged-token', byteSize: 42, complete: options.complete === true };
      },
      async replaceContentBatch(items) {
        replacements.push(items);
        return { operationId: 'op-1', items: [{ assetId: 'asset-stale', revisionId: 'rev-1000', byteSize: 42 }] };
      },
    },
  };

  const outcome = await commitOutput({
    scoped,
    processed: {
      assetId: 'asset-stale',
      displayName: 'clip.mp4',
      managedFolderId: 'folder-1',
      expectedRevisionId: 'rev-stale-old', // 过期的旧版本
      output: {
        path: outputPath,
        extension: 'mp4',
        byteSize: 42,
        suggestedName: 'clip.mp4',
      },
      source: { byteSize: 100 },
    },
    request: { kind: 'compress', options: { suffix: '' } },
    signal: new AbortController().signal,
  });

  assert.equal(outcome.mode, 'replaced');
  assert.equal(replacements.length, 1);
  // 必须已经被动态刷新为最新版本 rev-latest-999，而不是过期的 rev-stale-old
  assert.equal(replacements[0][0].expectedRevisionId, 'rev-latest-999');
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});


