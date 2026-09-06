'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cleanupStaleRequests, createJobRequest, deleteJobRequest, readJobRequest } = require('./job-request-store');
const { deriveLibraryRoot, indexAssetSummaries, normalizeAssetSummary } = require('./library-media');
const { commitOutput, isImageAsset, isVideoAsset, processAsset, shouldReplaceOriginal } = require('./convert-pipeline');
const { createAbortError, listFfmpegEncoders, pickVideoEncoders } = require('./ffmpeg-runner');
const { resolveHostBinaries } = require('./host-binaries');
const {
  optionsFromWidgetValues,
  renderCompressDialog,
  renderConvertDialog,
} = require('./dialog-ui');

const PLUGIN_ID = 'com.dolag.serpent.media-converter';
const LAST_RESULT_KEY = 'panel.last-result';
const PROGRESS_UNITS_PER_ASSET = 100;
const PROGRESS_FLUSH_MS = 250;
const PROGRESS_MIN_UNIT_DELTA = 2;

const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'ts', 'mts', 'm2ts']);
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tif', 'tiff', 'gif', 'avif']);

let cachedEncoders = null;
async function getCachedEncoders(ffmpegPath, signal) {
  if (cachedEncoders !== null) return cachedEncoders;
  const listed = await listFfmpegEncoders(ffmpegPath, signal);
  cachedEncoders = pickVideoEncoders(listed);
  return cachedEncoders;
}

const inFlightAssetIds = new Set();

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function createJobProgressSink({ report, total }) {
  let sentCompleted = 0;
  let lastSentAt = 0;
  let chain = Promise.resolve();

  function enqueue(input, force) {
    chain = chain.then(async () => {
      const completed = Math.max(sentCompleted, Math.min(total, Math.floor(input.completed)));
      const now = Date.now();
      if (!force && completed === sentCompleted) return;
      if (!force
        && completed - sentCompleted < PROGRESS_MIN_UNIT_DELTA
        && now - lastSentAt < PROGRESS_FLUSH_MS) {
        return;
      }
      sentCompleted = completed;
      lastSentAt = now;
      await report({
        completed,
        total,
        phase: input.phase,
        message: input.message,
      });
    });
    return chain;
  }

  return {
    total,
    report(input) { return enqueue(input, true); },
    reportPercent(input) { return enqueue(input, false); },
    flush() { return chain; },
  };
}

function createCancellationBridge({ jobSignal, lifecycleSignal }) {
  const controller = new AbortController();
  const onAbort = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  const listeners = [];
  for (const signal of [jobSignal, lifecycleSignal]) {
    if (typeof signal?.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort, { once: true });
      listeners.push(signal);
    }
  }
  const timer = setInterval(() => {
    if (jobSignal?.aborted || lifecycleSignal?.aborted) onAbort();
  }, 50);
  timer.unref?.();
  return {
    signal: controller.signal,
    abort: onAbort,
    dispose() {
      clearInterval(timer);
      for (const signal of listeners) signal.removeEventListener('abort', onAbort);
    },
  };
}

async function writeState(serpent, key, value, scope = 'library') {
  await serpent.storage.set(key, value, { scope });
}

async function readState(serpent, key, scope = 'library') {
  return serpent.storage.get(key, { scope });
}

async function notifyUser(serpent, input) {
  if (typeof serpent.ui?.notify !== 'function') return;
  try {
    await serpent.ui.notify(input);
  } catch {
    // Notification failure must not change the command or Job result.
  }
}

function resolveCommandTargets(context) {
  const invocation = context?.invocation;
  const targetLibraryId = typeof invocation?.libraryId === 'string' && invocation.libraryId.length > 0
    ? invocation.libraryId
    : context?.targetLibraryId;
  const invocationAssetIds = invocation?.selection?.assetIds;
  const assetIds = Array.isArray(invocationAssetIds)
    ? [...invocationAssetIds]
    : Array.isArray(context?.assetIds) ? [...context.assetIds] : [];
  const invocationAssets = Array.isArray(invocation?.selection?.assets)
    ? invocation.selection.assets.map(normalizeAssetSummary).filter(Boolean)
    : [];
  return { targetLibraryId, assetIds, assets: invocationAssets };
}

