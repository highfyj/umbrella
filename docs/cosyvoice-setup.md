# CosyVoice 3 本地 TTS 环境部署（WSL2）

> 更新日期：2026-06-16。本文件记录本项目所用的 CosyVoice 3 本地 TTS 服务部署方法。
> **架构：CosyVoice 3 跑在 WSL2 内（venv 隔离），Windows 侧通过 `wsl` 命令调起。** 这是 Windows 上最省心的部署方式——避开 pynini/ffmpeg/torchcodec 等 Windows 原生坑。
> **已实测验证**：模型加载（GPU 加速）+ TTS 生成 + HTTP 接口全部跑通。
> WSL 环境 + 模型已通过 `.gitignore` 排除（`/cosyvoice/`），**不入库**。

## 0. 为什么用 WSL2（不用 Windows 原生）

CosyVoice 依赖链（pynini/OpenFST、ffmpeg、torchcodec）在 **Windows 原生**上全是坑（需 conda 预编译 pynini、torchaudio 2.4 强制 torchcodec、numpy 2.x 冲突、hyperpyyaml 贪婪 import 等，实测踩了 7-8 个坑）。

**WSL2 的优势**：
- pynini 在 Linux 是 pip 原生包，**直接装无障碍**
- ffmpeg `apt install` 一条命令
- torch CUDA 版 pip 直装，**GPU 直通**（RTX 3090 完整可用）
- 整体踩坑数 ≈ 0

代价：需要在 WSL 里建 venv（不污染系统 python）+ 处理 Windows/WSL 路径映射。

## 1. 前置条件

- **WSL2 + Ubuntu**（本项目用 Ubuntu-22.04）。检查：`wsl -l -v`
- WSL 内 GPU 直通：WSL2 默认支持 NVIDIA CUDA。检查（WSL 内）：`nvidia-smi`
- 磁盘空间：仓库 clone ~200MB + venv ~6GB + 模型 ~8GB
- `git lfs`（下模型用）

## 2. 目录约定

```
Windows 侧:
D:\work\game\cosyvoice\                    ← 服务目录（gitignore，不入库）
├── server.py                              ← FastAPI 服务（入库，v3 适配）
├── start.bat                              ← Windows 启动入口（入库）
├── start.sh                               ← WSL 内启动脚本（入库）
├── pretrained_models\
│   └── Fun-CosyVoice3-0.5B\              ← 模型（~8GB，gitignore）
└── (webui_cv3.py, test_cosyvoice3.py)     ← 可选的 WebUI/测试脚本

WSL 侧:
~/CosyVoice/                               ← 官方仓库 clone（含推理引擎）
├── venv/                                  ← 独立虚拟环境（不污染系统 python）
├── third_party/Matcha-TTS/               ← 子模块（flow 依赖）
└── pretrained_models -> /mnt/d/work/game/cosyvoice/pretrained_models  ← 软链接
```

> 跨边界：Windows `D:\work\game\cosyvoice` = WSL `/mnt/d/work/game/cosyvoice`。模型放 Windows 侧（便于备份/移动），WSL 通过软链接访问。

## 3. 部署步骤（换机复现，PowerShell 调用 WSL）

以下命令在 **Windows PowerShell** 里执行（通过 `wsl` 调用 WSL）。设：
```powershell
$WSL = "wsl -d Ubuntu-22.04 -- bash -lc"
```

### 3.1 WSL 内装系统依赖

```powershell
# 系统级依赖（apt，仅装一次）
& $WSL "sudo apt update && sudo apt install -y python3.10 python3.10-venv git ffmpeg"
```

> ffmpeg 是 torchaudio 的后端依赖；Linux 上 `apt` 一条命令搞定（Windows 原生要手动找 dll）。

### 3.2 Clone 官方仓库 + Matcha-TTS 子模块

```powershell
& $WSL "cd ~ && git clone --depth 1 https://github.com/FunAudioLLM/CosyVoice.git && cd CosyVoice && git clone --depth 1 https://ghproxy.net/https://github.com/shivammehta25/Matcha-TTS.git third_party/Matcha-TTS"
```

> Matcha-TTS 子模块用 ghproxy 镜像（GitHub 直连常超时）。

### 3.3 创建 venv + 安装依赖（venv 隔离，不污染系统 python）

```powershell
& $WSL "cd ~/CosyVoice && python3.10 -m venv venv && source venv/bin/activate && pip install -U pip 'setuptools<81' wheel"
```

> `setuptools<81` 解决 openai-whisper 的 `pkg_resources` 构建问题。

```powershell
& $WSL "cd ~/CosyVoice && source venv/bin/activate && pip install --retries 10 numpy==1.26.4 torch==2.3.1 torchaudio==2.3.1"
```

> torch/torchaudio 锁定 2.3.1（不要用 2.4.0，会走 torchcodec）。Linux pip 默认拉 **CUDA 版**（GPU 可用）。

```powershell
& $WSL "cd ~/CosyVoice && source venv/bin/activate && grep -vE '^deepspeed|^tensorrt' requirements.txt > /tmp/req_infer.txt && pip install --retries 10 -r /tmp/req_infer.txt --no-build-isolation"
```

