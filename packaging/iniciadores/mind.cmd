@echo off
rem Iniciador de Mind para Windows. Usa exclusivamente el Node.js incluido en Runtime\.
setlocal
set "NODE_OPTIONS="
"%~dp0Runtime\node\node.exe" "%~dp0Motor\bin\mind.js" %* & exit /b
