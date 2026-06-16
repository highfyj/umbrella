# CosyVoice 本地 TTS 服务：首次运行自动安装（全部装进 tts-local/，已 gitignore），之后直接启动。
# 用法：
#   .\tts-server.ps1              # 安装（仅首次）并启动服务，默认端口 50000（编辑器 TTS 设置的默认地址）
#   .\tts-server.ps1 -Port 50001  # 换端口
#   .\tts-server.ps1 -Reinstall   # 强制重走所有安装步骤
# 停止：Ctrl+C。
#
# 说明：
# - 本机无 Python/conda 也能跑：脚本自动下载 Miniforge 装到 tts-local\conda（不写注册表、不进 PATH）。
# - pynini 在 Windows 上没有 pip 轮子，必须走 conda-forge，这是用 conda 而不是 venv 的原因。
# - RTX 50 系（Blackwell, sm_120）需要 PyTorch >= 2.7 的 cu128 构建，所以不用 CosyVoice 官方
#   requirements 里钉死的旧版 torch，单独安装。
# - 模型默认用 CosyVoice3-0.5B（Fun-CosyVoice3-0.5B-2512，ModelScope 下载，约 8GB，质量/情感控制优于 v2）；
#   v2（CosyVoice2-0.5B，约 5GB）仍保留为兜底，用 -ModelVersion v2 切回。

