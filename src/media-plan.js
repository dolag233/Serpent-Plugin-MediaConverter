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
};

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

function resolveTargetBytes(options, sourceByteSize) {
  if (options.targetMode === 'percent') {
    return Math.max(64 * 1024, Math.round((sourceByteSize * clamp(options.percent ?? 50, 5, 95)) / 100));
  }
  if (options.targetMode === 'size') {
    return Math.max(64 * 1024, Math.round(options.targetBytes ?? 0));
  }
  return null;
}

/**
 * Builds the video transcode argument list.
 * @param {object} input
 * @param {string} input.inputPath
 * @param {string} input.outputPath
 * @param {number} input.durationMicros
 * @param {number} input.sourceByteSize
 * @param {object} input.options { videoFormat, videoCodec, crf, percent, targetBytes, targetMode, audioMode, advancedArgs }
 */
function buildVideoArgs(input) {
  const { durationMicros, sourceByteSize, options } = input;
  // The output extension decides the container (compress keeps the original
  // extension, so unknown values here are legitimate).
  const videoFormat = typeof options.videoFormat === 'string' && options.videoFormat.length > 0
    ? options.videoFormat
    : 'mp4';
  const codec = VIDEO_CODEC_LIBS[options.videoCodec] ?? VIDEO_CODEC_LIBS.h264;
  const args = ['-y', '-i', input.inputPath];

  let qualityArgs;
  if (options.targetMode === 'quality') {
    const crf = clamp(Math.round(options.crf ?? 23), 14, 34);
    qualityArgs = ['-c:v', codec, '-preset', 'medium', '-crf', String(crf)];
  } else {
    const targetBytes = resolveTargetBytes(options, sourceByteSize);
    if (targetBytes === null) {
      throw new Error('压缩目标无效。');
    }
    if (durationMicros <= 0) {
      throw new Error('无法确定媒体时长，无法按目标大小压缩。请改用质量模式或检查源文件。');
    }
    const totalBits = targetBytes * 8;
    const audioBits = options.audioMode === 'none'
      ? 0
      : Math.min(192_000, Math.max(32_000, Math.round(totalBits * 0.12)));
    const videoBits = Math.max(64_000, Math.floor(totalBits - audioBits));
    qualityArgs = [
      '-c:v', codec,
      '-preset', 'medium',
      '-b:v', `${videoBits}`,
      '-maxrate', `${Math.round(videoBits * 1.45)}`,
      '-bufsize', `${Math.round(videoBits * 2)}`,
    ];
  }

  let audioArgs;
  if (options.audioMode === 'none') audioArgs = ['-an'];
  else if (options.audioMode === 'copy') audioArgs = ['-c:a', 'copy'];
  else audioArgs = ['-c:a', 'aac', '-b:a', '192k'];

  args.push(
    ...qualityArgs,
    ...audioArgs,
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
 * @param {object} input.options { imageFormat, crf, qualityArg?, advancedArgs }
 *  `qualityArg` is resolved by searchImageQuality for size/percent targets.
 */
function buildImageArgs(input) {
  const { options } = input;
  const imageFormat = IMAGE_FORMATS.includes(options.imageFormat) ? options.imageFormat : 'jpg';
  const args = ['-y', '-i', input.inputPath];
  if (imageFormat === 'png') {
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
 *   receives the FFmpeg quality flag value, returns the produced file size.
 * @param {number} input.targetBytes
 * @param {'jpg'|'avif'|'webp'} input.format
 * @returns {Promise<{ qualityArg: number, bytes: number } | null>}
 *   null when even the smallest output exceeds the target.
 */
async function searchImageQuality(input) {
  const { encodeAndGetBytes, targetBytes, format } = input;
  const scale = IMAGE_SEARCH_SCALES[format] ?? IMAGE_SEARCH_SCALES.jpg;
  let best = null;
  let low = scale.min;
  let high = scale.max;
  const iterations = Math.ceil(Math.log2(high - low + 1)) + 1;
  for (let iteration = 0; iteration < iterations && low <= high; iteration += 1) {
    const mid = Math.round((low + high) / 2);
    const bytes = await encodeAndGetBytes(scale.toArg(mid));
    if (bytes <= targetBytes) {
      // Fits — remember it and try better quality (smaller search value).
      best = { qualityArg: scale.toArg(mid), bytes };
      high = mid - 1;
    } else {
      // Output too large — degrade quality.
      low = mid + 1;
    }
  }
  if (best !== null) return best;
  const worst = scale.toArg(scale.max);
  const bytes = await encodeAndGetBytes(worst);
  return bytes <= targetBytes ? { qualityArg: worst, bytes } : null;
}

module.exports = {
  IMAGE_FORMATS,
  IMAGE_SEARCH_SCALES,
  VIDEO_CODEC_LIBS,
  VIDEO_CONTAINERS,
  buildImageArgs,
  buildVideoArgs,
  clamp,
  formatBytesForLog,
  resolveTargetBytes,
  searchImageQuality,
  tokenizeAdvancedArgs,
};
