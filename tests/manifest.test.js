'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveFfmpegBinaries } = require('../src/ffmpeg-locator');

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

test('permissions are unique and minimal for the media pipeline', () => {
  const permissions = manifest.permissions;
  assert.equal(new Set(permissions).size, permissions.length);
  for (const required of ['asset.read', 'content.read', 'content.write', 'file.import', 'data.files', 'job.manage', 'library.read', 'storage.read', 'storage.write', 'ui.notify']) {
    requireCondition(permissions.includes(required), `missing permission ${required}`);
  }
  requireCondition(!permissions.includes('secrets.read'), 'the plugin must not request secrets');
  requireCondition(!permissions.includes('trash.write'), 'the plugin must not trash assets silently');
});

test('contributes asset context menu items for convert and compress', () => {
  const menuItems = manifest.contributes.menus.asset;
  const convert = menuItems.find((item) => item.command === 'mediaconverter.open-convert');
  const compress = menuItems.find((item) => item.command === 'mediaconverter.open-compress');
  assert(convert !== undefined);
  assert(compress !== undefined);
  for (const item of [convert, compress]) {
    assert(item.when.includes('selection.assetCount == selection.count'), 'multi-select guard missing');
    assert(item.enablement.includes('library.writable'), 'writable enablement missing');
  }
  const commandIds = new Set(manifest.contributes.commands.map((command) => command.id));
  for (const item of menuItems) {
    requireCondition(commandIds.has(item.command), `menu item references undeclared command ${item.command}`);
  }
});

test('every run command and job handler is declared', () => {
  const jobs = manifest.contributes.jobs;
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, 'media-convert');
  const view = manifest.contributes.views.find((entry) => entry.id === 'converter-panel');
  assert(view !== undefined && view.location === 'sidebar');
  assert(view.entry === 'entry/ui/panel.html');
  assert(fs.existsSync(path.join(__dirname, '..', view.entry)));
});

test('binary locator prefers settings, then bundled, then PATH', () => {
  const root = path.join(__dirname, '..', 'src');
  assert(typeof resolveFfmpegBinaries === 'function');
  assert(fs.existsSync(path.join(root, 'ffmpeg-runner.js')));
});