function classifyAssets(summaries) {
  const counts = { imageCount: 0, videoCount: 0, total: summaries.length };
  for (const summary of summaries) {
    if (isVideoAsset(summary)) counts.videoCount += 1;
    else if (isImageAsset(summary)) counts.imageCount += 1;
  }
  return counts;
}

function classifySelectionFromAssets(assetIds, assets) {
  const wanted = new Set(assetIds);
  const summaries = assets.filter((summary) => wanted.has(summary.assetId));
  if (summaries.length === 0) return { imageCount: 0, videoCount: 0, total: assetIds.length };
  return { ...classifyAssets(summaries), total: assetIds.length };
}

function filterTargetsForCommand(kind, assetIds, assets) {
  if (kind !== 'convert') {
    return {
      assetIds: [...assetIds],
      assets: [...assets],
      skippedImageCount: 0,
      skippedOtherCount: 0,
    };
  }
  const index = new Map(assets.map((summary) => [summary.assetId, summary]));
  const keptIds = [];
  const keptAssets = [];
  let skippedImageCount = 0;
  let skippedOtherCount = 0;
  for (const assetId of assetIds) {
    const summary = index.get(assetId);
    if (summary === undefined) {
      keptIds.push(assetId);
      continue;
    }
    if (isVideoAsset(summary)) {
      keptIds.push(assetId);
      keptAssets.push(summary);
      continue;
    }
    if (isImageAsset(summary)) skippedImageCount += 1;
    else skippedOtherCount += 1;
  }
  return { assetIds: keptIds, assets: keptAssets, skippedImageCount, skippedOtherCount };
}

function deriveSelectionFromContext(context, assetIds, assets) {
  if (Array.isArray(assets) && assets.length > 0) {
    return classifySelectionFromAssets(assetIds, assets);
  }
  const selection = context?.invocation?.selection;
  const mediaTypes = Array.isArray(selection?.mediaTypes) ? selection.mediaTypes : [];
  const extensions = Array.isArray(selection?.extensions)
    ? selection.extensions.map((e) => String(e).toLowerCase().replace(/^\./, ''))
    : [];

  let hasVideo = mediaTypes.includes('video');
  let hasImage = mediaTypes.includes('image');
  if (!hasVideo && !hasImage && extensions.length > 0) {
    hasVideo = extensions.some((ext) => VIDEO_EXTENSIONS.has(ext));
    hasImage = extensions.some((ext) => IMAGE_EXTENSIONS.has(ext));
  }

  if (hasVideo && !hasImage) {
    return { imageCount: 0, videoCount: assetIds.length, total: assetIds.length };
  }
  if (hasImage && !hasVideo) {
    return { imageCount: assetIds.length, videoCount: 0, total: assetIds.length };
  }
  return { imageCount: 0, videoCount: 0, total: assetIds.length };
}

function indexFromSnapshots(items) {
  const index = new Map();
  if (!Array.isArray(items)) return index;
  for (const item of items) {
    const summary = normalizeAssetSummary(item);
    if (summary) index.set(summary.assetId, summary);
  }
  return index;
}

function unwrapDialogResult(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return null;
  if ('videoFormat' in value || 'targetMode' in value || 'videoCodec' in value
    || 'imageTargetMode' in value || 'videoTargetMode' in value) {
    return value;
  }
  if ('result' in value) {
    const inner = value.result;
    if (inner === null || inner === undefined) return null;
    if (typeof inner === 'object') return inner;
  }
  return value;
}