> 过滤掉 deepspeed/tensorrt（推理不需要，且安装慢/易冲突）。`--no-build-isolation` 避免 conformer 等包构建失败。

### 3.4 下载模型（ModelScope，约 8GB）

```powershell
# 在 Windows 侧建模型目录
New-Item -ItemType Directory -Force -Path D:\work\game\cosyvoice\pretrained_models

# WSL 内用 modelscope SDK 下载到 Windows 侧目录
& $WSL "python3 -m venv ~/dlvenv && source ~/dlvenv/bin/activate && pip install -q -i https://pypi.tuna.tsinghua.edu.cn/simple modelscope && modelscope download --model FunAudioLLM/Fun-CosyVoice3-0.5B-2512 --local_dir /mnt/d/work/game/cosyvoice/pretrained_models/Fun-CosyVoice3-0.5B"
```

### 3.5 建立 WSL 软链接（指向 Windows 侧模型）

```powershell
& $WSL "rm -f ~/CosyVoice/pretrained_models && ln -s /mnt/d/work/game/cosyvoice/pretrained_models ~/CosyVoice/pretrained_models"
```

> 软链接让 WSL 内的 CosyVoice 能访问 Windows 侧的模型。**移动 Windows 目录后需重建此链接。**

### 3.6 验证环境

```powershell
& $WSL "cd ~/CosyVoice && source venv/bin/activate && python -c `"import sys; sys.path.insert(0,'.'); sys.path.insert(0,'third_party/Matcha-TTS'); from cosyvoice.cli.cosyvoice import AutoModel; m=AutoModel('/mnt/d/work/game/cosyvoice/pretrained_models/Fun-CosyVoice3-0.5B'); print('LOADED', m.sample_rate)`"
```

预期输出含 `LOADED 24000`。加载时若看到 `CUDAExecutionProvider` 字样，说明 GPU 生效。

## 4. 启动与验证

### 启动服务

双击 `D:\work\game\cosyvoice\start.bat`，或 PowerShell：
```powershell
wsl -d Ubuntu-22.04 -- bash /mnt/d/work/game/cosyvoice/start.sh
```

服务监听 `http://0.0.0.0:50000`（WSL2 会转发到 Windows 的 `localhost:50000`）。首次请求加载模型 30-60s。

### 验证

1. **探活**：Windows 浏览器打开 `http://localhost:50000`，应返回 `{"status":"ok","service":"cosyvoice3",...}`
2. **生成测试**（需参考音频）：
   ```powershell
   curl.exe -X POST "http://localhost:50000/inference_zero_shot" `
     -F "tts_text=你好，这是语音测试。" `
     -F "prompt_text=希望你以后能够做的比我还好呦。" `
     -F "prompt_wav=@D:\work\game\cosyvoice\你的参考音频.wav" `
     -o output.wav
   ```
3. **编辑器对接**：编辑器 → TTS 设置 → baseUrl 填 `http://localhost:50000` → 测试连接

### 接口契约（与编辑器 vnVitePlugin.ts 对齐）

| 端点 | 方法 | 用途 | 表单字段 | 返回 |
|------|------|------|---------|------|
| `/` | GET | 探活 | — | JSON |
| `/inference_zero_shot` | POST | 音色克隆 | `tts_text`+`prompt_text`+`prompt_wav` | audio/wav |
| `/inference_instruct2` | POST | 情感/语气指令控制 | `tts_text`+`prompt_wav`+`instruct_text` | audio/wav |

返回：RIFF WAV，16-bit PCM，24000Hz。

> **注意**：CosyVoice3 无内置预设音色（`list_available_spks()` 返回空），`inference_sft` 不可用，只能用 zero_shot 克隆 + instruct2 指令控制。

## 5. 已知限制

- **首次请求慢**：模型懒加载（~2GB 权重 + onnxruntime 初始化），首次 30-60s。
- **必须提供参考音频**：CosyVoice3 是纯克隆模型，3 秒以上清晰人声即可。galgame 用法：为每个角色录一句参考音频，存到 `production.tts.sample` 指向的路径。
- **prompt_text 的 system prefix**：CosyVoice3 的 zero_shot 要求 prompt_text 带 `You are a helpful assistant.<|endofprompt|>` 前缀，server.py 已自动补全（`ensure_system_prefix`），编辑器侧传入普通文本即可。
- **WSL 网络转发**：WSL2 的 `0.0.0.0:50000` 会自动映射到 Windows `localhost:50000`。若访问不通，检查 WSL 网络（`wsl --shutdown` 后重启通常能修复）。
- **移动目录需重建软链接**：`~/CosyVoice/pretrained_models` 是软链接指向 Windows 侧，若移动 `cosyvoice` 目录，需按 3.5 重建。
- **换机需重配**：WSL 环境 + 模型不入库，每台机器按本文重装。编辑器 TTS 设置存浏览器 localStorage，换机器也要重配。
```
