#!/bin/sh
set -eu
DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
"$DIR/mind" preparar
printf '\n%s\n' 'Mind quedó conectado. Abre una conversación nueva en tu agente.'
