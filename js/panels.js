// 下部パネル（取引・ストラテジーテスター・エディター）と右の注文パネル
import { el, fmtNum, fmtSigned, fmtTime, fmtDur, store, toast, clamp } from './util.js';
import { tabs, modal, form, menu } from './ui.js';
import { PRESETS, TEMPLATE, compile } from './strategy.js';
import { qtyDigits } from './drawings.js';

export const moneyDigits = (sym) => (sym.quote === 'JPY' ? 0 : 2);
const money = (v, sym) => fmtNum(v, moneyDigits(sym));
const smoney = (v, sym) => fmtSigned(v, moneyDigits(sym));
const pnlCls = (v) => (v > 0 ? 'up' : v < 0 ? 'dn' : '');

// ================= 取引パネル =================
export class TradingPanel {
  constructor(root, app) {
    this.app = app;
    this.root = root;
    this.which = 'manual';
    this.tab = 0;
    this.summary = el('div', { class: 'acct-summary' });
    this.body = el('div', { class: 'tbl-wrap' });
    this.tabsEl = tabs(['ポジション', '注文', '取引履歴', '約定', 'ログ'], (i) => { this.tab = i; this.lastKey = null; this.refresh(true); });
    root.append(el('div', { class: 'panel-sub' }, this.tabsEl), this.summary, this.body);
  }
  acc() { const a = this.app.accounts(); return this.which === 'strategy' && a.strategy ? a.strategy : a.manual; }
  refresh(force) {
    const app = this.app, a = app.accounts();
    if (this.which === 'strategy' && !a.strategy) this.which = 'manual';
    const acc = this.acc();
    if (!acc) { this.summary.innerHTML = ''; this.body.innerHTML = '<div class="empty">リプレイを開始すると取引できます</div>'; return; }
    const sym = acc.sym, q = sym.quote;
    const realized = acc.balance - acc.cfg.balance;
    const ml = acc.marginLevel();
    this.summary.innerHTML = '';
    const sel = el('select', { class: 'acct-sel', onchange: (e) => { this.which = e.target.value; this.lastKey = null; this.refresh(true); } },
      el('option', { value: 'manual', selected: this.which === 'manual' }, '手動口座'),
      a.strategy ? el('option', { value: 'strategy', selected: this.which === 'strategy' }, '◆ 自動売買口座') : null);
    const kv = (k, v, cls = '') => el('div', { class: 'kv' }, el('span', {}, k), el('b', { class: cls }, v));
    this.summary.append(sel,
      kv('口座残高', money(acc.balance, sym) + ' ' + q),
      kv('有効証拠金', money(acc.equity(), sym)),
      kv('評価損益', smoney(acc.unrealized(), sym), pnlCls(acc.unrealized())),
      kv('実現損益', smoney(realized, sym), pnlCls(realized)),
      kv('必要証拠金', money(acc.marginUsed(), sym)),
      kv('余剰証拠金', money(acc.freeMargin(), sym)),
      kv('証拠金維持率', ml == null ? '—' : fmtNum(ml, 0) + '%', ml != null && ml < 150 ? 'dn' : ''),
      ...(a.strategy ? [this.compareChip(a)] : []));
    this.tabsEl.querySelectorAll('.tab').forEach((b, i) => {
      const n = [acc.pos.qty ? 1 : 0, acc.orders.length, acc.trades.length, acc.execs.length, acc.log.length][i];
      b.textContent = ['ポジション', '注文', '取引履歴', '約定', 'ログ'][i] + (n ? ` ${n}` : '');
    });
    const key = this.which + ':' + this.tab + ':' + acc.version;
    if (!force && this.tab !== 0 && key === this.lastKey) return;
    this.lastKey = key;
    this.body.innerHTML = '';
    this.body.append([this.positions, this.orders, this.trades, this.execs, this.logs][this.tab].call(this, acc));
  }
  compareChip(a) {
    const m = a.manual.equity() - a.manual.cfg.balance, s = a.strategy.equity() - a.strategy.cfg.balance;
    return el('div', { class: 'kv compare' }, el('span', {}, '手動 vs 自動'), el('b', {}, el('i', { class: pnlCls(m) }, smoney(m, a.manual.sym)), ' / ', el('i', { class: pnlCls(s) }, smoney(s, a.manual.sym))));
  }
  positions(acc) {
    const p = acc.pos, sym = acc.sym, own = acc === this.app.accounts().manual;
    if (!p.qty) return el('div', { class: 'empty' }, 'ポジションはありません');
    const u = acc.unrealized();
    const qd = qtyDigits(sym);
    const pips = sym.pip ? ` (${fmtSigned(((p.qty > 0 ? acc.bid : acc.ask) - p.avg) * Math.sign(p.qty) / sym.pip, 1)} pips)` : '';
    const parts = acc.orders.filter((o) => o.reduceOnly);
    const partTxt = (type) => parts.filter((o) => o.type === type).map((o) => `${fmtNum(o.price, sym.digits)}×${fmtNum(o.qty, qd)}`).join(' / ');
    const withParts = (main, type) => { const t = partTxt(type); return t ? el('span', {}, main, el('small', { class: 'muted', title: '一部決済の注文（「注文」タブで変更・取消）' }, ' ＋' + t)) : main; };
    return table(['銘柄', '売買', '数量', '平均取得価格', '現在値', '損切り', '利確', 'トレール幅', '評価損益', '保有時間', ''], [[
      sym.id, sideTag(p.qty), fmtNum(Math.abs(p.qty), qd), fmtNum(p.avg, sym.digits), fmtNum(p.qty > 0 ? acc.bid : acc.ask, sym.digits),
      withParts(own ? editable(p.sl, sym, (v) => acc.setBrackets(v, undefined)) : fmtOr(p.sl, sym), 'stop'),
      withParts(own ? editable(p.tp, sym, (v) => acc.setBrackets(undefined, v)) : fmtOr(p.tp, sym), 'limit'),
      own ? editable(p.trail, sym, (v) => acc.setTrail(v), '価格の幅（例: 損切りを最高値の 500 下に付けて追いかける）。空にすると解除') : fmtOr(p.trail, sym),
      el('span', { class: pnlCls(u) }, smoney(u, sym) + pips), fmtDur(acc.t - p.t),
      own ? el('span', { class: 'row-btns' },
        el('button', { class: 'mini', onclick: () => closeDialog(this.app), title: '成行・指値・逆指値で、数量や割合を決めて一部だけ決済します' }, '一部決済…'),
        el('button', { class: 'mini', onclick: () => this.app.closePosition(0.5) }, '半分決済'),
        el('button', { class: 'mini', onclick: () => this.app.breakeven(), title: '損切りを建値（手数料込み）に移します' }, '建値に損切り'),
        el('button', { class: 'mini', onclick: () => this.app.reverse() }, 'ドテン'),
        el('button', { class: 'mini danger', onclick: () => this.app.closePosition() }, '決済')) : '',
    ]]);
  }
  orders(acc) {
    const sym = acc.sym, own = acc === this.app.accounts().manual;
    if (!acc.orders.length) return el('div', { class: 'empty' }, '待機中の注文はありません');
    const tpOf = (o) => (o.tps ? o.tps.map((x) => `${fmtNum(x.price, sym.digits)}(${x.pct}%)`).join(' / ') : fmtOr(o.tp, sym));
    return table(['種類', '売買', '数量', '価格', '損切り', '利確', '発注時刻', ''], acc.orders.map((o) => [
      o.reduceOnly ? el('span', { title: '決済専用（ポジションを減らすだけで、反対のポジションは作りません）' }, `決済${o.type === 'limit' ? '指値' : '逆指値'}${o.label ? '・' + o.label : ''}`) : o.type === 'limit' ? '指値' : '逆指値',
      sideTag(o.side), fmtNum(o.qty, qtyDigits(sym)),
      own ? editable(o.price, sym, (v) => v != null && acc.modifyOrder(o.id, { price: v })) : fmtNum(o.price, sym.digits),
      fmtOr(o.sl, sym), tpOf(o), fmtTime(o.t), own ? el('button', { class: 'mini danger', onclick: () => acc.cancelOrder(o.id) }, '取消') : '',
    ]));
  }
  trades(acc) {
    const sym = acc.sym;
    if (!acc.trades.length) return el('div', { class: 'empty' }, 'まだ決済した取引はありません');
    return table(['#', '売買', '数量', '建値', '決済値', '損益', '手数料', '理由', '建玉時刻', '決済時刻'], acc.trades.slice(-300).reverse().map((t, i) => [
      acc.trades.length - i, sideTag(t.dir), fmtNum(t.qty, qtyDigits(sym)), fmtNum(t.entry, sym.digits), fmtNum(t.exit, sym.digits),
      el('span', { class: pnlCls(t.pnl) }, smoney(t.pnl, sym)), money(t.fees, sym), t.reason, fmtTime(t.entryT), fmtTime(t.exitT),
    ]));
  }
  execs(acc) {
    const sym = acc.sym;
    if (!acc.execs.length) return el('div', { class: 'empty' }, '約定はまだありません');
    return table(['時刻', '売買', '数量', '価格', '内容'], acc.execs.slice(-300).reverse().map((x) => [fmtTime(x.t, true), sideTag(x.side), fmtNum(x.qty, qtyDigits(sym)), fmtNum(x.px, sym.digits), x.reason]));
  }
  logs(acc) {
    if (!acc.log.length) return el('div', { class: 'empty' }, 'ログはありません');
    return table(['時刻', '内容'], acc.log.slice(-300).reverse().map((x) => [fmtTime(x.t), x.msg]));
  }
}

