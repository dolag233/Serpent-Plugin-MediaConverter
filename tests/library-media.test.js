'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  assembleAssetToFile,
  deriveLibraryRoot,
  resolveManagedSourcePath,
  stageFileForReplace,
} = require('../src/library-media');

function createFakeLibrary() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-converter-library-'));
  fs.mkdirSync(path.join(root, '.serpent', 'plugin-files', 'com.dolag.serpent.media-converter'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Assets', '项目'), { recursive: true });
  const sourcePath = path.join(root, 'Assets', '项目', 'shot.mp4');
  fs.writeFileSync(sourcePath, 'video-bytes');
  return { root, sourcePath };
}

test('derives the library root from the plugin-files directory', () => {
  const { root } = createFakeLibrary();
  const pluginDir = path.join(root, '.serpent', 'plugin-files', 'com.dolag.serpent.media-converter');
  assert.equal(deriveLibraryRoot(pluginDir, 'com.dolag.serpent.media-converter'), path.resolve(root));
});

test('rejects layouts that do not match the plugin-files contract', () => {
  assert.equal(deriveLibraryRoot('C:\\somewhere\\else', 'com.dolag.serpent.media-converter'), null);
  assert.equal(deriveLibraryRoot('', 'com.dolag.serpent.media-converter'), null);
});

test('resolves managed assets under the Assets root', () => {
  const { root, sourcePath } = createFakeLibrary();
  const resolved = resolveManagedSourcePath(root, path.join('项目', 'shot.mp4'));
  assert.equal(resolved, sourcePath);
  assert.equal(resolveManagedSourcePath(root, path.join('项目', 'missing.mp4')), null);
});

test('assembles asset bytes into a local file via chunked reads', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-converter-assemble-'));
  const destinationPath = path.join(temporaryRoot, 'source.bin');
  const chunks = ['aaa', 'bbb', 'ccc'];
  const expectedOffsets = [0, 3, 6, 9];
  let call = 0;
  const assets = {
    async readContent(assetId, { offsetBytes, maxBytes }) {
      assert.equal(assetId, 'asset-1');
      assert.equal(offsetBytes, expectedOffsets[call]);
      const data = chunks[call] ?? '';
      call += 1;
      return {
        assetId,
        revisionId: 'rev-1',
        byteSize: 9,
        dataBase64: Buffer.from(data).toString('base64'),
        truncated: call < chunks.length,
        mimeType: null,
      };
    },
  };
  const { byteSize, assembled } = await assembleAssetToFile({
    assets,
    assetId: 'asset-1',
    destinationPath,
  });
  assert.equal(byteSize, 9);
  assert.equal(assembled, true);
  assert.equal(fs.readFileSync(destinationPath, 'utf8'), 'aaabbbccc');
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});

test('stages a local file for replacement in bounded chunks', async () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-converter-stage-'));
  const filePath = path.join(temporaryRoot, 'output.mp4');
  fs.writeFileSync(filePath, Buffer.from('x'.repeat(3000)));
  const stagedChunks = [];
  const assets = {
    async stageContent(assetId, dataBase64, options) {
      assert.equal(assetId, 'asset-1');
      const token = stagedChunks.length === 0 ? 'token-1' : options.stagingToken;
      stagedChunks.push(Buffer.from(dataBase64, 'base64'));
      return { assetId, stagingToken: token, byteSize: 3000, complete: options.complete === true };
    },
  };
  const progresses = [];
  const result = await stageFileForReplace({
    assets,
    assetId: 'asset-1',
    filePath,
    onProgress: (percent) => progresses.push(percent),
  });
  assert.equal(result.stagingToken, 'token-1');
  assert.equal(result.byteSize, 3000);
  assert.equal(Buffer.concat(stagedChunks).toString(), 'x'.repeat(3000));
  assert.ok(progresses[progresses.length - 1] === 100);
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
});
