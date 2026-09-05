# Third-party notices

## Upscayl NCNN runtime

The build output may contain the `upscayl-ncnn` executable from the Upscayl
project. It is distributed under AGPL-3.0. Source and license:

- https://github.com/upscayl/upscayl-ncnn
- https://github.com/upscayl/upscayl-ncnn/blob/master/LICENSE

The runtime is downloaded by `scripts/build.mjs` from the pinned
`20251207-174704` release.

## Models

The official model files are bundled in the installable `dist` package from
the Upscayl repository:

- `upscayl-standard-4x`
- `digital-art-4x`

Model attribution and licensing follow the upstream Upscayl and model authors'
notices:

- https://github.com/upscayl/upscayl/tree/main/resources/models
- https://github.com/xinntao/Real-ESRGAN

## Sharp

The plugin includes `sharp` and its platform-specific `libvips` dependencies
for the 1x resize-back step. Their notices are distributed in
`node_modules/sharp` and the corresponding `@img/*` packages in the built
plugin.

---

## FFmpeg

This plugin bundles or downloads FFmpeg static builds (scripts/build.mjs).
FFmpeg is licensed under the GNU Lesser General Public License (LGPL) version
2.1 or later, depending on the build configuration. Source code:
https://ffmpeg.org/download.html

- win32-x64 / linux-x64: BtbN/FFmpeg-Builds (LGPL variant)
  https://github.com/BtbN/FFmpeg-Builds
- darwin-arm64: evermeet.cx static builds
  https://evermeet.cx/ffmpeg/