function createPluginRuntime(options = {}) {
  const packageRoot = options.packageRoot ?? path.resolve(__dirname, '..');
  let serpent;
  let lifecycleSignal;
  let jobsDirectory;
  let workRoot;
  let currentCancellation;
  let initialized = false;
  let disposed = false;

  function assertNotCancelled(jobSignal) {
    if (disposed || lifecycleSignal?.aborted) throw createAbortError('The plugin instance was disposed.');
    if (jobSignal?.aborted) {
      jobSignal.throwIfAborted?.();
      throw createAbortError();
    }
  }

  async function handleMediaJob(payload, job, jobSignal) {
    const requestFile = payload?.requestFile;
    const targetLibraryId = job?.libraryId;
    if (typeof targetLibraryId !== 'string' || targetLibraryId.length === 0) {
      throw new Error('The media Job did not receive a target library.');
    }
    const request = await readJobRequest({ directory: jobsDirectory, fileName: requestFile });
    if (request.libraryId !== targetLibraryId) {
      throw new Error('The media Job target library does not match the request.');
    }
    const scoped = serpent.forLibrary(targetLibraryId);
    const binaries = await resolveHostBinaries(serpent);
    const cancellation = createCancellationBridge({ jobSignal, lifecycleSignal });
    currentCancellation = cancellation;
    const workDirectory = fs.mkdtempSync(path.join(workRoot, 'job-'));
    let totalAssets = request.assetIds.length;
    const progressTotal = Math.max(1, totalAssets) * PROGRESS_UNITS_PER_ASSET;
    const progressSink = createJobProgressSink({
      total: progressTotal,
      report: (progress) => scoped.jobs.reportProgress({ jobId: job.jobId, ...progress }),
    });
    const committed = [];
    const failures = [];
    try {
      await progressSink.report({ completed: 0, phase: '准备', message: '读取资产信息' });
      const encoders = await getCachedEncoders(binaries.ffmpeg, cancellation.signal);
      if (encoders.h264 === null && encoders.hevc === null && encoders.vp9 === null && encoders.av1 === null) {
        throw new Error('宿主 FFmpeg 没有可用的视频编码器。');
      }
      const jobBinaries = { ...binaries, encoders };
      const index = indexFromSnapshots(request.assets);
      const missing = request.assetIds.filter((assetId) => !index.has(assetId));
      if (missing.length > 0) {
        const listedSummaries = await indexAssetSummaries({
          assets: scoped.assets,
          assetIds: missing,
          signal: cancellation.signal,
        });
        for (const [assetId, summary] of listedSummaries) index.set(assetId, summary);
      }
      if (shouldReplaceOriginal(request)) {
        const missingRevision = request.assetIds.filter((assetId) => {
          const summary = index.get(assetId);
          return summary !== undefined
            && (typeof summary.currentRevisionId !== 'string' || summary.currentRevisionId.length === 0);
        });
        if (missingRevision.length > 0) {
          const listedSummaries = await indexAssetSummaries({
            assets: scoped.assets,
            assetIds: missingRevision,
            signal: cancellation.signal,
          });
          for (const [assetId, summary] of listedSummaries) {
            const existing = index.get(assetId);
            if (existing === undefined) {
              index.set(assetId, summary);
              continue;
            }
            index.set(assetId, {
              ...existing,
              currentRevisionId: summary.currentRevisionId ?? existing.currentRevisionId,
              managedFolderId: existing.managedFolderId ?? summary.managedFolderId,
            });
          }
        }
      }
      const loadedSummaries = request.assetIds
        .map((assetId) => index.get(assetId))
        .filter((summary) => summary !== undefined);
      const skippedNonVideo = [];
      const summaries = request.kind === 'convert'
        ? loadedSummaries.filter((summary) => {
          if (isVideoAsset(summary)) return true;
          skippedNonVideo.push(summary);
          return false;
        })
        : loadedSummaries;
      totalAssets = summaries.length;
      const needsLinked = summaries.some((summary) => summary.locationKind === 'linked');
      const linkedFolderPage = needsLinked
        ? await scoped.linkedFolders.list({ limit: 200 }).catch(() => null)
        : null;
      const linkedFolders = Array.isArray(linkedFolderPage?.items) ? linkedFolderPage.items : [];

      for (const assetId of request.assetIds) {
        if (!index.has(assetId)) {
          failures.push({ assetId, displayName: assetId, error: '未找到资产信息。' });
        }
      }

      for (const [index, summary] of summaries.entries()) {
        assertNotCancelled(jobSignal);
        const label = `第 ${index + 1}/${totalAssets} 个`;
        const assetBase = index * PROGRESS_UNITS_PER_ASSET;
        try {
          await progressSink.report({ completed: assetBase, phase: '读取', message: `${label} ${summary.displayName}` });
          const processed = await processAsset({
            scoped,
            libraryRoot: request.libraryRoot ?? null,
            linkedFolders,
            assetSummary: summary,
            request,
            binaries: jobBinaries,
            workDirectory,
            signal: cancellation.signal,
            onPercent(percent) {
              const units = assetBase + Math.min(PROGRESS_UNITS_PER_ASSET - 1, Math.round(percent));
              return progressSink.reportPercent({
                completed: units,
                phase: request.kind === 'convert' ? '转换' : '压缩',
                message: `${label} ${summary.displayName} · ${Math.round(percent)}%`,
              });
            },
          });
          await progressSink.flush();
          await progressSink.report({
            completed: assetBase + PROGRESS_UNITS_PER_ASSET - 5,
            phase: '写入',
            message: `${label} ${summary.displayName}`,
          });
          const outcome = await commitOutput({ scoped, processed, request, signal: cancellation.signal });
          committed.push({ ...outcome, displayName: summary.displayName });
          await progressSink.report({
            completed: (index + 1) * PROGRESS_UNITS_PER_ASSET,
            phase: '写入',
            message: `已完成 ${committed.length}/${totalAssets} 个`,
          });
        } catch (error) {
          if (error?.name === 'AbortError') throw error;
          failures.push({ assetId: summary.assetId, displayName: summary.displayName, error: errorMessage(error) });
        }
      }

      assertNotCancelled(jobSignal);
      await progressSink.flush();
      await deleteJobRequest({ directory: jobsDirectory, fileName: requestFile });
      const result = {
        kind: request.kind,
        jobId: job.jobId,
        completed: committed.length,
        failed: failures.length,
        total: totalAssets,
        committed,
        failures,
        status: failures.length > 0 && committed.length === 0 ? 'failed' : 'succeeded',
      };
      await writeState(serpent, LAST_RESULT_KEY, result);
      const skippedNote = skippedNonVideo.length > 0
        ? `，跳过 ${skippedNonVideo.length} 个非视频`
        : '';
      await notifyUser(scoped, {
        severity: failures.length > 0 ? 'warning' : 'info',
        title: request.kind === 'convert' ? '视频转码完成' : '媒体压缩完成',
        message: `${committed.length}/${totalAssets} 个成功`
          + skippedNote
          + (failures.length > 0 ? `，${failures.length} 个失败：${failures[0].error}` : '。'),
      });
    } catch (error) {
      await writeState(serpent, LAST_RESULT_KEY, {
        kind: request.kind,
        jobId: job?.jobId,
        completed: committed.length,
        failed: failures.length,
        total: totalAssets,
        status: error?.name === 'AbortError' ? 'cancelled' : 'failed',
        error: errorMessage(error),
      }).catch(() => undefined);
      await notifyUser(scoped, {
        severity: 'error',
        title: request.kind === 'convert' ? '视频转码失败' : '媒体压缩失败',
        message: errorMessage(error),
      });
      throw error;
    } finally {
      if (Array.isArray(request?.assetIds)) {
        for (const id of request.assetIds) inFlightAssetIds.delete(id);
      }
      cancellation.dispose();
      if (currentCancellation === cancellation) currentCancellation = undefined;
      try { fs.rmSync(workDirectory, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }

  function labelFor(kind) {
    return kind === 'compress' ? '媒体压缩' : '视频转码';
  }

  async function runOpenDialogCommand(context, requestedKind) {
    const { targetLibraryId, assetIds: selectedAssetIds, assets: selectedAssets } = resolveCommandTargets(context);
    if (typeof targetLibraryId !== 'string' || targetLibraryId.length === 0) {
      throw new Error('The command did not receive a target library.');
    }
    if (selectedAssetIds.length === 0) throw new Error('请先选择要处理的资产。');
    if (typeof serpent.ui?.openDialog !== 'function') {
      throw new Error('当前 Serpent 未提供对话框接口。请升级宿主后再试。');
    }

    const kind = requestedKind ?? 'convert';
    const scoped = serpent.forLibrary(targetLibraryId);
    const filtered = filterTargetsForCommand(kind, selectedAssetIds, selectedAssets);
    if (kind === 'convert' && filtered.assetIds.length === 0) {
      await notifyUser(scoped, {
        severity: 'warning',
        title: '视频转码',
        message: '所选资产中没有可转码的视频。图片不会进入转码任务。',
      });
      return;
    }
    const assetIds = filtered.assetIds;
    const assets = filtered.assets;
    const selection = kind === 'compress'
      ? deriveSelectionFromContext(context, selectedAssetIds, selectedAssets)
      : {
        imageCount: 0,
        videoCount: assetIds.length,
        total: assetIds.length,
        skippedImageCount: filtered.skippedImageCount,
        skippedOtherCount: filtered.skippedOtherCount,
      };
    const rawResult = await serpent.ui.openDialog({
      title: labelFor(kind),
      submitLabel: '开始处理',
      render(ui) {
        return kind === 'compress'
          ? renderCompressDialog(ui, selection)
          : renderConvertDialog(ui, selection);
      },
    });
    const values = unwrapDialogResult(rawResult);
    if (values === null || typeof values !== 'object') return;
    const options = optionsFromWidgetValues(kind, values);

    // 防重入与竞态保护：检查是否有资产正在处理中
    const busyAssetIds = assetIds.filter((id) => inFlightAssetIds.has(id));
    if (busyAssetIds.length > 0) {
      await notifyUser(scoped, {
        severity: 'warning',
        title: '任务正在处理中',
        message: `所选资产中有 ${busyAssetIds.length} 个已有任务正在处理，请勿重复提交。`,
      });
      return;
    }

    for (const id of assetIds) inFlightAssetIds.add(id);

    let libraryRoot = null;
    try {
      const data = await serpent.data.getDirectory({ scope: 'library' });
      libraryRoot = deriveLibraryRoot(data.path, PLUGIN_ID);
    } catch {
      libraryRoot = null;
    }

    const request = {
      kind,
      assetIds,
      assets,
      libraryId: targetLibraryId,
      libraryRoot,
      createdAt: Date.now(),
      options,
    };
    const requestFile = await createJobRequest({ directory: jobsDirectory, request });
    let result;
    try {
      result = await scoped.jobs.enqueue({
        handlerId: 'media-convert',
        payload: { requestFile: requestFile.fileName },
        recoveryStrategy: 'idempotent',
      });
    } catch (error) {
      for (const id of assetIds) inFlightAssetIds.delete(id);
      await deleteJobRequest({ directory: jobsDirectory, fileName: requestFile.fileName });
      throw error;
    }
    await writeState(serpent, LAST_RESULT_KEY, {
      kind,
      jobId: result.jobId,
      completed: 0,
      failed: 0,
      total: assetIds.length,
      status: 'queued',
    });
    await notifyUser(scoped, {
      severity: 'info',
      title: labelFor(kind),
      message: `${assetIds.length} 个资产已开始处理，可于活动任务横幅查看进度。`,
    });
  }

  async function setup(context) {
    if (initialized) return;
    if (disposed) throw new Error('The plugin runtime has already been disposed.');
    serpent = context?.serpent;
    if (serpent === null || typeof serpent !== 'object') {
      throw new TypeError('setup(context) requires context.serpent.');
    }
    lifecycleSignal = context.signal;

    const userData = await serpent.data.getDirectory({ scope: 'user' });
    jobsDirectory = path.join(userData.path, 'jobs');
    workRoot = path.join(os.tmpdir(), 'serpent-media-converter');
    fs.mkdirSync(jobsDirectory, { recursive: true, mode: 0o700 });
    fs.mkdirSync(workRoot, { recursive: true, mode: 0o700 });
    cleanupStaleRequests(jobsDirectory);

    serpent.commands.register('mediaconverter.open-convert', (commandContext) => runOpenDialogCommand(commandContext, 'convert'));
    serpent.commands.register('mediaconverter.open-compress', (commandContext) => runOpenDialogCommand(commandContext, 'compress'));
    serpent.jobs.registerHandler('media-convert', handleMediaJob);

    if (typeof lifecycleSignal?.addEventListener === 'function') {
      const onAbort = () => {
        void dispose('instance-aborted');
      };
      lifecycleSignal.addEventListener('abort', onAbort, { once: true });
      context.subscriptions?.add?.(() => lifecycleSignal.removeEventListener('abort', onAbort));
    }
    initialized = true;
  }

  async function dispose(reason) {
    if (disposed) return;
    disposed = true;
    currentCancellation?.abort();
    currentCancellation = undefined;
    void reason;
  }

  return {
    setup,
    dispose,
  };
}

const defaultRuntime = createPluginRuntime();

async function setup(context) {
  return defaultRuntime.setup(context);
}

async function dispose(reason) {
  return defaultRuntime.dispose(reason);
}

module.exports = {
  PLUGIN_ID,
  PROGRESS_UNITS_PER_ASSET,
  classifyAssets,
  createPluginRuntime,
  deriveSelectionFromContext,
  dispose,
  filterTargetsForCommand,
  resolveCommandTargets,
  setup,
  unwrapDialogResult,
  optionsFromWidgetValues,
};
