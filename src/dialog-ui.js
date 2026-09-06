'use strict';

/**
 * Host widget trees for convert/compress. The plugin never paints HTML; Serpent
 * maps this IR onto Field/Select/TextField primitives.
 */

const VIDEO_FORMATS = [
  { value: 'mp4', label: 'MP4' },
  { value: 'webm', label: 'WebM' },
];

const CODECS_BY_CONTAINER = {
  mp4: [
    { value: 'h264', label: 'H.264' },
    { value: 'h265', label: 'H.265' },
    { value: 'vp9', label: 'VP9' },
    { value: 'av1', label: 'AV1' },
  ],
  webm: [
    { value: 'vp9', label: 'VP9' },
    { value: 'av1', label: 'AV1' },
  ],
};

const VIDEO_CODECS = CODECS_BY_CONTAINER.mp4;

function codecsForContainer(format) {
  return CODECS_BY_CONTAINER[format] ?? CODECS_BY_CONTAINER.mp4;
}

function coerceCodec(format, requested) {
  const allowed = codecsForContainer(format).map((option) => option.value);
  if (typeof requested === 'string' && allowed.includes(requested)) return requested;
  return allowed[0];
}

const AUDIO_MODES = [
  { value: 'copy', label: '复制音轨' },
  { value: 'aac', label: 'AAC' },
  { value: 'none', label: '无音频' },
];

const IMAGE_TARGET_MODES = [
  { value: 'percent', label: '按原体积百分比' },
  { value: 'size', label: '目标文件大小' },
  { value: 'quality', label: '质量' },
];

const VIDEO_TARGET_MODES = [
  { value: 'percent', label: '按原体积百分比' },
  { value: 'size', label: '目标文件大小' },
  { value: 'quality', label: '质量（CRF）' },
  { value: 'bitrate', label: '目标码率' },
];

const CONVERT_RATE_MODES = [
  { value: 'quality', label: '质量（CRF）' },
  { value: 'bitrate', label: '目标码率' },
];

const SIZE_UNITS = [
  { value: 'mb', label: 'MB' },
  { value: 'kb', label: 'KB' },
];

const RESOLUTION_MODES = [
  { value: 'off', label: '原始分辨率' },
  { value: 'percent', label: '按百分比缩小' },
  { value: 'max-edge', label: '最长边上限' },
];

const MAX_EDGE_PRESETS = [
  { value: '1920', label: '1920 px' },
  { value: '1080', label: '1080 px' },
  { value: '720', label: '720 px' },
  { value: 'custom', label: '自定义' },
];

const SUFFIX_DESCRIPTION = '留空表示替换原资产';

function sizeFields(ui, ids, defaults) {
  return ui.row(
    ui.number({
      id: ids.value,
      label: '目标大小',
      value: defaults.value,
      min: 1,
      step: 1,
    }),
    ui.select({
      id: ids.unit,
      label: '单位',
      value: defaults.unit,
      options: SIZE_UNITS,
    }),
  );
}

function percentField(ui, id, value) {
  return ui.number({
    id,
    label: '目标体积（%）',
    value,
    min: 5,
    max: 95,
    step: 1,
  });
}

function bitrateField(ui, id, value) {
  return ui.number({
    id,
    label: '视频码率（kbps）',
    value,
    min: 100,
    max: 100_000,
    step: 100,
    description: '平均视频码率。',
  });
}

function renderResolutionFields(ui, prefix, mode, preset) {
  const current = mode.get();
  const currentPreset = preset.get();
  return [
    ui.select({
      id: `${prefix}ResolutionMode`,
      label: '分辨率',
      value: current,
      onChange: mode.set,
      options: RESOLUTION_MODES,
    }),
    current === 'percent'
      ? ui.number({
        id: `${prefix}ResolutionPercent`,
        label: '分辨率（%）',
        value: 50,
        min: 5,
        max: 100,
        step: 1,
        description: '相对源宽高缩放。50 表示边长一半，像素约四分之一。',
      })
      : null,
    current === 'max-edge'
      ? ui.select({
        id: `${prefix}MaxEdgePreset`,
        label: '最长边',
        value: currentPreset,
        onChange: preset.set,
        options: MAX_EDGE_PRESETS,
      })
      : null,
    current === 'max-edge' && currentPreset === 'custom'
      ? ui.number({
        id: `${prefix}MaxEdgeCustom`,
        label: '自定义最长边（px）',
        value: 1920,
        min: 16,
        max: 16_384,
        step: 1,
      })
      : null,
  ];
}