param(
  [int]$Port = 50000,
  [ValidateSet('v3','v2')][string]$ModelVersion = 'v3',
  [switch]$Reinstall
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root     = Split-Path -Parent $MyInvocation.MyCommand.Path
$Tts      = Join-Path $Root 'tts-local'
$CondaDir = Join-Path $Tts 'conda'
$EnvDir   = Join-Path $Tts 'env'
$RepoDir  = Join-Path $Tts 'CosyVoice'
$ModelDir = if ($ModelVersion -eq 'v3') {
  Join-Path $Tts 'models\Fun-CosyVoice3-0.5B'
} else {
  Join-Path $Tts 'models\CosyVoice2-0.5B'
}
$CacheDir = Join-Path $Tts 'cache'
$StepsDir = Join-Path $Tts '.steps'
$Conda    = Join-Path $CondaDir 'Scripts\conda.exe'
$Py       = Join-Path $EnvDir 'python.exe'

# 缓存全部留在 tts-local 内，不污染用户目录
$env:CONDA_PKGS_DIRS  = Join-Path $CacheDir 'conda-pkgs'
$env:PIP_CACHE_DIR    = Join-Path $CacheDir 'pip'
$env:MODELSCOPE_CACHE = Join-Path $CacheDir 'modelscope'
$env:HF_HOME          = Join-Path $CacheDir 'hf'

New-Item -ItemType Directory -Force $Tts, $CacheDir, $StepsDir | Out-Null

function Exec([string]$desc, [scriptblock]$cmd) {
  & $cmd
  if ($LASTEXITCODE -ne 0) { throw "$desc 失败（退出码 $LASTEXITCODE）" }
}

function Step([string]$name, [scriptblock]$body) {
  $marker = Join-Path $StepsDir "$name.done"
  if ((Test-Path $marker) -and -not $Reinstall) { Write-Host "[跳过] $name" -ForegroundColor DarkGray; return }
  Write-Host "==> $name" -ForegroundColor Cyan
  & $body
  New-Item -ItemType File -Force $marker | Out-Null
}

Step 'miniforge' {
  if (-not (Test-Path $Conda)) {
    $installer = Join-Path $CacheDir 'Miniforge3-Windows-x86_64.exe'
    if (-not (Test-Path $installer)) {
      Write-Host '    下载 Miniforge 安装器...'
      Invoke-WebRequest -UseBasicParsing -OutFile $installer `
        -Uri 'https://github.com/conda-forge/miniforge/releases/latest/download/Miniforge3-Windows-x86_64.exe'
    }
    Write-Host '    静默安装 Miniforge（仅本目录，不写 PATH/注册表）...'
    Start-Process -Wait -FilePath $installer -ArgumentList `
      '/InstallationType=JustMe', '/RegisterPython=0', '/AddToPath=0', '/S', "/D=$CondaDir"
    if (-not (Test-Path $Conda)) { throw 'Miniforge 安装失败' }
  }
}

Step 'python-env' {
  Exec 'conda 创建环境' { & $Conda create -y -p $EnvDir python=3.10 }
  # pynini：WeTextProcessing（中文文本正则化）的依赖，Windows 上只有 conda-forge 有包
  Exec 'conda 安装 pynini' { & $Conda install -y -p $EnvDir -c conda-forge pynini=2.1.5 }
}

Step 'clone-cosyvoice' {
  if (Test-Path (Join-Path $RepoDir '.git')) {
    Exec '更新子模块' { git -C $RepoDir submodule update --init --recursive }
  } else {
    Exec '克隆 CosyVoice' { git clone --recursive --depth 1 --shallow-submodules `
      https://github.com/FunAudioLLM/CosyVoice.git $RepoDir }
  }
}

Step 'pip-deps' {
  # setuptools>=81 移除了 pkg_resources，openai-whisper 等老式 sdist 的 setup.py 会构建失败；
  # 通过 PIP_CONSTRAINT 把（含构建隔离环境在内的）setuptools 约束到旧版
  $constraint = Join-Path $CacheDir 'build-constraints.txt'
  'setuptools<81' | Set-Content -Encoding Ascii $constraint
  $env:PIP_CONSTRAINT = $constraint
  # 先装 torch cu128（RTX 50 系必需），再装其余依赖时 torch 已就位、不会被替换成 CPU 版
  Exec '安装 torch (cu128)' { & $Py -m pip install torch==2.7.1 torchaudio==2.7.1 `
    --index-url https://download.pytorch.org/whl/cu128 }
  # 过滤官方 requirements：torch 系已单独装；deepspeed/tensorrt/triton 是 Linux 训练/加速用，
  # Windows 装不上也不需要；onnxruntime 单独装 CPU 版（只跑小的 speech tokenizer）；gradio 是 demo UI 用不上
  $filtered = Get-Content (Join-Path $RepoDir 'requirements.txt') | Where-Object {
    $_ -notmatch '^(torch|deepspeed|onnxruntime|ttsfrd|tensorrt|triton|gradio|bitsandbytes|flash)' -and
    $_ -notmatch '^--(extra-)?index-url'
  }
  $reqFile = Join-Path $CacheDir 'requirements-filtered.txt'
  $filtered | Set-Content -Encoding Ascii $reqFile
  Exec '安装其余依赖' { & $Py -m pip install -r $reqFile }
  Exec '安装 onnxruntime' { & $Py -m pip install onnxruntime }
}

Step 'download-model' {
  if ($ModelVersion -eq 'v3') {
    Write-Host '    从 ModelScope 下载 Fun-CosyVoice3-0.5B-2512（约 8GB，可中断后重跑续传）...'
    Exec '下载模型 v3' { & $Py -c "from modelscope import snapshot_download; snapshot_download('FunAudioLLM/Fun-CosyVoice3-0.5B-2512', local_dir=r'$ModelDir')" }
  } else {
    Write-Host '    从 ModelScope 下载 CosyVoice2-0.5B（约 5GB，可中断后重跑续传）...'
    Exec '下载模型 v2' { & $Py -c "from modelscope import snapshot_download; snapshot_download('iic/CosyVoice2-0.5B', local_dir=r'$ModelDir')" }
  }
}

# 服务端脚本每次启动都重写，保证与本文件一致（API 形态与官方 fastapi server 兼容，另支持 speed 参数）
$serverPy = @'
import argparse
import logging
import os
import tempfile

import numpy as np
import uvicorn
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse

logging.basicConfig(level=logging.INFO)
app = FastAPI()
cosyvoice = None


def pcm_stream(model_output, cleanup=None):
    # raw 16-bit mono PCM, matches the official fastapi server's response format
    try:
        for chunk in model_output:
            yield (chunk['tts_speech'].numpy() * (2 ** 15)).astype(np.int16).tobytes()
    finally:
        # 生成器消费完毕后才清理临时文件——若提前删除，cosyvoice 内部的 load_wav(path) 会读到空
        if cleanup:
            try:
                os.remove(cleanup)
            except OSError:
                pass


def save_upload(upload):
    # CosyVoice3 的 frontend 内部会对 prompt_wav 重复调用 load_wav（按 24k/16k 重采样），
    # 期望收到「文件路径」而非已加载的 tensor。把上传内容落盘后返回路径。
    import uuid
    cache_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cache', 'uploads')
    os.makedirs(cache_dir, exist_ok=True)
    path = os.path.join(cache_dir, '{}.wav'.format(uuid.uuid4().hex))
    data = upload.file.read()
    with open(path, 'wb') as f:
        f.write(data)
    return path


_SYSTEM_PREFIX = 'You are a helpful assistant.<|endofprompt|>'


def ensure_system_prefix(text):
    # CosyVoice3 的 zero_shot/instruct2 要求 prompt 文本带 system prefix，否则 LLM 断言失败。
    # v1/v2 忽略该前缀也安全，所以无条件补全（已带则不重复）。
    if '<|endofprompt|>' not in text:
        return _SYSTEM_PREFIX + text
    return text


@app.get('/')
def health():
    return {'ok': True, 'service': 'cosyvoice', 'sample_rate': cosyvoice.sample_rate}


@app.post('/inference_zero_shot')
async def inference_zero_shot(tts_text: str = Form(), prompt_text: str = Form(),
                              prompt_wav: UploadFile = File(), speed: float = Form(1.0)):
    prompt_wav_path = save_upload(prompt_wav)
    out = cosyvoice.inference_zero_shot(tts_text, ensure_system_prefix(prompt_text),
                                        prompt_wav_path, stream=False, speed=speed)
    return StreamingResponse(pcm_stream(out, cleanup=prompt_wav_path))


@app.post('/inference_instruct2')
async def inference_instruct2(tts_text: str = Form(), instruct_text: str = Form(),
                              prompt_wav: UploadFile = File(), speed: float = Form(1.0)):
    prompt_wav_path = save_upload(prompt_wav)
    out = cosyvoice.inference_instruct2(tts_text, ensure_system_prefix(instruct_text),
                                        prompt_wav_path, stream=False, speed=speed)
    return StreamingResponse(pcm_stream(out, cleanup=prompt_wav_path))


@app.post('/inference_sft')
async def inference_sft(tts_text: str = Form(), spk_id: str = Form(), speed: float = Form(1.0)):
    try:
        out = cosyvoice.inference_sft(tts_text, spk_id, stream=False, speed=speed)
        return StreamingResponse(pcm_stream(out))
    except Exception as e:  # CosyVoice2 无预置音色，sft 模式不可用
        return JSONResponse(status_code=400, content={'error': str(e)})


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--model_dir', required=True)
    parser.add_argument('--port', type=int, default=50000)
    args = parser.parse_args()

    import torch
    logging.info('CUDA available: %s', torch.cuda.is_available())

    # AutoModel 按 yaml 文件名（cosyvoice3.yaml / cosyvoice2.yaml / cosyvoice.yaml）自动选对应版本
    from cosyvoice.cli.cosyvoice import AutoModel
    cosyvoice = AutoModel(model_dir=args.model_dir)

    logging.info('模型就绪，sample_rate=%d，监听 http://127.0.0.1:%d', cosyvoice.sample_rate, args.port)
    uvicorn.run(app, host='127.0.0.1', port=args.port)
'@
$serverFile = Join-Path $Tts 'server.py'
$serverPy | Set-Content -Encoding UTF8 $serverFile

$env:PYTHONPATH = "$RepoDir;$(Join-Path $RepoDir 'third_party\Matcha-TTS')"
Write-Host ''
Write-Host "==> 启动 TTS 服务 http://localhost:$Port （编辑器 → TTS 设置 → 测试连接；Ctrl+C 停止）" -ForegroundColor Green
& $Py $serverFile --model_dir $ModelDir --port $Port
