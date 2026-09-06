'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { execSync } = require('node:child_process');

const {
  commitOutput,
  processAsset,
} = require('../src/convert-pipeline');
const {
  createPluginRuntime,
  deriveSelectionFromContext,
} = require('../src/plugin');

const ffmpeg = 'D:\\\\Tools\\\\ffmpeg\\\\ffmpeg.exe';
const ffprobe = 'D:\\\\Tools\\\\ffmpeg\\\\ffprobe.exe';
const hasRealFfmpeg = fs.existsSync(ffmpeg);

test('verify zero-delay context classification for image, video and mixed selections', () => {
  // 1. 视频选择：0ms 内存推导，不执行任何 I/O
  const videoSelection = deriveSelectionFromContext({
    invocation: {
      selection: {
        assetIds: ['v1'],
        mediaTypes: ['video'],
        extensions: ['mp4'],
      },
    },
  }, ['v1'], []);
  assert.deepEqual(videoSelection, { imageCount: 0, videoCount: 1, total: 1 });

  // 2. 图像选择：0ms 内存推导
  const imageSelection = deriveSelectionFromContext({
    invocation: {
      selection: {
        assetIds: ['img1'],
        mediaTypes: ['image'],
        extensions: ['jpg'],
      },
    },
  }, ['img1'], []);
  assert.deepEqual(imageSelection, { imageCount: 1, videoCount: 0, total: 1 });

  // 3. 混合或未知选择：两者均支持
  const mixedSelection = deriveSelectionFromContext({
    invocation: {
      selection: {
        assetIds: ['a1', 'a2'],
        mediaTypes: ['video', 'image'],
      },
    },
  }, ['a1', 'a2'], []);
  assert.deepEqual(mixedSelection, { imageCount: 0, videoCount: 0, total: 2 });
});

