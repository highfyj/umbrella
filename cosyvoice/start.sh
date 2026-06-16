#!/bin/bash
# CosyVoice3 TTS 服务启动脚本（WSL 内运行）
# 激活独立 venv（不污染系统 python），加载 CosyVoice 推理引擎，启动 FastAPI 服务。
set -e
cd ~/CosyVoice
source venv/bin/activate
export PYTHONPATH="$HOME/CosyVoice/third_party/Matcha-TTS"

MODEL_DIR="/mnt/d/work/game/cosyvoice/pretrained_models/Fun-CosyVoice3-0.5B"

echo "============================================"
echo "  CosyVoice 3 TTS 服务"
echo "  venv : $VIRTUAL_ENV"
echo "  模型 : $MODEL_DIR"
echo "  地址 : http://0.0.0.0:50000"
echo "  首次请求会加载模型（约 30-60s）"
echo "============================================"

python /mnt/d/work/game/cosyvoice/server.py \
  --host 0.0.0.0 --port 50000 \
  --model_dir "$MODEL_DIR"
