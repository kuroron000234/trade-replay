// AI トレーナー: ローカルサーバー（Windows 版の exe、または Cloud Shell の `Trading`）経由で `claude -p` に相談する
// （GitHub Pages など、サーバーがない環境では Windows 版を案内する）
// Windows 版で Claude Code が未導入・未ログインなら、インストールとログインを案内する
import { el, store, toast, fmtNum, fmtTime } from './util.js';
import { toAIText, marketContext, summarize, toCSV, jdb, fmtISO } from './journal.js';
import { STRATEGY_API, PRESETS, compile } from './strategy.js';
import { modal } from './ui.js';

export const MODELS = [
  ['', 'Claude Code の既定モデル'],
  ['opus', 'Opus'],
  ['sonnet', 'Sonnet'],
  ['haiku', 'Haiku（速い）'],
];
const API = 'api/coach';
const HDR = { 'X-Trade-Replay': '1' };
const RELEASES = 'https://github.com/kuroron000234/trade-replay/releases/latest';

export class Coach {
  constructor(root, app) {
    this.app = app;
    this.history = [];
    this.session = null;
    this.busy = false;
    this.model = el('select', {}, ...MODELS.map(([v, l]) => el('option', { value: v, selected: v === store.get('coachModel', '') }, l)));
    this.model.onchange = () => { store.set('coachModel', this.model.value); this.reset(); };
    this.status = el('span', { class: 'muted' }, '確認中…');
    this.log = el('div', { class: 'coach-log' });
    this.input = el('textarea', { class: 'coach-in', rows: 2, placeholder: '質問を入力（Enter で送信、Shift+Enter で改行）' });
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.ask(); }
    });
    this.sendBtn = el('button', { class: 'btn small primary', onclick: () => (this.busy ? this.stop() : this.ask()) }, '送信');
    this.mode = store.get('coachMode', 'coach');
    this.modeBtns = el('div', { class: 'tabs' }, ...[['coach', '相談'], ['rules', 'ルール作り']].map(([m, l]) =>
      el('button', { class: 'tab', 'data-mode': m, onclick: () => this.setMode(m) }, l)));
    this.quick = el('div', { class: 'coach-quick' });
    root.append(
      el('div', { class: 'coach-head' }, el('b', {}, 'AI トレーナー（claude -p）'), this.modeBtns, this.model, this.status, el('span', { class: 'grow' }),
        el('button', { class: 'btn small', onclick: () => this.reset() }, '会話をリセット')),
      this.quick,
      this.log,
      el('div', { class: 'coach-foot' }, this.input, this.sendBtn));
    this.setMode(this.mode, true);
    this.ready = this.check();
  }
  setMode(m, init) {
    if (!init && m === this.mode) return;
    this.mode = m;
    store.set('coachMode', m);
    this.modeBtns.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
    this.quick.innerHTML = '';
    const b = (label, f, title) => el('button', { class: 'btn small', onclick: f, title }, label);
    if (m === 'coach') {
      this.quick.append(
        b('今のセッションを振り返る', () => this.analyzeSession()),
        b('全取引の傾向と改善点', () => this.analyzeAll()),
        b('今の局面を相談', () => this.askSituation()));
    } else {
      this.quick.append(
        b('ルール作りを始める', () => this.startRules(), 'トレーナーが質問しながら、一緒にルールを決めます'),
        b('自分の記録からルールを作る', () => this.rulesFromJournal(), 'これまでの取引記録から、勝てている条件をルールにします'),
        b('コードにしてチャートで回す', () => this.codify(), 'ここまでの話をストラテジーのコードにしてもらいます'),
        b('バックテスト結果を見せて改善', () => this.feedBacktest(), '今チャートで回しているストラテジーの成績を渡して改善してもらいます'));
    }
    this.input.placeholder = m === 'rules' ? 'どんなルールで取引したいか書いてください（例: 15分足で押し目買い、損切りは直近安値）' : '質問を入力（Enter で送信、Shift+Enter で改行）';
    if (!init) this.reset(); else this.empty();
  }
  async check(fresh) {
    let j = null;
    try {
      const r = await fetch(API + '/status' + (fresh ? '?fresh=1' : ''), { headers: HDR, cache: 'no-store' });
      j = r.ok ? await r.json() : null;
    } catch {}
    this.info = j;
    this.available = !!j?.available;
    this.status.className = 'muted';
    if (this.available) this.status.textContent = j.host === 'desktop' ? 'この PC の Claude Code を使います（取引の記録やチャートをファイルで渡し、Claude が自由に調べます）' : 'Cloud Shell の Claude Code を使います（取引の記録やチャートをファイルで渡し、Claude が自由に調べます）';
    else if (j?.host === 'desktop') this.status.textContent = '準備が必要です（下の案内に従ってください）';
    else if (j) this.status.textContent = 'Claude Code が見つかりません';
    else this.status.textContent = 'このページでは使えません（Windows 版で使えます）';
    // インストールが終わったら、続けてログインの窓を開く
    if (this.autoLogin && j?.installed && !j.loggedIn && !j.setup?.running) { this.autoLogin = false; this.login(); }
    if (j?.host === 'desktop' && !this.available) this.showSetup(); else { this.hideSetup(); this.empty(); }
    return this.available;
  }
  // ---------- 初めての人向けのセットアップ（Windows 版） ----------
  showSetup() {
    const j = this.info || {}, st = j.setup || {};
    if (!this.setupBox) {
      this.log.innerHTML = '';
      this.setupBox = el('div', { class: 'coach-setup' });
      this.log.append(this.setupBox);
      clearInterval(this.poll);
      this.poll = setInterval(() => this.check(), 2000);
    }
    const step = (n, title, state, body) => el('div', { class: 'setup-step ' + state }, el('div', { class: 'setup-n' }, state === 'done' ? '✓' : String(n)), el('div', {}, el('b', {}, title), body));
    const installing = st.running && st.step === 'install';
    const s1 = j.installed ? 'done' : 'now';
    const s2 = !j.installed ? 'later' : j.loggedIn ? 'done' : 'now';
    this.setupBox.innerHTML = '';
    this.setupBox.append(
      el('h3', {}, 'AI トレーナーの準備'),
      el('p', { class: 'muted' }, 'AI トレーナーは、Anthropic 公式の Claude Code（claude コマンド）を使って Claude と話します。最初に 1 回だけ準備が必要です。'),
      step(1, 'Claude Code をインストール', s1, j.installed ? el('div', { class: 'muted' }, 'インストール済みです')
        : el('div', {},
          el('div', { class: 'muted' }, '公式のインストーラーを自動で実行します（管理者権限は不要、数分かかります）。'),
          el('button', { class: 'btn small primary', disabled: installing, onclick: () => this.install() }, installing ? 'インストール中…' : (st.step === 'failed' ? 'もう一度試す' : 'インストールする')),
          st.error ? el('div', { style: { color: 'var(--dn)' } }, 'インストールできませんでした: ' + st.error) : null,
          (installing || st.error) && st.log ? el('pre', { class: 'setup-log' }, st.log.slice(-1200)) : null)),
      step(2, 'Claude にログイン', s2, j.loggedIn ? el('div', { class: 'muted' }, 'ログイン済みです')
        : el('div', {},
          el('div', { class: 'muted' }, '「ログイン」を押すと窓が開き、続けてブラウザで Claude のログイン画面が開きます。ログインして「承認」を押してください。'),
          el('div', { class: 'muted' }, 'Claude の Pro / Max などの有料プラン、または Anthropic Console のアカウントが必要です（無料プランでは使えません）。'),
          el('button', { class: 'btn small primary', disabled: !j.installed, onclick: () => this.login() }, st.loginOpened ? 'ログインの窓をもう一度開く' : 'ログイン'),
          st.loginOpened ? el('div', { class: 'muted' }, 'ログインが終わると、ここは自動で切り替わります…') : null)));
  }
  hideSetup() {
    if (this.poll) { clearInterval(this.poll); this.poll = null; }
    if (this.setupBox) { this.setupBox.remove(); this.setupBox = null; toast('AI トレーナーの準備ができました', 'ok'); }
  }
  async post(path) {
    const r = await fetch(path, { method: 'POST', headers: HDR }).catch(() => null);
    const j = r ? await r.json().catch(() => ({})) : { error: 'サーバーに接続できません' };
    if (!r?.ok) toast(j.error || 'エラー', 'err', 5000);
    return r?.ok;
  }
  async install() { this.autoLogin = true; await this.post('api/setup/install'); this.check(); }
  async login() { await this.post('api/setup/login'); this.check(true); }
  // 起動時: Windows 版で未セットアップなら、自動セットアップを提案する
  async offerSetup() {
    await this.ready;
    const j = this.info;
    if (j?.host !== 'desktop' || this.available || store.get('setupOffered', false)) return;
    store.set('setupOffered', true);
    modal('AI トレーナーを使いますか？', el('div', {},
      el('p', {}, 'Claude と話しながら売買ルールを作り、そのままチャートでバックテストできます。'),
      el('p', { class: 'muted' }, '使うには Claude Code（Anthropic 公式）のインストールと、Claude の有料プラン（Pro / Max など）でのログインが必要です。インストールは自動で行い、ログインは画面で案内します。'),
      el('p', { class: 'muted' }, 'あとからでも「AI トレーナー」タブで準備できます。')), {
      width: 460,
      buttons: [{ label: 'あとで' }, { label: 'セットアップする', primary: true, onclick: () => { this.app.showBottom(4, 460); if (!j.installed) this.install(); else this.login(); } }],
    });
  }
  empty() {
    if (this.history.length || this.setupBox) return;
    this.log.innerHTML = '';
    this.log.append(...[el('div', { class: 'empty' }, this.mode === 'rules'
      ? 'トレーナーと話しながら、機械的に判定できる取引ルールを決めます。決まったルールはコードになり、「▶ チャートで回す」でバックテストやリプレイ中の自動売買に使えます。「ルール作りを始める」を押すか、やりたいトレードを書いてください。'
      : 'Claude がトレード記録を読んで、癖や改善点を教えてくれます。上のボタンを押すか、質問を書いてください。'),
      this.info === null && !this.available ? el('div', { class: 'empty muted' }, '（AI トレーナーは Windows 版で使えます。', el('a', { href: RELEASES, target: '_blank', rel: 'noopener' }, 'ダウンロード'), '）') : null].filter(Boolean));
  }
  reset() { this.stop(); this.history = []; this.session = null; this.empty(); }

  // ---------- 送るデータ ----------
  async analyzeSession() {
    if (this.mode !== 'coach') this.setMode('coach');
    const r = this.app.recorder;
    const sid = r.session?.id;
    const all = await r.loadAll();
    const list = sid ? all.filter((t) => t.sessionId === sid) : [];
    if (!list.length) { toast('今のリプレイにはまだ決済した取引がありません。「全取引」を試してください'); return; }
    this.reset();
    this.send(`${toAIText(list, [r.session], { title: '今のセッションの取引' })}\n\n${this.liveState()}\n\nこのセッションを振り返ってください。良かった点、繰り返している悪い癖、次のセッションで試すルールを3つ挙げてください。`, 'high', `今のセッション（${list.length} 件）を分析`);
  }
  async analyzeAll() {
    if (this.mode !== 'coach') this.setMode('coach');
    const r = this.app.recorder;
    const all = await r.loadAll();
    if (!all.length) { toast('まだ記録された取引がありません'); return; }
    const sessions = await import('./journal.js').then((m) => m.jdb.all('sessions')).catch(() => []);
    this.reset();
    const limit = 400;
    if (all.length > limit) toast(`取引が ${all.length} 件あるため、直近 ${limit} 件の詳細と全件の集計を送ります`);
    this.send(`${toAIText(all, sessions, { title: 'これまでの全取引', limit })}\n\nこれまでの記録全体から、勝てている条件と負けている条件（時間帯・相場状況・エントリー方法・保有時間・損切りの使い方など）を見つけ、改善のための具体的なルールを提案してください。`, 'high', `全取引（${all.length} 件）を分析`);
  }
  askSituation() {
    if (this.mode !== 'coach') this.setMode('coach');
    if (!this.app.inReplay()) { toast('リプレイ中に使えます'); return; }
    this.send(`${this.liveState(true)}\n\nいまの局面について、どんな見方ができるか、エントリーするならどこに損切り・利確を置く考え方があるか、見送るべき理由はあるかを整理してください。`, 'medium', '今の局面を相談');
  }
  liveState(withBars) {
    const a = this.app, r = a.replay, sym = a.sym;
    if (!a.inReplay()) return '';
    const n = r.countClosed();
    const bars = r.bars.slice(Math.max(0, n - 400), n);
    const ctx = marketContext(bars, r.lastPrice, r.T, r.tf, sym);
    const m = a.manual, p = m?.pos;
    const lines = [
      `## 現在の状況（リプレイ中の時点。これより先のデータはありません）`,
      `- 銘柄 ${sym.id}、時間足 ${r.tf / 60} 分、時刻 ${fmtTime(r.T)}、現在値 ${fmtNum(r.lastPrice, sym.digits)}`,
      `- 相場状況: ${JSON.stringify(ctx)}`,
      m ? `- 口座: 残高 ${fmtNum(m.balance, 2)} ${sym.quote}、有効証拠金 ${fmtNum(m.equity(), 2)}、レバレッジ ${m.cfg.leverage}倍` : '',
      p?.qty ? `- 保有: ${p.qty > 0 ? '買い' : '売り'} ${Math.abs(p.qty)} @ ${p.avg}、損切り ${p.sl ?? 'なし'}、利確 ${p.tp ?? 'なし'}、評価損益 ${fmtNum(m.unrealized(), 2)}` : '- 保有: なし',
      m?.orders.length ? `- 待機注文: ${m.orders.map((o) => `${o.side > 0 ? '買' : '売'}${o.type === 'limit' ? '指値' : '逆指値'} ${o.price}`).join(', ')}` : '',
      a.ov.drawings.length ? `- チャートに引いた線: ${a.ov.drawings.filter((d) => d.type === 'hline' || d.type === 'hray').map((d) => fmtNum(d.pts[0].p, sym.digits)).join(', ') || 'トレンドライン等 ' + a.ov.drawings.length + ' 本'}` : '',
    ];
    if (withBars) {
      const recent = bars.slice(-60).map((b) => [fmtTime(b.t).slice(5), b.o, b.h, b.l, b.c].join(' '));
      lines.push(`- 直近 ${recent.length} 本の足（日時 始 高 安 終）:\n${recent.join('\n')}`);
    }
    return lines.filter(Boolean).join('\n');
  }

  // ---------- 送受信 ----------
  ask() {
    const q = this.input.value.trim();
    if (!q || this.busy) return;
    this.input.value = '';
    const extra = this.history.length ? '' : this.mode === 'rules' ? `\n\n${this.rulesContext()}` : `\n\n参考データ:\n${this.liveState()}`;
    this.send(q + extra, 'medium', q);
  }
  bubble(role, text) {
    if (!this.history.length && this.log.querySelector('.empty')) this.log.innerHTML = '';
    const b = el('div', { class: 'msg ' + role });
    if (role === 'user') b.textContent = text; else b.innerHTML = text;
    this.log.append(b);
    this.log.scrollTop = this.log.scrollHeight;
    return b;
  }
  async send(content, effort, shown) {
    if (this.busy) return;
    if (!this.available && !(await this.check())) { toast(this.info?.host === 'desktop' ? 'AI トレーナーの準備が必要です（下の案内に従ってください）' : 'AI トレーナーは Windows 版で使えます', 'err', 4000); return; }
    this.bubble('user', shown || content);
    this.history.push({ role: 'user', content });
    const out = this.bubble('assistant', '<span class="thinking">考えています…</span>');
    this.busy = true; this.sendBtn.textContent = '停止';
    this.ctrl = new AbortController();
    let text = '', done = null, err = null;
    try {
      const r = await fetch(API, {
        method: 'POST', signal: this.ctrl.signal,
        headers: { ...HDR, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: content, session: this.session, model: this.model.value, effort, mode: this.mode, files: await this.workspace().catch(() => null) }),
      });
      if (!r.ok) throw new Error('サーバーエラー (' + r.status + ')');
      const reader = r.body.getReader(), dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done: end } = await reader.read();
        if (end) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          const m = JSON.parse(line);
          if (m.t === 'start') this.session = m.session;
          else if (m.t === 'text') { text += m.v; out.innerHTML = md(text); this.log.scrollTop = this.log.scrollHeight; }
          else if (m.t === 'tool') { text += `${text && !text.endsWith('\n') ? '\n' : ''}${TOOL}${m.v}\n\n`; out.innerHTML = md(text); this.log.scrollTop = this.log.scrollHeight; }
          else if (m.t === 'done') done = m;
          else if (m.t === 'error') err = m.v;
        }
      }
      if (done?.error) err = done.result || 'Claude Code がエラーを返しました';
      if (done?.session) this.session = done.session;
      if (err && !text) throw new Error(err);
      this.history.push({ role: 'assistant', content: text });
      if (this.mode === 'rules') this.strategyCard(out, text);
      if (done?.usage) out.append(el('div', { class: 'usage' }, `入力 ${(done.usage.input_tokens + (done.usage.cache_read_input_tokens || 0) + (done.usage.cache_creation_input_tokens || 0)).toLocaleString()} / 出力 ${done.usage.output_tokens.toLocaleString()} トークン`));
    } catch (e) {
      this.history.pop();
      const msg = e.name === 'AbortError' ? '停止しました' : e.message;
      out.innerHTML = (text ? md(text) : '') + `<p class="dn">${esc(msg)}</p>`;
    } finally {
      this.busy = false; this.sendBtn.textContent = '送信'; this.ctrl = null;
    }
  }
  stop() { try { this.ctrl?.abort(); } catch { /* */ } }

  // ---------- Claude が読めるファイル ----------
  // 送信のたびに、ブラウザ内の記録や今のチャートをファイルにしてサーバーへ渡す（作業フォルダの data/ に書き出される）
  async workspace() {
    const a = this.app, r = a.replay, sym = a.sym, f = {};
    const json = (v) => JSON.stringify(v, null, 1);
    const trades = await a.recorder.loadAll().catch(() => []);
    const sessions = await jdb.all('sessions').catch(() => []);
    let events = await jdb.all('events').catch(() => []);
    if (events.length > 50000) events = events.slice(-50000);
    f['trades.json'] = json(trades);
    f['trades.csv'] = toCSV(trades);
    f['sessions.json'] = json(sessions);
    f['events.json'] = json(events);
    f['STRATEGY_API.md'] = STRATEGY_API;
    for (const p of PRESETS) f[`strategies/preset-${p.id}.js`] = p.code;
    a.customStrategies().forEach((c, i) => { f[`strategies/custom-${i + 1}-${c.id}.js`] = c.code; });
    const bars = a.inReplay() ? r.closedBars() : r.bars;
    f['chart/bars.csv'] = 'time,unix,open,high,low,close,volume\n' + bars.map((b) => [fmtISO(b.t), b.t, b.o, b.h, b.l, b.c, b.v ?? ''].join(',')).join('\n');
    f['chart/state.json'] = json({
      symbol: sym, timeframeMinutes: r.tf / 60, inReplay: a.inReplay(), replayTime: a.inReplay() ? fmtISO(r.T) : null, lastPrice: r.lastPrice,
      account: a.accountCfg(), live: a.inReplay() ? this.liveState() : null, strategy: a.strat ? { name: a.strat.compiled?.name, inputs: a.strat.inputs, error: a.strat.error || null } : null,
    });
    if (a.strat && a.bt) {
      f['backtest/code.js'] = a.strat.code;
      f['backtest/result.json'] = json({ name: a.strat.compiled?.name, inputs: a.strat.inputs, symbol: sym.id, timeframeMinutes: r.tf / 60, bars: a.bt.bars.length,
        from: a.bt.bars[0] ? fmtISO(a.bt.bars[0].t) : null, to: a.bt.bars.length ? fmtISO(a.bt.bars[a.bt.bars.length - 1].t) : null, stats: a.bt.acc.stats(), error: a.strat.error || null });
      f['backtest/trades.json'] = json(a.bt.acc.trades);
    }
    f['README.md'] = [
      '# Trade Replay から送られたデータ（メッセージを送るたびに最新に置き換わります）',
      '時刻は日本時間の文字列（time / *Time）と UNIX 秒（unix / t / entryT / exitT）。',
      `- trades.json / trades.csv: 手動・自動売買の全取引の記録（${trades.length} 件。建玉時・決済時の相場状況 ctxEntry/ctxExit、保有中の操作 ops、メモ・タグを含む）`,
      `- sessions.json: リプレイのセッション（${sessions.length} 件）`,
      `- events.json: 操作ログ（注文・損切り変更など。直近 ${events.length} 件）`,
      '- STRATEGY_API.md: ストラテジーの書き方。strategies/ にプリセットと自作のコード',
      `- chart/bars.csv: 今のチャートの足（${sym.id}・${r.tf / 60}分足・${bars.length} 本${a.inReplay() ? '。リプレイ中なので現在時刻までの確定足だけ' : ''}）。chart/state.json: 銘柄の設定・口座・現在の状況`,
      a.bt ? `- backtest/: 今チャートで回しているストラテジーのコード・成績・全取引（${a.bt.acc.trades.length} 件）` : '- backtest/: （今はストラテジーを回していないのでありません）',
    ].join('\n');
    return f;
  }

  // ---------- ルール作り ----------
  rulesContext() {
    const a = this.app, sym = a.sym, cfg = a.accountCfg();
    const n = a.replay.bars.length;
    const first = a.replay.bars[0], last = a.replay.bars[n - 1];
    return [STRATEGY_API, '', '## 今のチャート',
      `- 銘柄 ${sym.id}（${sym.type === 'fx' ? 'FX、1pips = ' + sym.pip : '暗号資産'}、価格の桁 ${sym.digits}、数量の刻み ${sym.qtyStep}、注文パネルの既定数量 ${sym.qty}）`,
      `- 時間足 ${a.replay.tf / 60} 分、チャート上の足 ${n} 本（${first ? fmtTime(first.t) : ''} 〜 ${last ? fmtTime(last.t) : ''}）`,
      `- 口座: 初期資金 ${cfg.balance.toLocaleString()} ${sym.quote}、レバレッジ ${cfg.leverage} 倍${cfg.spread ? '、スプレッド ' + cfg.spread : ''}${cfg.fee ? '、手数料 ' + cfg.fee * 100 + '%' : ''}`,
    ].join('\n');
  }
  startRules() {
    this.setMode('rules');
    this.reset();
    this.send(`${this.rulesContext()}\n\n取引ルールを一緒に作りたいです。私がどんなトレードをしたいか、順番に質問してください。`, 'medium', 'ルール作りを始める');
  }
  async rulesFromJournal() {
    const all = await this.app.recorder.loadAll();
    if (!all.length) { toast('まだ記録された取引がありません。リプレイで取引するか、「ルール作りを始める」から話してください'); return; }
    this.setMode('rules');
    this.reset();
    const limit = 300;
    this.send(`${this.rulesContext()}\n\n${toAIText(all, [], { title: '私のこれまでの取引記録', limit })}\n\nこの記録から、勝てている条件と負けている条件を見つけ、勝てている条件を機械的なルールにしたいです。まず見つけたことを短く説明し、ルールの案を示して、決めるべき点を質問してください。`, 'high', `取引記録（${all.length} 件）からルールを作る`);
  }
  codify() {
    if (this.mode !== 'rules' || !this.history.length) { toast('先に「ルール作りを始める」でルールを話し合ってください'); return; }
    this.send('ここまでの内容でルールを確定し、日本語の箇条書きのまとめと、```strategy のコードを出してください。未定の点は妥当な既定値を選んで、そう書いてください。', 'medium', 'コードにしてチャートで回す');
  }
  feedBacktest() {
    const a = this.app, bt = a.bt;
    if (!a.strat || !bt) { toast('先にストラテジーをチャートで回してください'); return; }
    const s = bt.acc.stats(), sym = a.sym, tr = bt.acc.trades;
    const f2 = (v) => (Number.isFinite(v) ? v.toFixed(2) : String(v));
    const lines = [
      `## バックテスト結果: ${a.strat.compiled?.name}（${sym.id}・${a.replay.tf / 60}分足・確定足 ${bt.bars.length} 本、${bt.bars[0] ? fmtTime(bt.bars[0].t) : ''} 〜 ${bt.bars.length ? fmtTime(bt.bars[bt.bars.length - 1].t) : ''}）`,
      `- 入力: ${JSON.stringify(a.strat.inputs)}`,
      `- 純利益 ${f2(s.net)} ${sym.quote}（${f2(s.netPct)}%）、取引 ${s.n}、勝率 ${f2(s.winRate)}%、PF ${f2(s.pf)}、最大DD ${f2(s.maxDD)}（${f2(s.maxDDpct)}%）、平均損益 ${f2(s.avg)}、平均利益 ${f2(s.avgWin)}、平均損失 ${f2(s.avgLoss)}、最大連敗 ${s.maxLossStreak}`,
      `- 買い: ${s.long.n} 件 勝率 ${f2(s.long.win)}% 損益 ${f2(s.long.net)} / 売り: ${s.short.n} 件 勝率 ${f2(s.short.win)}% 損益 ${f2(s.short.net)}`,
      a.strat.error ? `- 実行時エラー: ${a.strat.error}` : '',
      `- 取引（直近 ${Math.min(80, tr.length)} 件。時刻は日本時間）:`,
      ...tr.slice(-80).map((t) => `${t.dir > 0 ? '買' : '売'} ${fmtTime(t.entryT)}→${fmtTime(t.exitT)} ${t.entry}→${t.exit} ${f2(t.pnl)} ${t.reason}`),
      '', '## 今のコード', '```strategy', a.strat.code, '```',
      '', 'この結果を見て、問題点と改善案を出し、改善したコードを ```strategy で出してください。',
    ];
    this.setMode('rules');
    this.send(lines.filter(Boolean).join('\n'), 'high', `バックテスト結果を渡して改善（${s.n} 件、純利益 ${f2(s.net)}）`);
  }
  // 返答の中のストラテジーのコードを見つけて「チャートで回す」ボタンを付ける
  strategyCard(out, text) {
    const blocks = [...text.matchAll(/```(?:strategy|javascript|js)\s*\n([\s\S]*?)```/g)];
    if (!blocks.length) return;
    const code = blocks[blocks.length - 1][1].trim() + '\n';
    let compiled = null, err = null;
    try { compiled = compile(code); } catch (e) { err = e.message; }
    const card = el('div', { class: 'strat-card' });
    if (compiled) {
      card.append(el('b', {}, '📈 ' + compiled.name),
        el('button', { class: 'btn small primary', onclick: () => this.runStrategy(code, false) }, '▶ チャートで回す（バックテスト）'),
        el('button', { class: 'btn small', onclick: () => this.runStrategy(code, true), title: 'リプレイ中に別の口座で自動売買し、手動と比べられます' }, '◆ 自動売買も ON'),
        el('button', { class: 'btn small', onclick: () => { this.app.editor.open({ kind: 'new' }, code); this.app.showBottom(2); } }, 'エディターで開く'));
    } else {
      card.append(el('span', { class: 'dn' }, 'コードを読み込めませんでした: ' + err),
        el('button', { class: 'btn small', onclick: () => this.send(`コードを読み込んだところエラーになりました: ${err}\n直したコードを \`\`\`strategy で出してください。`, 'medium', 'エラーを直してもらう') }, 'AI に直してもらう'));
    }
    out.append(card);
  }
  runStrategy(code, auto) {
    const a = this.app;
    const list = a.customStrategies();
    const name = compile(code).name;
    // 同じ名前の自作ストラテジーは上書き（改善を繰り返しても一覧が増えすぎないように）
    let item = list.find((c) => compile(c.code).name === name);
    if (item) item.code = code; else { item = { id: Math.random().toString(36).slice(2, 9), code }; list.push(item); }
    a.saveCustomStrategies(list);
    store.set('stratInputs.custom:' + item.id, {});
    a.selectStrategy('custom:' + item.id);
    if (auto && !a.autoOn) a.toggleAuto();
    a.showBottom(1);
    const s = a.bt?.acc.stats();
    if (a.strat?.error) toast('実行中にエラーが出ました: ' + a.strat.error + '（AI トレーナーに伝えると直してもらえます）', 'err', 6000);
    else toast(`${name} をチャートで回しました${s ? `: ${s.n} 件、純利益 ${s.net.toFixed(2)}` : ''}${auto ? '。リプレイ中は自動売買もします' : ''}`, 'info', 5000);
  }

  // 取引の詳細画面から
  reviewTrade(rec) {
    this.app.showBottom(4);
    if (this.mode !== 'coach') this.setMode('coach');
    this.reset();
    this.send(`${toAIText([rec], [], { title: '1件の取引' })}\n\nこの取引をレビューしてください。エントリーの根拠として妥当だった点、損切り・利確・保有中の操作の良し悪し、同じ場面で次にどうするとよいかを教えてください。`, 'medium', `取引のレビュー: ${rec.sym} ${rec.dir === 'long' ? '買い' : '売り'} ${fmtTime(rec.entryT)}`);
    void summarize;
  }
}

