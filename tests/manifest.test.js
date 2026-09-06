'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const manifestPath = path.join(__dirname, '..', 'serpent-plugin.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

test('manifest declares the Plugin API 1 unrestricted runtime', () => {
  assert.equal(manifest.manifestVersion, 1);
  assert.equal(manifest.id, 'com.dolag.serpent.media-converter');
  assert.equal(manifest.engines.pluginApi, 1);
  assert.equal(manifest.runtime.mode, 'unrestricted');
  assert.equal(manifest.runtime.entry, 'entry/main.js');
  assert.equal(manifest.runtime.instanceScope, 'global');
});

test('permissions are unique and include host FFmpeg plus dialogs', () => {
  const permissions = manifest.permissions;
  assert.equal(new Set(permissions).size, permissions.length);
  for (const required of [
    'asset.read', 'content.read', 'content.write', 'file.import', 'file.rename', 'data.files',
    'job.manage', 'library.read', 'metadata.read', 'metadata.write', 'tag.read', 'tag.write',
    'storage.read', 'storage.write',
    'ui.notify', 'ui.dialogs', 'media.binaries',
  ]) {
    requireCondition(permissions.includes(required), `missing permission ${required}`);
  }
  requireCondition(!permissions.includes('secrets.read'), 'the plugin must not request secrets');
  requireCondition(!permissions.includes('trash.write'), 'the plugin must not trash assets silently');
});

test('does not expose an FFmpeg path setting', () => {
  assert.equal(manifest.contributes.settings.length, 0);
});

test('contributes asset context menu items for convert and compress', () => {
  const menuItems = manifest.contributes.menus.asset;
  const convert = menuItems.find((item) => item.command === 'mediaconverter.open-convert');
  const compress = menuItems.find((item) => item.command === 'mediaconverter.open-compress');
  assert.equal(convert.title, '视频转码');
  assert.equal(compress.title, '压缩体积');
  assert.match(convert.when, /mp4/);
  assert.doesNotMatch(convert.when, /jpg/);
  assert.match(compress.when, /jpg/);
  assert.match(compress.when, /mp4/);
  for (const item of [convert, compress]) {
    assert(item.when.includes('selection.assetCount == selection.count'), 'multi-select guard missing');
    assert(item.enablement.includes('library.writable'), 'writable enablement missing');
  }
  const commandIds = new Set(manifest.contributes.commands.map((command) => command.id));
  for (const item of menuItems) {
    requireCondition(commandIds.has(item.command), `menu item references undeclared command ${item.command}`);
  }
});

test('does not declare iframe dialog entries', () => {
  const jobs = manifest.contributes.jobs;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, 'media-convert');
  assert.equal((manifest.contributes.dialogs ?? []).length, 0);
  assert.equal(manifest.contributes.views.length, 0);
});