function suffixField(ui) {
  return ui.text({
    id: 'suffix',
    label: '文件名后缀',
    value: '',
    description: SUFFIX_DESCRIPTION,
  });
}

function advancedField(ui) {
  return ui.text({
    id: 'advancedArgs',
    label: '附加 FFmpeg 参数',
    value: '',
  });
}

function convertDialogNote(selection) {
  const videoCount = typeof selection === 'number'
    ? selection
    : Number(selection?.videoCount) || 0;
  const skippedImageCount = typeof selection === 'number'
    ? 0
    : Number(selection?.skippedImageCount) || 0;
  const skippedOtherCount = typeof selection === 'number'
    ? 0
    : Number(selection?.skippedOtherCount) || 0;
  let skipped = '';
  if (skippedImageCount > 0 && skippedOtherCount > 0) {
    skipped = `，已跳过 ${skippedImageCount} 张图片和 ${skippedOtherCount} 个其他资产`;
  } else if (skippedImageCount > 0) {
    skipped = `，已跳过 ${skippedImageCount} 张图片`;
  } else if (skippedOtherCount > 0) {
    skipped = `，已跳过 ${skippedOtherCount} 个非视频资产`;
  }
  return `将转码 ${videoCount} 个视频${skipped}。输出仅支持 MP4 与 WebM。`;
}

function renderConvertDialog(ui, selection) {
  const format = ui.state('mp4');
  const codec = ui.state('h264');
  const rateMode = ui.state('quality');
  const currentFormat = format.get();
  const currentCodec = coerceCodec(currentFormat, codec.get());
  const currentRate = rateMode.get();
  return ui.column(
    ui.note(convertDialogNote(selection)),
    ui.select({
      id: 'videoFormat',
      label: '视频格式',
      value: currentFormat,
      onChange: (value) => {
        format.set(value);
        const nextCodec = coerceCodec(value, codec.get());
        codec.set(nextCodec);
        ui.applyChange?.('videoCodec', nextCodec);
      },
      options: VIDEO_FORMATS,
    }),
    ui.select({
      id: 'videoCodec',
      label: '视频编码',
      value: currentCodec,
      onChange: codec.set,
      options: codecsForContainer(currentFormat),
    }),
    ui.select({
      id: 'audioMode',
      label: '音频',
      value: 'copy',
      options: AUDIO_MODES,
    }),
    ui.select({
      id: 'targetMode',
      label: '视频目标',
      value: currentRate,
      onChange: rateMode.set,
      options: CONVERT_RATE_MODES,
    }),
    currentRate === 'quality'
      ? ui.slider({
        id: 'crf',
        label: '质量 CRF',
        value: 23,
        min: 14,
        max: 34,
        step: 1,
      })
      : bitrateField(ui, 'videoBitrateKbps', 2500),
    suffixField(ui),
    advancedField(ui),
  );
}

function renderImageTargetFields(ui, mode, resolutionMode, maxEdgePreset) {
  const current = mode.get();
  return [
    ...renderResolutionFields(ui, 'image', resolutionMode, maxEdgePreset),
    ui.select({
      id: 'imageTargetMode',
      label: '压缩目标',
      value: current,
      onChange: mode.set,
      options: IMAGE_TARGET_MODES,
    }),
    current === 'percent' ? percentField(ui, 'imagePercent', 50) : null,
    current === 'size'
      ? sizeFields(ui, { value: 'imageSizeValue', unit: 'imageSizeUnit' }, { value: 2, unit: 'mb' })
      : null,
    current === 'quality'
      ? ui.slider({
        id: 'imageQuality',
        label: '质量',
        value: 8,
        min: 2,
        max: 31,
        step: 1,
        description: '数值越小质量越高、文件越大。',
      })
      : null,
  ];
}

