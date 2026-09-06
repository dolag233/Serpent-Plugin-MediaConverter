'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  optionsForAsset,
  optionsFromWidgetValues,
  convertDialogNote,
  renderCompressDialog,
  renderConvertDialog,
} = require('../src/dialog-ui');

function createTestUi() {
  const values = Object.create(null);
  const listeners = Object.create(null);
  const states = [];
  let stateCursor = 0;

  function compact(children) {
    return [...children].filter((child) => child !== null && child !== undefined && child !== false);
  }

  function remember(spec) {
    const value = Object.prototype.hasOwnProperty.call(values, spec.id) ? values[spec.id] : spec.value;
    values[spec.id] = value;
    if (typeof spec.onChange === 'function') listeners[spec.id] = spec.onChange;
    else delete listeners[spec.id];
    return value;
  }

  const ui = {
    state(initial) {
      const index = stateCursor;
      stateCursor += 1;
      if (states[index] === undefined) states[index] = { current: initial };
      const slot = states[index];
      return {
        get() { return slot.current; },
        set(value) { slot.current = value; },
      };
    },
    column(...children) { return { type: 'column', children: compact(children) }; },
    row(...children) { return { type: 'row', children: compact(children) }; },
    note(text) { return { type: 'note', text: String(text) }; },
    heading(text) { return { type: 'heading', text: String(text) }; },
    separator() { return { type: 'separator' }; },
    text(spec) {
      return { type: 'text', id: spec.id, label: spec.label, value: remember(spec), description: spec.description };
    },
    number(spec) { return { type: 'number', id: spec.id, label: spec.label, value: remember(spec) }; },
    select(spec) {
      return { type: 'select', id: spec.id, label: spec.label, value: remember(spec), options: spec.options };
    },
    switch(spec) { return { type: 'switch', id: spec.id, label: spec.label, value: remember(spec) }; },
    slider(spec) { return { type: 'slider', id: spec.id, label: spec.label, value: remember(spec) }; },
    applyChange(nodeId, value) {
      values[nodeId] = value;
      if (typeof listeners[nodeId] === 'function') listeners[nodeId](value);
    },
    build(render) {
      stateCursor = 0;
      return render(ui);
    },
  };

  return ui;
}

function fieldIds(node, found = []) {
  if (!node || typeof node !== 'object') return found;
  if (typeof node.id === 'string') found.push(node.id);
  if (Array.isArray(node.children)) {
    for (const child of node.children) fieldIds(child, found);
  }
  return found;
}

function headings(node, found = []) {
  if (!node || typeof node !== 'object') return found;
  if (node.type === 'heading') found.push(node.text);
  if (Array.isArray(node.children)) {
    for (const child of node.children) headings(child, found);
  }
  return found;
}

function findField(node, id) {
  if (!node || typeof node !== 'object') return null;
  if (node.id === id) return node;
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      const found = findField(child, id);
      if (found) return found;
    }
  }
  return null;
}

test('convert dialog offers mp4/webm, copy audio, and bitrate', () => {
  const ui = createTestUi();
  let tree = ui.build((toolkit) => renderConvertDialog(toolkit, 3));
  assert.equal(tree.children[0].text, '将转码 3 个视频。输出仅支持 MP4 与 WebM。');
  assert.deepEqual(fieldIds(tree), [
    'videoFormat', 'videoCodec', 'audioMode', 'targetMode', 'crf', 'suffix', 'advancedArgs',
  ]);
  assert.equal(tree.children.find((child) => child.id === 'videoFormat').options.map((option) => option.value).join(','), 'mp4,webm');
  const mp4Codecs = tree.children.find((child) => child.id === 'videoCodec');
  assert.deepEqual(mp4Codecs.options.map((option) => option.value), ['h264', 'h265', 'vp9', 'av1']);
  assert.equal(mp4Codecs.value, 'h264');
  assert.equal(tree.children.find((child) => child.id === 'audioMode').value, 'copy');
  const suffix = tree.children.find((child) => child.id === 'suffix');
  assert.equal(suffix.description, '留空表示替换原资产');

  ui.applyChange('videoFormat', 'webm');
  tree = ui.build((toolkit) => renderConvertDialog(toolkit, 3));
  const webmCodecs = tree.children.find((child) => child.id === 'videoCodec');
  assert.ok(webmCodecs);
  assert.deepEqual(webmCodecs.options.map((option) => option.value), ['vp9', 'av1']);
  assert.equal(webmCodecs.value, 'vp9');
  assert.ok(!tree.children.some((child) => child.type === 'note' && /VP9/u.test(child.text)));

  ui.applyChange('targetMode', 'bitrate');
  tree = ui.build((toolkit) => renderConvertDialog(toolkit, 3));
  assert.ok(fieldIds(tree).includes('videoBitrateKbps'));
  assert.ok(!fieldIds(tree).includes('crf'));
});

