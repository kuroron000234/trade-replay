# Trade Replay のローカルサーバー: サイトを配信し、AI コーチ用に `claude -p` を中継する
#   python3 tools/serve.py [port]      （普段は ~/bin/Trading から起動）
# - 静的ファイルはキャッシュ無効で配信
# - POST /api/coach: 受け取った文章を claude -p に渡し、返答を 1 行 1 JSON で流す
#   Claude は普段の Claude Code と同じツールを auto モード（安全な操作は自動で許可）で使える。
#   ブラウザから届いた記録やチャートは作業フォルダの data/ に書き出して読ませる
import http.server, json, os, re, subprocess, sys, shutil, threading

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
os.chdir(ROOT)
COACH_CWD = os.path.expanduser('~/.local/share/trade-replay/coach')
os.makedirs(COACH_CWD, exist_ok=True)
CLAUDE = shutil.which('claude') or os.path.expanduser('~/.local/bin/claude')

# システムプロンプトは Windows 版（desktop/）と共有
with open(os.path.join(ROOT, 'tools', 'prompts.json'), encoding='utf-8') as f:
    PROMPTS = json.load(f)
SYSTEM, RULES_SYSTEM = PROMPTS['coach'] + PROMPTS['workspace'], PROMPTS['rules'] + PROMPTS['workspace']
DATA_DIR = os.path.join(COACH_CWD, 'data')
SAFE_PATH = re.compile(r'^[\w\-]+(/[\w\-]+)*\.\w+$')
WRITE_LOCK = threading.Lock()


def write_workspace(files):
    # data/ を丸ごと作り直す（前回の古いファイルを残さない）
    if not isinstance(files, dict):
        return
    with WRITE_LOCK:
        shutil.rmtree(DATA_DIR, ignore_errors=True)
        for name, text in files.items():
            if not isinstance(name, str) or not isinstance(text, str) or not SAFE_PATH.match(name):
                continue
            path = os.path.join(DATA_DIR, *name.split('/'))
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, 'w', encoding='utf-8') as f:
                f.write(text)

MODELS = {'', 'opus', 'sonnet', 'haiku'}
EFFORTS = {'low', 'medium', 'high'}


def tool_label(name, inp):
    # 画面に出す 1 行の説明（例: Bash: python3 ...）
    arg = inp.get('description') or inp.get('command') or inp.get('file_path') or inp.get('pattern') or inp.get('query') or inp.get('url') or ''
    arg = ' '.join(str(arg).split())
    return f'{name}: {arg[:160]}' if arg else str(name)


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
        # Host も確認して DNS リバインディング（外部のドメインをこのサーバーに向ける攻撃）を防ぐ
        host = (self.headers.get('Host') or '').split(':')[0].lower()
        ok_host = host in ('127.0.0.1', 'localhost') or host.endswith('.cloudshell.dev')
        if not ok_host:
            print(f'拒否: Host={host!r} {self.path}', file=sys.stderr, flush=True)
        return ok_host and self.headers.get('X-Trade-Replay') == '1'

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
            req = json.loads(self.rfile.read(min(n, 200_000_000)) or b'{}')
        except Exception:
            return self._json(400, {'error': 'bad request'})
        prompt = str(req.get('prompt') or '')
        if not prompt.strip():
            return self._json(400, {'error': 'empty prompt'})
        cmd = [CLAUDE, '-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
               '--permission-mode', 'auto', '--system-prompt', RULES_SYSTEM if req.get('mode') == 'rules' else SYSTEM]
        model = req.get('model') or ''
        if model in MODELS and model:
            cmd += ['--model', model]
        if req.get('effort') in EFFORTS:
            cmd += ['--effort', req['effort']]
        sid = str(req.get('session') or '')
        if sid and all(c in '0123456789abcdef-' for c in sid):
            cmd += ['--resume', sid]

        try:
            write_workspace(req.get('files'))
        except Exception as e:
            return self._json(500, {'error': f'データを書き出せませんでした: {e}'})

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
                elif t == 'assistant':
                    for c in (j.get('message') or {}).get('content') or []:
                        if isinstance(c, dict) and c.get('type') == 'tool_use':
                            out({'t': 'tool', 'v': tool_label(c.get('name'), c.get('input') or {})})
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