test('verify real image compression achieves strict 50% target and 70KB target', { skip: !hasRealFfmpeg }, async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-image-'));
  const assetsDir = path.join(tmpDir, 'Assets');
  fs.mkdirSync(assetsDir, { recursive: true });

  const srcPath = path.join(assetsDir, 'test-noise.jpg');
  // 生成一张 650KB+ 的真实噪点图片
  execSync(`${ffmpeg} -y -f lavfi -i "nullsrc=s=1280x720,geq=random(1)*255:128:128" -frames:v 1 -q:v 2 "${srcPath}"`);
  const srcSize = fs.statSync(srcPath).size;
  assert.ok(srcSize > 500 * 1024, `Source image size ${srcSize} should be > 500KB`);

  // 1. 测试 50% 压缩
  const target50 = Math.round(srcSize * 0.5);
  const result50 = await processAsset({
    scoped: {},
    libraryRoot: tmpDir,
    linkedFolders: [],
    assetSummary: {
      assetId: 'asset-img-50',
      displayName: 'test-noise.jpg',
      relativeFilePath: 'test-noise.jpg',
      byteSize: srcSize,
      mediaType: 'image',
      currentRevisionId: 'rev-1',
    },
    request: {
      kind: 'compress',
      options: {
        imageTargetMode: 'percent',
        imagePercent: 50,
      },
    },
    binaries: { ffmpeg, ffprobe, encoders: {} },
    workDirectory: tmpDir,
    signal: new AbortController().signal,
  });

  const size50 = fs.statSync(result50.output.path).size;
  assert.ok(size50 <= target50, `50% compression size ${size50} must be <= ${target50}`);
  assert.ok(size50 < srcSize, 'Compressed image must not be larger than source');

  // 2. 测试 70KB 绝对大小压缩
  const target70k = 70 * 1024;
  const result70k = await processAsset({
    scoped: {},
    libraryRoot: tmpDir,
    linkedFolders: [],
    assetSummary: {
      assetId: 'asset-img-70k',
      displayName: 'test-noise.jpg',
      relativeFilePath: 'test-noise.jpg',
      byteSize: srcSize,
      mediaType: 'image',
      currentRevisionId: 'rev-1',
    },
    request: {
      kind: 'compress',
      options: {
        imageTargetMode: 'size',
        imageTargetBytes: target70k,
      },
    },
    binaries: { ffmpeg, ffprobe, encoders: {} },
    workDirectory: tmpDir,
    signal: new AbortController().signal,
  });

  const size70k = fs.statSync(result70k.output.path).size;
  assert.ok(size70k <= target70k, `70KB target compression size ${size70k} must be <= ${target70k}`);
  assert.ok(size70k < srcSize, 'Compressed image must not be larger than source');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('verify dynamic revision refresh protects against stale expectedRevisionId race condition', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-race-'));
  const outputPath = path.join(tmpDir, 'output.mp4');
  fs.writeFileSync(outputPath, 'fake-encoded-data');

  let batchSubmittedRevision = null;
  const scoped = {
    assets: {
      async list({ assetIds }) {
        assert.deepEqual(assetIds, ['asset-race-1']);
        // 模拟由于前序并发任务更新，最新 revision 已经是 rev-concurrent-latest
        return {
          assets: [{
            assetId: 'asset-race-1',
            currentRevisionId: 'rev-concurrent-latest',
          }],
        };
      },
      async stageContent(assetId) {
        return { assetId, stagingToken: 'tok-123', byteSize: 100, complete: true };
      },
      async replaceContentBatch(items) {
        batchSubmittedRevision = items[0].expectedRevisionId;
        return { operationId: 'op-1', items: [{ assetId: 'asset-race-1', revisionId: 'rev-final', byteSize: 100 }] };
      },
    },
  };

  const outcome = await commitOutput({
    scoped,
    processed: {
      assetId: 'asset-race-1',
      displayName: 'clip.mp4',
      managedFolderId: null,
      expectedRevisionId: 'rev-stale-initial', // 请求开始时获取到的旧版本
      output: {
        path: outputPath,
        extension: 'mp4',
        byteSize: 100,
        suggestedName: 'clip.mp4',
      },
      source: { byteSize: 200 },
    },
    request: { kind: 'compress', options: { suffix: '' } },
    signal: new AbortController().signal,
  });

  assert.equal(outcome.mode, 'replaced');
  assert.equal(batchSubmittedRevision, 'rev-concurrent-latest');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('verify transcode replace calls renameFile with newFileName and keeps asset intact', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-transcode-rename-'));
  const outputPath = path.join(tmpDir, 'clip.webm');
  fs.writeFileSync(outputPath, 'fake-webm-data');

  let renameCalledWith = null;
  const scoped = {
    assets: {
      async stageContent(assetId) {
        return { assetId, stagingToken: 'tok-transcode', byteSize: 200, complete: true };
      },
      async replaceContentBatch(items) {
        return { operationId: 'op-transcode', items: [{ assetId: items[0].assetId, revisionId: 'rev-2', byteSize: 200 }] };
      },
      async renameFile(assetId, baseName, options) {
        renameCalledWith = { assetId, baseName, options };
        return { assetId, displayName: options?.fileName ?? `${baseName}.webm` };
      },
    },
  };

  const outcome = await commitOutput({
    scoped,
    processed: {
      assetId: 'asset-video-1',
      displayName: 'my-holiday-video.mp4',
      managedFolderId: null,
      expectedRevisionId: 'rev-1',
      output: {
        path: outputPath,
        extension: 'webm',
        byteSize: 200,
        suggestedName: 'my-holiday-video.webm',
      },
      source: {
        byteSize: 500,
        extension: 'mp4',
      },
    },
    request: {
      kind: 'convert',
      options: {
        suffix: '', // 留空替换原资产
        videoFormat: 'webm',
        videoCodec: 'vp9',
      },
    },
    signal: new AbortController().signal,
  });

  assert.equal(outcome.mode, 'replaced');
  assert.ok(renameCalledWith);
  assert.equal(renameCalledWith.assetId, 'asset-video-1');
  assert.equal(renameCalledWith.baseName, 'my-holiday-video');
  assert.deepEqual(renameCalledWith.options, { fileName: 'my-holiday-video.webm' });

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