function renderVideoTargetFields(ui, mode, resolutionMode, maxEdgePreset) {
  const current = mode.get();
  return [
    ...renderResolutionFields(ui, 'video', resolutionMode, maxEdgePreset),
    ui.select({
      id: 'videoTargetMode',
      label: '压缩目标',
      value: current,
      onChange: mode.set,
      options: VIDEO_TARGET_MODES,
    }),
    current === 'percent' ? percentField(ui, 'videoPercent', 50) : null,
    current === 'size'
      ? sizeFields(ui, { value: 'videoSizeValue', unit: 'videoSizeUnit' }, { value: 20, unit: 'mb' })
      : null,
    current === 'quality'
      ? ui.slider({
        id: 'videoCrf',
        label: '质量 CRF',
        value: 23,
        min: 14,
        max: 34,
        step: 1,
      })
      : null,
    current === 'bitrate' ? bitrateField(ui, 'videoBitrateKbps', 2500) : null,
    ui.select({
      id: 'videoCodec',
      label: '视频编码',
      value: 'h264',
      options: VIDEO_CODECS,
    }),
    ui.select({
      id: 'audioMode',
      label: '音频',
      value: 'copy',
      options: AUDIO_MODES,
    }),
  ];
}

function renderCompressDialog(ui, selection) {
  const imageCount = Number(selection?.imageCount) || 0;
  const videoCount = Number(selection?.videoCount) || 0;
  const total = Number(selection?.total) || imageCount + videoCount;
  const showImage = imageCount > 0 || videoCount === 0;
  const showVideo = videoCount > 0 || imageCount === 0;
  const imageMode = ui.state('percent');
  const videoMode = ui.state('percent');
  const imageResolutionMode = ui.state('off');
  const videoResolutionMode = ui.state('off');
  const imageMaxEdgePreset = ui.state('1920');
  const videoMaxEdgePreset = ui.state('1920');
  const parts = [];
  if (showImage && showVideo) {
    parts.push(ui.note(`将压缩 ${imageCount} 张图片、${videoCount} 个视频。`));
  } else if (showImage) {
    parts.push(ui.note(`将压缩 ${imageCount} 张选中的图片。`));
  } else if (showVideo) {
    parts.push(ui.note(`将压缩 ${videoCount} 个选中的视频。`));
  } else {
    parts.push(ui.note(`将压缩 ${total} 个选中的资产。`));
  }
  if (showImage) {
    parts.push(ui.heading('图像设置'), ...renderImageTargetFields(ui, imageMode, imageResolutionMode, imageMaxEdgePreset));
  }
  if (showVideo) {
    if (showImage) parts.push(ui.separator());
    parts.push(ui.heading('视频设置'), ...renderVideoTargetFields(ui, videoMode, videoResolutionMode, videoMaxEdgePreset));
  }
  parts.push(suffixField(ui), advancedField(ui));
  return ui.column(...parts);
}

function maxEdgeFromValues(values, prefix) {
  const preset = String(values[`${prefix}MaxEdgePreset`] ?? '1920');
  if (preset === 'custom') {
    const custom = Number(values[`${prefix}MaxEdgeCustom`]);
    return Number.isFinite(custom) ? Math.round(custom) : 1920;
  }
  const parsed = Number(preset);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1920;
}

function resolutionFromValues(values, prefix) {
  const mode = String(values[`${prefix}ResolutionMode`] ?? 'off');
  return {
    [`${prefix}ResolutionMode`]: mode === 'percent' || mode === 'max-edge' ? mode : 'off',
    [`${prefix}ResolutionPercent`]: Number(values[`${prefix}ResolutionPercent`]) || 50,
    [`${prefix}MaxEdge`]: maxEdgeFromValues(values, prefix),
  };
}

