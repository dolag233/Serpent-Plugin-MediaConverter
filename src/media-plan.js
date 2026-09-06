'use strict';

/**
 * Encoding plans: turn user-facing compression targets (percent of original
 * size, absolute size ceiling, quality) and format choices into FFmpeg
 * argument lists for video and image assets.
 */

const VIDEO_CONTAINERS = ['mp4', 'mov', 'mkv', 'webm'];
const IMAGE_FORMATS = ['jpg', 'png', 'webp', 'avif'];

const VIDEO_CODEC_LIBS = {
  h264: 'libx264',
  h265: 'libx265',
  vp9: 'libvpx-vp9',
  av1: 'libsvtav1',
};

/** Encoders that honor x264-style CRF. Host LGPL FFmpeg has none of these for H.264. */
const CRF_VIDEO_ENCODERS = new Set([
  'libx264',
  'libx265',
  'libvpx-vp9',
  'libkvazaar',
  'libsvtav1',
  'libaom-av1',
]);
const PRESET_VIDEO_ENCODERS = new Set(['libx264', 'libx265']);

const IMAGE_QUALITY_FLAG = {
  jpg: '-q:v',
  avif: '-q:v',
  webp: '-quality',
};

/**
 * Image quality search scales. `min` = best quality, `max` = worst quality;
 * output size grows monotonically from min to max. `toArg` maps the search
 * value onto the FFmpeg quality flag for the format.
 */
