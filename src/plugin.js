'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveFfmpegBinaries } = require('./ffmpeg-locator');
const { cleanupStaleRequests, createJobRequest, deleteJobRequest, readJobRequest } = require('./job-request-store');
const { deriveLibraryRoot, indexAssetSummaries } = require('./library-media');
const { commitOutput, processAsset } = require('./convert-pipeline');
const { createAbortError } = require('./ffmpeg-runner');

const PLUGIN_ID = 'com.dolag.serpent.media-converter';
const PENDING_REQUEST_KEY = 'panel.pending-request';
const LAST_RESULT_KEY = 'panel.last-result';
const PROGRESS_UNITS_PER_ASSET = 100;
const PROGRESS_FLUSH_MS = 250;
const PROGRESS_MIN_UNIT_DELTA = 2;
const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const CONVERT_VIDEO_EXTENSIONS = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'ts', 'mts', 'm2ts'];
const CONVERT_IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'tif', 'tiff', 'gif', 'avif'];

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
  return { targetLibraryId, assetIds };
}

function isValidRequest(request) {
  return request !== null
    && typeof request === 'object'
    && (request.kind === 'convert' || request.kind === 'compress')
    && typeof request.libraryId === 'string' && request.libraryId.length > 0
    && Array.isArray(request.assetIds) && request.assetIds.length > 0
    && typeof request.createdAt === 'number'
    && Date.now() - request.createdAt < PENDING_MAX_AGE_MS;
}