const TOOL = '\u2063⚙ ';
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }
// 最低限の Markdown 表示（エスケープしてから整形）
function md(src) {
  const blocks = esc(src).split(/```/);
  return blocks.map((b, i) => {
    if (i % 2) return `<pre>${b.replace(/^\w*\n/, '')}</pre>`;
    const lines = b.split('\n');
    let html = '', list = null;
    const inline = (s) => s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
    let table = null;
    const flushTable = () => {
      if (!table) return;
      const rows = table.filter((r) => !/^\|?\s*:?-{2,}/.test(r)).map((r) => r.replace(/^\||\|$/g, '').split('|').map((c) => inline(c.trim())));
      html += '<table class="tbl md-tbl">' + rows.map((r, i) => '<tr>' + r.map((c) => (i ? `<td>${c}</td>` : `<th>${c}</th>`)).join('') + '</tr>').join('') + '</table>';
      table = null;
    };
    for (const l of lines) {
      if (/^\s*\|.*\|\s*$/.test(l)) { if (list) { html += `</${list}>`; list = null; } (table ||= []).push(l.trim()); continue; }
      if (table && !l.trim()) continue;
      flushTable();
      const m = l.match(/^\s*([-*]|\d+\.)\s+(.*)/);
      if (m) { const tag = /\d/.test(m[1]) ? 'ol' : 'ul'; if (list !== tag) { if (list) html += `</${list}>`; html += `<${tag}>`; list = tag; } html += `<li>${inline(m[2])}</li>`; continue; }
      if (list) { html += `</${list}>`; list = null; }
      const h = l.match(/^(#{1,4})\s+(.*)/);
      if (h) html += `<h${h[1].length + 2}>${inline(h[2])}</h${h[1].length + 2}>`;
      else if (l.startsWith(TOOL)) html += `<div class="tool-line">${l.slice(1)}</div>`;
      else if (l.trim() === '---') html += '<hr>';
      else if (l.trim()) html += `<p>${inline(l)}</p>`;
    }
    flushTable();
    if (list) html += `</${list}>`;
    return html;
  }).join('');
}
