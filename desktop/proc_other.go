//go:build !windows

package main

import (
	"errors"
	"os/exec"
	"runtime"
)

func hideWindow(cmd *exec.Cmd) {}

func openBrowser(url string) {
	if runtime.GOOS == "darwin" {
		exec.Command("open", url).Start()
	} else {
		exec.Command("xdg-open", url).Start()
	}
}

// Windows 以外では窓を開けないので、端末で実行してもらう
func openLoginWindow(claude string) error {
	return errors.New("端末で `" + claude + " auth login` を実行してください")
}