function table(head, rows) {
  return el('table', { class: 'tbl' }, el('thead', {}, el('tr', {}, ...head.map((h) => el('th', {}, h)))), el('tbody', {}, ...rows.map((r) => el('tr', {}, ...r.map((c) => el('td', {}, c))))));
}
const sideTag = (s) => el('span', { class: 'side ' + (s > 0 ? 'buy' : 'sell') }, s > 0 ? '買い' : '売り');
const fmtOr = (v, sym) => (v == null ? '—' : fmtNum(v, sym.digits));
// ポジションの一部決済（成行・指値・逆指値。数量は割合か直接入力）
function closeDialog(app) {
  const acc = app.accounts().manual, p = acc?.pos, sym = app.sym;
  if (!p?.qty) return;
  const all = Math.abs(p.qty), qd = qtyDigits(sym), long = p.qty > 0;
  let type = 'market';
  const price = el('input', { type: 'number', class: 'tk-in', step: 10 ** -sym.digits, value: (long ? acc.bid : acc.ask).toFixed(sym.digits) });
  const qty = el('input', { type: 'number', class: 'tk-in', step: sym.qtyStep, min: sym.qtyStep, max: all, value: (Math.round(all / 2 / sym.qtyStep) * sym.qtyStep).toFixed(qd) });
  const info = el('div', { class: 'muted' });
  const priceRow = el('label', { class: 'tk-row' }, el('span', {}, '価格'), price);
  const upd = () => {
    priceRow.hidden = type === 'market';
    const q = Math.min(all, +qty.value || 0), px = type === 'market' ? (long ? acc.bid : acc.ask) : +price.value;
    info.textContent = q > 0 && px ? `${fmtNum((q / all) * 100, 0)}% を決済 → 確定する損益 ${smoney((px - p.avg) * q * Math.sign(p.qty), sym)} ${sym.quote}${type === 'market' ? '' : '（約定したとき）'}` : '';
  };
  price.oninput = qty.oninput = upd;
  const body = el('div', { class: 'close-dlg' },
    el('div', { class: 'muted' }, `${long ? '買い' : '売り'} ${fmtNum(all, qd)} @ ${fmtNum(p.avg, sym.digits)}`),
    tabs(['成行', '指値（利確）', '逆指値（損切り）'], (i) => { type = ['market', 'limit', 'stop'][i]; upd(); }),
    priceRow,
    el('label', { class: 'tk-row' }, el('span', {}, '数量'), qty),
    el('div', { class: 'tk-pct' }, ...[25, 33, 50, 75, 100].map((pc) => el('button', { class: 'mini', onclick: () => { qty.value = (pc === 100 ? all : Math.max(sym.qtyStep, Math.round((all * pc) / 100 / sym.qtyStep) * sym.qtyStep)).toFixed(qd); upd(); } }, pc + '%'))),
    info);
  upd();
  modal('一部決済', body, { width: 380, buttons: [{ label: 'キャンセル' }, { label: '決済する', primary: true, onclick: () => {
    const q = Math.min(all, +qty.value || 0);
    if (!(q > 0)) { toast('数量を入れてください', 'err'); return false; }
    if (type === 'market') { app.recorder.op('close', { qty: q, of: all }); acc.closePosition('手動決済', q); return true; }
    return app.closeOrder(type, +price.value, 1, q);
  } }] });
}

