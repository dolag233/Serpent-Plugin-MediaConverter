'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { createAbortError, probeMedia, runFfmpeg } = require('./ffmpeg-runner');
const {
  buildImageArgs,
  buildVideoArgs,
  formatBytesForLog,
  searchImageQuality,
  tokenizeAdvancedArgs,
} = require('./media-plan');
const { resolveSourceFile, stageFileForReplace } = require('./library-media');

const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'ts', 'mts', 'm2ts']);
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tif', 'tiff', 'gif', 'avif']);

function extensionOf(relativeFilePath) {
  const base = path.basename(relativeFilePath || '');
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot + 1).toLowerCase();
}

function isVideoAsset(assetSummary) {
  return VIDEO_EXTENSIONS.has(extensionOf(assetSummary.relativeFilePath));
}

function isImageAsset(assetSummary) {
  return IMAGE_EXTENSIONS.has(extensionOf(assetSummary.relativeFilePath));
}

function outputExtension(request, assetSummary) {
  if (request.kind === 'convert') {
    return isVideoAsset(assetSummary) ? request.options.videoFormat : request.options.imageFormat;
  }
  return extensionOf(assetSummary.relativeFilePath);
}

function sanitizeStem(displayName) {
  const stem = (displayName ?? '').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_').trim();
  return stem.length > 0 ? stem : 'asset';
}

async function ensureUniqueOutputPath(workDirectory, baseName, extension) {
  let candidate = path.join(workDirectory, `${baseName}.${extension}`);
  let counter = 1;
  while (fs.existsSync(candidate)) {
    counter += 1;
    candidate = path.join(workDirectory, `${baseName}-${counter}.${extension}`);
  }
  return candidate;
}

/**
 * Processes one asset end-to-end: source resolution, FFmpeg run, and output
 * classification. Commit (import vs replace) is performed by the caller.
 */
