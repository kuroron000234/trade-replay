// AI コーチ: 利用者自身の API キーで Claude を呼び、トレード記録を分析・相談する
// API キーと記録はこのブラウザから api.anthropic.com へ直接送られる（このサイトのサーバーは経由しない）
import { el, store, toast, fmtNum, fmtTime } from './util.js';
import { toAIText, marketContext, summarize } from './journal.js';

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.7.0/+esm';
let sdkP = null;
const loadSDK = () => (sdkP ||= import(SDK_URL).catch((e) => { sdkP = null; throw new Error('Anthropic SDK を読み込めませんでした: ' + e.message); }));

export const MODELS = [
  ['claude-opus-5-5', 'Claude Opus 5.5（標準）'],
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5'],
  ['claude-haiku-5-5', 'Claude Haiku 5.5（安い・速い）'],
];

const SYSTEM = `あなたはトレード練習のコーチです。ユーザーは過去の相場データをリアルタイムのように再生するデモ環境で練習しています（実際のお金は動いていません）。
- 渡された記録データに基づき、具体的な数字や取引の例（日時・銘柄）を挙げて、良い点・悪い癖・次に試すことを伝えてください。
- データから言えることと推測は分けてください。件数が少ないときは偏りの可能性に触れてください。
- 相場の先行きを断定したり、特定の売買を勧めたりはせず、判断の材料・リスク管理・ルール作りの観点で助言してください。
- 日本語で、見出しと箇条書きを使って簡潔に。`;