function editable(v, sym, set, title = 'クリックで変更') {
  const sp = el('span', { class: 'editable', title }, v == null ? '＋設定' : fmtNum(v, sym.digits));
  sp.onclick = () => {
    const inp = el('input', { type: 'number', step: 10 ** -sym.digits, value: v ?? '', class: 'inline' });
    const done = (ok) => { if (ok) set(inp.value === '' ? null : +inp.value); };
    inp.onkeydown = (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); };
    inp.onblur = () => done(true);
    sp.replaceWith(inp); inp.focus(); inp.select();
  };
  return sp;
}

// ================= ストラテジーテスター =================
export class TesterPanel {
  constructor(root, app) {
    this.app = app;
    this.tab = 0;
    this.head = el('div', { class: 'tester-head' });
    this.body = el('div', { class: 'tester-body' });
    this.tabsEl = tabs(['概要', 'パフォーマンス', '取引一覧'], (i) => { this.tab = i; this.render(); });
    root.append(this.head, el('div', { class: 'panel-sub' }, this.tabsEl), this.body);
    this.renderHead();
  }
  renderHead() {
    const app = this.app, st = app.strat;
    this.head.innerHTML = '';
    const sel = el('select', { class: 'strat-sel', onchange: (e) => app.selectStrategy(e.target.value || null) },
      el('option', { value: '' }, '— ストラテジーなし —'),
      el('optgroup', { label: 'プリセット' }, ...PRESETS.map((p) => el('option', { value: 'preset:' + p.id, selected: st?.key === 'preset:' + p.id }, nameOf(p.code)))),
      el('optgroup', { label: '自作' }, ...app.customStrategies().map((c) => el('option', { value: 'custom:' + c.id, selected: st?.key === 'custom:' + c.id }, nameOf(c.code)))));
    this.head.append(sel);
    if (st) {
      this.head.append(
        el('button', { class: 'btn small', onclick: () => app.editStrategyInputs() }, '⚙ 設定'),
        el('label', { class: 'chk' }, el('input', { type: 'checkbox', checked: app.showStratOnChart, onchange: (e) => app.setShowStrat(e.target.checked) }), 'チャートに表示'),
        el('button', { class: 'btn small ' + (app.autoOn ? 'on-auto' : ''), title: 'リプレイ中、ストラテジーが別口座で自動売買します（手動と比較できます）', onclick: () => app.toggleAuto() }, app.autoOn ? '◆ 自動売買 ON' : '◇ 自動売買 OFF'),
        el('span', { class: 'muted' }, app.strat?.error ? '⚠ ' + app.strat.error : `期間: チャート上の確定足 ${app.bt?.bars.length ?? 0} 本`));
    }
  }
  render() {
    const app = this.app, bt = app.bt;
    this.body.innerHTML = '';
    if (!app.strat) { this.body.append(el('div', { class: 'empty' }, '上のメニューからストラテジーを選ぶと、チャート上のデータでバックテストします。自作はエディタータブで書けます。')); return; }
    if (!bt) { this.body.append(el('div', { class: 'empty' }, app.strat.error ? 'エラー: ' + app.strat.error : '計算中…')); return; }
    const acc = bt.acc, s = acc.stats(), sym = acc.sym;
    if (this.tab === 0) {
      const tile = (k, v, cls = '', sub = '') => el('div', { class: 'tile' }, el('span', {}, k), el('b', { class: cls }, v), sub ? el('small', {}, sub) : null);
      const tiles = el('div', { class: 'tiles' },
        tile('純利益', smoney(s.net, sym) + ' ' + sym.quote, pnlCls(s.net), fmtSigned(s.netPct, 2) + '%'),
        tile('総取引数', String(s.n)),
        tile('勝率', s.n ? fmtNum(s.winRate, 1) + '%' : '—', '', `${s.wins} 勝 ${s.losses} 敗`),
        tile('プロフィットファクター', s.pf === Infinity ? '∞' : s.n ? fmtNum(s.pf, 2) : '—', s.pf >= 1 ? 'up' : s.n ? 'dn' : ''),
        tile('最大ドローダウン', money(s.maxDD, sym), 'dn', fmtNum(s.maxDDpct, 2) + '%'),
        tile('平均損益', s.n ? smoney(s.avg, sym) : '—', pnlCls(s.avg)),
        tile('含み損益', smoney(s.open, sym), pnlCls(s.open)));
      const cv = el('canvas', { class: 'equity' });
      this.body.append(tiles, cv);
      requestAnimationFrame(() => drawEquity(cv, acc));
    } else if (this.tab === 1) {
      const r = (k, a, b, c) => el('tr', {}, el('td', {}, k), el('td', {}, a), el('td', {}, b ?? ''), el('td', {}, c ?? ''));
      this.body.append(el('table', { class: 'tbl perf' },
        el('thead', {}, el('tr', {}, el('th', {}, ''), el('th', {}, 'すべて'), el('th', {}, '買い'), el('th', {}, '売り'))),
        el('tbody', {},
          r('純利益', smoney(s.net, sym), smoney(s.long.net, sym), smoney(s.short.net, sym)),
          r('総利益', money(s.gp, sym)), r('総損失', money(-s.gl, sym)),
          r('プロフィットファクター', s.pf === Infinity ? '∞' : fmtNum(s.pf, 2)),
          r('最大ドローダウン', `${money(s.maxDD, sym)} (${fmtNum(s.maxDDpct, 2)}%)`),
          r('総取引数', s.n, s.long.n, s.short.n),
          r('勝率', fmtNum(s.winRate, 1) + '%', fmtNum(s.long.win, 1) + '%', fmtNum(s.short.win, 1) + '%'),
          r('平均損益', smoney(s.avg, sym)), r('平均利益', money(s.avgWin, sym)), r('平均損失', money(s.avgLoss, sym)),
          r('ペイオフレシオ', s.avgLoss ? fmtNum(s.avgWin / -s.avgLoss, 2) : '—'),
          r('最大利益', money(s.maxWin, sym)), r('最大損失', money(s.maxLoss, sym)),
          r('最大連敗', s.maxLossStreak), r('支払手数料', money(s.fees, sym)),
          r('初期資金', money(acc.cfg.balance, sym) + ' ' + sym.quote), r('レバレッジ', acc.cfg.leverage + ' 倍'))));
    } else {
      if (!acc.trades.length) { this.body.append(el('div', { class: 'empty' }, '取引はありません')); return; }
      let cum = 0;
      const rows = acc.trades.map((t, i) => { cum += t.pnl; return [i + 1, sideTag(t.dir), fmtTime(t.entryT), fmtNum(t.entry, sym.digits), fmtTime(t.exitT), fmtNum(t.exit, sym.digits), t.reason, fmtNum(t.qty, qtyDigits(sym)), el('span', { class: pnlCls(t.pnl) }, smoney(t.pnl, sym)), el('span', { class: pnlCls(cum) }, smoney(cum, sym)), el('span', { class: 'up' }, money(t.mfe ?? 0, sym)), el('span', { class: 'dn' }, money(t.mae ?? 0, sym))]; });
      const tb = table(['#', '売買', '建玉', '建値', '決済', '決済値', '理由', '数量', '損益', '累積損益', '最大含み益', '最大含み損'], rows.reverse().slice(0, 500));
      tb.querySelectorAll('tbody tr').forEach((tr, k) => { const t = acc.trades[acc.trades.length - 1 - k]; tr.style.cursor = 'pointer'; tr.onclick = () => this.app.scrollToTime(t.entryT, t.exitT); });
      this.body.append(tb);
    }
  }
}
const nameOf = (code) => (code.match(/const\s+name\s*=\s*['"`](.+?)['"`]/) || [])[1] || '無題';

function drawEquity(cv, acc) {
  const W = cv.clientWidth, H = cv.clientHeight, dpr = devicePixelRatio || 1;
  if (!W || !H) return;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  const pts = acc.curve;
  g.fillStyle = '#787b86'; g.font = '11px sans-serif';
  if (pts.length < 2) { g.fillText('損益曲線: 取引が始まると表示されます', 10, 20); return; }
  const base = acc.cfg.balance;
  let lo = Math.min(base, ...pts.map((p) => p.eq)), hi = Math.max(base, ...pts.map((p) => p.eq));
  if (hi === lo) { hi += 1; lo -= 1; }
  const pad = 8, x = (i) => pad + ((W - pad * 2 - 60) * i) / (pts.length - 1), y = (v) => pad + ((H - pad * 2) * (hi - v)) / (hi - lo);
  g.strokeStyle = '#2a2e39'; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(pad, y(base)); g.lineTo(W - 60, y(base)); g.stroke(); g.setLineDash([]);
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, 'rgba(41,98,255,0.35)'); grad.addColorStop(1, 'rgba(41,98,255,0)');
  g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(x(i), y(p.eq)) : g.moveTo(x(i), y(p.eq))));
  g.lineTo(x(pts.length - 1), H); g.lineTo(x(0), H); g.closePath(); g.fillStyle = grad; g.fill();
  g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(x(i), y(p.eq)) : g.moveTo(x(i), y(p.eq)))); g.strokeStyle = '#2962ff'; g.lineWidth = 1.5; g.stroke();
  g.fillStyle = '#787b86';
  const d = moneyDigits(acc.sym);
  g.fillText(fmtNum(hi, d), W - 56, pad + 8); g.fillText(fmtNum(lo, d), W - 56, H - pad);
}

