@echo off
setlocal
call "%~dp0mind.cmd" preparar
if errorlevel 1 (
  echo.
  echo Mind no pudo conectar todos los agentes. Revisa el mensaje anterior.
) else (
  echo.
  echo Mind quedo conectado. Abre una conversacion nueva en tu agente.
)
pause
