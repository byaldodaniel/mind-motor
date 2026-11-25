#!/bin/sh
set -eu

cd "$(dirname "$0")"
case "${1-}" in
    --pruebas)
        cargo test --locked --release --target-dir target
        exit
        ;;
    '') ;;
    *) printf 'Uso: sh programa/build.sh [--pruebas]\n' >&2; exit 2 ;;
esac

# Esta compilación se ejecuta en el sistema de destino.
cargo build --locked --release --target-dir target
mkdir -p '../My Mind/Sistema'
install -m 755 target/release/mind '../My Mind/Sistema/mind'
