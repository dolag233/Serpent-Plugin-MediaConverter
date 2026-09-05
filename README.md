# Serpent-Plugin-MediaConverter

Serpent 插件：基于 FFmpeg 的媒体资产批量**格式转换**与**压缩**。

## 功能

- 资产右键菜单新增「格式转换…」与「压缩…」（支持多选）
- 右键后打开侧栏「媒体转换」面板完成设置：
  - **格式转换**：视频（MP4/MOV/MKV/WebM，H.264/H.265）与图像（JPG/PNG/WebP/AVIF）互转，支持音频（AAC/复制/移除）
  - **压缩**：三种目标——原文件大小百分比、目标大小（MB）、固定质量（CRF）；图像按质量二分搜索逼近目标体积
  - **FFmpeg 高级参数**：任意追加参数（如 `-vf scale=1920:-2`）
- 批量执行以插件 Job 运行：进度百分比、取消、逐项失败报告；完成后系统通知
- 输出：转换导入为新资产；压缩默认替换原资产（保留修订历史），可选导入为新资产

## 安装与运行时

1. 主仓：设置 → 插件 → 本地安装本目录（或装 release zip）→ 信任 → 开库激活。
2. FFmpeg 来源（按优先级）：
   - 插件设置 `FFmpeg 可执行文件路径`
   - 捆绑二进制 `runtime/bin/<platform>-<arch>/`（`npm run build` 自动下载，见下）
   - 系统 PATH

## 构建

```bash
npm run build            # 下载各平台 FFmpeg (BtbN LGPL / evermeet) 到 runtime/bin
npm test                 # 单元测试（无需二进制）
npm run check            # 语法检查
npm run package:release  # 打包各平台 release zip 到 out/
```

本地已装 FFmpeg 时可跳过下载：`SERPENT_MEDIA_CONVERTER_FFMPEG=<目录> npm run build`（目录内含 ffmpeg/ffprobe）。

## 权限说明

- `asset.read` / `content.read` / `content.write`：读取源媒体字节、写回压缩结果
- `file.import`：转换产物导入为新资产
- `data.files`：插件工作目录（任务请求与临时文件）
- `job.manage`：批量任务的入队与进度上报
- 其余为面板与通知所需的最小权限