function flattenResolution(options, isVideo) {
  if (isVideo) {
    return {
      resolutionMode: options.videoResolutionMode ?? options.resolutionMode ?? 'off',
      resolutionPercent: options.videoResolutionPercent ?? options.resolutionPercent ?? 50,
      maxEdge: options.videoMaxEdge ?? options.maxEdge ?? 1920,
    };
  }
  return {
    resolutionMode: options.imageResolutionMode ?? options.resolutionMode ?? 'off',
    resolutionPercent: options.imageResolutionPercent ?? options.resolutionPercent ?? 50,
    maxEdge: options.imageMaxEdge ?? options.maxEdge ?? 1920,
  };
}

function targetBytesFromValues(values, valueKey, unitKey) {
  const value = Number(values[valueKey]) || 0;
  const multiplier = values[unitKey] === 'kb' ? 1024 : 1024 * 1024;
  return Math.max(1024, Math.round(value * multiplier));
}

function optionsFromWidgetValues(kind, values) {
  const shared = {
    advancedArgs: typeof values.advancedArgs === 'string' ? values.advancedArgs : '',
    suffix: typeof values.suffix === 'string' ? values.suffix : '',
  };
  if (kind === 'convert') {
    const videoFormat = String(values.videoFormat ?? 'mp4') === 'webm' ? 'webm' : 'mp4';
    return {
      ...shared,
      videoFormat,
      videoCodec: coerceCodec(videoFormat, values.videoCodec),
      audioMode: String(values.audioMode ?? 'copy'),
      targetMode: String(values.targetMode ?? 'quality'),
      crf: Number(values.crf) || 23,
      videoBitrateKbps: Number(values.videoBitrateKbps) || 2500,
    };
  }
  return {
    ...shared,
    audioMode: String(values.audioMode ?? 'copy'),
    videoCodec: String(values.videoCodec ?? 'h264'),
    imageTargetMode: String(values.imageTargetMode ?? 'percent'),
    imagePercent: Number(values.imagePercent) || 50,
    imageTargetBytes: targetBytesFromValues(values, 'imageSizeValue', 'imageSizeUnit'),
    imageQuality: Number(values.imageQuality) || 8,
    ...resolutionFromValues(values, 'image'),
    videoTargetMode: String(values.videoTargetMode ?? 'percent'),
    videoPercent: Number(values.videoPercent) || 50,
    videoTargetBytes: targetBytesFromValues(values, 'videoSizeValue', 'videoSizeUnit'),
    videoCrf: Number(values.videoCrf) || 23,
    videoBitrateKbps: Number(values.videoBitrateKbps) || 2500,
    ...resolutionFromValues(values, 'video'),
  };
}

function optionsForAsset(kind, options, isVideo) {
  if (kind === 'convert' || options == null) return options ?? {};
  if (isVideo) {
    return {
      ...options,
      targetMode: options.videoTargetMode ?? 'percent',
      percent: options.videoPercent ?? 50,
      targetBytes: options.videoTargetBytes,
      crf: options.videoCrf ?? 23,
      videoBitrateKbps: options.videoBitrateKbps,
      ...flattenResolution(options, true),
    };
  }
  return {
    ...options,
    targetMode: options.imageTargetMode ?? 'percent',
    percent: options.imagePercent ?? 50,
    targetBytes: options.imageTargetBytes,
    crf: options.imageQuality ?? 8,
    ...flattenResolution(options, false),
  };
}

module.exports = {
  AUDIO_MODES,
  CODECS_BY_CONTAINER,
  CONVERT_RATE_MODES,
  IMAGE_TARGET_MODES,
  MAX_EDGE_PRESETS,
  RESOLUTION_MODES,
  VIDEO_CODECS,
  VIDEO_FORMATS,
  VIDEO_TARGET_MODES,
  codecsForContainer,
  coerceCodec,
  convertDialogNote,
  optionsForAsset,
  optionsFromWidgetValues,
  renderCompressDialog,
  renderConvertDialog,
  targetBytesFromValues,
};
