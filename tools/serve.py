# Trade Replay のローカルサーバー: サイトを配信し、AI コーチ用に `claude -p` を中継する
#   python3 tools/serve.py [port]      （普段は ~/bin/Trading から起動）
# - 静的ファイルはキャッシュ無効で配信
# - POST /api/coach: 受け取った文章を claude -p に渡し、返答を 1 行 1 JSON で流す
#   Claude にはツールも MCP も与えない（記録を読んで答えるだけ）
import http.server, json, os, subprocess, sys, shutil, threading

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
os.chdir(ROOT)
COACH_CWD = os.path.expanduser('~/.local/share/trade-replay/coach')
os.makedirs(COACH_CWD, exist_ok=True)
CLAUDE = shutil.which('claude') or os.path.expanduser('~/.local/bin/claude')

# システムプロンプトは Windows 版（desktop/）と共有
with open(os.path.join(ROOT, 'tools', 'prompts.json'), encoding='utf-8') as f:
    PROMPTS = json.load(f)
SYSTEM, RULES_SYSTEM = PROMPTS['coach'], PROMPTS['rules']

MODELS = {'', 'opus', 'sonnet', 'haiku'}
EFFORTS = {'low', 'medium', 'high'}


class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, *a):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _same_origin(self):
        # 他のサイトからの呼び出しを防ぐ: 独自ヘッダーが必須なので、別サイトのページからは
        # ブラウザの事前確認（OPTIONS）が必要になり、このサーバーはそれを許可しない
        return self.headers.get('X-Trade-Replay') == '1'

    def do_OPTIONS(self):
        self.send_response(405)
        self.end_headers()

    def do_GET(self):
        if self.path.startswith('/api/coach/status'):
            if not self._same_origin():
                return self._json(403, {'error': 'forbidden'})
            return self._json(200, {'available': os.path.exists(CLAUDE), 'host': 'cloudshell'})
        return super().do_GET()

    def do_POST(self):
        if not self.path.startswith('/api/coach'):
            return self._json(404, {'error': 'not found'})
        if not self._same_origin():
            return self._json(403, {'error': 'forbidden'})
        try:
            n = int(self.headers.get('Content-Length') or 0)
            req = json.loads(self.rfile.read(min(n, 5_000_000)) or b'{}')
        except Exception:
            return self._json(400, {'error': 'bad request'})
        prompt = str(req.get('prompt') or '')
        if not prompt.strip():
            return self._json(400, {'error': 'empty prompt'})
        cmd = [CLAUDE, '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
               '--tools', '', '--strict-mcp-config', '--system-prompt', RULES_SYSTEM if req.get('mode') == 'rules' else SYSTEM]
        model = req.get('model') or ''
        if model in MODELS and model:
            cmd += ['--model', model]
        if req.get('effort') in EFFORTS:
            cmd += ['--effort', req['effort']]
        sid = str(req.get('session') or '')
        if sid and all(c in '0123456789abcdef-' for c in sid):
            cmd += ['--resume', sid]

        self.send_response(200)
        self.send_header('Content-Type', 'application/x-ndjson; charset=utf-8')
        self.end_headers()

        def out(obj):
            self.wfile.write((json.dumps(obj, ensure_ascii=False) + '\n').encode())
            self.wfile.flush()

        try:
            p = subprocess.Popen(cmd, cwd=COACH_CWD, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)
        except Exception as e:
            out({'t': 'error', 'v': f'claude を起動できませんでした: {e}'})
            return
        threading.Thread(target=lambda: (p.stdin.write(prompt), p.stdin.close()), daemon=True).start()
        try:
            for line in p.stdout:
                try:
                    j = json.loads(line)
                except Exception:
                    continue
                t = j.get('type')
                if t == 'stream_event':
                    ev = j.get('event', {})
                    d = ev.get('delta') or {}
                    if ev.get('type') == 'content_block_delta' and d.get('type') == 'text_delta':
                        out({'t': 'text', 'v': d.get('text', '')})
                elif t == 'system' and j.get('subtype') == 'init':
                    out({'t': 'start', 'session': j.get('session_id'), 'model': j.get('model')})
                elif t == 'result':
                    out({'t': 'done', 'session': j.get('session_id'), 'error': j.get('is_error'), 'result': j.get('result') if j.get('is_error') else None,
                         'usage': j.get('usage'), 'cost': j.get('total_cost_usd')})
            p.wait()
            if p.returncode:
                err = (p.stderr.read() or '').strip()[-500:]
                if err:
                    out({'t': 'error', 'v': err})
        except (BrokenPipeError, ConnectionResetError):
            pass  # ブラウザ側で停止された
        finally:
            if p.poll() is None:
                p.kill()


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    http.server.ThreadingHTTPServer.daemon_threads = True
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', port), H)
    print(f'Trade Replay: http://127.0.0.1:{port}/', flush=True)
    srv.serve_forever()
