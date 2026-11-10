@echo off
rem Iniciador portable de My Mind.
setlocal
set "NODE_OPTIONS="
set "MIND_NODE=%~dp0Componentes\Node\win32-x64\node.exe"
if not exist "%MIND_NODE%" set "MIND_NODE=%~dp0Actualizaciones\Trabajo\actual\recuperador\Node\node.exe"
"%MIND_NODE%" "%~dp0arranque.cjs" %* & exit /b
