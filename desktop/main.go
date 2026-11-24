// Trade Replay デスクトップ版（主に Windows 向け）
//
// サイト一式を exe に同梱してローカルで配信し、既定のブラウザで開く。
// AI トレーナー用に `claude -p` を中継し、Claude Code が入っていなければ
// 画面のボタンから自動でインストールし、ログインまで案内する。
//
// ビルドは desktop/build.sh（サイトを site/ にコピーしてから go build）。
package main

import (
	"bufio"
	"bytes"
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

//go:embed all:site
var siteFS embed.FS

//go:embed prompts.json
var promptsJSON []byte

var version = "dev"

const appID = "trade-replay-desktop"

var (
	prompts  map[string]string
	coachDir string
)

func main() {
	if err := json.Unmarshal(promptsJSON, &prompts); err != nil {
		fatal("prompts.json を読めません: " + err.Error())
	}
	base, _ := os.UserCacheDir() // Windows では %LOCALAPPDATA%
	if base == "" {
		base = os.TempDir()
	}
	coachDir = filepath.Join(base, "TradeReplay", "coach")
	os.MkdirAll(coachDir, 0o755)

	fmt.Printf("Trade Replay %s\n", version)
	ln, url, already := listen()
	if already {
		fmt.Println("すでに起動しています。ブラウザで開きます:", url)
		openBrowser(url)
		time.Sleep(1500 * time.Millisecond)
		return
	}
	sub, _ := fs.Sub(siteFS, "site")
	mux := http.NewServeMux()
	files := http.FileServer(http.FS(sub))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		files.ServeHTTP(w, r)
	})
	mux.HandleFunc("/api/ping", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, map[string]any{"app": appID}) })
	mux.HandleFunc("/api/coach/status", guard(handleStatus))
	mux.HandleFunc("/api/coach", guard(handleCoach))
	mux.HandleFunc("/api/setup/install", guard(handleInstall))
	mux.HandleFunc("/api/setup/login", guard(handleLogin))

	fmt.Println("ブラウザで開きます:", url)
	fmt.Println("このウィンドウを閉じると Trade Replay が終了します。")
	go func() { time.Sleep(300 * time.Millisecond); openBrowser(url) }()
	go func() {
		if c := findClaude(); c == "" {
			fmt.Println("AI トレーナー用の Claude Code はまだ入っていません。画面の「AI トレーナー」タブからセットアップできます。")
		}
	}()
	srv := &http.Server{Handler: mux}
	if err := srv.Serve(ln); err != nil {
		fatal(err.Error())
	}
}

func fatal(msg string) {
	fmt.Println("エラー:", msg)
	if runtime.GOOS == "windows" {
		fmt.Println("Enter キーで閉じます")
		bufio.NewReader(os.Stdin).ReadString('\n')
	}
	os.Exit(1)
}

// 固定ポートを優先する（ブラウザに保存されたデータはポートごとに分かれるため）
func listen() (net.Listener, string, bool) {
	for p := 8765; p < 8785; p++ {
		addr := fmt.Sprintf("127.0.0.1:%d", p)
		url := "http://" + addr + "/"
		ln, err := net.Listen("tcp", addr)
		if err == nil {
			return ln, url, false
		}
		// すでに自分が動いているなら、それを開く
		c := http.Client{Timeout: time.Second}
		if r, err := c.Get(url + "api/ping"); err == nil {
			var j map[string]any
			json.NewDecoder(r.Body).Decode(&j)
			r.Body.Close()
			if j["app"] == appID {
				return nil, url, true
			}
		}
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		fatal(err.Error())
	}
	return ln, fmt.Sprintf("http://%s/", ln.Addr()), false
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

// 他のサイトからの呼び出しを防ぐ: 独自ヘッダーが必須なので、別サイトのページからは
// 事前確認（OPTIONS）が必要になり、このサーバーはそれを許可しない
func guard(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// DNS リバインディング対策: 別サイトのドメインを 127.0.0.1 に向けられると同一オリジン扱いになり
		// 独自ヘッダーも付けられるので、Host がこのマシン自身のときだけ受け付ける
		host, _, err := net.SplitHostPort(r.Host)
		if err != nil {
			host = r.Host
		}
		local := host == "127.0.0.1" || host == "localhost" || host == "::1"
		if !local || r.Method == http.MethodOptions || r.Header.Get("X-Trade-Replay") != "1" {
			writeJSON(w, 403, map[string]any{"error": "forbidden"})
			return
		}
		h(w, r)
	}
}