export class Coach {
  constructor(root, app) {
    this.app = app;
    this.history = [];
    this.busy = false;
    this.keyIn = el('input', { type: 'password', placeholder: 'sk-ant-...', value: store.get('apiKey', '') || sessionStorage.getItem('tr.apiKey') || '', autocomplete: 'off', class: 'key-in' });
    this.saveChk = el('input', { type: 'checkbox', checked: !!store.get('apiKey', '') });
    this.model = el('select', {}, ...MODELS.map(([v, l]) => el('option', { value: v, selected: v === store.get('coachModel', MODELS[0][0]) }, l)));
    this.model.onchange = () => store.set('coachModel', this.model.value);
    this.keyIn.onchange = () => this.persistKey();
    this.saveChk.onchange = () => this.persistKey();
    this.log = el('div', { class: 'coach-log' });
    this.input = el('textarea', { class: 'coach-in', rows: 2, placeholder: '質問を入力（Enter で送信、Shift+Enter で改行）' });
    this.input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.ask(); }
    });
    this.sendBtn = el('button', { class: 'btn small primary', onclick: () => (this.busy ? this.stop() : this.ask()) }, '送信');
    root.append(
      el('div', { class: 'coach-head' },
        el('label', { class: 'chk' }, 'API キー', this.keyIn),
        el('label', { class: 'chk', title: 'オフにするとこのタブを閉じるまでだけ覚えます' }, this.saveChk, 'このブラウザに保存'),
        this.model,
        el('a', { href: 'https://platform.claude.com/settings/keys', target: '_blank', rel: 'noopener', class: 'muted' }, 'キーを作る'),
        el('span', { class: 'grow' }),
        el('button', { class: 'btn small', onclick: () => this.reset() }, '会話をリセット')),
      el('div', { class: 'coach-quick' },
        el('button', { class: 'btn small', onclick: () => this.analyzeSession() }, '今のセッションを振り返る'),
        el('button', { class: 'btn small', onclick: () => this.analyzeAll() }, '全取引の傾向と改善点'),
        el('button', { class: 'btn small', onclick: () => this.askSituation() }, '今の局面を相談'),
        el('span', { class: 'muted' }, 'キーと記録はこのブラウザから Anthropic の API に直接送られます。利用料はキーの持ち主に請求されます。')),
      this.log,
      el('div', { class: 'coach-foot' }, this.input, this.sendBtn));
    this.empty();
  }
  persistKey() {
    const k = this.keyIn.value.trim();
    if (this.saveChk.checked) store.set('apiKey', k); else store.set('apiKey', '');
    try { sessionStorage.setItem('tr.apiKey', k); } catch { /* */ }
  }
  empty() {
    if (this.history.length) return;
    this.log.innerHTML = '';
    this.log.append(el('div', { class: 'empty' }, 'Claude がトレード記録を読んで、癖や改善点を教えてくれます。上のボタンを押すか、質問を書いてください。'));
  }
  reset() { this.stop(); this.history = []; this.empty(); }

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
    const key = this.keyIn.value.trim();
    if (!key) { toast('API キーを入れてください', 'err'); this.keyIn.focus(); return; }
    this.persistKey();
    this.bubble('user', shown || content);
    this.history.push({ role: 'user', content });
    const out = this.bubble('assistant', '<span class="thinking">考えています…</span>');
    this.busy = true; this.sendBtn.textContent = '停止';
    let text = '';
    try {
      const { default: Anthropic } = await loadSDK();
      this.Anthropic = Anthropic;
      const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
      const model = this.model.value;
      const params = { model, max_tokens: 64000, system: SYSTEM, messages: this.history, output_config: { effort } };
      // 安全分類器で断られたときに別モデルへ自動で切り替える（Haiku は非対応）
      if (model !== 'claude-haiku-5-5') { params.betas = ['server-side-fallback-2026-07-01']; params.fallbacks = 'default'; }
      this.stream = client.beta.messages.stream(params);
      for await (const ev of this.stream) {
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') {
          text += ev.delta.text;
          out.innerHTML = md(text);
          this.log.scrollTop = this.log.scrollHeight;
        }
      }
      const msg = await this.stream.finalMessage();
      if (msg.stop_reason === 'refusal') {
        out.innerHTML = md(text) + '<p class="dn">（この内容には答えられないと判断されました）</p>';
        this.history.pop();
      } else {
        this.history.push({ role: 'assistant', content: msg.content });
        if (msg.stop_reason === 'max_tokens') out.innerHTML += '<p class="muted">（長さの上限で途中までになりました）</p>';
        const u = msg.usage;
        out.append(el('div', { class: 'usage' }, `${model} ・ 入力 ${u.input_tokens.toLocaleString()} / 出力 ${u.output_tokens.toLocaleString()} トークン`));
      }
    } catch (e) {
      this.history.pop();
      const A = this.Anthropic;
      let msg = e.message;
      if (A && e instanceof A.AuthenticationError) msg = 'API キーが正しくありません';
      else if (A && e instanceof A.PermissionDeniedError) msg = 'このキーではこのモデルを使えません';
      else if (A && e instanceof A.RateLimitError) msg = '利用制限に達しました。しばらく待ってから試してください';
      else if (A && e instanceof A.APIUserAbortError) msg = '停止しました';
      else if (A && e instanceof A.APIConnectionError) msg = 'Anthropic の API に接続できませんでした';
      out.innerHTML = (text ? md(text) : '') + `<p class="dn">${esc(msg)}</p>`;
    } finally {
      this.busy = false; this.sendBtn.textContent = '送信'; this.stream = null;
    }
  }
  stop() { try { this.stream?.abort(); } catch { /* */ } }

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
    for (const l of lines) {
      const m = l.match(/^\s*([-*]|\d+\.)\s+(.*)/);
      if (m) { const tag = /\d/.test(m[1]) ? 'ol' : 'ul'; if (list !== tag) { if (list) html += `</${list}>`; html += `<${tag}>`; list = tag; } html += `<li>${inline(m[2])}</li>`; continue; }
      if (list) { html += `</${list}>`; list = null; }
      const h = l.match(/^(#{1,4})\s+(.*)/);
      if (h) html += `<h${h[1].length + 2}>${inline(h[2])}</h${h[1].length + 2}>`;
      else if (l.trim() === '---') html += '<hr>';
      else if (l.trim()) html += `<p>${inline(l)}</p>`;
    }
    if (list) html += `</${list}>`;
    return html;
  }).join('');
}
