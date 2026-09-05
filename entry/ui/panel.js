/* global document, window, URLSearchParams, location */

const contributionId = new URLSearchParams(location.search).get('contributionId')
  ?? 'com.dolag.serpent.media-converter.converter';
const instanceId = decodeURIComponent(location.pathname.split('/')[1] || '');

const elements = {
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
  pendingHint: document.querySelector('#pending-hint'),
};

let currentKind = 'convert';
let payload = null;

function request(message) {
  window.parent.postMessage(message, '*');
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

function buildOptions() {
  const shared = {
    advancedArgs: elements.advancedArgs.value,
    suffix: currentKind === 'convert' ? elements.convertSuffix.value : elements.compressSuffix.value,
  };
  if (currentKind === 'convert') {
    return {
      ...shared,
      videoFormat: elements.convertVideoFormat.value,
      videoCodec: elements.convertVideoCodec.value,
      audioMode: elements.convertAudio.value,
      imageFormat: elements.convertImageFormat.value,
    };
  }
  return {
    ...shared,
    targetMode: elements.compressTargetMode.value,
    percent: Number(elements.compressPercent.value) || 50,
    targetBytes: Math.round((Number(elements.compressSizeMb.value) || 0) * 1024 * 1024),
    crf: Number(elements.compressCrf.value) || 23,
    audioMode: elements.compressAudio.value,
    videoCodec: elements.compressVideoCodec.value,
    outputMode: document.querySelector('input[name="compress-output"]:checked')?.value ?? 'replace',
  };
}

window.addEventListener('message', (event) => {
  if (event.source !== window.parent || event.origin !== 'null') return;
  if (event.data?.type === 'plugin-ui.dialog-payload') {
    payload = event.data.payload ?? null;
    const kind = payload?.kind === 'compress' ? 'compress' : 'convert';
    setKind(kind);
    const count = typeof payload?.assetCount === 'number' ? payload.assetCount : 0;
    elements.pendingHint.textContent = count > 0
      ? `将处理 ${count} 个选中的资产（转换针对视频，图像仅支持格式变化与质量压缩）。`
      : '未检测到选中资产。';
    return;
  }
  if (event.data?.type === 'plugin-ui.theme-changed') {
    for (const [name, value] of Object.entries(event.data.tokens || {})) {
      document.documentElement.style.setProperty(name, value);
    }
  }
});

request({
  type: 'plugin-ui.ready',
  contributionId,
  instanceId,
  viewType: 'dialog',
  scope: 'library',
});

elements.tabConvert.addEventListener('click', () => setKind('convert'));
elements.tabCompress.addEventListener('click', () => setKind('compress'));
elements.compressTargetMode.addEventListener('change', updateCompressRows);

elements.start.addEventListener('click', () => {
  elements.start.disabled = true;
  window.parent.postMessage({
    type: 'plugin-ui.dialog-complete',
    result: buildOptions(),
  }, '*');
});
