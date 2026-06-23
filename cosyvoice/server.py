"""
CosyVoice 3 本地 TTS 服务（WSL 内运行的 FastAPI）
=====================================================
运行位置：WSL Ubuntu-22.04 内，由 Windows 侧 start.bat 调起。
对外暴露编辑器（vnVitePlugin.ts）期望的接口契约：
  - GET  /                         → 探活
  - POST /inference_zero_shot      → 零样本音色克隆
  - POST /inference_instruct2      → 自然语言指令控制（情感/语气/方言）

请求：multipart/form-data
  tts_text       （必需）要合成的文本
  prompt_text    （zero_shot）参考音频的文本转写
  prompt_wav     （参考音频文件）
  instruct_text  （instruct）指令文本，如「请用开心的语气说」
  speed          （可选）语速

返回：audio/wav（RIFF），16-bit PCM，24000Hz

启动（WSL 内）：
  python /mnt/d/work/game/cosyvoice/server.py
  --model_dir /mnt/d/work/game/cosyvoice/pretrained_models/Fun-CosyVoice3-0.5B
"""

from __future__ import annotations

import argparse
import io
import logging
import tempfile
import time
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse, Response
import numpy as np

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("cosyvoice-server")

# CosyVoice 官方仓库路径（WSL 内）
REPO_DIR = "/home/fuyujia/CosyVoice"
import sys
for _p in (f"{REPO_DIR}/third_party/Matcha-TTS", REPO_DIR):
    if _p not in sys.path:
        sys.path.insert(0, _p)

# CosyVoice3 的 prompt_text 需要带 system prefix（见 webui_cv3.py 的 ensure_system_prefix）
SYSTEM_PREFIX = "You are a helpful assistant.<|endofprompt|>"


def ensure_system_prefix(text: str) -> str:
    if "<|endofprompt|>" not in text:
        return SYSTEM_PREFIX + text
    return text


# ---------------------------------------------------------------------------
# 模型懒加载
# ---------------------------------------------------------------------------
_cosyvoice = None
_model_dir: str = ""


def get_model():
    global _cosyvoice
    if _cosyvoice is not None:
        return _cosyvoice
    log.info("首次请求，正在加载 CosyVoice3 模型（约 30-60s）……")
    t0 = time.time()
    from cosyvoice.cli.cosyvoice import AutoModel
    _cosyvoice = AutoModel(model_dir=_model_dir)
    log.info("模型加载完成，耗时 %.1fs", time.time() - t0)
    return _cosyvoice


# ---------------------------------------------------------------------------
# 音频工具：torch tensor(1,T) → WAV bytes
# ---------------------------------------------------------------------------
def tensor_to_pcm(audio_tensor) -> bytes:
    """模型输出的 torch tensor → 16-bit PCM bytes"""
    import torch
    if hasattr(audio_tensor, "cpu"):
        audio_tensor = audio_tensor.cpu()
    arr = np.asarray(audio_tensor, dtype=np.float32)
    if arr.ndim > 1:
        arr = arr.reshape(-1)
    arr = np.clip(arr, -1.0, 1.0)
    return (arr * 32767).astype(np.int16).tobytes()


def wrap_pcm_wav(pcm: bytes, sample_rate: int) -> bytes:
    """裸 PCM → 标准 RIFF WAV"""
    import struct
    data_len = len(pcm)
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF", 36 + data_len, b"WAVE",
        b"fmt ", 16, 1, 1, sample_rate,
        sample_rate * 2, 2, 16,
        b"data", data_len,
    )
    return header + pcm


# ---------------------------------------------------------------------------
# FastAPI
# ---------------------------------------------------------------------------
app = FastAPI(title="CosyVoice3 TTS", version="1.0")


@app.get("/")
def root():
    """探活端点"""
    return {"status": "ok", "service": "cosyvoice3", "model": _model_dir,
            "spks": _cosyvoice.list_available_spks() if _cosyvoice else []}


@app.post("/register_spk")
async def register_spk(
    spk_id: str = Form(...),
    prompt_wav: UploadFile = File(...),
    prompt_text: str = Form(""),
    mode: str = Form("zero_shot"),  # zero_shot | instruct
):
    """预提取并缓存说话人特征，之后用 zero_shot_spk_id 复用，跳过 prompt 重复处理。

    mode=instruct 时，prompt_text 当作 instruct 指令（套 instruct 的 system 格式）。
    """
    if not spk_id.strip():
        return JSONResponse({"error": "spk_id 不能为空"}, status_code=400)
    audio_bytes = await prompt_wav.read()
    if not audio_bytes:
        return JSONResponse({"error": "prompt_wav 为空"}, status_code=400)

    model = get_model()
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
        tf.write(audio_bytes)
        prompt_path = tf.name
    try:
        if mode == "instruct":
            ptext = prompt_text if prompt_text.endswith("<|endofprompt|>") else \
                "You are a helpful assistant. " + prompt_text + "<|endofprompt|>"
        else:
            ptext = ensure_system_prefix(prompt_text)
        model.add_zero_shot_spk(ptext, prompt_path, spk_id)
    finally:
        Path(prompt_path).unlink(missing_ok=True)
    log.info("已注册音色 spk_id=%s mode=%s", spk_id, mode)
    return {"status": "ok", "spk_id": spk_id, "mode": mode,
            "spks": model.list_available_spks()}