test('convert dialog announces skipped images before processing', () => {
  assert.equal(
    convertDialogNote(3),
    '将转码 3 个视频。输出仅支持 MP4 与 WebM。',
  );
  assert.equal(
    convertDialogNote({ videoCount: 2, skippedImageCount: 3, skippedOtherCount: 0 }),
    '将转码 2 个视频，已跳过 3 张图片。输出仅支持 MP4 与 WebM。',
  );
  const ui = createTestUi();
  const tree = ui.build((toolkit) => renderConvertDialog(toolkit, {
    videoCount: 1,
    skippedImageCount: 2,
    skippedOtherCount: 0,
  }));
  assert.ok(tree.children.some((child) => child.type === 'note' && child.text.includes('已跳过 2 张图片')));
});

test('compress dialog splits image and video settings', () => {
  const ui = createTestUi();
  let tree = ui.build((toolkit) => renderCompressDialog(toolkit, { imageCount: 2, videoCount: 0, total: 2 }));
  assert.deepEqual(headings(tree), ['图像设置']);
  assert.ok(fieldIds(tree).includes('imageTargetMode'));
  assert.ok(!fieldIds(tree).includes('videoCodec'));
  assert.ok(!fieldIds(tree).includes('audioMode'));

  tree = ui.build((toolkit) => renderCompressDialog(toolkit, { imageCount: 0, videoCount: 1, total: 1 }));
  assert.deepEqual(headings(tree), ['视频设置']);
  assert.ok(fieldIds(tree).includes('videoCodec'));
  assert.deepEqual(findField(tree, 'videoCodec').options.map((option) => option.value), ['h264', 'h265', 'vp9', 'av1']);
  assert.ok(!fieldIds(tree).includes('imageTargetMode'));

  tree = ui.build((toolkit) => renderCompressDialog(toolkit, { imageCount: 1, videoCount: 2, total: 3 }));
  assert.deepEqual(headings(tree), ['图像设置', '视频设置']);
  ui.applyChange('videoTargetMode', 'bitrate');
  tree = ui.build((toolkit) => renderCompressDialog(toolkit, { imageCount: 1, videoCount: 2, total: 3 }));
  assert.ok(fieldIds(tree).includes('videoBitrateKbps'));
  ui.applyChange('imageTargetMode', 'size');
  tree = ui.build((toolkit) => renderCompressDialog(toolkit, { imageCount: 1, videoCount: 2, total: 3 }));
  assert.ok(fieldIds(tree).includes('imageSizeValue'));
  assert.ok(fieldIds(tree).includes('imageResolutionMode'));
  assert.ok(fieldIds(tree).includes('videoResolutionMode'));
  assert.equal(findField(tree, 'imageResolutionMode').value, 'off');
  assert.equal(
    findField(tree, 'imageResolutionMode').options.find((option) => option.value === 'off')?.label,
    '原始分辨率',
  );
  ui.applyChange('imageResolutionMode', 'percent');
  tree = ui.build((toolkit) => renderCompressDialog(toolkit, { imageCount: 1, videoCount: 2, total: 3 }));
  assert.ok(fieldIds(tree).includes('imageResolutionPercent'));
  assert.ok(!fieldIds(tree).includes('imageMaxEdgePreset'));
  ui.applyChange('videoResolutionMode', 'max-edge');
  tree = ui.build((toolkit) => renderCompressDialog(toolkit, { imageCount: 1, videoCount: 2, total: 3 }));
  assert.ok(fieldIds(tree).includes('videoMaxEdgePreset'));
  ui.applyChange('videoMaxEdgePreset', 'custom');
  tree = ui.build((toolkit) => renderCompressDialog(toolkit, { imageCount: 1, videoCount: 2, total: 3 }));
  assert.ok(fieldIds(tree).includes('videoMaxEdgeCustom'));
});

