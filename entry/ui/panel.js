/* global URLSearchParams, location, document, window, crypto, setInterval */

const contributionId = new URLSearchParams(location.search).get('contributionId')
  ?? 'com.dolag.serpent.media-converter.converter-panel';
const instanceId = decodeURIComponent(location.pathname.split('/')[1] || '');

const elements = {
  pendingHint: document.querySelector('#pending-hint'),
  tabConvert: document.querySelector('#tab-convert'),
  tabCompress: document.querySelector('#tab-compress'),
  sectionConvert: document.querySelector('#section-convert'),
  sectionCompress: document.querySelector('#section-compress'),
  convertVideoFormat: document.querySelector('#convert-video-format'),
  convertVideoCodec: document.querySelector('#convert-video-codec'),
  convertAudio: document.querySelector('#convert-audio'),
  convertImageFormat: document.querySelector('#convert-image-format'),
  convertSuffix: document.querySelector('#convert-suffix'),
  compressTargetMode: document.querySelector('#compress-target-mode'),
  rowPercent: document.querySelector('#row-percent'),
  rowSize: document.querySelector('#row-size'),
  rowCrf: document.querySelector('#row-crf'),
  compressPercent: document.querySelector('#compress-percent'),
  compressSizeMb: document.querySelector('#compress-size-mb'),
  compressCrf: document.querySelector('#compress-crf'),
  compressAudio: document.querySelector('#compress-audio'),
  compressVideoCodec: document.querySelector('#compress-video-codec'),
  compressSuffix: document.querySelector('#compress-suffix'),
  advancedArgs: document.querySelector('#advanced-args'),
  start: document.querySelector('#start'),
  status: document.querySelector('#status'),
  failures: document.querySelector('#failures'),
};

let currentKind = 'convert';

function request(message) {
  window.parent.postMessage(message, '*');
}

const inflight = new Map();

function requestWithId(message) {
  const requestId = crypto.randomUUID();
  return new Promise((resolve) => {
    inflight.set(requestId, resolve);
    request({ ...message, requestId });
  });
}

async function storageGet(key) {
  const result = await requestWithId({ type: 'plugin-ui.storage.get', key });
  return result.ok ? result.value : null;
}

async function storageSet(key, value) {
  const result = await requestWithId({ type: 'plugin-ui.storage.set', key, value });
  return result.ok;
}

function setStatus(text, tone) {
  elements.status.textContent = text;
  elements.status.className = `status${tone === undefined ? '' : ` is-${tone}`}`;
}

function setKind(kind) {
  currentKind = kind;
  elements.tabConvert.classList.toggle('is-active', kind === 'convert');
  elements.tabCompress.classList.toggle('is-active', kind === 'compress');
  elements.sectionConvert.classList.toggle('hidden', kind !== 'convert');
  elements.sectionCompress.classList.toggle('hidden', kind !== 'compress');
}

function updateCompressRows() {
  const mode = elements.compressTargetMode.value;
  elements.rowPercent.classList.toggle('hidden', mode !== 'percent');
  elements.rowSize.classList.toggle('hidden', mode !== 'size');
  elements.rowCrf.classList.toggle('hidden', mode !== 'quality');
}

function buildOptions(kind) {
  const shared = {
    advancedArgs: elements.advancedArgs.value,
    suffix: kind === 'convert' ? elements.convertSuffix.value : elements.compressSuffix.value,
  };
  if (kind === 'convert') {
    return {
      ...shared,
      videoFormat: elements.convertVideoFormat.value,
      videoCodec: elements.convertVideoCodec.value,
      audioMode: elements.convertAudio.value,
      imageFormat: elements.convertImageFormat.value,
    };
  }
  const targetMode = elements.compressTargetMode.value;
  const outputMode = document.querySelector('input[name="compress-output"]:checked')?.value ?? 'replace';
  return {
    ...shared,
    targetMode,
    percent: Number(elements.compressPercent.value) || 50,
    targetBytes: Math.round((Number(elements.compressSizeMb.value) || 0) * 1024 * 1024),
    crf: Number(elements.compressCrf.value) || 23,
    audioMode: elements.compressAudio.value,
    videoCodec: elements.compressVideoCodec.value,
    outputMode,
  };
}

async function refreshPending() {
  const pending = await storageGet('panel.pending-request');
  if (pending === null || typeof pending !== 'object') {
    elements.pendingHint.textContent = '尚未载入资产：请在资产上右键选择「格式转换…」或「压缩…」。';
    return;
  }
  setKind(pending.kind === 'compress' ? 'compress' : 'convert');
  elements.pendingHint.textContent = `已载入 ${pending.assetIds.length} 个资产（资源库 ${pending.libraryId.slice(0, 8)}…）。`;
}

async function refreshLastResult() {
  const result = await storageGet('panel.last-result');
  if (result === null || typeof result !== 'object') return;
  const failures = Array.isArray(result.failures) ? result.failures : [];
  elements.failures.replaceChildren(
    ...failures.map((failure) => {
      const item = document.createElement('li');
      item.textContent = `${failure.displayName}: ${failure.error}`;
      return item;
    }),
  );
  const label = result.kind === 'convert' ? '格式转换' : '压缩';
  if (result.status === 'queued') setStatus(`${label}任务已排队（${result.total} 个）。`);
  else if (result.status === 'succeeded') setStatus(`${label}完成：${result.completed}/${result.total} 个成功。`, 'success');
  else if (result.status === 'cancelled') setStatus(`${label}已取消。`);
  else if (result.status === 'failed') setStatus(`${label}失败：${result.error ?? '未知错误'}`, 'error');
}

window.addEventListener('message', (event) => {
  if (event.source !== window.parent || event.origin !== 'null') return;
  if (event.data?.type === 'plugin-ui.theme-changed') {
    for (const [name, value] of Object.entries(event.data.tokens || {})) {
      document.documentElement.style.setProperty(name, value);
    }
    return;
  }
  if (event.data?.type === 'plugin-ui.storage.result' || event.data?.type === 'plugin-ui.command-result') {
    const resolve = inflight.get(event.data.requestId);
    if (resolve !== undefined) {
      inflight.delete(event.data.requestId);
      resolve(event.data);
    }
  }
});

request({ type: 'plugin-ui.ready', contributionId, instanceId });

elements.tabConvert.addEventListener('click', () => setKind('convert'));
elements.tabCompress.addEventListener('click', () => setKind('compress'));
elements.compressTargetMode.addEventListener('change', updateCompressRows);

elements.start.addEventListener('click', async () => {
  const kind = currentKind;
  elements.start.disabled = true;
  setStatus('正在提交任务…');
  try {
    await storageSet('panel.options', buildOptions(kind));
    const result = await requestWithId({
      type: 'plugin-ui.invoke-command',
      commandId: kind === 'convert' ? 'mediaconverter.run-convert' : 'mediaconverter.run-compress',
    });
    if (result.ok) {
      setStatus('任务已提交，进度见「后台任务」。');
      await refreshLastResult();
    } else {
      setStatus(`提交失败：${result.errorCode ?? '未知错误'}`, 'error');
    }
  } catch (error) {
    setStatus(`提交失败：${error.message}`, 'error');
  } finally {
    elements.start.disabled = false;
  }
});

setKind('convert');
updateCompressRows();
void refreshPending();
void refreshLastResult();
setInterval(() => { void refreshPending(); void refreshLastResult(); }, 2000);
