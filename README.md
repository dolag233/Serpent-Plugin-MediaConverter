# Serpent-Plugin-MediaConverter

Serpent 插件：用**宿主内置 FFmpeg** 对选中资产做批量**视频转码**和**媒体压缩**。

## 功能

在资源库里选中一笔或多笔资产，右键：

- **视频转码**：仅视频。输出容器为 MP4 或 WebM。编码随容器切换：MP4 为 H.264 / H.265 / VP9 / AV1，WebM 为 VP9 / AV1。可设 CRF 或目标码率，音频默认复制。后缀留空会替换原资产；若容器变了，会改扩展名并保留同一资产上的标签等信息。
- **压缩体积**：图片和视频设置完全分开。图像可按百分比、目标大小或质量；视频额外支持目标码率。分辨率是并列约束：默认为原始分辨率，也可按百分比缩小，或限制最长边（1920 / 1080 / 自定义），不放大。可与体积目标同时生效（先缩画幅，再压体积）。按百分比/目标大小压缩时按时长换算视频码率。音频默认复制。

两个菜单都打开宿主标准对话框。文件名后缀留空表示替换原资产；填写后缀则另存为新资产。确认后以后台 Job 执行，进度走宿主任务条。

FFmpeg / ffprobe 一律来自 Serpent 的 `serpent.media.getBinaryPaths()`，插件不提供路径设置，也不捆绑第二套二进制。

## 安装

1. 使用带 `serpent.ui.openDialog` 与 `serpent.media.getBinaryPaths` 的 Serpent 构建（当前开发分支）。
2. 设置 → 插件 → 本地安装本目录（或 Release 的 `any` zip）→ 信任 → 开库激活。
3. 选中视频或图片，右键使用上述两项。

## 构建与测试

插件 CI **不启动 Serpent / Electron**。对话框由宿主用标准化控件渲染：插件在 `openDialog({ render })` 里组合 `ui.select` / `ui.number` 等 widget，单测覆盖树的可见性切换和提交值形状。

```bash
npm test                 # 契约 + widget 树 + 管线（不需要本机 FFmpeg / Serpent）
npm run check            # 语法检查
npm run package:release  # 打出平台无关 zip 到 out/
```

本机若要在真实窗口里复验，先完整退出 Serpent 再 `npm start`，并重装/刷新本插件包。

## 权限

- `asset.read` / `content.read` / `content.write`：读源媒体、写回压缩结果
- `file.import`：带后缀时导入为新资产
- `file.rename`：转码改扩展名时原地重命名同一资产
- `metadata.read` / `metadata.write` / `tag.read` / `tag.write`：另存为新资产时拷贝标签、评分等
- `data.files`：任务请求文件
- `job.manage`：批量任务入队与进度
- `ui.dialogs` / `ui.notify`：设置面板与完成通知
- `media.binaries`：使用宿主 FFmpeg