@app.post("/inference_zero_shot")
async def inference_zero_shot(
    tts_text: str = Form(...),
    prompt_text: str = Form(""),
    prompt_wav: Optional[UploadFile] = File(None),
    zero_shot_spk_id: str = Form(""),
    speed: float = Form(1.0),
):
    """零样本音色克隆。传 zero_shot_spk_id 则复用已注册音色（跳过 prompt 处理，更快）。"""
    if not tts_text.strip():
        return JSONResponse({"error": "tts_text 不能为空"}, status_code=400)

    model = get_model()

    if zero_shot_spk_id:
        if zero_shot_spk_id not in model.list_available_spks():
            return JSONResponse({"error": f"未注册的 spk_id: {zero_shot_spk_id}"}, status_code=400)
        chunks = list(model.inference_zero_shot(
            tts_text, "", "", zero_shot_spk_id=zero_shot_spk_id, stream=False, speed=speed))
        pcm = b"".join(tensor_to_pcm(c["tts_speech"]) for c in chunks)
        sr = getattr(model, "sample_rate", 24000)
        return Response(content=wrap_pcm_wav(pcm, sr), media_type="audio/wav")

    if not prompt_text.strip():
        return JSONResponse({"error": "zero_shot 需要 prompt_text（参考音频的文字转写）"}, status_code=400)
    if prompt_wav is None:
        return JSONResponse({"error": "需要 prompt_wav 或 zero_shot_spk_id"}, status_code=400)
    audio_bytes = await prompt_wav.read()
    if not audio_bytes:
        return JSONResponse({"error": "prompt_wav 为空"}, status_code=400)

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
        tf.write(audio_bytes)
        prompt_path = tf.name
    try:
        # CosyVoice3 的 prompt_text 需要 system prefix
        chunks = list(model.inference_zero_shot(
            tts_text, ensure_system_prefix(prompt_text), prompt_path, stream=False, speed=speed
        ))
        pcm = b"".join(tensor_to_pcm(c["tts_speech"]) for c in chunks)
    finally:
        Path(prompt_path).unlink(missing_ok=True)

    sr = getattr(model, "sample_rate", 24000)
    return Response(content=wrap_pcm_wav(pcm, sr), media_type="audio/wav")


@app.post("/inference_instruct2")
async def inference_instruct2(
    tts_text: str = Form(...),
    prompt_wav: Optional[UploadFile] = File(None),
    instruct_text: str = Form(""),
    zero_shot_spk_id: str = Form(""),
    speed: float = Form(1.0),
):
    """自然语言指令控制。传 zero_shot_spk_id 则复用已注册音色（含其注册时的 instruct）。"""
    if not tts_text.strip():
        return JSONResponse({"error": "tts_text 不能为空"}, status_code=400)

    model = get_model()

    if zero_shot_spk_id:
        if zero_shot_spk_id not in model.list_available_spks():
            return JSONResponse({"error": f"未注册的 spk_id: {zero_shot_spk_id}"}, status_code=400)
        chunks = list(model.inference_instruct2(
            tts_text, "", "", zero_shot_spk_id=zero_shot_spk_id, stream=False, speed=speed))
        pcm = b"".join(tensor_to_pcm(c["tts_speech"]) for c in chunks)
        sr = getattr(model, "sample_rate", 24000)
        return Response(content=wrap_pcm_wav(pcm, sr), media_type="audio/wav")

    if prompt_wav is None:
        return JSONResponse({"error": "需要 prompt_wav 或 zero_shot_spk_id"}, status_code=400)
    audio_bytes = await prompt_wav.read()
    if not audio_bytes:
        return JSONResponse({"error": "prompt_wav 为空"}, status_code=400)

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
        tf.write(audio_bytes)
        prompt_path = tf.name
    try:
        # instruct_text 补全 system prefix
        full_instruct = instruct_text if instruct_text.endswith("<|endofprompt|>") else \
            "You are a helpful assistant. " + instruct_text + "<|endofprompt|>"
        chunks = list(model.inference_instruct2(
            tts_text, full_instruct, prompt_path, stream=False, speed=speed
        ))
        pcm = b"".join(tensor_to_pcm(c["tts_speech"]) for c in chunks)
    finally:
        Path(prompt_path).unlink(missing_ok=True)

    sr = getattr(model, "sample_rate", 24000)
    return Response(content=wrap_pcm_wav(pcm, sr), media_type="audio/wav")


# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn

    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=50000)
    parser.add_argument("--host", type=str, default="0.0.0.0")  # 0.0.0.0 让 Windows 侧能访问
    parser.add_argument("--model_dir", type=str,
                        default="/mnt/d/work/game/cosyvoice/pretrained_models/Fun-CosyVoice3-0.5B")
    args = parser.parse_args()
    _model_dir = args.model_dir

    log.info("CosyVoice3 服务启动：http://%s:%d  模型：%s", args.host, args.port, _model_dir)
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")