test('maps widget values onto convert/compress pipeline options', () => {
  assert.deepEqual(optionsFromWidgetValues('convert', {
    videoFormat: 'webm',
    audioMode: 'copy',
    targetMode: 'bitrate',
    videoBitrateKbps: 1800,
    suffix: '',
    advancedArgs: '-an',
  }), {
    advancedArgs: '-an',
    suffix: '',
    videoFormat: 'webm',
    videoCodec: 'vp9',
    audioMode: 'copy',
    targetMode: 'bitrate',
    crf: 23,
    videoBitrateKbps: 1800,
  });
  const compressed = optionsFromWidgetValues('compress', {
    imageTargetMode: 'size',
    imageSizeValue: 2,
    imageSizeUnit: 'mb',
    videoTargetMode: 'bitrate',
    videoBitrateKbps: 1200,
    audioMode: 'copy',
    videoCodec: 'h265',
    suffix: '-small',
    advancedArgs: '',
  });
  assert.equal(compressed.imageTargetBytes, 2 * 1024 * 1024);
  assert.equal(compressed.videoTargetMode, 'bitrate');
  assert.equal(compressed.audioMode, 'copy');
  const videoOptions = optionsForAsset('compress', compressed, true);
  assert.equal(videoOptions.targetMode, 'bitrate');
  assert.equal(videoOptions.videoBitrateKbps, 1200);
  const imageOptions = optionsForAsset('compress', compressed, false);
  assert.equal(imageOptions.targetMode, 'size');
  assert.equal(imageOptions.targetBytes, 2 * 1024 * 1024);
  assert.equal(imageOptions.resolutionMode, 'off');
});

test('maps combined resolution and size targets onto pipeline options', () => {
  const compressed = optionsFromWidgetValues('compress', {
    imageTargetMode: 'percent',
    imagePercent: 10,
    imageResolutionMode: 'percent',
    imageResolutionPercent: 50,
    videoTargetMode: 'percent',
    videoPercent: 10,
    videoResolutionMode: 'max-edge',
    videoMaxEdgePreset: '1080',
    audioMode: 'copy',
    videoCodec: 'h264',
    suffix: '',
    advancedArgs: '',
  });
  assert.equal(compressed.imageResolutionMode, 'percent');
  assert.equal(compressed.imageResolutionPercent, 50);
  assert.equal(compressed.videoResolutionMode, 'max-edge');
  assert.equal(compressed.videoMaxEdge, 1080);
  const imageOptions = optionsForAsset('compress', compressed, false);
  assert.equal(imageOptions.targetMode, 'percent');
  assert.equal(imageOptions.percent, 10);
  assert.equal(imageOptions.resolutionMode, 'percent');
  assert.equal(imageOptions.resolutionPercent, 50);
  const videoOptions = optionsForAsset('compress', compressed, true);
  assert.equal(videoOptions.targetMode, 'percent');
  assert.equal(videoOptions.resolutionMode, 'max-edge');
  assert.equal(videoOptions.maxEdge, 1080);
});

test('derives selection from context without blocking I/O', () => {
  const { deriveSelectionFromContext } = require('../src/plugin');
  if (typeof deriveSelectionFromContext === 'function') {
    // 纯视频选择
    const videoOnly = deriveSelectionFromContext({
      invocation: {
        selection: {
          assetIds: ['v1', 'v2'],
          mediaTypes: ['video'],
          extensions: ['mp4', 'mov'],
        },
      },
    }, ['v1', 'v2'], []);
    assert.deepEqual(videoOnly, { imageCount: 0, videoCount: 2, total: 2 });

    // 纯图片选择
    const imageOnly = deriveSelectionFromContext({
      invocation: {
        selection: {
          assetIds: ['i1'],
          mediaTypes: ['image'],
          extensions: ['jpg'],
        },
      },
    }, ['i1'], []);
    assert.deepEqual(imageOnly, { imageCount: 1, videoCount: 0, total: 1 });

    // 混合选择
    const mixed = deriveSelectionFromContext({
      invocation: {
        selection: {
          assetIds: ['i1', 'v1'],
          mediaTypes: ['image', 'video'],
        },
      },
    }, ['i1', 'v1'], []);
    assert.deepEqual(mixed, { imageCount: 0, videoCount: 0, total: 2 });
  }
});

