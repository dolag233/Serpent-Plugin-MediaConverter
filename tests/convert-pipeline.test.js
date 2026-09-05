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
    outputExtension({ kind: 'convert', options: { videoFormat: 'mov', imageFormat: 'webp' } }, summary),
    'mov',
  );
  assert.equal(
    outputExtension({ kind: 'compress', options: {} }, summary),
    'mp4',
  );
  assert.equal(
    outputExtension(
      { kind: 'convert', options: { imageFormat: 'webp' } },
      assetSummary({ relativeFilePath: 'a/shot.jpg', displayName: 'shot.jpg' }),
    ),
    'webp',
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
      options: { videoFormat: 'mov', videoCodec: 'h264', audioMode: 'aac', targetMode: 'quality', crf: 23 },
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
  assert.equal(output.extension, 'mov');
  assert.equal(output.suggestedName, 'clip_converted.mov');
  assert.equal(fs.readFileSync(output.path, 'utf8'), 'fake-mov-output');
  assert.ok(runArgs[0].includes(sourcePath));
  assert.ok(runArgs[0].includes('-crf'));
});

test('commit imports new assets for conversion requests', async () => {
  const imports = [];
  const scoped = {
    files: {
      async import(input) {
        imports.push(input);
        return { status: 'completed', completion: { imported: 1 } };
      },
    },
  };
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-converter-commit-'));
  const outputPath = path.join(temporaryRoot, 'clip_converted.mov');
  fs.writeFileSync(outputPath, 'fake-mov');
  const outcome = await commitOutput({
    scoped,
    processed: {
      assetId: 'asset-1',
      displayName: 'clip.mp4',
      managedFolderId: 'folder-1',
      expectedRevisionId: 'rev-1',
      output: {
        path: outputPath,
        extension: 'mov',
        byteSize: 42,
        suggestedName: 'clip_converted.mov',
      },
      source: { byteSize: 100 },
    },
    request: { kind: 'convert', options: {} },
    signal: new AbortController().signal,
  });
  assert.equal(outcome.mode, 'imported');
  assert.equal(imports.length, 1);
  assert.equal(imports[0].sourceKind, 'files');
  assert.deepEqual(imports[0].sourcePaths, [outputPath]);
  assert.equal(imports[0].targetFolderId, 'folder-1');
  assert.equal(imports[0].expandImageSequences, false);
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

test('commit stages and replaces for compress requests', async () => {
  const replacements = [];
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-converter-commit-'));
  const outputPath = path.join(temporaryRoot, 'clip_compressed.mp4');
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
        suggestedName: 'clip_compressed.mp4',
      },
      source: { byteSize: 100 },
    },
    request: { kind: 'compress', options: { outputMode: 'replace' } },
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

test('plugin setup registers commands and the media-convert handler', async () => {
  const commands = new Map();
  const handlers = new Map();
  const storage = new Map();
  const runtime = createPluginRuntime({
    resolveBinaries: () => ({ ffmpeg: 'ffmpeg-fake', ffprobe: 'ffprobe-fake' }),
  });
  await runtime.setup({
    pluginId: 'com.dolag.serpent.media-converter',
    serpent: {
      data: {
        async getDirectory({ scope }) {
          return { path: path.join(os.tmpdir(), `media-converter-data-${scope}`), scope };
        },
      },
      storage: {
        async get(key, { scope }) {
          void scope;
          return storage.get(key) ?? null;
        },
        async set(key, value, { scope }) {
          void scope;
          storage.set(key, value);
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
  assert.ok(commands.has('mediaconverter.capture-selection'));
  assert.ok(commands.has('mediaconverter.run-convert'));
  assert.ok(commands.has('mediaconverter.run-compress'));
  assert.ok(handlers.has('media-convert'));

  // The open-convert command captures the invocation selection for the panel.
  await commands.get('mediaconverter.open-convert')({
    invocation: {
      libraryId: 'lib-1',
      selection: { assetIds: ['a1', 'a2'] },
    },
  });
  assert.deepEqual(storage.get('panel.pending-request'), {
    kind: 'convert',
    assetIds: ['a1', 'a2'],
    libraryId: 'lib-1',
    libraryRoot: null,
    createdAt: storage.get('panel.pending-request').createdAt,
  });

  await runtime.dispose('test');
});
