// トレード記録タブ: 一覧・分析・セッション・取引の詳細（メモ・タグ）・書き出し
import { el, fmtNum, fmtSigned, fmtTime, fmtDur, toast } from './util.js';
import { tabs, modal } from './ui.js';
import { jdb, summarize, GROUPS, groupBy, toCSV, toAIText, download } from './journal.js';

const TAG_SUGGEST = ['順張り', '逆張り', 'ブレイク', '押し目', '戻り売り', 'レンジ', 'ルール通り', 'ルール違反', '感情的', '早すぎ', '遅すぎ', '損切りが遅い', '利確が早い', 'ナンピン'];
const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'dn' : '');
const dig = (q) => (q === 'JPY' ? 0 : 2);
const fR = (v) => (v == null ? '—' : fmtSigned(v, 2) + 'R');

export class JournalPanel {
  constructor(root, app) {
    this.app = app;
    this.tab = 0;
    this.f = { acc: 'all', sym: 'all', session: 'all', tag: 'all' };
    this.head = el('div', { class: 'tester-head' });
    this.body = el('div', { class: 'tester-body' });
    this.tabsEl = tabs(['取引一覧', '分析', 'セッション'], (i) => { this.tab = i; this.render(); });
    root.append(this.head, el('div', { class: 'panel-sub' }, this.tabsEl), this.body);
    app.recorder.onChange(() => { if (this.visible) this.render(); });
  }
  async data() {
    const all = await this.app.recorder.loadAll();
    let sessions = [];
    try { sessions = await jdb.all('sessions'); } catch { /* */ }
    sessions.sort((a, b) => b.createdAt - a.createdAt);
    const f = this.f;
    const list = all.filter((t) => (f.acc === 'all' || t.acc === f.acc) && (f.sym === 'all' || t.sym === f.sym) && (f.session === 'all' || t.sessionId === f.session) && (f.tag === 'all' || t.tags?.includes(f.tag)));
    return { all, list, sessions };
  }
  async render() {
    const { all, list, sessions } = await this.data();
    this.renderHead(all, list, sessions);
    this.body.innerHTML = '';
    if (!all.length) { this.body.append(el('div', { class: 'empty' }, 'リプレイで取引すると、ここにすべて記録されます（建値・決済・損益・保有中の操作・エントリー時の相場状況など）。記録はこのブラウザに保存され、ページを閉じても残ります。')); return; }
    if (this.tab === 0) this.renderList(list);
    else if (this.tab === 1) this.renderAnalysis(list);
    else this.renderSessions(sessions, all);
  }
  renderHead(all, list, sessions) {
    const f = this.f;
    const sel = (k, opts) => el('select', { onchange: (e) => { f[k] = e.target.value; this.render(); } }, ...opts.map(([v, l]) => el('option', { value: v, selected: f[k] === v }, l)));
    const syms = [...new Set(all.map((t) => t.sym))];
    const tags = [...new Set(all.flatMap((t) => t.tags || []))];
    this.head.innerHTML = '';
    this.head.append(
      sel('acc', [['all', '口座: すべて'], ['manual', '手動'], ['auto', '◆ 自動売買']]),
      sel('sym', [['all', '銘柄: すべて'], ...syms.map((s) => [s, s])]),
      sel('session', [['all', 'セッション: すべて'], ...sessions.map((s) => [s.id, `${s.sym} ${fmtTime(s.startT).slice(0, 10)}〜（${new Date(s.createdAt).toLocaleDateString('ja-JP')}）`])]),
      tags.length ? sel('tag', [['all', 'タグ: すべて'], ...tags.map((t) => [t, '#' + t])]) : '',
      el('span', { class: 'muted' }, `${list.length} 件`),
      el('span', { class: 'grow' }),
      el('button', { class: 'btn small', title: 'Excel などで開ける CSV（1取引1行、相場状況の列つき）', onclick: () => this.exportCSV(list) }, 'CSV'),
      el('button', { class: 'btn small', title: 'セッション・取引・すべての操作ログを含む JSON', onclick: () => this.exportJSON() }, 'JSON（全データ）'),
      el('button', { class: 'btn small', title: 'ChatGPT や Claude に貼り付けやすい形でコピー', onclick: () => this.copyAI(list, sessions) }, 'AI 用にコピー'),
      el('button', { class: 'btn small primary', onclick: () => { this.app.showBottom(4); this.app.coach.analyzeAll(); } }, 'AI コーチで分析'),
      el('button', { class: 'btn small danger', onclick: () => this.clear() }, '削除'));
  }

