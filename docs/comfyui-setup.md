# ComfyUI 本地生图环境（模型下载与参数参考）

> 更新日期：2026-06-16。本文件记录本项目所用的 ComfyUI 环境、模型清单与下载方法，换机器时可照此复现相同的生图能力。
> ComfyUI 便携包与模型体积较大，已通过 `.gitignore` 排除（`/ComfyUI_windows_portable/`），**不入库**，需在每台机器上按本文重新下载。

## 0. 前置条件

- **NVIDIA GPU**，显存建议 ≥ 8GB（本项目开发机：RTX 3090 / 24GB）
- 驱动较新即可（开发机驱动 596.49）
- 磁盘空间 ≥ 30GB（便携包 ~5GB 解压后 + 三个模型 ~17GB + IP-Adapter 依赖 ~3GB）
- Windows + 可用的 `curl`（系统自带）与 `tar`（bsdtar，系统自带，可解压 `.7z`）
- 国内网络：HuggingFace 主站可能不通，**下方所有模型链接已改用镜像 `hf-mirror.com`**

## 1. 目录约定

所有内容放在仓库根目录下的 `ComfyUI_windows_portable/`：

```
<仓库根>/
└── ComfyUI_windows_portable/        ← 已在 .gitignore 中排除
    ├── run_nvidia_gpu.bat           ← 启动入口（双击）
    └── ComfyUI/
        ├── custom_nodes/
        │   └── ComfyUI_IPAdapter_plus/   ← IP-Adapter 扩展（git clone）
        └── models/
            ├── checkpoints/         ← 主模型（生图底模）
            ├── clip_vision/         ← IP-Adapter 依赖的视觉编码器
            └── ipadapter/           ← IP-Adapter 权重
```

## 2. 下载 ComfyUI 便携包

官方 Release（NVIDIA 版，自带 Python + CUDA 运行库，无需额外配环境）：

```bash
# 下载（约 1.9GB）
curl -L -o ComfyUI_windows_portable.7z ^
  "https://github.com/Comfy-Org/ComfyUI/releases/download/v0.24.0/ComfyUI_windows_portable_nvidia.7z"

# 解压（Windows 自带 tar 基于 libarchive，可直接解 7z）
tar -xf ComfyUI_windows_portable.7z
# 解压后可删除压缩包
del ComfyUI_windows_portable.7z
```

> 版本：v0.24.0。新版本地址见 https://github.com/comfyanonymous/ComfyUI/releases （选 `ComfyUI_windows_portable_nvidia.7z`）。驱动新时也可用 `_nvidia_cu126.7z`。

## 3. 模型清单（核心，换机复现的依据）

| 用途 | 文件名 | 目标目录 | 体积（字节） | 来源 |
|---|---|---|---|---|
| 背景（写实） | `Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors` | `models/checkpoints/` | 7,105,348,188 | RunDiffusion/Juggernaut-XL-v9 |
| 立绘（二次元） | `animagine-xl-3.1.safetensors` | `models/checkpoints/` | 6,938,325,776 | cagliostrolab/animagine-xl-3.1 |
| 立绘（通用底模，可选） | `v1-5-pruned-emaonly.safetensors` | `models/checkpoints/` | 4,265,146,304 | stable-diffusion-v1-5/stable-diffusion-v1-5 |
| IP-Adapter 权重 | `ip-adapter-plus_sdxl_vit-h.safetensors` | `models/ipadapter/` | 847,517,512 | h94/IP-Adapter（sdxl_models/，**必须用 PLUS ViT-H 版**） |
| CLIP 视觉编码器 | `CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors` | `models/clip_vision/` | 2,528,373,448 | h94/IP-Adapter（models/image_encoder/model.safetensors，**下载后改名**） |

> ⚠️ **IP-Adapter 文件名不可随意**：cubiq 的 ComfyUI_IPAdapter_plus 插件按文件名正则匹配模型类型。
> - CLIP 编码器在镜像上叫 `model.safetensors`，但插件要求文件名含 `ViT-H-14...s32B-b79K`，下载后必须改名成 `CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors`。
> - IP-Adapter **不要用** `ip-adapter_sdxl.safetensors`（标准版）：它与当前插件版本的 `ImageProjModel` 维度推断不兼容（报 `[8192,1280] vs [8192,1024]` shape mismatch）。用 **PLUS ViT-H 版**（`ip-adapter-plus_sdxl_vit-h.safetensors`），质量更高且插件走 PLUS 分支正确处理维度。

