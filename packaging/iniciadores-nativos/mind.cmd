@echo off
setlocal
set "MIND_TARGET="
set "MIND_ARCH=%PROCESSOR_ARCHITECTURE%"
if defined PROCESSOR_ARCHITEW6432 set "MIND_ARCH=%PROCESSOR_ARCHITEW6432%"
if /I "%MIND_ARCH%"=="AMD64" set "MIND_TARGET=win32-x64"
if /I "%MIND_ARCH%"=="ARM64" set "MIND_TARGET=win32-arm64"
if not defined MIND_TARGET (
  >&2 echo Esta arquitectura de Windows no es compatible con Mind.
  exit /b 1
)
set "MIND_EXE=%~dp0Componentes\Nativo\%MIND_TARGET%\mind-native.exe"
if not exist "%MIND_EXE%" (
  >&2 echo Falta el Motor nativo para %MIND_TARGET%.
  exit /b 1
)
"%MIND_EXE%" producto %*
exit /b %ERRORLEVEL%
