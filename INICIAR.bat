@echo off
chcp 65001 >nul
title IA SDR
cd /d "%~dp0"

echo.
echo   ============================================
echo     IA SDR - iniciando
echo   ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   O Node.js nao esta instalado nesta maquina.
  echo.
  echo   1. Baixe em https://nodejs.org  ^(versao LTS^)
  echo   2. Instale
  echo   3. Feche esta janela e clique aqui de novo
  echo.
  pause
  exit /b 1
)

node start.js

echo.
echo   ============================================
echo     O servidor parou.
echo     Se apareceu erro acima, copie o texto.
echo   ============================================
echo.
pause
