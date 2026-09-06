'use strict';

/**
 * Release asset naming contract:
 * `Serpent-Plugin-MediaConverter-<version>-any.zip`
 */
function releaseAssetName(version, platform = 'any') {
  if (!version) throw new Error('version is required.');
  return `Serpent-Plugin-MediaConverter-${version}-${platform}.zip`;
}

function pluginVersionFromManifest(manifestPath) {
  const manifest = JSON.parse(require('node:fs').readFileSync(manifestPath, 'utf8'));
  return manifest.version;
}

module.exports = {
  releaseAssetName,
  pluginVersionFromManifest,
};
