# Mind nativo — cimientos de Mind 1.0.5

Código de la pieza nativa que, por etapas, asumirá el Motor completo de Mind:
un solo proceso `Mind`, sin Node, Python ni ONNX, para Windows, macOS y Linux
en x64 y ARM64. Mientras dura la transición, el Motor de `src/` (r3) sigue
siendo el único escritor de la Base.

Hoy el ejecutable tiene dos modos, heredados del piloto de r3
(`Borradores/Piloto-Nativo-r3`, 16-nov-2026):

- `bridge`: puente MCP stdio ↔ Streamable HTTP hacia el Motor Central.
- `scan`: enumeración segura de un directorio por petición JSONL.

## Contenido

| Ruta | Qué es |
|---|---|
| `rust/` | Fuente vigente (Rust). `build.ps1` compila en Windows. |
| `go/` | Alternativa Go del piloto. Se conserva porque r3 distribuye binarios Go en cuatro destinos (`packaging/nativo.json`); no es la ruta de 1.0.5. |
| `contracts/r3/` | Contrato observable de r3, capturado del Motor real: `capturar.mjs` y `contrato-r3.json`. |
| `contracts/*.json`, `*.sql`, `CONTRATOS.md` | Borradores de contratos del piloto (scan, rpc, health, esquema v3). Referencia; el vigente es `contracts/r3/`. |
| `test/` | Pruebas del ejecutable contra el Motor de `src/` y prueba del contrato r3. |
| `evidence/` | Mediciones registradas. |
| `RESULTADOS.md` | Resultados del piloto (Rust frente a Go). |

## Compilar

Windows, con `cargo` en el PATH o con la toolchain portátil del piloto:

```powershell
.\nativo\rust\build.ps1
.\nativo\rust\build.ps1 -Toolchain 'D:\ruta\a\toolchain\rust'
```

Salida: `nativo/rust/target/release/mind-native-rust-pilot.exe`.
Los seis destinos se compilan en CI (`.github/workflows/nativo.yml`), cada uno
con el SDK de su sistema.

## Probar

```powershell
node --test --test-concurrency=1 nativo/test/contrato-r3.test.mjs
$env:MIND_NATIVE_EXE = (Resolve-Path .\nativo\rust\target\release\mind-native-rust-pilot.exe).Path
npm test
```

`npm test` incluye siempre el contrato r3, y las pruebas del ejecutable cuando
`MIND_NATIVE_EXE` está definido. Las Bases ficticias se crean en
`%TEMP%\mind-nativo-runs` (o `MIND_NATIVO_RUNS`), fuera del Motor: r3 rechaza
una Base dentro de su programa. Nunca usar una Base personal.

Si el contrato falla, el Motor cambió algo que la pieza nativa debe respetar.
Si el cambio es intencionado: `node nativo/contracts/r3/capturar.mjs --escribir`.

## Estado de los seis destinos

| Destino | Compilado | Ejecutado |
|---|---|---|
| win32-x64 | Sí, en este equipo y en CI | Sí, en este equipo (13/13 pruebas + contrato) |
| win32-arm64 | En CI (MSVC) | No: sin ejecutor ARM64 |
| darwin-arm64 | En CI (macos-14) | En CI |
| darwin-x64 | En CI (macos-14, cruzado) | No |
| linux-x64 | En CI (musl, rust-lld) | En CI |
| linux-arm64 | En CI (musl, rust-lld) | No: sin ejecutor ARM64 |

«En CI» significa que el flujo está preparado; su resultado se registra cuando
se ejecute. Lo no ejecutado en su sistema se declara así.
