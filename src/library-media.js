'use strict';

/**
 * Library media access for the plugin:
 * - derives the library root from the documented plugin-files directory,
 * - resolves source file paths for managed and linked assets,
 * - falls back to chunked `readContent` assembly when the disk layout does
 *   not match (keeps the pipeline correct on any library shape),
 * - stages replacement content back through the chunked staging API.
 *
 * All library WRITES go through serpent APIs; fs is read-only here.
 */

const fs = require('node:fs');
const path = require('node:path');

const READ_CHUNK_BYTES = 8 * 1024 * 1024;
const STAGE_CHUNK_BYTES = 768 * 1024; // base64 ≈ 1 MiB, inside the transport budget

function isDirectory(filePath) {
  try {
    return fs.lstatSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function isFile(filePath) {
  try {
    const entry = fs.lstatSync(filePath);
    return entry.isFile() && !entry.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Derives the library root from `{root}/.serpent/plugin-files/<pluginId>`.
 * Returns null when the layout does not match.
 */
function deriveLibraryRoot(libraryPluginDirectory, pluginId) {
  if (typeof libraryPluginDirectory !== 'string' || libraryPluginDirectory.length === 0) return null;
  const expectedSuffix = path.join('.serpent', 'plugin-files', pluginId);
  if (!libraryPluginDirectory.toLowerCase().endsWith(expectedSuffix.toLowerCase())) return null;
  const root = path.resolve(libraryPluginDirectory, '..', '..', '..');
  if (!isDirectory(path.join(root, '.serpent'))) return null;
  return root;
}

function resolveManagedSourcePath(libraryRoot, relativeFilePath) {
  const assetsRoot = path.join(libraryRoot, 'Assets');
  if (!isDirectory(assetsRoot)) return null;
  const candidate = path.join(assetsRoot, relativeFilePath);
  return isFile(candidate) ? candidate : null;
}

function resolveLinkedSourcePath(linkedFolders, assetSummary) {
  if (assetSummary.locationKind !== 'linked' || !assetSummary.linkedFolderId) return null;
  const linked = linkedFolders.find((entry) => entry.linkedFolderId === assetSummary.linkedFolderId);
  const absoluteRootPath = linked?.absoluteRootPath ?? linked?.absolutePath;
  if (typeof absoluteRootPath !== 'string' || absoluteRootPath.length === 0) return null;
  const candidate = path.join(absoluteRootPath, assetSummary.relativeFilePath);
  return isFile(candidate) ? candidate : null;
}

/**
 * Assembles an asset's bytes into destinationPath via chunked readContent.
 * Works for any size and any location kind.
 */
async function assembleAssetToFile({ assets, assetId, destinationPath, signal }) {
  const handle = fs.openSync(destinationPath, 'w', 0o600);
  let offset = 0;
  let byteSize = 0;
  try {
    for (;;) {
      signal?.throwIfAborted?.();
      const chunk = await assets.readContent(assetId, {
        offsetBytes: offset,
        maxBytes: READ_CHUNK_BYTES,
      });
      byteSize = chunk.byteSize;
      const bytes = Buffer.from(chunk.dataBase64, 'base64');
      if (bytes.length > 0) fs.writeSync(handle, bytes);
      offset += bytes.length;
      if (!chunk.truncated || bytes.length === 0) break;
    }
  } finally {
    fs.closeSync(handle);
  }
  return { byteSize, assembled: true };
}

/**
 * Resolves a readable local file for the asset. Prefers the direct library
 * path; falls back to chunked content assembly.
 */
async function resolveSourceFile({
  assets,
  libraryRoot,
  linkedFolders,
  assetSummary,
  workDirectory,
  signal,
}) {
  if (libraryRoot) {
    const direct = assetSummary.locationKind === 'linked'
      ? resolveLinkedSourcePath(linkedFolders, assetSummary)
      : resolveManagedSourcePath(libraryRoot, assetSummary.relativeFilePath);
    if (direct) return { filePath: direct, assembled: false };
  }
  const destinationPath = path.join(workDirectory, `source-${assetSummary.assetId}${path.extname(assetSummary.relativeFilePath)}`);
  const { byteSize } = await assembleAssetToFile({
    assets,
    assetId: assetSummary.assetId,
    destinationPath,
    signal,
  });
  return { filePath: destinationPath, assembled: true, byteSize };
}

/**
 * Stages a local file as replacement content through chunked stageContent.
 * @returns {Promise<{ stagingToken: string, byteSize: number }>}
 */
async function stageFileForReplace({ assets, assetId, filePath, signal, onProgress }) {
  const byteSize = fs.statSync(filePath).size;
  const handle = fs.openSync(filePath, 'r');
  let stagingToken;
  let offset = 0;
  try {
    while (offset < byteSize) {
      signal?.throwIfAborted?.();
      const length = Math.min(STAGE_CHUNK_BYTES, byteSize - offset);
      const bytes = Buffer.allocUnsafe(length);
      let filled = 0;
      while (filled < length) {
        const count = fs.readSync(handle, bytes, filled, length - filled, offset + filled);
        if (count === 0) break;
        filled += count;
      }
      const payload = filled === length ? bytes : bytes.subarray(0, filled);
      const complete = offset + filled >= byteSize;
      const result = await assets.stageContent(assetId, payload.toString('base64'), {
        ...(stagingToken === undefined ? {} : { stagingToken }),
        complete,
      });
      if (typeof result?.stagingToken !== 'string' || result.stagingToken.length === 0) {
        throw new Error('Host did not return a staging token.');
      }
      stagingToken = result.stagingToken;
      offset += filled;
      onProgress?.(Math.round((offset / byteSize) * 100));
    }
  } finally {
    fs.closeSync(handle);
  }
  if (offset !== byteSize) throw new Error(`Staged ${offset} of ${byteSize} bytes.`);
  return { stagingToken, byteSize };
}

/** Builds an id→summary index across paginated asset.list pages. */
async function indexAssetSummaries({ assets, assetIds, signal }) {
  const wanted = new Set(assetIds);
  const index = new Map();
  const pageSize = 200;
  for (let offset = 0; wanted.size > index.size; offset += pageSize) {
    signal?.throwIfAborted?.();
    const page = await assets.list({ limit: pageSize, offset });
    const items = Array.isArray(page?.items) ? page.items : Array.isArray(page?.assets) ? page.assets : [];
    for (const summary of items) {
      if (wanted.has(summary.assetId) && !index.has(summary.assetId)) {
        index.set(summary.assetId, summary);
      }
    }
    if (items.length < pageSize) break;
  }
  return index;
}

module.exports = {
  STAGE_CHUNK_BYTES,
  assembleAssetToFile,
  deriveLibraryRoot,
  indexAssetSummaries,
  resolveLinkedSourcePath,
  resolveManagedSourcePath,
  resolveSourceFile,
  stageFileForReplace,
};
