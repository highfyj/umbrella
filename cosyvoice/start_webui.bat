@echo off
rem CosyVoice3 WebUI - 启动后浏览器访问 http://localhost:50000
echo Starting CosyVoice3 WebUI, please wait for model loading (1-2 min)...
echo Open http://localhost:50000 in your browser when ready.
wsl -d Ubuntu-22.04 -- bash /mnt/d/work/tts/start_webui.sh
pause