function createPluginRuntime(options = {}) {
  const packageRoot = options.packageRoot ?? path.resolve(__dirname, '..');
  const runProcessOverride = options.runProcess;
  const resolveBinariesOverride = options.resolveBinaries;
  let serpent;
  let lifecycleSignal;
  let jobsDirectory;
  let workRoot;
  let settingsFfmpegPath = '';
  let currentCancellation;
  let initialized = false;
  let disposed = false;

  function resolveBinaries() {
    if (resolveBinariesOverride) return resolveBinariesOverride();
    return resolveFfmpegBinaries(settingsFfmpegPath);
  }

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
    const binaries = resolveBinaries();
    const cancellation = createCancellationBridge({ jobSignal, lifecycleSignal });
    currentCancellation = cancellation;
    const workDirectory = fs.mkdtempSync(path.join(workRoot, 'job-'));
    const totalAssets = request.assetIds.length;
    const progressTotal = totalAssets * PROGRESS_UNITS_PER_ASSET;
    const progressSink = createJobProgressSink({
      total: progressTotal,
      report: (input) => scoped.jobs.reportProgress({ jobId: job.jobId, ...input }),
    });
    const committed = [];
    const failures = [];
    try {
      await progressSink.report({ completed: 0, phase: '准备', message: '读取资产信息' });
      const summaries = await indexAssetSummaries({
        assets: scoped.assets,
        assetIds: request.assetIds,
        signal: cancellation.signal,
      });
      const linkedFolderPage = await scoped.linkedFolders.list({ limit: 200 }).catch(() => null);
      const linkedFolders = Array.isArray(linkedFolderPage?.items) ? linkedFolderPage.items : [];

      for (const [index, assetId] of request.assetIds.entries()) {
        assertNotCancelled(jobSignal);
        const assetSummary = summaries.get(assetId);
        const label = `第 ${index + 1}/${totalAssets} 个`;
        if (assetSummary === undefined) {
          failures.push({ assetId, displayName: assetId, error: '未找到资产信息。' });
          continue;
        }
        const assetBase = index * PROGRESS_UNITS_PER_ASSET;
        try {
          await progressSink.report({ completed: assetBase, phase: '读取', message: `${label} ${assetSummary.displayName}` });
          const processed = await processAsset({
            scoped,
            libraryRoot: request.libraryRoot ?? null,
            linkedFolders,
            assetSummary,
            request,
            binaries,
            workDirectory,
            signal: cancellation.signal,
            onPercent(percent) {
              const units = assetBase + Math.min(PROGRESS_UNITS_PER_ASSET - 1, Math.round(percent));
              return progressSink.reportPercent({
                completed: units,
                phase: request.kind === 'convert' ? '转换' : '压缩',
                message: `${label} ${assetSummary.displayName} · ${Math.round(percent)}%`,
              });
            },
          });
          await progressSink.flush();
          await progressSink.report({
            completed: assetBase + PROGRESS_UNITS_PER_ASSET - 5,
            phase: '写入',
            message: `${label} ${assetSummary.displayName}`,
          });
          const outcome = await commitOutput({ scoped, processed, request, signal: cancellation.signal });
          committed.push({ ...outcome, displayName: assetSummary.displayName });
          await progressSink.report({
            completed: (index + 1) * PROGRESS_UNITS_PER_ASSET,
            phase: '写入',
            message: `已完成 ${committed.length}/${totalAssets} 个`,
          });
        } catch (error) {
          if (error?.name === 'AbortError') throw error;
          failures.push({ assetId, displayName: assetSummary.displayName, error: errorMessage(error) });
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
      await notifyUser(scoped, {
        severity: failures.length > 0 ? 'warning' : 'info',
        title: request.kind === 'convert' ? '格式转换完成' : '压缩完成',
        message: `${committed.length}/${totalAssets} 个成功`
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
        title: request.kind === 'convert' ? '格式转换失败' : '压缩失败',
        message: errorMessage(error),
      });
      throw error;
    } finally {
      cancellation.dispose();
      if (currentCancellation === cancellation) currentCancellation = undefined;
      try { fs.rmSync(workDirectory, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }

  async function capturePending(context, kind) {
    const { targetLibraryId, assetIds } = resolveCommandTargets(context);
    if (typeof targetLibraryId !== 'string' || targetLibraryId.length === 0) {
      throw new Error('The command did not receive a target library.');
    }
    if (assetIds.length === 0) throw new Error('请先选择要处理的资产。');

    let libraryRoot = null;
    try {
      const data = await serpent.data.getDirectory({ scope: 'library' });
      libraryRoot = deriveLibraryRoot(data.path, PLUGIN_ID);
    } catch {
      libraryRoot = null;
    }

    const existing = await readState(serpent, PENDING_REQUEST_KEY);
    const request = {
      kind: kind ?? (existing?.kind === 'compress' ? 'compress' : 'convert'),
      assetIds,
      libraryId: targetLibraryId,
      libraryRoot,
      createdAt: Date.now(),
    };
    await writeState(serpent, PENDING_REQUEST_KEY, request);
    await notifyUser(serpent, {
      severity: 'info',
      title: kind === 'compress' ? '压缩' : '格式转换',
      message: `已载入 ${assetIds.length} 个资产，请在侧栏「媒体转换」面板完成设置。`,
    });
  }

  async function runFromPanel(context, kind) {
    const { targetLibraryId } = resolveCommandTargets(context);
    const pending = await readState(serpent, PENDING_REQUEST_KEY);
    if (!isValidRequest(pending)) {
      throw new Error('没有待处理的资产。请先在资产上右键选择「格式转换…」或「压缩…」。');
    }
    if (typeof targetLibraryId === 'string' && targetLibraryId.length > 0 && pending.libraryId !== targetLibraryId) {
      throw new Error('待处理资产属于另一个资源库，请重新选择。');
    }
    const options = await readState(serpent, 'panel.options');
    if (options === null || typeof options !== 'object') {
      throw new Error('缺少转换 / 压缩设置。');
    }

    const scoped = serpent.forLibrary(pending.libraryId);
    let result;
    const requestFile = await createJobRequest({
      directory: jobsDirectory,
      request: {
        kind: pending.kind,
        libraryId: pending.libraryId,
        libraryRoot: pending.libraryRoot ?? null,
        assetIds: pending.assetIds,
        options: { ...options, suffix: typeof options.suffix === 'string' ? options.suffix : '' },
      },
    });
    try {
      result = await scoped.jobs.enqueue({
        handlerId: 'media-convert',
        payload: { requestFile: requestFile.fileName },
        recoveryStrategy: 'idempotent',
      });
    } catch (error) {
      await deleteJobRequest({ directory: jobsDirectory, fileName: requestFile.fileName });
      throw error;
    }
    await writeState(serpent, LAST_RESULT_KEY, {
      kind: pending.kind,
      jobId: result.jobId,
      completed: 0,
      failed: 0,
      total: pending.assetIds.length,
      status: 'queued',
    });
    await writeState(serpent, PENDING_REQUEST_KEY, null);
    await notifyUser(scoped, {
      severity: 'info',
      title: pending.kind === 'convert' ? '格式转换' : '压缩',
      message: `${pending.assetIds.length} 个资产的批处理任务已开始。`,
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

    const ffmpegPathSetting = await serpent.storage.get('settings.ffmpeg-path', { scope: 'user' });
    settingsFfmpegPath = typeof ffmpegPathSetting === 'string' ? ffmpegPathSetting : '';

    serpent.commands.register('mediaconverter.open-convert', (commandContext) => capturePending(commandContext, 'convert'));
    serpent.commands.register('mediaconverter.open-compress', (commandContext) => capturePending(commandContext, 'compress'));
    serpent.commands.register('mediaconverter.capture-selection', (commandContext) => capturePending(commandContext, null));
    serpent.commands.register('mediaconverter.run-convert', (commandContext) => runFromPanel(commandContext, 'convert'));
    serpent.commands.register('mediaconverter.run-compress', (commandContext) => runFromPanel(commandContext, 'compress'));
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
  PENDING_REQUEST_KEY,
  PROGRESS_UNITS_PER_ASSET,
  createPluginRuntime,
  dispose,
  setup,
};