  renderList(list) {
    if (!list.length) { this.body.append(el('div', { class: 'empty' }, '条件に合う取引はありません')); return; }
    const rows = list.slice(-1000).reverse();
    const tb = el('table', { class: 'tbl' },
      el('thead', {}, el('tr', {}, ...['決済日時', '銘柄', '口座', '売買', '数量', '建値', '決済値', '損益', 'R', '資金比', '保有', '入り方', '決済理由', 'RSI', 'タグ', 'メモ'].map((h) => el('th', {}, h)))),
      el('tbody', {}, ...rows.map((t) => {
        const tr = el('tr', { style: { cursor: 'pointer' }, onclick: () => this.detail(t) },
          el('td', {}, fmtTime(t.exitT)), el('td', {}, t.sym), el('td', {}, t.acc === 'auto' ? '◆自動' : '手動'),
          el('td', {}, el('span', { class: 'side ' + (t.dir === 'long' ? 'buy' : 'sell') }, t.dir === 'long' ? '買い' : '売り')),
          el('td', {}, fmtNum(t.qty, 4).replace(/\.?0+$/, '')), el('td', {}, String(t.entry)), el('td', {}, String(t.exit)),
          el('td', {}, el('span', { class: cls(t.pnl) }, fmtSigned(t.pnl, dig(t.quote)) + ' ' + t.quote)),
          el('td', {}, el('span', { class: cls(t.R) }, fR(t.R))),
          el('td', {}, el('span', { class: cls(t.pnlPctEquity) }, t.pnlPctEquity == null ? '—' : fmtSigned(t.pnlPctEquity, 2) + '%')),
          el('td', {}, fmtDur(t.holdSec)), el('td', {}, t.entryReason || ''), el('td', {}, t.exitReason || ''),
          el('td', {}, t.ctxEntry?.rsi14 ?? '—'),
          el('td', {}, (t.tags || []).map((x) => '#' + x).join(' ')), el('td', { class: 'note-cell' }, t.note || ''));
        return tr;
      })));
    this.body.append(el('div', { class: 'tbl-wrap' }, tb));
    if (list.length > rows.length) this.body.append(el('div', { class: 'muted', style: { padding: '6px 10px' } }, `表示は直近 ${rows.length} 件です（書き出しには全 ${list.length} 件が入ります）`));
  }

  renderAnalysis(list) {
    if (!list.length) { this.body.append(el('div', { class: 'empty' }, '条件に合う取引はありません')); return; }
    const s = summarize(list);
    const tile = (k, v, c = '', sub = '') => el('div', { class: 'tile' }, el('span', {}, k), el('b', { class: c }, v), sub ? el('small', {}, sub) : null);
    this.body.append(el('div', { class: 'tiles' },
      tile('取引数', String(s.n), '', `${s.wins} 勝`),
      tile('勝率', s.winRate == null ? '—' : fmtNum(s.winRate, 1) + '%'),
      tile('プロフィットファクター', s.pf == null ? '—' : s.pf === Infinity ? '∞' : fmtNum(s.pf, 2), s.pf >= 1 ? 'up' : 'dn'),
      tile('平均R', s.avgR == null ? '—' : fmtSigned(s.avgR, 2), cls(s.avgR), `損切りあり ${s.nR} 件`),
      tile('1取引の平均（資金比）', s.avgPctEq == null ? '—' : fmtSigned(s.avgPctEq, 2) + '%', cls(s.avgPctEq)),
      tile('最大連敗', String(s.maxLossStreak)),
      tile('平均保有', s.avgHold == null ? '—' : fmtDur(s.avgHold)),
      tile('損益', Object.entries(s.byCur).map(([k, v]) => `${fmtSigned(v, dig(k))} ${k}`).join(' / ') || '—')));
    const grid = el('div', { class: 'groups' });
    for (const g of GROUPS) {
      const rows = groupBy(list, g);
      if (rows.length < 2 && g.id !== 'sym') continue;
      const maxAbs = Math.max(...rows.map((r) => Math.abs(r.avgPctEq ?? 0)), 0.0001);
      grid.append(el('div', { class: 'group' }, el('h5', {}, g.label),
        el('table', { class: 'tbl' }, el('thead', {}, el('tr', {}, ...['', '件数', '勝率', '平均R', '平均(資金比)', ''].map((h) => el('th', {}, h)))),
          el('tbody', {}, ...rows.map((r) => el('tr', {},
            el('td', {}, String(r.key)), el('td', {}, r.n), el('td', {}, r.winRate == null ? '—' : fmtNum(r.winRate, 0) + '%'),
            el('td', {}, el('span', { class: cls(r.avgR) }, r.avgR == null ? '—' : fmtSigned(r.avgR, 2))),
            el('td', {}, el('span', { class: cls(r.avgPctEq) }, r.avgPctEq == null ? '—' : fmtSigned(r.avgPctEq, 2) + '%')),
            el('td', { class: 'barcell' }, el('i', { class: (r.avgPctEq ?? 0) >= 0 ? 'pos' : 'neg', style: { width: Math.round((Math.abs(r.avgPctEq ?? 0) / maxAbs) * 60) + 'px' } }))))))));
    }
    this.body.append(grid);
  }

