#!/bin/sh
# Doble clic en macOS: abre la consola de autorización de Mind.
case "$0" in
  */*) DIR=${0%/*} ;;
  *) DIR=. ;;
esac
DIR=$(cd -P -- "$DIR" && pwd -P) || exit 1
"$DIR/mind" autorizar
printf '\nPulsa Intro para cerrar esta ventana.'
read -r _
