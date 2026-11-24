// AI コーチ: Cloud Shell で `Trading` から起動したときだけ、ローカルサーバー経由で `claude -p` に相談する
// （GitHub Pages など、サーバーがない環境では使えない旨を表示する）
import { el, store, toast, fmtNum, fmtTime } from './util.js';
import { toAIText, marketContext, summarize } from './journal.js';

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
    root.append(
      el('div', { class: 'coach-head' }, el('b', {}, 'AI コーチ（claude -p）'), this.model, this.status, el('span', { class: 'grow' }),
        el('button', { class: 'btn small', onclick: () => this.reset() }, '会話をリセット')),
      el('div', { class: 'coach-quick' },
        el('button', { class: 'btn small', onclick: () => this.analyzeSession() }, '今のセッションを振り返る'),
        el('button', { class: 'btn small', onclick: () => this.analyzeAll() }, '全取引の傾向と改善点'),
        el('button', { class: 'btn small', onclick: () => this.askSituation() }, '今の局面を相談')),
      this.log,
      el('div', { class: 'coach-foot' }, this.input, this.sendBtn));
    this.empty();
    this.check();
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
    this.log.append(el('div', { class: 'empty' }, 'Claude がトレード記録を読んで、癖や改善点を教えてくれます。上のボタンを押すか、質問を書いてください。（Cloud Shell で `Trading` を実行して開いたときだけ使えます）'));
  }
  reset() { this.stop(); this.history = []; this.session = null; this.empty(); }

  // ---------- 送るデータ ----------
  async analyzeSession() {
    const r = this.app.recorder;
    const sid = r.session?.id;
    const all = await r.loadAll();
    const list = sid ? all.filter((t) => t.sessionId === sid) : [];
    if (!list.length) { toast('今のリプレイにはまだ決済した取引がありません。「全取引」を試してください'); return; }
    this.reset();
    this.send(`${toAIText(list, [r.session], { title: '今のセッションの取引' })}\n\n${this.liveState()}\n\nこのセッションを振り返ってください。良かった点、繰り返している悪い癖、次のセッションで試すルールを3つ挙げてください。`, 'high', `今のセッション（${list.length} 件）を分析`);
  }
  async analyzeAll() {
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
    const extra = this.history.length ? '' : `\n\n参考データ:\n${this.liveState()}`;
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
        body: JSON.stringify({ prompt: content, session: this.session, model: this.model.value, effort }),
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

  // 取引の詳細画面から
  reviewTrade(rec) {
    this.app.showBottom(4);
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