  renderSessions(sessions, all) {
    const rows = sessions.map((s) => {
      const tr = all.filter((t) => t.sessionId === s.id);
      const m = summarize(tr.filter((t) => t.acc === 'manual'));
      return el('tr', { style: { cursor: 'pointer' }, onclick: () => { this.f.session = s.id; this.tabsEl.select(0); } },
        el('td', {}, new Date(s.createdAt).toLocaleString('ja-JP')), el('td', {}, s.sym),
        el('td', {}, `${fmtTime(s.startT)} 〜 ${s.lastT ? fmtTime(s.lastT) : ''}`),
        el('td', {}, m.n), el('td', {}, m.winRate == null ? '—' : fmtNum(m.winRate, 0) + '%'),
        el('td', {}, el('span', { class: cls(s.manual?.net) }, s.manual ? fmtSigned(s.manual.net, dig(s.quote)) + ' ' + s.quote : '—')),
        el('td', {}, s.manual?.maxDDpct != null ? fmtNum(s.manual.maxDDpct, 1) + '%' : '—'),
        el('td', {}, s.auto ? `◆ ${s.auto.strategy || ''} ${fmtSigned(s.auto.net, dig(s.quote))}` : ''),
        el('td', {}, s.endedAt ? '終了' : '途中'));
    });
    this.body.append(el('div', { class: 'tbl-wrap' }, el('table', { class: 'tbl' },
      el('thead', {}, el('tr', {}, ...['開始', '銘柄', 'リプレイした期間', '取引', '勝率', '手動の損益', '最大DD', '自動売買', '状態'].map((h) => el('th', {}, h)))),
      el('tbody', {}, ...rows))));
  }

