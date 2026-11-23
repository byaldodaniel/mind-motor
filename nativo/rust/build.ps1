param(
  [string]$Target = '',
  # Al cambiar dependencias: actualiza Cargo.lock (descarga de crates.io lo que falte).
  [switch]$ActualizarBloqueo,
  [string]$Toolchain = $env:MIND_RUST_TOOLCHAIN
)
# Compila el ejecutable nativo de Mind.
# - Si `cargo` está en el PATH (CI o equipo con rustup), lo usa tal cual.
# - Si no, usa una toolchain portátil: -Toolchain o MIND_RUST_TOOLCHAIN.
#   Por omisión, la del piloto en Borradores (Windows x64 GNU con rust-lld).
# Los compiladores y cachés nunca forman parte del paquete de Mind.
$ErrorActionPreference = 'Stop'
$env:CARGO_TARGET_DIR = Join-Path $PSScriptRoot 'target'
$lockFlag = if ($ActualizarBloqueo) { '--quiet' } else { '--locked' }
$buildArgs = @('build', '--release', $lockFlag, '--manifest-path', (Join-Path $PSScriptRoot 'Cargo.toml'))
if ($Target) { $buildArgs += @('--target', $Target) }

$cargo = Get-Command cargo -ErrorAction SilentlyContinue
if ($cargo -and -not $Toolchain) {
  & $cargo.Source @buildArgs
  exit $LASTEXITCODE
}

if (-not $Toolchain) {
  $relativeToolchain = 'Borradores\Piloto-Nativo-r3\toolchains\rust'
  $Toolchain = Join-Path $PSScriptRoot "..\..\..\$relativeToolchain"
  if (-not (Test-Path -LiteralPath $Toolchain -PathType Container)) {
    # En un worktree, Borradores sigue junto al repositorio principal.
    $gitDirectory = & git -C $PSScriptRoot rev-parse --path-format=absolute --git-common-dir
    if ($LASTEXITCODE -ne 0) { throw 'Indica -Toolchain con la ruta al compilador Rust portátil.' }
    $development = Split-Path -Parent (Split-Path -Parent $gitDirectory)
    $Toolchain = Join-Path $development $relativeToolchain
  }
}
$Toolchain = (Resolve-Path -LiteralPath $Toolchain).Path
$install = Join-Path $Toolchain 'install'
$hostLib = Join-Path $install 'lib\rustlib\x86_64-pc-windows-gnu\bin'
$llvm = Get-ChildItem -LiteralPath $Toolchain -Recurse -Filter 'llvm-dlltool.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not (Test-Path -LiteralPath (Join-Path $install 'bin\cargo.exe'))) { throw "No hay cargo en $install" }
if (-not $llvm) { throw "No hay llvm-dlltool en $Toolchain" }

$env:CARGO_HOME = Join-Path $Toolchain 'cargo-home'
$env:RUSTUP_HOME = Join-Path $Toolchain 'rustup-home'
$env:CARGO_BUILD_JOBS = '2'
$env:PATH = (Join-Path $install 'bin') + ';' + (Join-Path $hostLib 'self-contained') + ';' + $env:PATH
$lld = Join-Path $hostLib 'rust-lld.exe'
$effective = if ($Target) { $Target } else { 'x86_64-pc-windows-gnu' }
# SQLite y ring también necesitan un compilador C. Usa la copia de Zig del
# checkout cuando no haya un compilador GNU ya configurado.
if ($effective -eq 'x86_64-pc-windows-gnu' -and
    -not $env:CC_x86_64_pc_windows_gnu -and -not ${env:CC_x86_64-pc-windows-gnu} -and
    -not $env:HOST_CC -and -not $env:CC -and -not (Get-Command gcc -ErrorAction SilentlyContinue)) {
  $tools = Join-Path $env:CARGO_TARGET_DIR 'herramientas'
  $zigDirectory = Join-Path $tools 'ziglang'
  if (Test-Path -LiteralPath (Join-Path $zigDirectory 'zig.exe') -PathType Leaf) {
    $env:PATH = $zigDirectory + ';' + $env:PATH
    if (-not $env:ZIG_GLOBAL_CACHE_DIR) { $env:ZIG_GLOBAL_CACHE_DIR = Join-Path $tools 'zig-global-cache' }
    if (-not $env:ZIG_LOCAL_CACHE_DIR) { $env:ZIG_LOCAL_CACHE_DIR = Join-Path $tools 'zig-cache' }
  }
  if (-not (Get-Command zig -ErrorAction SilentlyContinue)) {
    throw 'La compilación Windows GNU necesita GCC o Zig en el PATH, o CC_x86_64_pc_windows_gnu.'
  }
  $env:CC_x86_64_pc_windows_gnu = 'zig.exe cc -target x86_64-windows-gnu'
  if (-not $env:AR_x86_64_pc_windows_gnu) {
    $env:AR_x86_64_pc_windows_gnu = Join-Path $llvm.DirectoryName 'llvm-ar.exe'
  }
  $env:CRATE_CC_NO_DEFAULTS = '1'
  if (-not $env:CFLAGS_x86_64_pc_windows_gnu) { $env:CFLAGS_x86_64_pc_windows_gnu = '-O2 -fno-stack-protector' }
}
switch -Wildcard ($effective) {
  'x86_64-pc-windows-gnu' { $flags = @('-C', "dlltool=$($llvm.FullName)", '-C', "linker=$lld", '-C', 'linker-flavor=ld.lld', '-C', 'link-self-contained=yes', '-C', 'link-arg=--no-insert-timestamp') }
  '*-unknown-linux-musl' { $flags = @('-C', "linker=$lld", '-C', 'linker-flavor=ld.lld', '-C', 'link-self-contained=yes') }
  default { throw "Destino $effective sin receta local: compílalo en CI con su SDK (ver nativo/README.md)." }
}
# Compilación reproducible: las rutas locales de la fuente y del registro de
# crates no quedan dentro del ejecutable.
$flags += @('--remap-path-prefix', "$((Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path)=/mind",
            '--remap-path-prefix', "$($env:CARGO_HOME)=/cargo")
$env:CARGO_ENCODED_RUSTFLAGS = $flags -join [char]31
& (Join-Path $install 'bin\cargo.exe') @buildArgs
exit $LASTEXITCODE