> **体积以字节为准**，下载后务必核对字节数是否与上表一致（见第 6 节校验方法）。文件名不可改。

### 3.1 下载命令（均用 hf-mirror 镜像）

```bash
cd ComfyUI_windows_portable\ComfyUI\models

:: checkpoints
curl -L -o checkpoints\Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors "https://hf-mirror.com/RunDiffusion/Juggernaut-XL-v9/resolve/main/Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors"
curl -L -o checkpoints\animagine-xl-3.1.safetensors "https://hf-mirror.com/cagliostrolab/animagine-xl-3.1/resolve/main/animagine-xl-3.1.safetensors"
curl -L -o checkpoints\v1-5-pruned-emaonly.safetensors "https://hf-mirror.com/stable-diffusion-v1-5/stable-diffusion-v1-5/resolve/main/v1-5-pruned-emaonly.safetensors"

:: IP-Adapter 依赖（先建目录；CLIP 编码器下载后必须改名成插件要求的文件名）
mkdir ipadapter clip_vision
curl -L -o ipadapter\ip-adapter-plus_sdxl_vit-h.safetensors "https://hf-mirror.com/h94/IP-Adapter/resolve/main/sdxl_models/ip-adapter-plus_sdxl_vit-h.safetensors"
curl -L -o clip_vision\CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors "https://hf-mirror.com/h94/IP-Adapter/resolve/main/models/image_encoder/model.safetensors"
```

### 3.2 大文件断点续传（推荐）

hf-mirror 的大文件（>4GB）单次下载易超时中断。用循环续传脚本，自动从断点接着下直到完整：

```powershell
# save as fetch.ps1, 改 $target / $url / $out 三处后运行
$ErrorActionPreference = 'SilentlyContinue'
$target = 6938325776                       # ← 改成目标字节数
$url    = 'https://hf-mirror.com/.../xxx.safetensors'  # ← 改成镜像直链
$out    = '...\xxx.safetensors'            # ← 改成本地输出路径
$attempt = 0
while ($true) {
    $attempt++
    $cur = if (Test-Path $out) { (Get-Item $out).Length } else { 0 }
    Write-Host "Attempt $attempt : $cur / $target ($([math]::Round($cur/$target*100,1))%)"
    if ($cur -ge $target) { Write-Host "DONE"; break }
    curl.exe -L -C - --retry 10 --retry-delay 5 --retry-all-errors `
        --connect-timeout 30 --speed-limit 51200 --speed-time 90 --max-time 480 `
        -o $out $url
    Start-Sleep -Seconds 2
}
```

> 注意：早期用批处理 `if %CURSZ% GEQ %TARGET%` 做大小判断会因超过 2³² 字节（4GB）的整数溢出而误判完成，**必须用 PowerShell 的 `[long]` 比较**。

## 4. IP-Adapter 扩展

```bash
cd ComfyUI_windows_portable\ComfyUI\custom_nodes
git clone https://github.com/cubiq/ComfyUI_IPAdapter_plus.git
```

装完模型与扩展后，**必须重启 ComfyUI**（关闭 `run_nvidia_gpu.bat` 窗口重新双击），扩展节点才会加载。

## 5. 生成参数参考（在 ComfyUI 界面 KSampler 节点设置）

### 5.1 通用（两模型共享，均为 SDXL 架构）

| 参数 | 值 |
|---|---|
| sampler_name | `dpmpp_2m` |
| scheduler | `karras` |
| steps | `30` |
| denoise（纯文生图） | `1.0` |

> 新版 ComfyUI 把"采样器"与"调度器"拆成两行：`sampler_name` 选 `dpmpp_2m`，`scheduler` 选 `karras`，二者配合使用。

### 5.2 背景（Juggernaut-XL v9）

| 参数 | 值 |
|---|---|
| Empty Latent 尺寸 | `1344 × 768`（16:9 横构图，galgame 标准背景比例） |
| cfg | `6.5`（勿超 7，否则过曝过饱和） |

正向基底（每个场景都加在最前面）：
```
masterpiece, best quality, highly detailed, anime background art, visual novel CG background, no humans, scenic,
```
负向（通用）：
```
humans, person, character, girl, boy, face, text, signature, watermark, logo, lowres, bad anatomy,
blurry, out of focus, oversaturated, photorealistic, 3d render, grainy, jpeg artifacts,
cropped, worst quality, low quality, messy lines
```
若出图偏写实（像照片），在基底中重复 `visual novel CG background` 加重权重。

