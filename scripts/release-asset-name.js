'use strict';

/**
 * Release asset naming contract:
 * `{pluginId}-{version}-{platform}.zip`
 */
function releaseAssetName(pluginId, version, platform = 'any') {
  if (!pluginId) throw new Error('pluginId is required.');
  if (!version) throw new Error('version is required.');
  return `${pluginId}-${version}-${platform}.zip`;
}

function pluginVersionFromManifest(manifestPath) {
  const manifest = JSON.parse(require('node:fs').readFileSync(manifestPath, 'utf8'));
  return manifest.version;
}

module.exports = {
  releaseAssetName,
  pluginVersionFromManifest,
};
