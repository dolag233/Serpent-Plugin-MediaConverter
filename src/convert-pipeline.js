'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { createAbortError, durationMicrosFromProbe, probeMedia, runFfmpeg } = require('./ffmpeg-runner');
const {
  buildImageArgs,
  buildVideoArgs,
  formatBytesForLog,
  isBitrateMode,
  isQualityMode,
  searchImageQuality,
  tokenizeAdvancedArgs,
} = require('./media-plan');
const { resolveSourceFile, stageFileForReplace } = require('./library-media');
const { optionsForAsset } = require('./dialog-ui');

const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'ts', 'mts', 'm2ts']);
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tif', 'tiff', 'gif', 'avif']);

const MIME_EXTENSION = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'video/x-msvideo': 'avi',
  'video/mp2t': 'ts',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'image/avif': 'avif',
};

function extensionOf(relativeFilePath) {
  const base = path.basename(relativeFilePath || '');
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot + 1).toLowerCase();
}

function extensionOfAsset(assetSummary) {
  const fromPath = extensionOf(assetSummary.relativeFilePath);
  if (fromPath) return fromPath;
  const fromName = extensionOf(assetSummary.displayName);
  if (fromName) return fromName;
  const mime = typeof assetSummary.mimeType === 'string' ? assetSummary.mimeType.toLowerCase() : '';
  return MIME_EXTENSION[mime] ?? '';
}

function isVideoAsset(assetSummary) {
  if (assetSummary.mediaType === 'video') return true;
  const extension = extensionOfAsset(assetSummary);
  if (VIDEO_EXTENSIONS.has(extension)) return true;
  const mime = typeof assetSummary.mimeType === 'string' ? assetSummary.mimeType.toLowerCase() : '';
  return mime.startsWith('video/');
}

function isImageAsset(assetSummary) {
  if (assetSummary.mediaType === 'image') return true;
  const extension = extensionOfAsset(assetSummary);
  if (IMAGE_EXTENSIONS.has(extension)) return true;
  const mime = typeof assetSummary.mimeType === 'string' ? assetSummary.mimeType.toLowerCase() : '';
  return mime.startsWith('image/');
}

function outputExtension(request, assetSummary) {
  if (request.kind === 'convert') {
    if (!isVideoAsset(assetSummary)) {
      throw new Error('视频转码仅支持视频资产。');
    }
    return request.options.videoFormat === 'webm' ? 'webm' : 'mp4';
  }
  const original = extensionOfAsset(assetSummary);
  return original === 'jpeg' ? 'jpg' : original;
}

function sanitizeStem(displayName) {
  const stem = (displayName ?? '').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_').trim();
  return stem.length > 0 ? stem : 'asset';
}

