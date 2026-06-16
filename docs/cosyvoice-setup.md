# CosyVoice 3 本地 TTS 环境部署（Windows 原生 Conda，RTX 50 系）

> 更新日期：2026-06-16。本文件记录本项目实际使用的 CosyVoice 3 本地 TTS 服务部署方法，换机器时可照此复现相同的 TTS 能力。
> **架构：CosyVoice 3 跑在 Windows 原生 Conda 环境里（无需 WSL），由 `tts-server.ps1` 一键自动安装并启动。**
> **已实测验证（RTX 5080）**：模型加载（torch 2.7.1+cu128 原生支持 sm_120）+ TTS 生成（rtf≈0.75，快于实时）+ HTTP 接口全部跑通。
> TTS 环境与模型体积大，已通过 `.gitignore` 排除（`/tts-local/`），**不入库**；部署脚本 `tts-server.ps1`（仓库根目录）入库，换机运行即可复现。

## 0. 为什么是这套方案（而不是 WSL / 文档旧版）

历史上有过一版 WSL2 + venv + `torch==2.3.1` 的方案，但它在 **RTX 50 系（Blackwell, sm_120）上不可用**：`torch 2.3.1` 的 CUDA 构建不包含 sm_120 的 kernel，加载会报 `no kernel image is available` 或静默回落 CPU。本版改用：

- **Windows 原生 Conda**（非 WSL）：`tts-server.ps1` 自动下载 Miniforge 装到 `tts-local\conda`，不写注册表、不进 PATH，删目录即彻底卸载。用 Conda 是因为 **pynini 在 Windows 上没有 pip 轮子，只有 conda-forge 有包**（pynini 是中文文本正则化 WeTextProcessing 的依赖）。
- **`torch 2.7.1+cu128`**：RTX 50 系（Blackwell, sm_120）需要 PyTorch ≥ 2.7 的 cu128 构建才原生支持，故不用 CosyVoice 官方 `requirements.txt` 里钉死的旧版 torch，单独安装。
- **CosyVoice 3**（`Fun-CosyVoice3-0.5B-2512`）：质量与情感/语种控制优于 v2；v2（`CosyVoice2-0.5B`）仍作为兜底保留，`-ModelVersion v2` 一键切回。

## 1. 前置条件

- **NVIDIA GPU**，Blackwell 架构（RTX 50 系，sm_120）或更早（本机：RTX 5080 / 16GB）。非 50 系也兼容，只要驱动支持 CUDA 12.8。
- **驱动较新**（本机驱动 596.49，`nvidia-smi` 报告 CUDA 13.2 可用）。
- **磁盘空间 ≥ 25GB**（Miniforge ~0.6GB + env ~6.6GB + v3 模型 ~9GB + v2 模型 ~5GB + 缓存 ~3.8GB）。
- **联网**：首次安装需访问 GitHub（Miniforge 安装器）、PyPI（pip 包）、PyTorch 官方索引（cu128 wheel）、ModelScope（模型）。国内网络均可直连；ModelScope 为阿里云 CDN，速度快。
- 无需预装 Python/conda：脚本会自动下载 Miniforge。

## 2. 目录约定

所有内容放在仓库根目录下的 `tts-local/`（已 gitignore）：

```
<仓库根>/
├── tts-server.ps1                    ← 部署+启动脚本（入库，核心）
└── tts-local/                        ← 运行时自动生成（gitignore，不入库）
    ├── conda/                        ← Miniforge（不写注册表/PATH）
    ├── env/                          ← Conda 环境（python 3.10 + 全部依赖）
    ├── CosyVoice/                    ← 官方仓库 clone（含推理引擎 + Matcha-TTS 子模块）
    ├── models/
    │   ├── Fun-CosyVoice3-0.5B/      ← v3 模型（~9GB，默认）
    │   └── CosyVoice2-0.5B/          ← v2 模型（~5GB，兜底）
    ├── cache/                        ← pip/conda/modelscope 缓存 + 上传音频临时落盘
    ├── .steps/                       ← 各安装步骤完成标记（.done 文件，用于跳过重装）
    └── server.py                     ← FastAPI 服务（每次启动由 tts-server.ps1 重写）
```

## 3. 一键部署（换机复现）