// ---------- Claude Code の場所と状態 ----------

func findClaude() string {
	home, _ := os.UserHomeDir()
	var cands []string
	if runtime.GOOS == "windows" {
		cands = append(cands, filepath.Join(home, ".local", "bin", "claude.exe"))
		if la := os.Getenv("LOCALAPPDATA"); la != "" {
			cands = append(cands, filepath.Join(la, "Microsoft", "WinGet", "Links", "claude.exe"))
		}
	} else {
		cands = append(cands, filepath.Join(home, ".local", "bin", "claude"))
	}
	for _, c := range cands {
		if st, err := os.Stat(c); err == nil && !st.IsDir() {
			return c
		}
	}
	if p, err := exec.LookPath("claude"); err == nil {
		return p
	}
	return ""
}

type authCache struct {
	mu       sync.Mutex
	at       time.Time
	path     string
	loggedIn bool
	method   string
}

var auth authCache

func authStatus(claude string, fresh bool) (bool, string) {
	auth.mu.Lock()
	defer auth.mu.Unlock()
	ttl := 10 * time.Second
	if !auth.loggedIn {
		ttl = 2 * time.Second // ログイン待ちの間はすぐ反映させる
	}
	if !fresh && auth.path == claude && time.Since(auth.at) < ttl {
		return auth.loggedIn, auth.method
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, claude, "auth", "status", "--json")
	hideWindow(cmd)
	out, _ := cmd.Output() // ログインしていないと終了コードが 0 以外になることがある
	var j struct {
		LoggedIn   bool   `json:"loggedIn"`
		AuthMethod string `json:"authMethod"`
	}
	json.Unmarshal(bytes.TrimSpace(out), &j)
	auth.at, auth.path, auth.loggedIn, auth.method = time.Now(), claude, j.LoggedIn, j.AuthMethod
	return j.LoggedIn, j.AuthMethod
}

// ---------- セットアップ（インストールとログイン） ----------

type setupState struct {
	mu      sync.Mutex
	Running bool   `json:"running"`
	Step    string `json:"step"`
	Log     string `json:"log"`
	Error   string `json:"error"`
	Login   bool   `json:"loginOpened"`
}

var setup setupState

func (s *setupState) snapshot() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	log := s.Log
	if len(log) > 4000 {
		log = log[len(log)-4000:]
	}
	return map[string]any{"running": s.Running, "step": s.Step, "log": log, "error": s.Error, "loginOpened": s.Login}
}

func (s *setupState) append(b []byte) {
	s.mu.Lock()
	s.Log += string(b)
	s.mu.Unlock()
}

type logWriter struct{}

func (logWriter) Write(b []byte) (int, error) { setup.append(b); os.Stdout.Write(b); return len(b), nil }

func handleStatus(w http.ResponseWriter, r *http.Request) {
	claude := findClaude()
	res := map[string]any{"host": "desktop", "os": runtime.GOOS, "version": version, "installed": claude != "", "setup": setup.snapshot()}
	logged := false
	if claude != "" {
		var method string
		logged, method = authStatus(claude, r.URL.Query().Get("fresh") == "1")
		res["authMethod"] = method
	}
	res["loggedIn"] = logged
	res["available"] = claude != "" && logged
	writeJSON(w, 200, res)
}

func handleInstall(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, 405, map[string]any{"error": "POST only"})
		return
	}
	setup.mu.Lock()
	if setup.Running {
		setup.mu.Unlock()
		writeJSON(w, 200, map[string]any{"ok": true})
		return
	}
	setup.Running, setup.Step, setup.Log, setup.Error = true, "install", "", ""
	setup.mu.Unlock()
	go func() {
		fmt.Println("Claude Code をインストールしています…")
		err := runInstaller(logWriter{})
		setup.mu.Lock()
		setup.Running = false
		if err == nil && findClaude() == "" {
			err = errors.New("インストールは終わりましたが、claude が見つかりません")
		}
		if err != nil {
			setup.Error = err.Error()
			setup.Step = "failed"
		} else {
			setup.Step = "installed"
		}
		setup.mu.Unlock()
		if err != nil {
			fmt.Println("インストールに失敗しました:", err)
		} else {
			fmt.Println("Claude Code をインストールしました")
		}
	}()
	writeJSON(w, 200, map[string]any{"ok": true})
}

