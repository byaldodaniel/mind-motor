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

## Compilación reproducible

`build.ps1` quita del ejecutable las rutas locales (`--remap-path-prefix`) y,
en Windows, la marca de fecha del formato PE (`--no-insert-timestamp`). El
mismo código y la misma toolchain producen el mismo archivo desde cualquier
carpeta. Comprobado el 19-nov-2026 compilando desde dos rutas distintas:

| Destino | SHA-256 |
|---|---|
| win32-x64 (GNU, rust-lld) | `d0948ebfe62c1d06637932f3803416d728b04bb5b24fca2debf935a415a8045f` |
| linux-x64 (musl, rust-lld) | `b28f863fbd8e8f43cca17aae09da410e33b0fd461652a9d59fe19e187b0b2a05` |

Toolchain: Rust 1.100.0 del piloto. Otra versión del compilador da otra huella.

## Estado de los seis destinos

| Destino | Compilado | Ejecutado |
|---|---|---|
| win32-x64 | Sí, en este equipo | Sí, en este equipo: 13/13 pruebas + contrato |
| linux-x64 | Sí, en este equipo (cruzado) | No: sin Linux ni WSL aquí; en CI cuando corra |
| linux-arm64 | Sí, en este equipo (cruzado) | No |
| win32-arm64 | Solo en CI (MSVC) | No |
| darwin-arm64 | Solo en CI (macos-14) | En CI cuando corra |
| darwin-x64 | Solo en CI (macos-14, cruzado) | No |

El flujo de CI se lanza a mano (`workflow_dispatch`). Hasta el 19-nov-2026 no
se ha ejecutado: la cuota de Actions de la cuenta está agotada. Lo no ejecutado
en su sistema se declara así.