function suffixOf(options) {
  return typeof options?.suffix === 'string' ? options.suffix.trim().replace(/[\\/:*?"<>|]/g, '_') : '';
}

function shouldReplaceOriginal(request) {
  return suffixOf(request.options).length === 0;
}

function normalizeMediaExtension(extension) {
  const lower = String(extension ?? '').toLowerCase();
  return lower === 'jpeg' ? 'jpg' : lower;
}

function importedAssetIdFromResult(result) {
  const assets = result?.completion?.assets ?? result?.assets;
  if (!Array.isArray(assets) || assets.length === 0) return null;
  const first = assets[0];
  if (!first || typeof first !== 'object') return null;
  if (typeof first.assetId === 'string' && first.assetId.length > 0) return first.assetId;
  if (typeof first.id === 'string' && first.id.length > 0) return first.id;
  return null;
}

function tagIdsFromMetadata(metadata) {
  if (!Array.isArray(metadata?.tags)) return [];
  return metadata.tags
    .map((tag) => (typeof tag === 'string' ? tag : tag?.id ?? tag?.tagId))
    .filter((id) => typeof id === 'string' && id.length > 0);
}

async function copyAssetAnnotations(scoped, sourceAssetId, targetAssetId) {
  if (!sourceAssetId || !targetAssetId || sourceAssetId === targetAssetId) return;
  if (typeof scoped?.assets?.getMetadata !== 'function') return;
  let payload;
  try {
    payload = await scoped.assets.getMetadata(sourceAssetId);
  } catch {
    return;
  }
  const metadata = payload?.metadata && typeof payload.metadata === 'object'
    ? payload.metadata
    : payload;
  if (!metadata || typeof metadata !== 'object') return;
  const tagIds = tagIdsFromMetadata(metadata);
  if (tagIds.length > 0 && typeof scoped.tags?.assign === 'function') {
    try {
      await scoped.tags.assign([targetAssetId], tagIds);
    } catch {
      // Permission or missing tags must not roll back the imported file.
    }
  }
  if (typeof scoped.assets.setMetadata !== 'function') return;
  try {
    await scoped.assets.setMetadata({
      assetId: targetAssetId,
      expectedVersion: 0,
      description: metadata.description ?? null,
      rating: typeof metadata.rating === 'number' ? metadata.rating : undefined,
      favorite: typeof metadata.favorite === 'boolean' ? metadata.favorite : undefined,
      sourcePageUrl: metadata.sourcePageUrl ?? undefined,
      author: metadata.author ?? undefined,
    });
  } catch {
    // New assets start at entityVersion 0; ignore if the host rejects a field.
  }
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
  let workingSummary = assetSummary;
  const source = await resolveSourceFile({
    assets: scoped.assets,
    libraryRoot,
    linkedFolders,
    assetSummary: workingSummary,
    workDirectory,
    signal,
  });
  workingSummary = {
    ...workingSummary,
    mimeType: source.mimeType ?? workingSummary.mimeType,
    byteSize: source.byteSize || workingSummary.byteSize,
    currentRevisionId: source.revisionId ?? workingSummary.currentRevisionId,
  };

  const isVideo = isVideoAsset(workingSummary);
  const isImage = isImageAsset(workingSummary);
  if (request.kind === 'convert' && !isVideo) {
    throw new Error('视频转码仅支持视频资产。');
  }
  if (!isVideo && !isImage) {
    throw new Error(`不支持的资产类型：${extensionOfAsset(workingSummary) || workingSummary.mimeType || '(未知)'}`);
  }

  const resolvedOptions = optionsForAsset(request.kind, request.options, isVideo);
  const resolvedExtension = outputExtension(request, workingSummary);
  const suffix = suffixOf(resolvedOptions);
  const outputNameBase = `${sanitizeStem(workingSummary.displayName)}${suffix}`;
  const outputPath = await ensureUniqueOutputPath(workDirectory, outputNameBase, resolvedExtension);

  let durationMicros = 0;
  const sourceByteSize = Number(source.byteSize || workingSummary.byteSize || 0);
  if (isVideo) {
    const probed = await probe(binaries.ffprobe, source.filePath, signal);
    const videoStream = probed.streams.find((stream) => stream.codec_type === 'video');
    if (videoStream === undefined) throw new Error('源文件不含视频流。');
    durationMicros = durationMicrosFromProbe(probed);
    const hasAudio = probed.streams.some((stream) => stream.codec_type === 'audio');

    const args = buildVideoArgs({
      inputPath: source.filePath,
      outputPath,
      durationMicros,
      sourceByteSize: Number(probed.format.size ?? sourceByteSize),
      encoders: binaries.encoders,
      hasAudio,
      options: {
        ...resolvedOptions,
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
    if (
      request.kind === 'compress'
      && !isQualityMode(resolvedOptions)
      && !isBitrateMode(resolvedOptions)
      && sourceByteSize > 0
      && fs.existsSync(outputPath)
      && fs.statSync(outputPath).size >= sourceByteSize
    ) {
      const durationSeconds = Math.max(0.05, durationMicros / 1_000_000);
      const reducedKbps = Math.max(100, Math.round((sourceByteSize * 8) / durationSeconds / 1000 * 0.45));
      const retryArgs = buildVideoArgs({
        inputPath: source.filePath,
        outputPath,
        durationMicros,
        sourceByteSize,
        encoders: binaries.encoders,
        hasAudio,
        options: {
          ...resolvedOptions,
          videoFormat: resolvedExtension,
          targetMode: 'bitrate',
          videoBitrateKbps: reducedKbps,
        },
      });
      await runProcess({
        ffmpegPath: binaries.ffmpeg,
        args: retryArgs,
        totalDurationMicros: durationMicros,
        signal,
        onPercent,
      });
    }
  } else {
    const imageFormat = resolvedExtension === 'jpeg' ? 'jpg' : resolvedExtension;
    const targetBytes = request.kind === 'compress' && resolvedOptions.targetMode !== 'quality'
      ? Math.max(
        1024,
        resolvedOptions.targetMode === 'percent'
          ? Math.round((sourceByteSize * Math.round(resolvedOptions.percent ?? 50)) / 100)
          : Math.round(resolvedOptions.targetBytes ?? 0),
      )
      : null;

    let qualityArg;
    let scaleRatio;

    if (targetBytes !== null) {
      if (imageFormat !== 'png') {
        const search = await searchImageQuality({
          format: imageFormat,
          targetBytes,
          returnBestEffort: true,
          async encodeAndGetBytes(testQualityArg) {
            const candidatePath = await ensureUniqueOutputPath(workDirectory, `${outputNameBase}-probe`, resolvedExtension);
            const args = buildImageArgs({
              inputPath: source.filePath,
              outputPath: candidatePath,
              options: { ...resolvedOptions, imageFormat: resolvedExtension, qualityArg: testQualityArg },
            });
            await runProcess({ ffmpegPath: binaries.ffmpeg, args, signal });
            const bytes = fs.existsSync(candidatePath) ? fs.statSync(candidatePath).size : Infinity;
            try { fs.rmSync(candidatePath, { force: true }); } catch { /* best effort */ }
            return bytes;
          },
        });

        if (search && !search.overflow && search.bytes <= targetBytes) {
          qualityArg = search.qualityArg;
        } else {
          // 原分辨率即使最低画质仍超出目标，需要结合等比分辨率缩放
          qualityArg = search?.qualityArg ?? (IMAGE_SEARCH_SCALES[imageFormat]?.max ?? 31);
          const currentBytes = search?.bytes ?? sourceByteSize;
          let currentScale = Math.min(0.95, Math.max(0.05, Math.sqrt(targetBytes / Math.max(targetBytes + 1, currentBytes)) * 0.95));
          for (let attempt = 0; attempt < 3; attempt += 1) {
            const candidatePath = await ensureUniqueOutputPath(workDirectory, `${outputNameBase}-probe-scale`, resolvedExtension);
            const args = buildImageArgs({
              inputPath: source.filePath,
              outputPath: candidatePath,
              options: {
                ...resolvedOptions,
                imageFormat: resolvedExtension,
                qualityArg,
                scaleRatio: currentScale,
              },
            });
            await runProcess({ ffmpegPath: binaries.ffmpeg, args, signal });
            const bytes = fs.existsSync(candidatePath) ? fs.statSync(candidatePath).size : Infinity;
            try { fs.rmSync(candidatePath, { force: true }); } catch { /* best effort */ }
            if (bytes <= targetBytes) {
              scaleRatio = currentScale;
              break;
            }
            currentScale = Math.min(currentScale * 0.85, Math.sqrt(targetBytes / bytes) * currentScale * 0.95);
            scaleRatio = currentScale;
          }
        }
      } else {
        // PNG 格式（无损）：先测原分辨率无损压缩体积
        const probePath = await ensureUniqueOutputPath(workDirectory, `${outputNameBase}-probe-png`, resolvedExtension);
        const probeArgs = buildImageArgs({
          inputPath: source.filePath,
          outputPath: probePath,
          options: { ...resolvedOptions, imageFormat: 'png' },
        });
        await runProcess({ ffmpegPath: binaries.ffmpeg, args: probeArgs, signal });
        const pngBytes = fs.existsSync(probePath) ? fs.statSync(probePath).size : Infinity;
        try { fs.rmSync(probePath, { force: true }); } catch { /* best effort */ }

        if (pngBytes > targetBytes) {
          let currentScale = Math.min(0.95, Math.max(0.05, Math.sqrt(targetBytes / Math.max(targetBytes + 1, pngBytes)) * 0.95));
          for (let attempt = 0; attempt < 3; attempt += 1) {
            const candidatePath = await ensureUniqueOutputPath(workDirectory, `${outputNameBase}-probe-scale`, resolvedExtension);
            const args = buildImageArgs({
              inputPath: source.filePath,
              outputPath: candidatePath,
              options: {
                ...resolvedOptions,
                imageFormat: 'png',
                scaleRatio: currentScale,
              },
            });
            await runProcess({ ffmpegPath: binaries.ffmpeg, args, signal });
            const bytes = fs.existsSync(candidatePath) ? fs.statSync(candidatePath).size : Infinity;
            try { fs.rmSync(candidatePath, { force: true }); } catch { /* best effort */ }
            if (bytes <= targetBytes) {
              scaleRatio = currentScale;
              break;
            }
            currentScale = Math.min(currentScale * 0.85, Math.sqrt(targetBytes / bytes) * currentScale * 0.95);
            scaleRatio = currentScale;
          }
        }
      }
    }

    const args = buildImageArgs({
      inputPath: source.filePath,
      outputPath,
      options: {
        ...resolvedOptions,
        imageFormat: resolvedExtension,
        qualityArg,
        scaleRatio,
      },
    });
    await runProcess({
      ffmpegPath: binaries.ffmpeg,
      args,
      signal,
      onPercent,
    });

    if (
      request.kind === 'compress'
      && sourceByteSize > 0
      && fs.existsSync(outputPath)
      && fs.statSync(outputPath).size >= sourceByteSize
    ) {
      const fallbackTarget = Math.round(sourceByteSize * 0.8);
      const currentSize = fs.statSync(outputPath).size;
      const retryScale = Math.min(0.85, Math.sqrt(fallbackTarget / Math.max(fallbackTarget + 1, currentSize)) * 0.9);
      const retryArgs = buildImageArgs({
        inputPath: source.filePath,
        outputPath,
        options: {
          ...resolvedOptions,
          imageFormat: resolvedExtension,
          qualityArg: imageFormat === 'png' ? undefined : (IMAGE_SEARCH_SCALES[imageFormat]?.max ?? 31),
          scaleRatio: retryScale,
        },
      });
      await runProcess({
        ffmpegPath: binaries.ffmpeg,
        args: retryArgs,
        signal,
        onPercent,
      });
    }
  }

  if (signal.aborted) throw createAbortError();
  if (!fs.existsSync(outputPath)) throw new Error('FFmpeg 未产生输出文件。');
  const outputByteSize = fs.statSync(outputPath).size;
  if (outputByteSize === 0) throw new Error('FFmpeg 输出为空。');

  return {
    assetId: workingSummary.assetId,
    displayName: workingSummary.displayName,
    managedFolderId: workingSummary.managedFolderId ?? null,
    expectedRevisionId: workingSummary.currentRevisionId,
    output: {
      path: outputPath,
      extension: resolvedExtension,
      byteSize: outputByteSize,
      suggestedName: `${outputNameBase}.${resolvedExtension}`,
    },
    source: {
      byteSize: sourceByteSize,
      assembled: source.assembled === true,
      extension: extensionOfAsset(workingSummary),
    },
  };
}

/**
 * Commits one processed output according to the request: replace the original
 * asset content through chunked staging, or import as a new asset.
 */
async function commitOutput({ scoped, processed, request, signal }) {
  const { output } = processed;
  if (shouldReplaceOriginal(request)) {
    let expectedRevisionId = processed.expectedRevisionId;
    if (typeof scoped?.assets?.list === 'function') {
      try {
        const fresh = await scoped.assets.list({ assetIds: [processed.assetId], limit: 1, offset: 0 });
        const items = Array.isArray(fresh?.items) ? fresh.items : Array.isArray(fresh?.assets) ? fresh.assets : [];
        if (items.length > 0 && typeof items[0].currentRevisionId === 'string' && items[0].currentRevisionId.length > 0) {
          expectedRevisionId = items[0].currentRevisionId;
        }
      } catch {
        // Fallback to original expectedRevisionId
      }
    }
    if (typeof expectedRevisionId !== 'string' || expectedRevisionId.length === 0) {
      throw new Error('无法替换原资产：缺少修订版本。');
    }
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
        expectedRevisionId,
      },
    ]);
    const item = replaced?.items?.[0];
    const sourceExtension = normalizeMediaExtension(
      processed.source?.extension ?? extensionOf(processed.displayName),
    );
    const outputExtensionName = normalizeMediaExtension(output.extension);
    if (sourceExtension.length > 0 && outputExtensionName.length > 0 && sourceExtension !== outputExtensionName) {
      if (typeof scoped.assets.renameFile !== 'function') {
        throw new Error('无法把转码结果改成新的文件扩展名：宿主未提供重命名。');
      }
      const stem = sanitizeStem(processed.displayName);
      await scoped.assets.renameFile(processed.assetId, stem, {
        fileName: `${stem}.${outputExtensionName}`,
      });
    }
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
  const importedAssetId = importedAssetIdFromResult(result);
  if (importedAssetId && importedAssetId !== processed.assetId) {
    await copyAssetAnnotations(scoped, processed.assetId, importedAssetId);
  }
  return {
    assetId: importedAssetId ?? processed.assetId,
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
  copyAssetAnnotations,
  extensionOf,
  extensionOfAsset,
  importedAssetIdFromResult,
  isImageAsset,
  isVideoAsset,
  normalizeMediaExtension,
  outputExtension,
  processAsset,
  sanitizeStem,
  shouldReplaceOriginal,
  suffixOf,
  tokenize,
};