```powershell
# 在仓库根目录运行（首次会自动下载安装一切，约 25GB，耗时取决于网速）
.\tts-server.ps1
```

默认拉 v3 模型并监听 `http://localhost:50000`。装完后再次运行会跳过所有安装步骤、直接起服务。常用参数：

```powershell
.\tts-server.ps1 -Port 50001           # 换端口
.\tts-server.ps1 -ModelVersion v2      # 用 v2 模型（兜底/对比）
.\tts-server.ps1 -Reinstall            # 强制重走所有安装步骤
```

停止：`Ctrl+C`。

### 3.1 脚本内部安装步骤（幂等，可中断重跑）

`tts-server.ps1` 用 `.steps/*.done` 标记记录进度，每步完成后写标记，重跑时已完成的步骤自动跳过：

1. **miniforge** — 下载并静默安装 Miniforge 到 `tts-local\conda`（`/AddToPath=0 /RegisterPython=0`，不污染系统）。
2. **python-env** — `conda create -p tts-local\env python=3.10`，再 `conda install -c conda-forge pynini=2.1.5`（pynini 只有 conda-forge 有 Windows 包）。
3. **clone-cosyvoice** — `git clone --recursive --depth 1 --shallow-submodules` 官方仓库（含 Matcha-TTS 子模块）。
4. **pip-deps** — 先 `pip install torch==2.7.1 torchaudio==2.7.1 --index-url .../cu128`（50 系必需），再装过滤后的官方 requirements（剔除 deepspeed/tensorrt/triton/gradio 等训练/Linux 专用包），最后补 `python-multipart`（FastAPI 表单上传）与 `onnxruntime`（speech tokenizer，CPU 版即可）。
5. **download-model** — 用 modelscope SDK 下载 `FunAudioLLM/Fun-CosyVoice3-0.5B-2512`（v3，默认）或 `iic/CosyVoice2-0.5B`（v2）到 `tts-local\models\`。

> `setuptools<81` 通过 `PIP_CONSTRAINT` 全局约束（含构建隔离环境），解决 openai-whisper 等 sdist 的 `pkg_resources` 构建问题。

### 3.2 关键依赖版本（实测可用）

| 依赖 | 版本 | 说明 |
|---|---|---|
| `torch` / `torchaudio` | `2.7.1+cu128` | RTX 50 系（sm_120）必需 cu128 构建 |
| `numpy` | `1.26.4` | 避开 numpy 2.x 与部分包的 ABI 冲突 |
| `onnxruntime` | `1.23.2` | speech tokenizer，CPU 版（无需 CUDA EP） |
| `python-multipart` | `0.0.32` | FastAPI `Form()`/`UploadFile` 上传参考音频 |
| `modelscope` | `1.20.0` | 模型下载 SDK |
| `pynini` | `2.1.5` | conda-forge 安装；WeTextProcessing 的中文正则化依赖 |

## 4. 服务端实现要点（踩坑记录）

`tts-local\server.py` 由 `tts-server.ps1` 每次启动时从内嵌模板重写，实现与官方 fastapi server 兼容的 HTTP 接口。其中几处与 CosyVoice3 / Windows 相关的关键设计：

- **模型加载用 `AutoModel`**：按模型目录里的 yaml 文件名（`cosyvoice3.yaml` / `cosyvoice2.yaml` / `cosyvoice.yaml`）自动选版本，无需在代码里硬编码 v2/v3 类，指向哪个模型目录就加载哪个版本。
- **prompt_wav 传「文件路径」而非 tensor**：CosyVoice3 的 `frontend.frontend_zero_shot` 内部会对参考音频重复调用 `load_wav`（分别按 24kHz/16kHz 重采样），**期望收到文件路径**；若像旧版那样先 `load_wav` 成 tensor 再传入，会报 `TypeError: Invalid file: tensor(...)`。故服务端把上传的 wav 落盘到 `tts-local\cache\uploads\` 后传路径。
- **system prefix 自动补全**：CosyVoice3 的 LLM **强制要求** `prompt_text`/`instruct_text` 带 `You are a helpful assistant.<|endofprompt|>` 前缀，否则断言失败（`<|endofprompt|> not detected`）。服务端 `ensure_system_prefix()` 自动补全，调用方传普通文本即可。
- **临时文件在生成器消费完后再删**：`StreamingResponse` 的 body 是惰性生成器，**不能在 handler 函数 return 时用 `try/finally` 删 prompt 文件**——那样会在生成器真正读取前就把文件删掉，导致 `libsndfile "System error"`。清理逻辑放在生成器内部，流式响应结束后才执行。
- **返回 raw PCM**：16-bit 单声道 PCM，24kHz，与官方 fastapi server 响应格式一致（非 RIFF WAV，纯 PCM）。

## 5. 启动与验证

### 启动

```powershell
.\tts-server.ps1
```

首次请求触发模型懒加载（~10s）。服务监听 `http://127.0.0.1:50000`。