// ================= エディター =================
export class EditorPanel {
  constructor(root, app) {
    this.app = app;
    this.cur = null; // {kind:'preset'|'custom'|'new', id}
    this.bar = el('div', { class: 'editor-bar' });
    this.gutter = el('div', { class: 'gutter' });
    this.ta = el('textarea', { class: 'code', spellcheck: 'false', wrap: 'off' });
    this.err = el('div', { class: 'editor-err' });
    this.ta.addEventListener('input', () => { this.dirty = true; this.lines(); this.renderBar(); });
    this.ta.addEventListener('scroll', () => { this.gutter.scrollTop = this.ta.scrollTop; });
    this.ta.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') { e.preventDefault(); document.execCommand('insertText', false, '  '); }
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); this.save(); }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); this.apply(); }
      e.stopPropagation();
    });
    root.append(this.bar, el('div', { class: 'editor' }, this.gutter, this.ta), this.err);
    this.open({ kind: 'new' }, store.get('editorDraft', TEMPLATE));
  }
  lines() { const n = this.ta.value.split('\n').length; this.gutter.textContent = Array.from({ length: n }, (_, i) => i + 1).join('\n'); }
  open(cur, code) { this.cur = cur; this.ta.value = code; this.dirty = false; this.err.textContent = ''; this.lines(); this.renderBar(); }
  renderBar() {
    const app = this.app;
    this.bar.innerHTML = '';
    const title = this.cur.kind === 'preset' ? `プリセット: ${nameOf(this.ta.value)}（保存すると自作にコピー）` : this.cur.kind === 'custom' ? `自作: ${nameOf(this.ta.value)}` : '新しいストラテジー';
    this.bar.append(
      el('button', { class: 'btn small', onclick: (e) => this.openMenu(e) }, '開く ▾'),
      el('button', { class: 'btn small', onclick: () => this.open({ kind: 'new' }, TEMPLATE) }, '新規'),
      el('button', { class: 'btn small', onclick: () => this.save() }, '保存'),
      this.cur.kind === 'custom' ? el('button', { class: 'btn small', onclick: () => this.del() }, '削除') : '',
      el('span', { class: 'muted' }, title + (this.dirty ? ' ●' : '')),
      el('span', { class: 'grow' }),
      el('button', { class: 'btn small', onclick: () => this.help() }, '書き方'),
      el('button', { class: 'btn small primary', onclick: () => this.apply(), title: 'Ctrl+Enter' }, '▶ 保存してチャートに追加'));
    void app;
  }
  openMenu(e) {
    const r = e.target.getBoundingClientRect();
    menu(r.left, r.bottom + 4, [
      { header: 'プリセット' },
      ...PRESETS.map((p) => ({ label: nameOf(p.code), onclick: () => this.open({ kind: 'preset', id: p.id }, p.code) })),
      '-', { header: '自作' },
      ...(this.app.customStrategies().length ? this.app.customStrategies().map((c) => ({ label: nameOf(c.code), onclick: () => this.open({ kind: 'custom', id: c.id }, c.code) })) : [{ label: '（まだありません）', disabled: true }]),
    ]);
  }
  check() {
    try { compile(this.ta.value); this.err.textContent = ''; return true; } catch (e) { this.err.textContent = '⚠ ' + e.message; return false; }
  }
  save() {
    if (!this.check()) return null;
    const list = this.app.customStrategies();
    let id = this.cur.kind === 'custom' ? this.cur.id : null;
    if (id) list.find((c) => c.id === id).code = this.ta.value;
    else { id = Math.random().toString(36).slice(2, 9); list.push({ id, code: this.ta.value }); this.cur = { kind: 'custom', id }; }
    this.app.saveCustomStrategies(list);
    store.set('editorDraft', TEMPLATE);
    this.dirty = false;
    this.renderBar();
    toast('保存しました: ' + nameOf(this.ta.value));
    return id;
  }
  del() {
    if (!confirm('このストラテジーを削除しますか？')) return;
    this.app.saveCustomStrategies(this.app.customStrategies().filter((c) => c.id !== this.cur.id));
    this.open({ kind: 'new' }, TEMPLATE);
  }
  apply() {
    const id = this.save();
    if (id) this.app.selectStrategy('custom:' + id, true);
  }
  help() {
    modal('ストラテジーの書き方', el('pre', { class: 'help-code' }, TEMPLATE.split('function onBar')[0] + `
// 例: 前の足の高値を上抜けたら買い、損切りは 2ATR、利確は 3ATR
function onBar(s, inp) {
  const atr = s.ta.atr(14).at(0);
  if (s.position.side === 0 && s.close.at(0) > s.high.at(1)) {
    s.entry('long', { sl: s.close.at(0) - 2 * atr, tp: s.close.at(0) + 3 * atr });
  }
}

// ・スクリプトは「足が確定するたび」に実行されます（未来の足は見えません）
// ・成行のエントリーは次の足の始値で約定します
// ・同じ方向に s.entry しても積み増しません（{ add: true } で積み増し）`), { width: 640 });
  }
}

