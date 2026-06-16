@echo off
chcp 65001 >nul 2>&1
title CosyVoice 3 TTS Server (WSL)

REM ============================================================
REM  CosyVoice 3 本地 TTS 服务启动脚本（Windows 侧）
REM  通过 WSL2 调用，服务地址：http://localhost:50000
REM  编辑器 TTS 设置里 baseUrl 填 http://localhost:50000 即可
REM ============================================================

echo Starting CosyVoice 3 TTS service in WSL...
echo Service will be at http://localhost:50000 after model loads (30-60s)
echo Press Ctrl+C to stop.
echo.

wsl -d Ubuntu-22.04 -- bash /mnt/d/work/game/cosyvoice/start.sh

pause