const IMAGE_SEARCH_SCALES = {
  jpg: { min: 2, max: 31, toArg: (value) => value },
  avif: { min: 0, max: 63, toArg: (value) => value },
  webp: { min: 0, max: 100, toArg: (value) => 100 - value }, // -quality: 100 = best
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatBytesForLog(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/**
 * Splits an advanced-arguments string into an argv array, honoring single and
 * double quotes. Returns [] for empty input.
 */
function tokenizeAdvancedArgs(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text.length === 0) return [];
  const tokens = [];
  let current = '';
  let quote = null;
  for (const character of text) {
    if (quote !== null) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === ' ' || character === '\t') {
      if (current.length > 0) tokens.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

const MIN_TARGET_BYTES = 1024;
const MIN_RESOLUTION_PERCENT = 5;
const MAX_RESOLUTION_PERCENT = 100;
const MIN_MAX_EDGE_PX = 16;
const MAX_MAX_EDGE_PX = 16_384;
const DEFAULT_MAX_EDGE_PX = 1920;

function normalizeResolutionMode(value) {
  if (value === 'percent' || value === 'max-edge') return value;
  return 'off';
}

function resolutionPercentRatio(options) {
  const percent = Number(options?.resolutionPercent);
  const clamped = Number.isFinite(percent)
    ? clamp(percent, MIN_RESOLUTION_PERCENT, MAX_RESOLUTION_PERCENT)
    : 50;
  return clamped / 100;
}

function maxEdgePixels(options) {
  const edge = Number(options?.maxEdge);
  if (!Number.isFinite(edge)) return DEFAULT_MAX_EDGE_PX;
  return Math.round(clamp(edge, MIN_MAX_EDGE_PX, MAX_MAX_EDGE_PX));
}

function extraScaleRatio(options) {
  const ratio = Number(options?.scaleRatio);
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio >= 1) return 1;
  return ratio;
}

function evenScaleByRatio(ratioLiteral) {
  return `scale=trunc(iw*${ratioLiteral}/2)*2:trunc(ih*${ratioLiteral}/2)*2`;
}

/**
 * User-facing resolution is an upper bound applied first. `scaleRatio` is the
 * existing overflow downsample and multiplies on top of that bound.
 */
function buildScaleFilter(options) {
  const mode = normalizeResolutionMode(options?.resolutionMode);
  const extra = extraScaleRatio(options);

  if (mode === 'percent') {
    const combined = resolutionPercentRatio(options) * extra;
    if (combined >= 0.999) return null;
    return evenScaleByRatio(combined.toFixed(4));
  }

  if (mode === 'max-edge') {
    const max = maxEdgePixels(options);
    const cap = `scale=w='min(iw,${max})':h='min(ih,${max})':force_original_aspect_ratio=decrease`;
    if (extra < 1) {
      return `${cap},${evenScaleByRatio(extra.toFixed(4))}`;
    }
    return `${cap},scale=trunc(iw/2)*2:trunc(ih/2)*2`;
  }

  if (extra < 1) return evenScaleByRatio(extra.toFixed(4));
  return null;
}

function resolveTargetBytes(options, sourceByteSize) {
  if (options.targetMode === 'percent') {
    return Math.max(MIN_TARGET_BYTES, Math.round((sourceByteSize * clamp(options.percent ?? 50, 5, 95)) / 100));
  }
  if (options.targetMode === 'size') {
    return Math.max(MIN_TARGET_BYTES, Math.round(options.targetBytes ?? 0));
  }
  return null;
}

function videoEncoderFor(format, requestedCodec, encoders) {
  const requested = typeof requestedCodec === 'string' ? requestedCodec : '';
  if (format === 'webm') {
    if (requested === 'av1') return encoders?.av1 ?? VIDEO_CODEC_LIBS.av1;
    return encoders?.vp9 ?? VIDEO_CODEC_LIBS.vp9;
  }
  if (requested === 'h265') {
    return encoders?.hevc ?? encoders?.h264 ?? VIDEO_CODEC_LIBS.h265;
  }
  if (requested === 'vp9') return encoders?.vp9 ?? VIDEO_CODEC_LIBS.vp9;
  if (requested === 'av1') return encoders?.av1 ?? encoders?.vp9 ?? VIDEO_CODEC_LIBS.av1;
  return encoders?.h264 ?? VIDEO_CODEC_LIBS.h264;
}

function containerVideoTags(format, codec) {
  if (format !== 'mp4') return [];
  if (codec === 'libvpx-vp9') return ['-tag:v', 'vp09'];
  if (codec === 'libsvtav1' || codec === 'libaom-av1') return ['-tag:v', 'av01'];
  return [];
}

/**
 * `-b:v` is bits per second. A 50% size target for a 100s clip is ~4 Mbps,
 * not "half the file in bits" dumped straight into the bitrate flag.
 */
function videoBitsPerSecondForSizeTarget({
  targetBytes,
  durationMicros,
  hasAudio = true,
  audioMode,
}) {
  const durationSeconds = Number(durationMicros) / 1_000_000;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error('无法确定媒体时长，无法按目标大小压缩。请改用质量或码率模式，或检查源文件。');
  }
  const totalBitsPerSecond = (targetBytes * 8) / durationSeconds;
  const audioBits = audioMode === 'none' || hasAudio === false
    ? 0
    : Math.min(192_000, Math.max(32_000, Math.round(totalBitsPerSecond * 0.12)));
  return Math.max(64_000, Math.floor(totalBitsPerSecond - audioBits));
}

function qualityBitrateKbps(crf, sourceByteSize, durationMicros) {
  const durationSeconds = Number(durationMicros) / 1_000_000;
  if (Number.isFinite(durationSeconds) && durationSeconds > 0 && Number(sourceByteSize) > 0) {
    const sourceKbps = (Number(sourceByteSize) * 8) / durationSeconds / 1000;
    const factor = 1 - ((clamp(crf, 14, 34) - 14) / 20) * 0.75;
    return Math.max(100, Math.round(sourceKbps * factor));
  }
  return crfToBitrateKbps(crf);
}

function audioArgsFor(format, audioMode, hasAudio = true) {
  if (audioMode === 'none' || hasAudio === false) return ['-an'];
  if (audioMode === 'copy' && format !== 'webm') return ['-c:a', 'copy'];
  if (format === 'webm') return ['-c:a', 'libopus', '-b:a', '128k'];
  return ['-c:a', 'aac', '-b:a', '192k'];
}

function isQualityMode(options) {
  return options.targetMode === 'quality' || options.targetMode === undefined || options.targetMode === 'convert';
}

function isBitrateMode(options) {
  return options.targetMode === 'bitrate';
}

function videoBitrateArgs(codec, kbps) {
  const rate = Math.max(100, Math.min(100_000, Math.round(kbps)));
  if (codec === 'libvpx-vp9') {
    return ['-c:v', codec, '-b:v', `${rate}k`, '-deadline', 'good'];
  }
  const args = ['-c:v', codec];
  if (PRESET_VIDEO_ENCODERS.has(codec)) args.push('-preset', 'medium');
  args.push(
    '-b:v', `${rate}k`,
    '-maxrate', `${Math.round(rate * 1.45)}k`,
    '-bufsize', `${Math.round(rate * 2)}k`,
  );
  return args;
}

function videoSizeBudgetArgs(codec, videoBits) {
  if (codec === 'libvpx-vp9') {
    return ['-c:v', codec, '-b:v', `${videoBits}`, '-maxrate', `${Math.round(videoBits * 1.45)}`, '-deadline', 'good'];
  }
  const args = ['-c:v', codec];
  if (PRESET_VIDEO_ENCODERS.has(codec)) args.push('-preset', 'medium');
  args.push(
    '-b:v', `${videoBits}`,
    '-maxrate', `${Math.round(videoBits * 1.45)}`,
    '-bufsize', `${Math.round(videoBits * 2)}`,
  );
  return args;
}

function crfToBitrateKbps(crf) {
  return Math.round(5000 - ((clamp(crf, 14, 34) - 14) / 20) * 4200);
}

function videoQualityArgs(codec, crf, source = {}) {
  if (codec === 'libvpx-vp9') {
    return ['-c:v', codec, '-b:v', '0', '-crf', String(crf), '-deadline', 'good'];
  }
  if (CRF_VIDEO_ENCODERS.has(codec)) {
    const args = ['-c:v', codec];
    if (PRESET_VIDEO_ENCODERS.has(codec)) args.push('-preset', 'medium');
    args.push('-crf', String(crf));
    return args;
  }
  return videoBitrateArgs(
    codec,
    qualityBitrateKbps(crf, source.sourceByteSize, source.durationMicros),
  );
}

function withYuv420p(codec, args) {
  if (codec === 'libvpx-vp9' || args.includes('-pix_fmt')) return args;
  return [...args, '-pix_fmt', 'yuv420p'];
}

/**
 * Builds the video transcode argument list.
 * @param {object} input
 * @param {string} input.inputPath
 * @param {string} input.outputPath
 * @param {number} input.durationMicros
 * @param {number} input.sourceByteSize
 * @param {object} input.options { videoFormat, videoCodec, crf, percent, targetBytes, targetMode, audioMode, advancedArgs, videoBitrateKbps, resolutionMode, resolutionPercent, maxEdge, scaleRatio }
 */
function buildVideoArgs(input) {
  const { durationMicros, sourceByteSize, options } = input;
  // The output extension decides the container (compress keeps the original
  // extension, so unknown values here are legitimate).
  const videoFormat = typeof options.videoFormat === 'string' && options.videoFormat.length > 0
    ? options.videoFormat
    : 'mp4';
  const codec = videoEncoderFor(videoFormat, options.videoCodec, input.encoders);
  const args = ['-y', '-i', input.inputPath];
  const scaleFilter = buildScaleFilter(options);
  if (scaleFilter) args.push('-vf', scaleFilter);

  let qualityArgs;
  if (isBitrateMode(options)) {
    qualityArgs = videoBitrateArgs(codec, options.videoBitrateKbps ?? 2500);
  } else if (isQualityMode(options)) {
    const crf = clamp(Math.round(options.crf ?? 23), 14, 34);
    qualityArgs = videoQualityArgs(codec, crf, { sourceByteSize, durationMicros });
  } else {
    const targetBytes = resolveTargetBytes(options, sourceByteSize);
    if (targetBytes === null) {
      throw new Error('压缩目标无效。');
    }
    const videoBits = videoBitsPerSecondForSizeTarget({
      targetBytes,
      durationMicros,
      hasAudio: input.hasAudio !== false,
      audioMode: options.audioMode,
    });
    qualityArgs = videoSizeBudgetArgs(codec, videoBits);
  }
  qualityArgs = withYuv420p(codec, qualityArgs);

  const audioArgs = audioArgsFor(videoFormat, options.audioMode, input.hasAudio !== false);

  args.push(
    ...qualityArgs,
    ...audioArgs,
    ...containerVideoTags(videoFormat, codec),
    ...(videoFormat === 'mp4' ? ['-movflags', '+faststart'] : []),
    ...tokenizeAdvancedArgs(options.advancedArgs),
  );
  args.push(input.outputPath);
  return args;
}

/**
 * Builds image conversion/compression arguments.
 * @param {object} input
 * @param {string} input.inputPath
 * @param {string} input.outputPath
 * @param {object} input.options { imageFormat, crf, qualityArg?, advancedArgs, resolutionMode, resolutionPercent, maxEdge, scaleRatio }
 *  `qualityArg` is resolved by searchImageQuality for size/percent targets.
 */
function buildImageArgs(input) {
  const { options } = input;
  const imageFormat = IMAGE_FORMATS.includes(options.imageFormat) ? options.imageFormat : 'jpg';
  const args = ['-y', '-i', input.inputPath];

  const scaleFilter = buildScaleFilter(options);
  if (scaleFilter) args.push('-vf', scaleFilter);

  if (imageFormat === 'png') {
    args.push('-compression_level', '9');
    args.push(...tokenizeAdvancedArgs(options.advancedArgs));
    args.push(input.outputPath);
    return args;
  }
  if (typeof options.qualityArg === 'number') {
    const scale = IMAGE_SEARCH_SCALES[imageFormat];
    args.push(IMAGE_QUALITY_FLAG[imageFormat] ?? '-q:v', String(scale.toArg(options.qualityArg)));
  } else if (options.targetMode === 'quality') {
    const scale = IMAGE_SEARCH_SCALES[imageFormat] ?? IMAGE_SEARCH_SCALES.jpg;
    args.push(IMAGE_QUALITY_FLAG[imageFormat] ?? '-q:v', String(scale.toArg(clamp(Math.round(options.crf ?? 4), scale.min, scale.max))));
  }
  args.push(...tokenizeAdvancedArgs(options.advancedArgs));
  args.push(input.outputPath);
  return args;
}

/**
 * Binary-searches the worst quality value whose output still fits under
 * targetBytes. Encodes at most `iterations` times.
 * @param {object} input
 * @param {(qualityArg: number) => Promise<number>} input.encodeAndGetBytes
 *   receives the quality search value (scale.min to scale.max), returns the produced file size.
 * @param {number} input.targetBytes
 * @param {'jpg'|'avif'|'webp'} input.format
 * @param {boolean} [input.returnBestEffort]
 *   if true, returns { qualityArg, bytes, overflow: true } when even worst quality exceeds targetBytes.
 * @returns {Promise<{ qualityArg: number, bytes: number, overflow?: boolean } | null>}
 */
async function searchImageQuality(input) {
  const { encodeAndGetBytes, targetBytes, format, returnBestEffort } = input;
  const scale = IMAGE_SEARCH_SCALES[format] ?? IMAGE_SEARCH_SCALES.jpg;
  let best = null;
  let low = scale.min;
  let high = scale.max;
  const iterations = Math.ceil(Math.log2(high - low + 1)) + 1;
  for (let iteration = 0; iteration < iterations && low <= high; iteration += 1) {
    const mid = Math.round((low + high) / 2);
    const bytes = await encodeAndGetBytes(mid);
    if (bytes <= targetBytes) {
      // Fits — remember it and try better quality (smaller search value).
      best = { qualityArg: mid, bytes };
      high = mid - 1;
    } else {
      // Output too large — degrade quality.
      low = mid + 1;
    }
  }
  if (best !== null) return best;
  const worstBytes = await encodeAndGetBytes(scale.max);
  if (worstBytes <= targetBytes) {
    return { qualityArg: scale.max, bytes: worstBytes };
  }
  return returnBestEffort === true ? { qualityArg: scale.max, bytes: worstBytes, overflow: true } : null;
}

module.exports = {
  CRF_VIDEO_ENCODERS,
  DEFAULT_MAX_EDGE_PX,
  IMAGE_FORMATS,
  IMAGE_SEARCH_SCALES,
  MAX_MAX_EDGE_PX,
  MIN_MAX_EDGE_PX,
  MIN_RESOLUTION_PERCENT,
  MAX_RESOLUTION_PERCENT,
  MIN_TARGET_BYTES,
  buildScaleFilter,
  PRESET_VIDEO_ENCODERS,
  VIDEO_CODEC_LIBS,
  VIDEO_CONTAINERS,
  audioArgsFor,
  buildImageArgs,
  buildVideoArgs,
  clamp,
  crfToBitrateKbps,
  formatBytesForLog,
  isBitrateMode,
  isQualityMode,
  resolveTargetBytes,
  searchImageQuality,
  tokenizeAdvancedArgs,
  videoBitsPerSecondForSizeTarget,
  videoEncoderFor,
  videoQualityArgs,
};
