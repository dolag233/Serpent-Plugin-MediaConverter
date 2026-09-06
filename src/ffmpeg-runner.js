'use strict';

/**
 * FFmpeg/FFprobe process execution: JSON probing and transcode runs with
 * machine-readable progress (-progress pipe:1) and bounded stderr capture.
 *
 * Host FFmpeg 8 no longer accepts ffprobe `-print-format` (hyphen). The
 * current flag is `-output_format json`. The bundled LGPL build also has no
 * libx264/libx265; encoder names must be picked from `ffmpeg -encoders`.
 */

const { spawn } = require('node:child_process');

const PROGRESS_TOTAL_MICROS_FALLBACK = 0;

const H264_ENCODER_CANDIDATES = [
  'libx264',
  'libopenh264',
  'h264_mf',
  'h264_videotoolbox',
  'h264_nvenc',
  'h264_qsv',
  'h264_amf',
];

const HEVC_ENCODER_CANDIDATES = [
  'libx265',
  'libkvazaar',
  'hevc_mf',
  'hevc_videotoolbox',
  'hevc_nvenc',
  'hevc_qsv',
  'hevc_amf',
];

const AV1_ENCODER_CANDIDATES = [
  'libsvtav1',
  'libaom-av1',
  'av1_nvenc',
  'av1_qsv',
  'av1_amf',
  'av1_videotoolbox',
];

function createAbortError(message = 'The media job was cancelled.') {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function toMicros(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : PROGRESS_TOTAL_MICROS_FALLBACK;
}

function durationMicrosFromProbe(probed) {
  const values = [probed?.format?.duration];
  for (const stream of Array.isArray(probed?.streams) ? probed.streams : []) {
    values.push(stream.duration);
  }
  for (const value of values) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1_000_000);
  }
  return 0;
}

function parseListedEncoders(text) {
  const names = new Set();
  for (const line of String(text).split(/\r?\n/u)) {
    const match = /^\s*[VAS][.A-Z]{5}\s+(\S+)/u.exec(line);
    if (match) names.add(match[1]);
  }
  return names;
}

function firstListed(available, candidates) {
  return candidates.find((name) => available.has(name)) ?? null;
}

function pickVideoEncoders(available) {
  return {
    h264: firstListed(available, H264_ENCODER_CANDIDATES),
    hevc: firstListed(available, HEVC_ENCODER_CANDIDATES),
    vp9: available.has('libvpx-vp9') ? 'libvpx-vp9' : null,
    av1: firstListed(available, AV1_ENCODER_CANDIDATES),
  };
}

function spawnCollect(binaryPath, args, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const onAbort = () => {
      child.kill();
      reject(createAbortError());
    };
    if (signal) {
      if (signal.aborted) {
        reject(createAbortError());
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/**
 * Runs FFprobe and parses its JSON output.
 * @returns {Promise<{ format: Record<string, unknown>, streams: Array<Record<string, unknown>> }>}
 */
async function probeMedia(ffprobePath, filePath, signal) {
  const result = await spawnCollect(ffprobePath, [
    '-v', 'error',
    '-output_format', 'json',
    '-show_format',
    '-show_streams',
    filePath,
  ], signal);
  if (result.code !== 0) {
    throw new Error(`ffprobe exited with code ${result.code}: ${result.stderr.slice(-2000)}`);
  }
  try {
    const parsed = JSON.parse(result.stdout);
    return {
      format: parsed.format ?? {},
      streams: Array.isArray(parsed.streams) ? parsed.streams : [],
    };
  } catch (parseError) {
    throw new Error(`ffprobe produced unparseable output: ${parseError.message}`);
  }
}

async function listFfmpegEncoders(ffmpegPath, signal) {
  const result = await spawnCollect(ffmpegPath, ['-hide_banner', '-encoders'], signal);
  return parseListedEncoders(`${result.stdout}\n${result.stderr}`);
}

/**
 * Runs an FFmpeg transcode.
 * @param {object} input
 * @param {string} input.ffmpegPath
 * @param {string[]} input.args full argument list (after the binary name)
 * @param {number} input.totalDurationMicros used to translate out_time into percent
 * @param {AbortSignal | undefined} input.signal
 * @param {(percent: number) => void} [input.onPercent]
 * @returns {Promise<{ stderrTail: string }>}
 */
function withProgressArgs(args) {
  if (!Array.isArray(args) || args.includes('-progress')) return args ?? [];
  return ['-hide_banner', '-nostats', '-progress', 'pipe:1', ...args];
}

function runFfmpeg(input) {
  const {
    ffmpegPath,
    args,
    totalDurationMicros = 0,
    signal,
    onPercent,
  } = input;
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, withProgressArgs(args), { windowsHide: true });
    let stderr = '';
    let aborted = false;
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 64 * 1024) stderr = stderr.slice(-32 * 1024);
    });
    let progressBuffer = '';
    child.stdout.on('data', (chunk) => {
      progressBuffer += chunk;
      const lines = progressBuffer.split('\n');
      progressBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const match = /^out_time_us=(\d+)/.exec(line.trim());
        if (!match || totalDurationMicros <= 0 || typeof onPercent !== 'function') continue;
        const percent = Math.min(100, Math.round((toMicros(match[1]) / totalDurationMicros) * 100));
        if (percent >= 0) onPercent(percent);
      }
    });
    const onAbort = () => {
      aborted = true;
      child.kill();
    };
    if (signal) {
      if (signal.aborted) { reject(createAbortError()); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    child.on('error', (error) => {
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (aborted) { reject(createAbortError()); return; }
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-2000)}`));
        return;
      }
      resolve({ stderrTail: stderr.slice(-2000) });
    });
  });
}

module.exports = {
  AV1_ENCODER_CANDIDATES,
  H264_ENCODER_CANDIDATES,
  HEVC_ENCODER_CANDIDATES,
  createAbortError,
  durationMicrosFromProbe,
  listFfmpegEncoders,
  parseListedEncoders,
  pickVideoEncoders,
  probeMedia,
  runFfmpeg,
  toMicros,
  withProgressArgs,
};