### 验证

1. **探活**：
   ```powershell
   curl http://127.0.0.1:50000/
   # {"ok":true,"service":"cosyvoice","sample_rate":24000}
   ```
2. **生成测试**（zero_shot 音色克隆，需参考音频）：
   ```powershell
   curl -X POST "http://127.0.0.1:50000/inference_zero_shot" ^
     -F "tts_text=你好，这是语音测试。" ^
     -F "prompt_text=希望你以后能够做的比我还好呦。" ^
     -F "prompt_wav=@tts-local\CosyVoice\asset\zero_shot_prompt.wav" ^
     -o output.pcm
   ```
   返回 raw PCM（24kHz 16-bit mono）。转成可播放 wav：
   ```powershell
   # PowerShell：把 PCM 包装成 RIFF WAV（24kHz/mono/16bit）
   $pcm = [IO.File]::ReadAllBytes('output.pcm')
   $w = New-Object IO.BinaryWriter([IO.File]::Create('output.wav'))
   $w.Write([Text.Encoding]::ASCII.GetBytes('RIFF')); $w.Write(36+$pcm.Length)
   $w.Write([Text.Encoding]::ASCII.GetBytes('WAVEfmt ')); $w.Write(16)
   $w.Write([Int16]1); $w.Write([Int16]1); $w.Write(24000); $w.Write(48000)
   $w.Write([Int16]2); $w.Write([Int16]16)
   $w.Write([Text.Encoding]::ASCII.GetBytes('data')); $w.Write($pcm.Length); $w.Write($pcm); $w.Close()
   ```
3. **编辑器对接**：编辑器 → TTS 设置 → baseUrl 填 `http://localhost:50000` → 测试连接。

### 接口契约（与编辑器 vnVitePlugin.ts 对齐）

| 端点 | 方法 | 用途 | 表单字段 | 返回 |
|------|------|------|---------|------|
| `/` | GET | 探活 | — | JSON |
| `/inference_zero_shot` | POST | 音色克隆 | `tts_text`+`prompt_text`+`prompt_wav`[+`speed`] | raw PCM |
| `/inference_instruct2` | POST | 情感/语气指令控制 | `tts_text`+`instruct_text`+`prompt_wav`[+`speed`] | raw PCM |

返回：raw 16-bit mono PCM，24000Hz（**非 WAV**，纯 PCM；编辑器侧按 PCM 解析）。

> **注意**：CosyVoice3 无内置预设音色，`inference_sft` 端点不可用，只能 zero_shot 克隆 + instruct2 指令控制。`speed` 可选，默认 1.0。

## 6. 已知限制

- **必须提供参考音频**：CosyVoice3 是纯克隆模型，3 秒以上清晰人声即可。galgame 用法：为每个角色录一句参考音频，存到 `production.tts.sample` 指向的路径。
- **首次请求较慢**：模型懒加载 + onnxruntime 初始化，首请求 ~10s；后续请求 rtf≈0.75（5080）。
- **`onnxruntime` 走 CPU**：日志里 `CUDAExecutionProvider is not in available provider names` 是**正常**的——只有 speech tokenizer（小模型）用 onnxruntime，CPU 足够；主推理（llm/flow）走 torch GPU，不受影响。
- **换机需重装**：`tts-local/` 不入库，每台机器运行 `tts-server.ps1` 重装。
- **彻底卸载**：停止服务后删除 `tts-local/` 整个目录即可（conda 装在该目录内，不污染系统）。