async function processAsset({
  scoped,
  libraryRoot,
  linkedFolders,
  assetSummary,
  request,
  binaries,
  workDirectory,
  signal,
  onPercent,
  runProcess = runFfmpeg,
  probe = probeMedia,
}) {
  if (signal.aborted) throw createAbortError();
  const isVideo = isVideoAsset(assetSummary);
  const isImage = isImageAsset(assetSummary);
  if (!isVideo && !isImage) {
    throw new Error(`不支持的资产扩展名：${extensionOf(assetSummary.relativeFilePath) || '(无)'}`);
  }

  const source = await resolveSourceFile({
    assets: scoped.assets,
    libraryRoot,
    linkedFolders,
    assetSummary,
    workDirectory,
    signal,
  });

  const resolvedExtension = outputExtension(request, assetSummary);
  const suffix = typeof request.options.suffix === 'string' && request.options.suffix.trim().length > 0
    ? request.options.suffix.trim().replace(/[\\/:*?"<>|]/g, '_')
    : (request.kind === 'convert' ? '_converted' : '_compressed');
  const outputNameBase = `${sanitizeStem(assetSummary.displayName)}${suffix}`;
  const outputPath = await ensureUniqueOutputPath(workDirectory, outputNameBase, resolvedExtension);

  let durationMicros = 0;
  if (isVideo) {
    const probed = await probe(binaries.ffprobe, source.filePath, signal);
    const videoStream = probed.streams.find((stream) => stream.codec_type === 'video');
    if (videoStream === undefined) throw new Error('源文件不含视频流。');
    durationMicros = Math.round(Number(probed.format.duration ?? 0) * 1_000_000);
    const sourceByteSize = Number(probed.format.size ?? assetSummary.byteSize ?? 0);

    const args = buildVideoArgs({
      inputPath: source.filePath,
      outputPath,
      durationMicros,
      sourceByteSize,
      options: {
        ...request.options,
        videoFormat: resolvedExtension,
      },
    });
    await runProcess({
      ffmpegPath: binaries.ffmpeg,
      args,
      totalDurationMicros: durationMicros,
      signal,
      onPercent,
    });
  } else {
    const imageFormat = request.kind === 'convert'
      ? resolvedExtension
      : extensionOf(assetSummary.relativeFilePath);
    const normalizedFormat = imageFormat === 'jpeg' ? 'jpg' : imageFormat;
    const targetBytes = request.kind === 'compress' && request.options.targetMode !== 'quality'
      ? Math.max(
        64 * 1024,
        request.options.targetMode === 'percent'
          ? Math.round((assetSummary.byteSize * Math.round(request.options.percent ?? 50)) / 100)
          : Math.round(request.options.targetBytes ?? 0),
      )
      : null;

    let qualityArg;
    if (normalizedFormat !== 'png' && targetBytes !== null) {
      const search = await searchImageQuality({
        format: normalizedFormat,
        targetBytes,
        async encodeAndGetBytes(qualityArg) {
          const candidatePath = await ensureUniqueOutputPath(workDirectory, `${outputNameBase}-probe`, resolvedExtension);
          const args = buildImageArgs({
            inputPath: source.filePath,
            outputPath: candidatePath,
            options: { ...request.options, imageFormat: resolvedExtension, qualityArg },
          });
          await runProcess({ ffmpegPath: binaries.ffmpeg, args, signal });
          const bytes = fs.statSync(candidatePath).size;
          try { fs.rmSync(candidatePath, { force: true }); } catch { /* best effort */ }
          return bytes;
        },
      });
      if (search === null) {
        throw new Error(
          `即使最低质量也无法压缩到 ${formatBytesForLog(targetBytes)} 以下，请放宽目标。`,
        );
      }
      qualityArg = search.qualityArg;
    }

    const args = buildImageArgs({
      inputPath: source.filePath,
      outputPath,
      options: {
        ...request.options,
        imageFormat: resolvedExtension,
        qualityArg,
      },
    });
    await runProcess({
      ffmpegPath: binaries.ffmpeg,
      args,
      signal,
      onPercent,
    });
  }

  if (signal.aborted) throw createAbortError();
  if (!fs.existsSync(outputPath)) throw new Error('FFmpeg 未产生输出文件。');
  const outputByteSize = fs.statSync(outputPath).size;
  if (outputByteSize === 0) throw new Error('FFmpeg 输出为空。');

  return {
    assetId: assetSummary.assetId,
    displayName: assetSummary.displayName,
    managedFolderId: assetSummary.managedFolderId ?? null,
    expectedRevisionId: assetSummary.currentRevisionId,
    output: {
      path: outputPath,
      extension: resolvedExtension,
      byteSize: outputByteSize,
      suggestedName: `${outputNameBase}.${resolvedExtension}`,
    },
    source: {
      byteSize: assetSummary.byteSize,
      assembled: source.assembled === true,
    },
  };
}

/**
 * Commits one processed output according to the request: replace the original
 * asset content through chunked staging, or import as a new asset.
 */
async function commitOutput({ scoped, processed, request, signal }) {
  const { output } = processed;
  if (request.kind === 'compress' && request.options.outputMode === 'replace') {
    const { stagingToken, byteSize } = await stageFileForReplace({
      assets: scoped.assets,
      assetId: processed.assetId,
      filePath: output.path,
      signal,
    });
    const replaced = await scoped.assets.replaceContentBatch([
      {
        assetId: processed.assetId,
        stagingToken,
        expectedRevisionId: processed.expectedRevisionId,
      },
    ]);
    const item = replaced?.items?.[0];
    return {
      assetId: processed.assetId,
      mode: 'replaced',
      byteSize: item?.byteSize ?? byteSize,
    };
  }

  const targetFolderId = processed.managedFolderId ?? undefined;
  const result = await scoped.files.import({
    sourceKind: 'files',
    sourcePaths: [output.path],
    ...(targetFolderId === undefined ? {} : { targetFolderId }),
    expandImageSequences: false,
  });
  if (result?.status === 'conflicts') {
    throw new Error(`导入存在需要人工处理的冲突（${output.suggestedName}）。`);
  }
  return {
    assetId: processed.assetId,
    mode: 'imported',
    suggestedName: output.suggestedName,
    byteSize: output.byteSize,
  };
}

/** Argument-tokenizer re-exported for tests. */
const tokenize = tokenizeAdvancedArgs;

module.exports = {
  IMAGE_EXTENSIONS,
  VIDEO_EXTENSIONS,
  commitOutput,
  extensionOf,
  isImageAsset,
  isVideoAsset,
  outputExtension,
  processAsset,
  sanitizeStem,
  tokenize,
};
