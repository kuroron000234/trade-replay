#!/bin/bash
# デスクトップ版をビルドする
#   desktop/build.sh [バージョン]   → dist/TradeReplay-<版>-windows-x64.zip と Linux 用の試験バイナリ
set -euo pipefail
cd "$(dirname "$0")"
VER=${1:-$(git describe --tags --always 2>/dev/null || echo dev)}
rm -rf site && mkdir site
cp -r ../index.html ../css ../js ../vendor ../data site/
cp ../tools/prompts.json .
[ -f go.mod ] || go mod init trade-replay-desktop >/dev/null 2>&1
mkdir -p ../dist
LD="-s -w -X main.version=$VER"
GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "$LD" -o ../dist/TradeReplay.exe .
go build -trimpath -ldflags "$LD" -o ../dist/trade-replay-linux .
cd ../dist
rm -f TradeReplay-*-windows-x64.zip
mkdir -p pkg && cp TradeReplay.exe pkg/ && cp ../desktop/README-windows.txt pkg/README.txt
(cd pkg && zip -qr "../TradeReplay-$VER-windows-x64.zip" .)
rm -rf pkg
ls -la