### 5.3 立绘（Animagine XL 3.1）

| 参数 | 值 |
|---|---|
| Empty Latent 尺寸 | `832 × 1216`（竖构图人像）或 `1024 × 1024` |
| cfg | `7` |

正向模板（danbooru 标签式，该模型最吃这套）：
```
1girl, solo, upper body, looking at viewer, simple background, white background,
detailed eyes, beautiful detailed face, long hair, school uniform,
masterpiece, best quality, very aesthetic
```
> `masterpiece, best quality, very aesthetic` 是该模型的特殊质量触发词，建议每次都带。

### 5.4 img2img 改表情/衣着（无需 IP-Adapter）

在文生图工作流上：加 `Load Image` → `VAE Encode`（Encode 不是 Decode）→ 其 LATENT 接到 KSampler 的 `latent_image`（替换 Empty Latent Image）。`denoise` 按改动幅度调整：

| 改动 | denoise |
|---|---|
| 微调色调/细节 | 0.25–0.35 |
| 改表情 | 0.4–0.55（甜区，身份基本保持） |
| 换衣服 | 0.5–0.65 |
| 换姿势 | 0.6–0.75（易崩，慎用） |

### 5.5 IP-Adapter 角色一致性（换表情/换衣不换脸）

> 本节配置已封装成可加载的工作流文件 `comfyui/立绘-IPAdapter.json`（见 5.6 节用法），直接拖进 ComfyUI 即用。以下是节点说明，便于手动调整。

节点链（**必须用 `IPAdapterUnifiedLoader`，不要手动接 CLIP Vision Load/Encode**）：

```
Checkpoint ──MODEL──→ IPAdapterUnifiedLoader ──MODEL──→ IPAdapterAdvanced ──MODEL──→ KSampler
            └──────────IPADAPTER─┘
Load Image ──IMAGE──→ IPAdapterAdvanced
```

- `IPAdapterUnifiedLoader` 的 `preset` 选 **`PLUS (high strength)`**（对应 `ip-adapter-plus_sdxl_vit-h.safetensors`）。该加载器会自动按文件名正则找到 CLIP 编码器（`CLIP-ViT-H-14...`）和 IP-Adapter 权重，无需手动接 CLIP Vision 节点。
- `IPAdapterAdvanced` 的 `weight`：`0.7–0.8`（角色相似度权重，越高越像基础图）
- 因 IP-Adapter 锁住身份，KSampler 的 `denoise` 可放到 `0.6–0.7` 大胆改

> ⚠️ **不要用 `IPAdapterModelLoader` + `CLIPVisionLoader` + `CLIPVisionEncode` 手动拼接**：标准版 IP-Adapter（`ip-adapter_sdxl.safetensors`）在该插件版本下会报 `shape mismatch [8192,1280] vs [8192,1024]`。UnifiedLoader + PLUS 版是已验证可跑的组合。

### 5.6 工作流文件（开箱即用）

仓库 `comfyui/` 下提供两个已验证可跑的 ComfyUI 工作流，拖进 `http://127.0.0.1:8188` 的画布（或 `Ctrl+O` 加载）即可：

| 文件 | 用途 | 节点数 |
|---|---|---|
| `comfyui/立绘-文生图.json` | 纯文生图，生成全新立绘（Animagine XL 3.1，832×1216 竖构图） | 7 |
| `comfyui/立绘-IPAdapter.json` | 同角色换表情/换衣（IP-Adapter PLUS 锁身份，denoise 0.65） | 10 |

改提示词（正向 CLIP Text Encode 节点）→ 点 Queue Prompt（或 `Ctrl+Enter`）即可生成。换表情只需改正向词里的表情词（`smile`/`angry`/`pouting` 等）+ 改 KSampler 的 seed。

## 6. 校验

下载完成后核对字节数（与第 3 节表一致即完整）：

```bash
powershell -Command "Get-ChildItem -Recurse ComfyUI_windows_portable\ComfyUI\models\*.safetensors | Select-Object FullName, Length | Format-Table -AutoSize"
```

启动并验证：双击 `run_nvidia_gpu.bat`，浏览器打开 `http://127.0.0.1:8188`，在默认工作流的 Load Checkpoint 下拉里应能看到上述三个 checkpoint。
