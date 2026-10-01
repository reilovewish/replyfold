# Replyfold のインストール用ファイル（.xpi）を作る。
# 使い方（PowerShell）：プロジェクト直下で  ./scripts/build-xpi.ps1
# 出力：dist/replyfold-<バージョン>.xpi（dist/ は公開対象外）
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root "src"
$dist = Join-Path $root "dist"

# バージョンは manifest.json から取る（ファイル名に入れて、どの版か分かるようにする）
$version = (Get-Content (Join-Path $src "manifest.json") -Raw | ConvertFrom-Json).version
New-Item -ItemType Directory -Force $dist | Out-Null
$xpi = Join-Path $dist "replyfold-$version.xpi"
$zip = [System.IO.Path]::ChangeExtension($xpi, ".zip")
Remove-Item $xpi, $zip -ErrorAction SilentlyContinue

# .xpi は zip そのもの。manifest.json が最上位に来るよう、src の「中身」を固める
Compress-Archive -Path (Join-Path $src "*") -DestinationPath $zip
Move-Item $zip $xpi
Write-Output "作成しました：$xpi"
