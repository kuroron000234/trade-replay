//go:build windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
)

const createNoWindow = 0x08000000

// 裏で動かすコマンドのために黒い窓を開かない
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
}

func openBrowser(url string) {
	exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
}

// ログインは新しい窓で `claude auth login` を実行する（ブラウザが開く。
// 開かないときやコードの貼り付けが必要なときも、窓の案内に従えばよい）
func openLoginWindow(claude string) error {
	q := func(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }
	ps := strings.Join([]string{
		"$Host.UI.RawUI.WindowTitle = 'Claude にログイン'",
		"[Console]::OutputEncoding = [Text.Encoding]::UTF8",
		"Write-Host 'Trade Replay の AI トレーナー用に、Claude にログインします。' -ForegroundColor Cyan",
		"Write-Host 'ブラウザが開いたらログインして「承認」を押してください。'",
		"Write-Host '（Claude の Pro / Max などの有料プラン、または Anthropic Console のアカウントが必要です）'",
		"Write-Host ''",
		"& " + q(claude) + " auth login",
		"Write-Host ''",
		"if ($LASTEXITCODE -eq 0) { Write-Host 'ログインできました。Trade Replay の画面に戻ってください。' -ForegroundColor Green } else { Write-Host 'ログインできませんでした。画面の「ログイン」をもう一度押してください。' -ForegroundColor Yellow }",
		"Read-Host 'Enter キーでこの窓を閉じます'",
	}, "\r\n")
	path := filepath.Join(coachDir, "login.ps1")
	// Windows PowerShell 5.1 は BOM がないと UTF-8 として読まない
	if err := os.WriteFile(path, append([]byte("\xEF\xBB\xBF"), ps...), 0o644); err != nil {
		return err
	}
	cmd := exec.Command("cmd")
	cmd.SysProcAttr = &syscall.SysProcAttr{
		HideWindow: true,
		CmdLine:    `cmd /c start "" powershell -NoProfile -ExecutionPolicy Bypass -File "` + path + `"`,
	}
	return cmd.Start()
}