  // ---------- 詳細 ----------
  detail(t) {
    const q = t.quote, d = dig(q);
    const kv = (k, v, c = '') => el('div', { class: 'kv2' }, el('span', {}, k), el('b', { class: c }, v ?? '—'));
    const ctxTable = (title, c) => {
      if (!c) return el('div', {});
      const L = { hour: '時', weekday: '曜日', session: '市場', price: '価格', rsi14: 'RSI14', devSMA20: 'SMA20乖離%', devSMA50: 'SMA50乖離%', devSMA200: 'SMA200乖離%', ema20Slope: 'EMA20傾き%', trend: 'トレンド', atr14: 'ATR14', atrPct: 'ATR%', bbPctB: 'BB %b', bbWidthPct: 'BB幅%', ret5: '5本騰落%', ret20: '20本騰落%', rangePos20: '20本レンジ内位置', distHigh20ATR: '20本高値まで(ATR)', distLow20ATR: '20本安値から(ATR)', volRatio: '出来高比', speed: '再生速度', decisionSec: '考えた秒数', equity: '有効証拠金', drawings: '描画数', strategy: 'ストラテジー' };
      return el('div', { class: 'ctx' }, el('h5', {}, title), el('div', { class: 'ctx-grid' }, ...Object.entries(L).filter(([k]) => c[k] != null).map(([k, l]) => kv(l, typeof c[k] === 'number' ? String(c[k]) : String(c[k])))),
        c.lastBar ? el('small', { class: 'muted' }, `直前の足: ${c.lastBar.dir}（実体 ${c.lastBar.bodyPct}%）、連続 ${Math.abs(c.lastBar.streak)} 本`) : '',
        c.indicatorsShown?.length ? el('small', { class: 'muted' }, ' 表示中: ' + c.indicatorsShown.join(', ')) : '');
    };
    const OPN = { order_place: '注文', order_cancel: '注文取消', order_modify: '注文変更', sl_change: '損切り変更', tp_change: '利確変更' };
    const ops = (t.ops || []).map((o) => el('li', {}, `${fmtTime(o.t)} ${OPN[o.type] || o.type} ${o.data?.from != null ? o.data.from + ' → ' : ''}${o.data?.to ?? o.data?.price ?? ''}`));
    const note = el('textarea', { class: 'note-in', rows: 3, placeholder: 'エントリーの理由、そのときの気持ち、反省など' });
    note.value = t.note || '';
    note.addEventListener('keydown', (e) => e.stopPropagation());
    const tagIn = el('input', { type: 'text', value: (t.tags || []).join(' '), placeholder: 'スペース区切り（例: 押し目 ルール通り）' });
    tagIn.addEventListener('keydown', (e) => e.stopPropagation());
    const chips = el('div', { class: 'chips' }, ...TAG_SUGGEST.map((x) => el('button', { class: 'chip', onclick: () => { const s = new Set(tagIn.value.split(/\s+/).filter(Boolean)); s.has(x) ? s.delete(x) : s.add(x); tagIn.value = [...s].join(' '); } }, x)));
    const save = async () => {
      t.note = note.value.trim();
      t.tags = [...new Set(tagIn.value.split(/[\s,、]+/).map((x) => x.replace(/^#/, '')).filter(Boolean))];
      await this.app.recorder.updateTrade(t);
      toast('保存しました');
    };
    modal(`${t.sym} ${t.dir === 'long' ? '買い' : '売り'} ・ ${fmtTime(t.entryT)}`, el('div', { class: 'trade-detail' },
      el('div', { class: 'ctx-grid' },
        kv('損益', `${fmtSigned(t.pnl, d)} ${q}`, cls(t.pnl)), kv('R倍数', fR(t.R), cls(t.R)), kv('資金比', t.pnlPctEquity == null ? '—' : fmtSigned(t.pnlPctEquity, 2) + '%', cls(t.pnlPctEquity)),
        kv('建値 → 決済値', `${t.entry} → ${t.exit}`), kv('数量', String(t.qty)), kv('pips', t.pips == null ? '—' : fmtSigned(t.pips, 1)),
        kv('保有', `${fmtDur(t.holdSec)}（${t.holdBars} 本）`), kv('入り方', t.entryReason), kv('決済理由', t.exitReason),
        kv('最初の損切り / 利確', `${t.initSL ?? 'なし'} / ${t.initTP ?? 'なし'}`), kv('決済時の損切り / 利確', `${t.slAtExit ?? 'なし'} / ${t.tpAtExit ?? 'なし'}`),
        kv('最大含み益', `${fmtNum(t.mfe, d)}${t.mfeR != null ? `（${fmtNum(t.mfeR, 2)}R）` : ''}`, 'up'), kv('最大含み損', `${fmtNum(t.mae, d)}${t.maeR != null ? `（${fmtNum(t.maeR, 2)}R）` : ''}`, 'dn'),
        kv('資金に対する証拠金', t.marginPct == null ? '—' : fmtNum(t.marginPct, 1) + '%'), kv('手数料', fmtNum(t.fees, d)), kv('口座', t.acc === 'auto' ? '◆ 自動売買 ' + (t.strategy || '') : '手動')),
      ctxTable('エントリー時の相場', t.ctxEntry), ctxTable('決済時の相場', t.ctxExit),
      ops.length ? el('div', { class: 'ctx' }, el('h5', {}, '保有中の操作'), el('ul', { class: 'ops' }, ...ops)) : '',
      el('div', { class: 'ctx' }, el('h5', {}, 'メモ'), note, el('h5', {}, 'タグ'), tagIn, chips)),
    { width: 760, buttons: [
      { label: 'AI コーチにレビューしてもらう', onclick: () => { save(); this.app.coach.reviewTrade(t); } },
      { label: '閉じる' },
      { label: '保存', primary: true, onclick: () => { save(); } },
    ] });
  }

  // ---------- 書き出し ----------
  stamp() { return new Date().toISOString().slice(0, 16).replace(/[-:T]/g, ''); }
  exportCSV(list) { download(`trades-${this.stamp()}.csv`, toCSV(list), 'text/csv'); }
  async exportJSON() {
    const [sessions, trades, events] = await Promise.all([jdb.all('sessions'), jdb.all('trades'), jdb.all('events')]);
    download(`trade-replay-${this.stamp()}.json`, JSON.stringify({ format: 'trade-replay-journal', version: 1, exportedAt: new Date().toISOString(), sessions, trades, events }, null, 1), 'application/json');
  }
  async copyAI(list, sessions) {
    const txt = toAIText(list, sessions);
    try { await navigator.clipboard.writeText(txt); toast(`AI 用のテキスト（${list.length} 件）をコピーしました`); }
    catch { download(`trades-ai-${this.stamp()}.md`, txt); toast('コピーできなかったのでファイルに保存しました'); }
  }
  async clear() {
    if (!confirm('記録したすべての取引・セッション・操作ログを削除します。元に戻せません。先に JSON で書き出しておくことをおすすめします。削除しますか？')) return;
    await this.app.recorder.clearAll();
    toast('記録を削除しました');
  }
}
