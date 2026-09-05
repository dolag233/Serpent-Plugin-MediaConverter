'use strict';

/**
 * Release asset naming contract:
 * `Serpent-Plugin-MediaConverter-<version>-<platform>-<arch>.zip`
 */
function releaseAssetName(version, platform, arch) {
  if (!version || !platform || !arch) throw new Error('version, platform, and arch are required.');
  return `Serpent-Plugin-MediaConverter-${version}-${platform}-${arch}.zip`;
}

function pluginVersionFromManifest(manifestPath) {
  const manifest = JSON.parse(require('node:fs').readFileSync(manifestPath, 'utf8'));
  return manifest.version;
}

module.exports = {
  releaseAssetName,
  pluginVersionFromManifest,
};