// ================= 注文パネル（右） =================
export class Ticket {
  constructor(root, app) {
    this.app = app;
    this.root = root;
    this.side = 1;
    this.type = 'market';
    this.useSL = false; this.useTP = false; this.useTP2 = false;
    this.build();
  }
  build() {
    const r = this.root;
    r.innerHTML = '';
    this.symEl = el('div', { class: 'tk-sym' });
    this.sellBtn = el('button', { class: 'tk-side sell', onclick: () => this.setSide(-1) });
    this.buyBtn = el('button', { class: 'tk-side buy', onclick: () => this.setSide(1) });
    this.spreadEl = el('div', { class: 'tk-spread' });
    this.typeTabs = tabs(['成行', '指値', '逆指値'], (i) => { this.type = ['market', 'limit', 'stop'][i]; if (i) this.priceIn.value = this.fmtP(this.app.price() ?? 0); this.sync(); });
    this.priceIn = el('input', { type: 'number', class: 'tk-in' });
    this.priceRow = el('label', { class: 'tk-row' }, el('span', {}, '価格'), this.priceIn);
    this.qtyIn = el('input', { type: 'number', class: 'tk-in', oninput: () => this.sync(true) });
    this.qtyBtns = el('div', { class: 'tk-qbtns' });
    this.pctBtns = el('div', { class: 'tk-pct' }, el('span', {}, '資金の'),
      ...[10, 25, 50, 75, 100].map((p) => el('button', { class: 'mini', title: `有効証拠金の ${p}% を証拠金に使う数量（取引金額 = 資金 × ${p}% × レバレッジ）`, onclick: () => this.pctQty(p / 100) }, p + '%')));
    this.slChk = el('input', { type: 'checkbox', title: 'オンにするとチャートに損切りのラインが出て、ドラッグで価格を決められます', onchange: (e) => this.toggleBracket('sl', e.target.checked) });
    this.tpChk = el('input', { type: 'checkbox', title: 'オンにするとチャートに利確のラインが出て、ドラッグで価格を決められます', onchange: (e) => this.toggleBracket('tp', e.target.checked) });
    this.slIn = el('input', { type: 'number', class: 'tk-in', oninput: () => this.sync(true) });
    this.tpIn = el('input', { type: 'number', class: 'tk-in', oninput: () => this.sync(true) });
    this.slInfo = el('small', { class: 'tk-info dn' });
    this.tpInfo = el('small', { class: 'tk-info up' });
    // 分割利確: 利確1 で建てた数量の何%を決済するか。100% 未満なら残りを利確2 に置ける
    this.tpPct = el('select', { class: 'tk-tppct', title: '利確で決済する割合。100% 未満にすると、残りを「利確2」で別の価格に置けます', onchange: () => { if (this.tpPctV() >= 100) this.toggleBracket('tp2', false); this.sync(true); } },
      ...[100, 75, 50, 33, 25].map((v) => el('option', { value: v }, v + '%')));
    this.tp2Chk = el('input', { type: 'checkbox', onchange: (e) => this.toggleBracket('tp2', e.target.checked) });
    this.tp2In = el('input', { type: 'number', class: 'tk-in', oninput: () => this.sync(true) });
    this.tp2Info = el('small', { class: 'tk-info up' });
    this.tp2Row = el('div', { class: 'tk-br' }, el('label', { class: 'chk', title: '残りの数量を別の価格で利確します' }, this.tp2Chk, '利確2'), this.tp2In, this.tp2Info);
    this.reduceChk = el('input', { type: 'checkbox', onchange: () => this.sync() });
    this.reduceRow = el('label', { class: 'chk tk-reduce', title: '今のポジションを減らすだけの注文です。ポジションを超える分は約定せず、反対のポジションも作りません。ポジションが無くなると自動で取り消されます' }, this.reduceChk, '決済のみ（reduce-only）');
    this.infoEl = el('div', { class: 'tk-sum' });
    this.submit = el('button', { class: 'tk-submit', onclick: () => this.send() });
    this.hint = el('div', { class: 'tk-hint' });
    this.posBox = el('div', { class: 'tk-pos' });
    r.append(
      el('div', { class: 'panel-title' }, '注文'),
      this.symEl,
      el('div', { class: 'tk-sides' }, this.sellBtn, this.spreadEl, this.buyBtn),
      this.typeTabs, this.priceRow,
      el('label', { class: 'tk-row' }, el('span', {}, '数量'), this.qtyIn), this.qtyBtns, this.pctBtns,
      this.reduceRow,
      el('div', { class: 'tk-br' }, el('label', { class: 'chk' }, this.tpChk, '利確'), el('span', { class: 'tk-tpin' }, this.tpIn, this.tpPct), this.tpInfo),
      this.tp2Row,
      el('div', { class: 'tk-br' }, el('label', { class: 'chk' }, this.slChk, '損切り'), this.slIn, this.slInfo),
      this.infoEl, this.submit, this.hint, this.posBox);
  }
  fmtP(v) { return (+v).toFixed(this.app.sym.digits); }
  setSymbol(sym) {
    this.qtyIn.step = sym.qtyStep; this.qtyIn.min = sym.qtyStep;
    this.qtyIn.value = store.get('qty.' + sym.id, sym.qty);
    const st = 10 ** -sym.digits;
    for (const i of [this.priceIn, this.slIn, this.tpIn, this.tp2In]) i.step = st;
    this.qtyBtns.innerHTML = '';
    const preset = sym.type === 'fx' ? [1000, 10000, 50000, 100000] : [sym.qty / 10, sym.qty, sym.qty * 5, sym.qty * 10];
    for (const q of preset) this.qtyBtns.append(el('button', { class: 'mini', onclick: () => { this.qtyIn.value = q; this.sync(true); } }, fmtNum(q, qtyDigits(sym))));
    this.qtyBtns.append(el('button', { class: 'mini', title: 'リスク計算: 損切りまでの損失が口座の 1% になる数量', onclick: () => this.riskQty() }, 'リスク1%'));
    this.useSL = this.useTP = this.useTP2 = false; this.slChk.checked = this.tpChk.checked = this.tp2Chk.checked = false;
    this.sync();
  }
  qty() { return Math.max(0, +this.qtyIn.value || 0); }
  tpPctV() { return +this.tpPct.value || 100; }
  reduceOnly() { return this.type !== 'market' && this.reduceChk.checked; }
  entryPx() {
    const a = this.app, bid = a.price();
    if (this.type !== 'market') return +this.priceIn.value;
    return bid == null ? null : this.side > 0 ? bid + a.spread() : bid;
  }
  defaultBracket(k) {
    const e = this.entryPx(); if (e == null) return;
    const sym = this.app.sym;
    const base = sym.pip ? sym.pip * 20 : e * 0.01;
    // 損切りは base、利確はその2倍。ただしチャートの表示範囲からはみ出さないよう、その向きの余白の 8 割までにする
    const dir = k === 'sl' ? -this.side : this.side;
    let dist = k === 'sl' ? base : base * 2;
    const cv = this.app.cv, h = cv.paneRect?.().h;
    if (h) {
      const top = cv.priceOfY(0), bottom = cv.priceOfY(h);
      const room = dir > 0 ? top - e : e - bottom;
      if (room > 0) dist = Math.min(dist, room * 0.8);
    }
    if (k === 'sl' && this.useSL && !this.slIn.value) this.slIn.value = this.fmtP(e + dir * dist);
    if (k === 'tp' && this.useTP && !this.tpIn.value) this.tpIn.value = this.fmtP(e + dir * dist);
    if (k === 'tp2' && this.useTP2 && !this.tp2In.value) {
      // 利確2 は利確1 より先（なければ利確の既定位置の 1.5 倍）に置く
      const t1 = +this.tpIn.value || e + dir * dist;
      this.tp2In.value = this.fmtP(t1 + (t1 - e) * 0.5);
    }
  }
  // 資金（有効証拠金）の p 割を証拠金に使う数量
  pctQty(p) {
    const a = this.app, acc = a.accounts().manual, e = this.entryPx();
    if (e == null || !(e > 0)) { toast('価格がまだありません', 'err'); return; }
    const cfg = acc?.cfg ?? a.accountCfg();
    const equity = acc ? acc.equity() : cfg.balance;
    // 100% のときはスプレッド・手数料で証拠金不足にならないよう少し余裕を持たせる
    const safety = p >= 1 ? 0.99 - cfg.fee * cfg.leverage : 1;
    const step = a.sym.qtyStep;
    const q = Math.floor((equity * p * safety * cfg.leverage) / e / step) * step;
    if (q < step) { toast('資金が足りず、最小数量に届きません', 'err'); return; }
    this.qtyIn.value = q.toFixed(qtyDigits(a.sym));
    this.sync(true);
  }
  riskQty() {
    const e = this.entryPx(), sl = +this.slIn.value, acc = this.app.accounts().manual;
    if (!this.useSL || !sl || e == null || !acc) { toast('損切り価格を入れると、損失が口座の1%になる数量を計算します'); return; }
    const per = Math.abs(e - sl);
    const step = this.app.sym.qtyStep;
    this.qtyIn.value = Math.max(step, Math.floor((acc.equity() * 0.01) / per / step) * step).toFixed(qtyDigits(this.app.sym));
    this.sync(true);
  }
  sync(fromInput) {
    const a = this.app, sym = a.sym, bid = a.price(), on = a.canTrade();
    if (!sym) return;
    if (!fromInput) store.set('qty.' + sym.id, this.qty());
    this.symEl.innerHTML = `<b>${sym.id}</b> <span>${sym.name}</span>`;
    const ask = bid == null ? null : bid + a.spread();
    this.sellBtn.innerHTML = `<span>売り</span><b>${bid == null ? '—' : fmtNum(bid, sym.digits)}</b>`;
    this.buyBtn.innerHTML = `<span>買い</span><b>${ask == null ? '—' : fmtNum(ask, sym.digits)}</b>`;
    this.sellBtn.classList.toggle('on', this.side < 0); this.buyBtn.classList.toggle('on', this.side > 0);
    this.spreadEl.textContent = sym.pip ? fmtNum(a.spread() / sym.pip, 1) : a.spread() ? fmtNum(a.spread(), sym.digits) : '0';
    this.priceRow.hidden = this.type === 'market';
    this.slIn.disabled = !this.useSL; this.tpIn.disabled = !this.useTP; this.tp2In.disabled = !this.useTP2;
    const ro = this.reduceOnly();
    this.reduceRow.hidden = this.type === 'market';
    this.tpPct.disabled = !this.useTP;
    this.tp2Row.hidden = ro || !this.useTP || this.tpPctV() >= 100;
    for (const c of [this.slChk, this.tpChk]) c.disabled = ro;
    const e = this.entryPx(), q = this.qty();
    const amt = (p) => (p - e) * q * this.side;
    const dist = (p) => (sym.pip ? `${fmtNum(Math.abs(p - e) / sym.pip, 1)} pips` : `${fmtNum((Math.abs(p - e) / e) * 100, 2)}%`);
    this.slInfo.textContent = this.useSL && e && this.slIn.value ? `${smoney(amt(+this.slIn.value), sym)} ${sym.quote}（${dist(+this.slIn.value)}）` : '';
    const f1 = this.tpPctV() / 100;
    this.tpInfo.textContent = this.useTP && e && this.tpIn.value ? `${smoney(amt(+this.tpIn.value) * f1, sym)} ${sym.quote}（${dist(+this.tpIn.value)}${f1 < 1 ? '・' + this.tpPctV() + '%' : ''}）` : '';
    this.tp2Info.textContent = this.useTP2 && e && this.tp2In.value ? `${smoney(amt(+this.tp2In.value) * (1 - f1), sym)} ${sym.quote}（${dist(+this.tp2In.value)}・残り ${100 - this.tpPctV()}%）` : '';
    const acc = a.accounts().manual;
    const lev = acc?.cfg.leverage ?? a.accountCfg().leverage;
    this.infoEl.innerHTML = e ? `<div><span>取引金額</span><b>${money(e * q, sym)} ${sym.quote}</b></div><div><span>必要証拠金</span><b>${money((e * q) / lev, sym)} ${sym.quote}</b></div>${sym.pip ? `<div><span>1pips あたり</span><b>${money(sym.pip * q, sym)} ${sym.quote}</b></div>` : ''}<div><span>レバレッジ</span><b>${lev} 倍</b></div><div><span>資金に対する証拠金</span><b>${fmtNum(((e * q) / lev / (acc ? acc.equity() : a.accountCfg().balance)) * 100, 1)}%</b></div>` : '';
    const tname = { market: '成行', limit: '指値', stop: '逆指値' }[this.type];
    this.submit.className = 'tk-submit ' + (this.side > 0 ? 'buy' : 'sell');
    this.submit.disabled = !on;
    this.submit.innerHTML = `${ro ? '決済' : ''}${this.side > 0 ? '買い' : '売り'} ${fmtNum(q, qtyDigits(sym))} ${sym.id} <small>${this.type === 'market' ? '@ 成行' : tname + ' @ ' + this.priceIn.value}</small>`;
    this.hint.textContent = on ? 'Shift+B / Shift+S で成行の買い・売り。チャート上のラインはドラッグで変更できます' : '上の「リプレイ」で開始位置を選ぶと取引できます';
    this.renderPos();
  }
  renderPos() {
    const acc = this.app.accounts().manual;
    this.posBox.innerHTML = '';
    if (!acc?.pos.qty) return;
    const p = acc.pos, u = acc.unrealized();
    this.posBox.append(el('div', { class: 'tk-pos-row' }, el('span', {}, `${p.qty > 0 ? '買い' : '売り'} ${fmtNum(Math.abs(p.qty), qtyDigits(acc.sym))} @ ${fmtNum(p.avg, acc.sym.digits)}`), el('b', { class: pnlCls(u) }, smoney(u, acc.sym))),
      el('div', { class: 'tk-pos-btns' }, el('button', { class: 'btn small', onclick: () => this.app.reverse() }, 'ドテン'), el('button', { class: 'btn small danger', onclick: () => this.app.closeAllManual() }, '全決済')));
  }
  send() {
    const q = this.qty();
    const sym = this.app.sym;
    if (!(q > 0)) { toast('数量を入れてください', 'err'); return; }
    const ro = this.reduceOnly();
    const sl = !ro && this.useSL && this.slIn.value ? +this.slIn.value : null;
    let tp = !ro && this.useTP && this.tpIn.value ? +this.tpIn.value : null;
    const tp2 = tp != null && this.useTP2 && this.tp2In.value ? +this.tp2In.value : null;
    const e = this.entryPx();
    if (sl != null && (sl - e) * this.side >= 0) { toast('損切り価格が逆です（買いなら建値より下）', 'err'); return; }
    if (tp != null && (tp - e) * this.side <= 0) { toast('利確価格が逆です（買いなら建値より上）', 'err'); return; }
    if (tp2 != null && (tp2 - e) * this.side <= 0) { toast('利確2 の価格が逆です（買いなら建値より上）', 'err'); return; }
    // 分割利確は決済専用の指値として置く（100% のときは従来どおりポジションの利確）
    let tps = null;
    if (tp != null && this.tpPctV() < 100) {
      tps = [{ price: tp, pct: this.tpPctV() }];
      if (tp2 != null) tps.push({ price: tp2, pct: 100 - this.tpPctV() });
      tp = null;
    }
    const ok = this.type === 'market' ? this.app.marketOrder(this.side, q, { sl, tp, tps })
      : this.app.pendingOrder({ side: this.side, type: this.type, price: clamp(+this.priceIn.value, 0, Infinity), qty: q, sl, tp, tps, reduceOnly: ro, label: ro ? (this.type === 'limit' ? '利確' : '損切り') : '' });
    // 発注できたら予定ラインは片付ける（次の注文でまた有効にする）
    if (ok) { this.toggleBracket('sl', false); this.toggleBracket('tp', false); this.toggleBracket('tp2', false); }
    void sym;
  }
  setSide(side) {
    if (side === this.side) return;
    this.side = side;
    // 売買を切り替えたら、損切り・利確を新しい向きの初期位置に置き直す
    for (const k of ['sl', 'tp']) if (k === 'sl' ? this.useSL : this.useTP) { (k === 'sl' ? this.slIn : this.tpIn).value = ''; this.defaultBracket(k); }
    if (this.useTP2) { this.tp2In.value = ''; this.defaultBracket('tp2'); }
    this.sync();
  }
  toggleBracket(k, on) {
    if (k === 'sl') { this.useSL = on; this.slChk.checked = on; if (!on) this.slIn.value = ''; }
    else if (k === 'tp') { this.useTP = on; this.tpChk.checked = on; if (!on) { this.tpIn.value = ''; if (this.useTP2) this.toggleBracket('tp2', false); } }
    else if (k === 'tp2') { this.useTP2 = on; this.tp2Chk.checked = on; if (!on) this.tp2In.value = ''; }
    if (on) this.defaultBracket(k);
    this.sync();
  }
  // チャートでドラッグした価格を反映
  setDraft(k, price) {
    if (!Number.isFinite(price)) return;
    const v = this.fmtP(price);
    if (k === 'sl') this.slIn.value = v;
    else if (k === 'tp') this.tpIn.value = v;
    else if (k === 'tp2') this.tp2In.value = v;
    else if (k === 'entry') this.priceIn.value = v;
    this.sync(true);
  }
  // チャートに出す予定ライン
  drafts() {
    const a = this.app, sym = a.sym;
    if (!a.canTrade()) return [];
    const e = this.entryPx(), q = this.qty(), out = [];
    if (!Number.isFinite(e)) return out;
    const dist = (p) => (sym.pip ? `${fmtNum(Math.abs(p - e) / sym.pip, 1)}pips` : `${fmtNum((Math.abs(p - e) / e) * 100, 2)}%`);
    const amt = (p) => smoney((p - e) * q * this.side, sym);
    const tn = { limit: '指値', stop: '逆指値' }[this.type];
    if (tn) out.push({ k: 'entry', price: e, color: this.side > 0 ? '#2962ff' : '#f23645', text: `${this.side > 0 ? '買い' : '売り'}${tn}（予定）${fmtNum(q, qtyDigits(sym))}` });
    const f1 = this.tpPctV() / 100, part = this.useTP && f1 < 1;
    const amtF = (p, f) => smoney((p - e) * q * f * this.side, sym);
    if (this.useTP && this.tpIn.value) { const p = +this.tpIn.value; out.push({ k: 'tp', price: p, color: '#089981', text: `利確${part ? '1' : ''}（予定${part ? '・' + this.tpPctV() + '%' : ''}） ${part ? amtF(p, f1) : amt(p)}・${dist(p)}` }); }
    if (part && this.useTP2 && this.tp2In.value) { const p = +this.tp2In.value; out.push({ k: 'tp2', price: p, color: '#089981', text: `利確2（予定・${100 - this.tpPctV()}%） ${amtF(p, 1 - f1)}・${dist(p)}` }); }
    if (this.useSL && this.slIn.value) { const p = +this.slIn.value; out.push({ k: 'sl', price: p, color: '#f23645', text: `損切り（予定） ${amt(p)}・${dist(p)}` }); }
    return out;
  }
}
