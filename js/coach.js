// AI コーチ: Cloud Shell で `Trading` から起動したときだけ、ローカルサーバー経由で `claude -p` に相談する
// （GitHub Pages など、サーバーがない環境では使えない旨を表示する）
import { el, store, toast, fmtNum, fmtTime } from './util.js';
import { toAIText, marketContext, summarize } from './journal.js';
import { STRATEGY_API, compile } from './strategy.js';

export const MODELS = [
  ['', 'Claude Code の既定モデル'],
  ['opus', 'Opus'],
  ['sonnet', 'Sonnet'],
  ['haiku', 'Haiku（速い）'],
];
const API = 'api/coach';
const HDR = { 'X-Trade-Replay': '1' };

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
    this.check();
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
  async check() {
    try {
      const r = await fetch(API + '/status', { headers: HDR, cache: 'no-store' });
      const j = r.ok ? await r.json() : null;
      this.available = !!j?.available;
    } catch { this.available = false; }
    this.status.textContent = this.available ? 'Cloud Shell の Claude Code を使います（ツールは使わず、記録を読んで答えるだけ）' : '';
    this.status.className = this.available ? 'muted' : 'dn';
    if (!this.available) this.status.textContent = 'このページでは使えません。Cloud Shell で `Trading` を実行して開いたページで使えます';
    return this.available;
  }
  empty() {
    if (this.history.length) return;
    this.log.innerHTML = '';
    this.log.append(el('div', { class: 'empty' }, this.mode === 'rules'
      ? 'トレーナーと話しながら、機械的に判定できる取引ルールを決めます。決まったルールはコードになり、「▶ チャートで回す」でバックテストやリプレイ中の自動売買に使えます。「ルール作りを始める」を押すか、やりたいトレードを書いてください。'
      : 'Claude がトレード記録を読んで、癖や改善点を教えてくれます。上のボタンを押すか、質問を書いてください。'), el('div', { class: 'empty muted' }, '（Cloud Shell で `Trading` を実行して開いたときだけ使えます）'));
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
    if (!this.available && !(await this.check())) { toast('AI コーチは Cloud Shell で `Trading` を実行して開いたページで使えます', 'err', 4000); return; }
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
        body: JSON.stringify({ prompt: content, session: this.session, model: this.model.value, effort, mode: this.mode }),
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
      `- 入力: ${JSON.stringify(a.stratInputs())}`,
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
      else if (l.trim() === '---') html += '<hr>';
      else if (l.trim()) html += `<p>${inline(l)}</p>`;
    }
    flushTable();
    if (list) html += `</${list}>`;
    return html;
  }).join('');
}
