param([switch]$Cross)
$ErrorActionPreference='Stop'
$root=$PSScriptRoot
$env:GOCACHE=Join-Path $root '.cache\build'
$env:GOMODCACHE=Join-Path $root '.cache\modules'
$env:GOPATH=Join-Path $root '.cache\gopath'
$env:GOTMPDIR=Join-Path $root '.cache\tmp'
$env:TMP=Join-Path $root '.cache\test-temp'
$env:TEMP=$env:TMP
$env:TMPDIR=$env:TMP
$env:GOTOOLCHAIN='local'
$env:CGO_ENABLED='0'
$env:GOMAXPROCS='2'
$go=Join-Path $root '..\toolchains\go\go\bin\go.exe'
New-Item -ItemType Directory -Path $env:GOCACHE,$env:GOMODCACHE,$env:GOPATH,$env:GOTMPDIR,$env:TMP,(Join-Path $root 'bin'),(Join-Path $root 'evidence') -Force | Out-Null
Push-Location $root
try {
 & $go fmt ./...
 if($LASTEXITCODE -ne 0){throw 'gofmt failed'}
 $targets=if($Cross){@('windows/amd64','windows/arm64','linux/amd64','linux/arm64','darwin/amd64','darwin/arm64')}else{@('windows/amd64')}
 $results=@()
 foreach($target in $targets){
  $pair=$target.Split('/');$env:GOOS=$pair[0];$env:GOARCH=$pair[1]
  $suffix=if($env:GOOS -eq 'windows'){'.exe'}else{''}
  $out=Join-Path $root ('bin\mind-native-go-'+$env:GOOS+'-'+$env:GOARCH+$suffix)
  $watch=[System.Diagnostics.Stopwatch]::StartNew()
  & $go build -p 2 -trimpath -ldflags '-s -w' -o $out .
  $code=$LASTEXITCODE;$watch.Stop()
  $item=[ordered]@{target=$target;exitCode=$code;elapsedMs=$watch.ElapsedMilliseconds;path=$out;bytes=$null;sha256=$null;executed=($target -eq 'windows/amd64')}
  if($code -eq 0){$item.bytes=(Get-Item -LiteralPath $out).Length;$item.sha256=(Get-FileHash -LiteralPath $out -Algorithm SHA256).Hash.ToLower()}
  $results+=[pscustomobject]$item
  $item | ConvertTo-Json -Compress | Write-Output
  $results | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $root 'evidence\crossbuild.json') -Encoding utf8
  if($code -ne 0){throw "Cross compilation failed: $target"}
 }
 $env:GOOS='windows';$env:GOARCH='amd64'
 & $go test -p 2 -v . 2>&1 | Tee-Object -FilePath (Join-Path $root 'evidence\unit-tests.txt')
 if($LASTEXITCODE -ne 0){throw 'tests failed'}
 & $go vet -p 2 . 2>&1 | Tee-Object -FilePath (Join-Path $root 'evidence\vet.txt')
 if($LASTEXITCODE -ne 0){throw 'vet failed'}
} finally {Pop-Location}
