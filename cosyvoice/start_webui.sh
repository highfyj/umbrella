#!/bin/bash
# CosyVoice3 WebUI 启动脚本（WSL 内运行）
cd ~/CosyVoice
source venv/bin/activate
export PYTHONPATH=third_party/Matcha-TTS
python /mnt/d/work/tts/webui_cv3.py --port 50000 --model_dir /mnt/d/work/tts/pretrained_models/Fun-CosyVoice3-0.5B
