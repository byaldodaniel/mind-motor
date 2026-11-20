param(
  [string]$Target = '',
  [string]$Toolchain = $env:MIND_RUST_TOOLCHAIN
)
# Compila el ejecutable nativo de Mind.
# - Si `cargo` está en el PATH (CI o equipo con rustup), lo usa tal cual.
# - Si no, usa una toolchain portátil: -Toolchain o MIND_RUST_TOOLCHAIN.
#   Por omisión, la del piloto en Borradores (Windows x64 GNU con rust-lld).
# Los compiladores y cachés nunca forman parte del paquete de Mind.
$ErrorActionPreference = 'Stop'
$env:CARGO_TARGET_DIR = Join-Path $PSScriptRoot 'target'
$buildArgs = @('build', '--release', '--locked', '--manifest-path', (Join-Path $PSScriptRoot 'Cargo.toml'))
if ($Target) { $buildArgs += @('--target', $Target) }

$cargo = Get-Command cargo -ErrorAction SilentlyContinue
if ($cargo -and -not $Toolchain) {
  & $cargo.Source @buildArgs
  exit $LASTEXITCODE
}

if (-not $Toolchain) {
  $Toolchain = Join-Path $PSScriptRoot '..\..\..\Borradores\Piloto-Nativo-r3\toolchains\rust'
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
switch -Wildcard ($effective) {
  'x86_64-pc-windows-gnu' { $flags = @('-C', "dlltool=$($llvm.FullName)", '-C', "linker=$lld", '-C', 'linker-flavor=ld.lld', '-C', 'link-self-contained=yes') }
  '*-unknown-linux-musl' { $flags = @('-C', "linker=$lld", '-C', 'linker-flavor=ld.lld', '-C', 'link-self-contained=yes') }
  default { throw "Destino $effective sin receta local: compílalo en CI con su SDK (ver nativo/README.md)." }
}
$env:CARGO_ENCODED_RUSTFLAGS = $flags -join [char]31
& (Join-Path $install 'bin\cargo.exe') @buildArgs
exit $LASTEXITCODE
