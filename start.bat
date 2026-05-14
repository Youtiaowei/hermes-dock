@echo off
chcp 65001 >nul
title Hermes Dock
cd /d "%~dp0"
set ELECTRON_DISABLE_GPU_CACHE=1
npx electron . --disable-gpu-cache