func runInstaller(out io.Writer) error {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		// 公式のインストーラー（管理者権限は不要。%USERPROFILE%\.local\bin に入る）
		cmd = exec.CommandContext(ctx, "powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
			"[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; irm https://claude.ai/install.ps1 | iex")
	} else {
		cmd = exec.CommandContext(ctx, "bash", "-c", "curl -fsSL https://claude.ai/install.sh | bash")
	}
	hideWindow(cmd)
	cmd.Stdout, cmd.Stderr = out, out
	return cmd.Run()
}

func handleLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, 405, map[string]any{"error": "POST only"})
		return
	}
	claude := findClaude()
	if claude == "" {
		writeJSON(w, 400, map[string]any{"error": "Claude Code が入っていません"})
		return
	}
	if err := openLoginWindow(claude); err != nil {
		writeJSON(w, 500, map[string]any{"error": err.Error()})
		return
	}
	setup.mu.Lock()
	setup.Login = true
	setup.mu.Unlock()
	writeJSON(w, 200, map[string]any{"ok": true})
}

// ---------- AI トレーナー（claude -p の中継） ----------

var models = map[string]bool{"": true, "opus": true, "sonnet": true, "haiku": true}
var efforts = map[string]bool{"low": true, "medium": true, "high": true}

func handleCoach(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, 404, map[string]any{"error": "not found"})
		return
	}
	var req struct {
		Prompt  string `json:"prompt"`
		Session string `json:"session"`
		Model   string `json:"model"`
		Effort  string `json:"effort"`
		Mode    string `json:"mode"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 5_000_000)).Decode(&req); err != nil {
		writeJSON(w, 400, map[string]any{"error": "bad request"})
		return
	}
	if strings.TrimSpace(req.Prompt) == "" {
		writeJSON(w, 400, map[string]any{"error": "empty prompt"})
		return
	}
	claude := findClaude()
	if claude == "" {
		writeJSON(w, 400, map[string]any{"error": "Claude Code が入っていません"})
		return
	}
	sys := prompts["coach"]
	if req.Mode == "rules" {
		sys = prompts["rules"]
	}
	args := []string{"-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
		"--tools", "", "--strict-mcp-config", "--system-prompt", sys}
	if models[req.Model] && req.Model != "" {
		args = append(args, "--model", req.Model)
	}
	if efforts[req.Effort] {
		args = append(args, "--effort", req.Effort)
	}
	if req.Session != "" && strings.Trim(req.Session, "0123456789abcdef-") == "" {
		args = append(args, "--resume", req.Session)
	}

	w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(200)
	fl, _ := w.(http.Flusher)
	out := func(v any) {
		b, _ := json.Marshal(v)
		w.Write(append(b, '\n'))
		if fl != nil {
			fl.Flush()
		}
	}

	cmd := exec.CommandContext(r.Context(), claude, args...) // ブラウザ側で停止されたら終了させる
	cmd.Dir = coachDir
	hideWindow(cmd)
	cmd.Stdin = strings.NewReader(req.Prompt)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err == nil {
		err = cmd.Start()
	}
	if err != nil {
		out(map[string]any{"t": "error", "v": "claude を起動できませんでした: " + err.Error()})
		return
	}
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 1<<20), 64<<20)
	for sc.Scan() {
		var j map[string]any
		if json.Unmarshal(bytes.TrimSpace(sc.Bytes()), &j) != nil {
			continue
		}
		switch j["type"] {
		case "stream_event":
			ev, _ := j["event"].(map[string]any)
			d, _ := ev["delta"].(map[string]any)
			if ev["type"] == "content_block_delta" && d["type"] == "text_delta" {
				out(map[string]any{"t": "text", "v": d["text"]})
			}
		case "system":
			if j["subtype"] == "init" {
				out(map[string]any{"t": "start", "session": j["session_id"], "model": j["model"]})
			}
		case "result":
			var res any
			if j["is_error"] == true {
				res = j["result"]
			}
			out(map[string]any{"t": "done", "session": j["session_id"], "error": j["is_error"], "result": res, "usage": j["usage"], "cost": j["total_cost_usd"]})
		}
	}
	if err := cmd.Wait(); err != nil && r.Context().Err() == nil {
		msg := strings.TrimSpace(stderr.String())
		if len(msg) > 500 {
			msg = msg[len(msg)-500:]
		}
		if msg != "" {
			out(map[string]any{"t": "error", "v": msg})
		}
	}
}
