'use strict';

/**
 * FFmpeg/FFprobe process execution: JSON probing and transcode runs with
 * machine-readable progress (-progress pipe:1) and bounded stderr capture.
 */

const { spawn } = require('node:child_process');

const PROGRESS_TOTAL_MICROS_FALLBACK = 0;

function createAbortError(message = 'The media job was cancelled.') {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function toMicros(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : PROGRESS_TOTAL_MICROS_FALLBACK;
}

/**
 * Runs FFprobe and parses its JSON output.
 * @returns {Promise<{ format: Record<string, unknown>, streams: Array<Record<string, unknown>> }>}
 */
function probeMedia(ffprobePath, filePath, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobePath, [
      '-v', 'error',
      '-print-format', 'json',
      '-show_format',
      '-show_streams',
      filePath,
    ], { windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const onAbort = () => {
      child.kill();
      reject(createAbortError());
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
      if (code !== 0) {
        reject(new Error(`ffprobe exited with code ${code}: ${stderr.slice(-2000)}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        resolve({
          format: parsed.format ?? {},
          streams: Array.isArray(parsed.streams) ? parsed.streams : [],
        });
      } catch (parseError) {
        reject(new Error(`ffprobe produced unparseable output: ${parseError.message}`));
      }
    });
  });
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
function runFfmpeg(input) {
  const {
    ffmpegPath,
    args,
    totalDurationMicros = 0,
    signal,
    onPercent,
  } = input;
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
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
  createAbortError,
  probeMedia,
  runFfmpeg,
  toMicros,
};
