// トレード記録: すべての取引・操作・相場状況をブラウザ内（IndexedDB）に保存し、分析・書き出しする
import { uid, TZ, alignTF, DAY } from './util.js';
import * as I from './indicators.js';

// ---------------- IndexedDB ----------------
const DBNAME = 'trade-replay-journal';
let dbp = null;
function db() {
  return (dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open(DBNAME, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('sessions', { keyPath: 'id' });
      d.createObjectStore('trades', { keyPath: 'id' }).createIndex('sessionId', 'sessionId');
      d.createObjectStore('events', { keyPath: 'id', autoIncrement: true }).createIndex('sessionId', 'sessionId');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}
function tx(store, mode, fn) {
  return db().then((d) => new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const out = fn(t.objectStore(store));
    t.oncomplete = () => res(out?.result ?? out);
    t.onerror = () => rej(t.error);
  }));
}
export const jdb = {
  put: (store, obj) => tx(store, 'readwrite', (s) => s.put(obj)),
  putMany: (store, list) => tx(store, 'readwrite', (s) => { for (const o of list) s.put(o); }),
  all: (store) => tx(store, 'readonly', (s) => s.getAll()),
  del: (store, key) => tx(store, 'readwrite', (s) => s.delete(key)),
  clear: async () => { for (const s of ['sessions', 'trades', 'events']) await tx(s, 'readwrite', (st) => st.clear()); },
};

// ---------------- 相場状況 ----------------
const last = (a) => a[a.length - 1];
const pct = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b ? (a / b - 1) * 100 : null);
const r2 = (v, d = 2) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(d));
const WD = ['日', '月', '火', '水', '木', '金', '土'];

function marketSession(t) {
  const h = new Date(t * 1000).getUTCHours();
  if (h >= 0 && h < 7) return '東京';
  if (h >= 7 && h < 12) return 'ロンドン';
  if (h >= 12 && h < 16) return 'ロンドン/NY';
  if (h >= 16 && h < 21) return 'NY';
  return 'オセアニア';
}

// bars: 確定足（最後が直近の確定足）、price: 今の価格
export function marketContext(bars, price, t, tf, sym) {
  const n = Math.min(bars.length, 400);
  const b = bars.slice(bars.length - n);
  const S = new I.Source();
  S.sync(b, 0);
  const c = S.c, N = b.length;
  const arr = (f, ...a) => { const d = []; f(...a, d, 0, N); return d; };
  const sma20 = arr((s, l, d, f, nn) => I.sma(s, l, d, f, nn), c, 20);
  const sma50 = arr((s, l, d, f, nn) => I.sma(s, l, d, f, nn), c, 50);
  const sma200 = arr((s, l, d, f, nn) => I.sma(s, l, d, f, nn), c, 200);
  const ema20 = arr((s, l, d, f, nn) => I.ema(s, l, d, f, nn), c, 20);
  const sd20 = arr((s, l, d, f, nn) => I.stdev(s, l, d, f, nn), c, 20);
  const rsiO = {}; I.rsiCalc(c, 14, rsiO, 0, N);
  const tr = []; I.trueRange(S, tr, 0, N);
  const atr = arr((s, l, d, f, nn) => I.rma(s, l, d, f, nn), tr, 14);
  const hi20 = arr((s, l, d, f, nn) => I.highest(s, l, d, f, nn), S.h, 20);
  const lo20 = arr((s, l, d, f, nn) => I.lowest(s, l, d, f, nn), S.l, 20);
  const vma = arr((s, l, d, f, nn) => I.sma(s, l, d, f, nn), S.v, 20);
  const A = last(atr), mid = last(sma20), sd = last(sd20);
  const lb = last(b);
  let streak = 0;
  for (let i = N - 1; i > 0; i--) { const up = b[i].c >= b[i].o; if (i === N - 1) streak = up ? 1 : -1; else if ((streak > 0) === up) streak += up ? 1 : -1; else break; }
  const jst = new Date((t + TZ.offset) * 1000);
  const ctx = {
    time: t, hour: jst.getUTCHours(), weekday: WD[jst.getUTCDay()], session: marketSession(t), tf, price: r2(price, sym.digits),
    rsi14: r2(last(rsiO.rsi), 1),
    devSMA20: r2(pct(price, mid)), devSMA50: r2(pct(price, last(sma50))), devSMA200: r2(pct(price, last(sma200))),
    ema20Slope: N > 5 ? r2(pct(last(ema20), ema20[N - 6])) : null,
    trend: Number.isFinite(mid) && Number.isFinite(last(sma50)) ? (mid > last(sma50) ? '上昇' : '下降') : null,
    atr14: r2(A, sym.digits), atrPct: r2((A / price) * 100, 3),
    bbPctB: sd ? r2((price - (mid - 2 * sd)) / (4 * sd), 2) : null, bbWidthPct: mid ? r2(((4 * sd) / mid) * 100, 2) : null,
    ret5: N > 5 ? r2(pct(price, c[N - 6])) : null, ret20: N > 20 ? r2(pct(price, c[N - 21])) : null,
    rangePos20: Number.isFinite(last(hi20)) && last(hi20) > last(lo20) ? r2((price - last(lo20)) / (last(hi20) - last(lo20)), 2) : null,
    distHigh20ATR: A ? r2((last(hi20) - price) / A, 2) : null, distLow20ATR: A ? r2((price - last(lo20)) / A, 2) : null,
    volRatio: last(vma) ? r2(lb.v / last(vma), 2) : null,
    lastBar: lb ? { dir: lb.c >= lb.o ? '陽線' : '陰線', bodyPct: lb.h > lb.l ? r2((Math.abs(lb.c - lb.o) / (lb.h - lb.l)) * 100, 0) : 0, streak } : null,
  };
  return ctx;
}

// ---------------- 記録係 ----------------
export class Recorder {
  constructor(app) {
    this.app = app;
    this.session = null;
    this.events = [];
    this.buf = [];
    this.pausedAt = Date.now();
    this.trades = null; // メモリ上のキャッシュ（全取引）
    this.listeners = new Set();
    setInterval(() => this.flush(), 3000);
    window.addEventListener('beforeunload', () => this.flush());
  }
  onChange(f) { this.listeners.add(f); }
  changed() { for (const f of this.listeners) f(); }

  async loadAll() {
    if (!this.trades) {
      try { this.trades = await jdb.all('trades'); } catch { this.trades = []; }
      this.trades.sort((a, b) => a.closedAt - b.closedAt);
    }
    return this.trades;
  }

  async startSession(existingId) {
    const a = this.app, r = a.replay;
    const id = existingId || uid() + uid();
    let s = null;
    if (existingId) { try { s = (await jdb.all('sessions')).find((x) => x.id === existingId); } catch { /* */ } }
    s ||= { id, sym: a.sym.id, quote: a.sym.quote, tf: r.tf, startT: r.T, createdAt: Date.now(), cfg: a.accountCfg(), name: '' };
    this.session = s;
    this.events = [];
    this.op('session_' + (existingId ? 'resume' : 'start'), { sym: a.sym.id, tf: r.tf, T: r.T }, 'app');
    this.saveSession();
    return id;
  }
  endSession() {
    if (!this.session) return;
    this.op('session_end', {}, 'app');
    this.saveSession(true);
    this.flush();
    this.session = null;
  }
  saveSession(ended) {
    const s = this.session;
    if (!s) return;
    const a = this.app;
    s.lastT = a.replay.T; s.updatedAt = Date.now(); s.tf = a.replay.tf;
    if (ended) s.endedAt = Date.now();
    const sum = (acc) => acc && { balance: acc.balance, equity: acc.equity(), trades: acc.trades.length, net: acc.balance - acc.cfg.balance, maxDD: acc.maxDD, maxDDpct: acc.maxDDpct };
    s.manual = sum(a.manual);
    if (a.auto) s.auto = { ...sum(a.auto), strategy: a.strat?.compiled?.name };
    jdb.put('sessions', JSON.parse(JSON.stringify(s))).catch(() => {});
  }

  // 口座にフックを付ける
  attach(acc, kind) {
    acc.hooks = {
      context: () => this.context(acc, kind),
      fill: (f) => this.op('fill', { side: f.side, qty: f.qty, px: f.px, reason: f.reason }, kind),
      trade: (t) => this.onTrade(acc, kind, t),
      op: (type, data) => this.op(type, data, kind),
    };
  }

  // 操作・出来事を記録
  op(type, data = {}, acc = 'manual') {
    if (!this.session) return;
    const r = this.app.replay;
    const e = { sessionId: this.session.id, acc, t: r.T, wall: Date.now(), type, data, price: r.lastPrice, speed: r.speed, playing: r.playing };
    this.events.push(e);
    this.buf.push(e);
    if (this.events.length > 20000) this.events.splice(0, 5000);
  }
  // 再生・一時停止（考えていた時間を測る）
  playState(playing) {
    if (playing) this.op('play', { pausedSec: Math.round((Date.now() - this.pausedAt) / 1000) }, 'app');
    else { this.pausedAt = Date.now(); this.op('pause', {}, 'app'); }
  }
  flush() {
    if (!this.buf.length) return;
    const list = this.buf; this.buf = [];
    jdb.putMany('events', list).catch(() => {});
  }

  context(acc, kind) {
    const a = this.app, r = a.replay;
    const n = r.countClosed();
    const ctx = marketContext(r.bars.slice(Math.max(0, n - 400), n), r.lastPrice, r.T, r.tf, a.sym);
    ctx.speed = r.speed;
    ctx.playing = r.playing;
    ctx.decisionSec = r.playing ? 0 : Math.round((Date.now() - this.pausedAt) / 1000);
    ctx.equity = acc.equity();
    ctx.drawings = a.ov.drawings.length;
    ctx.indicatorsShown = a.cv.inds.map((x) => x.def.short);
    if (kind === 'auto') ctx.strategy = a.strat?.compiled?.name;
    return ctx;
  }

  onTrade(acc, kind, t) {
    if (!this.session) return;
    const a = this.app, sym = a.sym;
    const risk = t.initSL != null ? Math.abs(t.entry - t.initSL) * t.qty : null;
    const ops = this.events.filter((e) => e.acc === kind && e.t >= t.entryT && e.t <= acc.t && e.type !== 'fill').slice(-50).map((e) => ({ t: e.t, type: e.type, data: e.data }));
    const rec = {
      id: uid() + uid(), sessionId: this.session.id, acc: kind, sym: sym.id, quote: sym.quote, tf: a.replay.tf,
      dir: t.dir > 0 ? 'long' : 'short', qty: t.qty, entry: t.entry, exit: t.exit, entryT: t.entryT, exitT: t.exitT,
      holdSec: t.exitT - t.entryT, holdBars: Math.round((t.exitT - t.entryT) / a.replay.tf),
      pnl: t.pnl, gross: t.gross, fees: t.fees,
      pips: sym.pip ? ((t.exit - t.entry) * t.dir) / sym.pip : null,
      movePct: ((t.exit / t.entry - 1) * 100) * t.dir,
      pnlPctEquity: t.openEquity ? (t.pnl / t.openEquity) * 100 : null,
      exitReason: t.reason, entryReason: t.entryReason, posId: t.posId,
      initSL: t.initSL ?? null, initTP: t.initTP ?? null, slAtExit: t.slAtExit ?? null, tpAtExit: t.tpAtExit ?? null,
      R: risk ? t.pnl / risk : null, mfe: t.mfe ?? 0, mae: t.mae ?? 0,
      mfeR: risk ? (t.mfe ?? 0) / risk : null, maeR: risk ? (t.mae ?? 0) / risk : null,
      openEquity: t.openEquity, equityAfter: acc.equity(),
      marginPct: t.openEquity ? ((t.entry * t.qty) / acc.cfg.leverage / t.openEquity) * 100 : null,
      leverage: acc.cfg.leverage,
      ctxEntry: t.ctx || null,
      ctxExit: this.context(acc, kind),
      ops, strategy: kind === 'auto' ? a.strat?.compiled?.name : null,
      note: '', tags: [], closedAt: Date.now(),
    };
    jdb.put('trades', rec).catch(() => {});
    if (this.trades) this.trades.push(rec);
    this.saveSession();
    this.changed();
  }

  async updateTrade(rec) {
    await jdb.put('trades', rec);
    this.changed();
  }
  async clearAll() {
    await jdb.clear();
    this.trades = [];
    this.changed();
  }
}

// ---------------- 集計 ----------------
export function summarize(list) {
  const n = list.length;
  const wins = list.filter((t) => t.pnl > 0);
  const gp = wins.reduce((a, t) => a + t.pnl, 0), gl = -list.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0);
  const Rs = list.map((t) => t.R).filter((x) => x != null);
  const pe = list.map((t) => t.pnlPctEquity).filter((x) => x != null);
  let streak = 0, maxLoss = 0;
  for (const t of list) { if (t.pnl <= 0) { streak++; maxLoss = Math.max(maxLoss, streak); } else streak = 0; }
  const byCur = {};
  for (const t of list) byCur[t.quote] = (byCur[t.quote] || 0) + t.pnl;
  return {
    n, wins: wins.length, winRate: n ? (wins.length / n) * 100 : null,
    pf: gl > 0 ? gp / gl : gp > 0 ? Infinity : null,
    avgR: Rs.length ? Rs.reduce((a, x) => a + x, 0) / Rs.length : null, nR: Rs.length,
    avgPctEq: pe.length ? pe.reduce((a, x) => a + x, 0) / pe.length : null,
    sumPctEq: pe.reduce((a, x) => a + x, 0),
    maxLossStreak: maxLoss, byCur,
    avgHold: n ? list.reduce((a, t) => a + t.holdSec, 0) / n : null,
  };
}

const holdBucket = (s) => (s < 900 ? '15分未満' : s < 3600 ? '15分〜1時間' : s < 4 * 3600 ? '1〜4時間' : s < DAY ? '4時間〜1日' : '1日以上');
const rsiBucket = (v) => (v == null ? '—' : v < 30 ? '30未満' : v < 50 ? '30〜50' : v < 70 ? '50〜70' : '70以上');
export const GROUPS = [
  { id: 'hour', label: '時間帯（' + TZ.name + '）', key: (t) => { const h = t.ctxEntry?.hour; return h == null ? '—' : `${String(Math.floor(h / 3) * 3).padStart(2, '0')}〜${String(Math.floor(h / 3) * 3 + 3).padStart(2, '0')}時`; } },
  { id: 'weekday', label: '曜日', key: (t) => t.ctxEntry?.weekday ?? '—', order: ['月', '火', '水', '木', '金', '土', '日'] },
  { id: 'session', label: '市場の時間帯', key: (t) => t.ctxEntry?.session ?? '—' },
  { id: 'sym', label: '銘柄', key: (t) => t.sym },
  { id: 'dir', label: '売買', key: (t) => (t.dir === 'long' ? '買い' : '売り') },
  { id: 'withTrend', label: 'トレンドとの向き（MA20 vs MA50）', key: (t) => { const tr = t.ctxEntry?.trend; if (!tr) return '—'; return (tr === '上昇') === (t.dir === 'long') ? '順張り' : '逆張り'; } },
  { id: 'rsi', label: 'エントリー時の RSI', key: (t) => rsiBucket(t.ctxEntry?.rsi14), order: ['30未満', '30〜50', '50〜70', '70以上', '—'] },
  { id: 'entryReason', label: 'エントリー方法', key: (t) => t.entryReason || '—' },
  { id: 'exitReason', label: '決済理由', key: (t) => t.exitReason || '—' },
  { id: 'sl', label: '損切りの有無', key: (t) => (t.initSL != null ? '損切りあり' : '損切りなし') },
  { id: 'hold', label: '保有時間', key: (t) => holdBucket(t.holdSec), order: ['15分未満', '15分〜1時間', '1〜4時間', '4時間〜1日', '1日以上'] },
  { id: 'tf', label: '時間足', key: (t) => ({ 60: '1分', 180: '3分', 300: '5分', 900: '15分', 1800: '30分', 3600: '1時間', 7200: '2時間', 14400: '4時間', 86400: '日足', 604800: '週足' })[t.tf] || String(t.tf) },
  { id: 'decision', label: 'エントリー時の状態', key: (t) => (t.ctxEntry ? (t.ctxEntry.playing ? '再生中に即決' : t.ctxEntry.decisionSec >= 30 ? '止めて30秒以上考えた' : '止めてすぐ') : '—') },
  { id: 'size', label: '資金に対する証拠金', key: (t) => (t.marginPct == null ? '—' : t.marginPct < 10 ? '10%未満' : t.marginPct < 30 ? '10〜30%' : t.marginPct < 60 ? '30〜60%' : '60%以上'), order: ['10%未満', '10〜30%', '30〜60%', '60%以上', '—'] },
  { id: 'tag', label: 'タグ', key: (t) => (t.tags?.length ? t.tags : ['（タグなし）']) },
];
export function groupBy(list, g) {
  const m = new Map();
  for (const t of list) {
    const ks = [].concat(g.key(t));
    for (const k of ks) { if (!m.has(k)) m.set(k, []); m.get(k).push(t); }
  }
  let rows = [...m.entries()].map(([k, l]) => ({ key: k, ...summarize(l) }));
  if (g.order) rows.sort((a, b) => (g.order.indexOf(a.key) + 99 * (g.order.indexOf(a.key) < 0)) - (g.order.indexOf(b.key) + 99 * (g.order.indexOf(b.key) < 0)));
  else rows.sort((a, b) => String(a.key).localeCompare(String(b.key), 'ja'));
  return rows;
}

// ---------------- 書き出し ----------------
const CTX_KEYS = ['hour', 'weekday', 'session', 'rsi14', 'devSMA20', 'devSMA50', 'devSMA200', 'ema20Slope', 'trend', 'atr14', 'atrPct', 'bbPctB', 'bbWidthPct', 'ret5', 'ret20', 'rangePos20', 'distHigh20ATR', 'distLow20ATR', 'volRatio', 'speed', 'playing', 'decisionSec', 'drawings'];
const TRADE_KEYS = ['id', 'sessionId', 'acc', 'strategy', 'sym', 'quote', 'tf', 'dir', 'qty', 'entry', 'exit', 'entryT', 'exitT', 'holdSec', 'holdBars', 'pnl', 'gross', 'fees', 'pips', 'movePct', 'pnlPctEquity', 'R', 'mfe', 'mae', 'mfeR', 'maeR', 'entryReason', 'exitReason', 'initSL', 'initTP', 'slAtExit', 'tpAtExit', 'openEquity', 'equityAfter', 'marginPct', 'leverage'];
const iso = (t) => (t == null ? '' : new Date((t + TZ.offset) * 1000).toISOString().replace('T', ' ').slice(0, 19));

export function toCSV(list) {
  const head = [...TRADE_KEYS, 'entryTime', 'exitTime', ...CTX_KEYS.map((k) => 'entry_' + k), ...CTX_KEYS.map((k) => 'exit_' + k), 'lastBarDir', 'lastBarStreak', 'opsCount', 'slMoves', 'tags', 'note'];
  const esc = (v) => { if (v == null) return ''; const s = typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const rows = list.map((t) => [
    ...TRADE_KEYS.map((k) => t[k]), iso(t.entryT), iso(t.exitT),
    ...CTX_KEYS.map((k) => t.ctxEntry?.[k]), ...CTX_KEYS.map((k) => t.ctxExit?.[k]),
    t.ctxEntry?.lastBar?.dir, t.ctxEntry?.lastBar?.streak, t.ops?.length ?? 0, (t.ops || []).filter((o) => o.type === 'sl_change').length,
    (t.tags || []).join(' '), t.note,
  ].map(esc).join(','));
  return '﻿' + head.join(',') + '\n' + rows.join('\n');
}

// AI に渡すテキスト（Markdown + 1 取引 1 行の JSON）
export function toAIText(trades, sessions, { title = 'トレード記録', limit = 400 } = {}) {
  const list = trades.slice(-limit);
  const s = summarize(trades);
  const fmt = (v, d = 2) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d));
  const lines = [
    `# ${title}`,
    `過去の相場データを再生して行った練習トレード（デモ）の記録です。時刻は ${TZ.name}。`,
    `- 取引数: ${s.n}（勝ち ${s.wins}）、勝率 ${fmt(s.winRate, 1)}%、PF ${s.pf === Infinity ? '∞' : fmt(s.pf)}、平均R ${fmt(s.avgR)}（損切りを置いた ${s.nR} 件）、最大連敗 ${s.maxLossStreak}`,
    `- 通貨ごとの損益: ${Object.entries(s.byCur).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ') || '—'}`,
    `- セッション数: ${sessions.length}`,
    trades.length > list.length ? `- 件数が多いため、直近 ${list.length} 件（全 ${trades.length} 件中）を載せています。上の集計は全件です。` : '',
    '',
    '## 各取引（JSON Lines）',
    '各項目: dir=売買, R=損切り幅を1とした損益, mfe/mae=保有中の最大含み益/損（金額）, pnlPctEquity=口座に対する損益%, entryReason/exitReason, initSL=最初の損切り, e=エントリー時の相場状況（rsi14, devSMA20=SMA20からの乖離%, trend=MA20とMA50の関係, atrPct, bbPctB, ret5/ret20=直近5/20本の騰落%, rangePos20=直近20本の高安の中の位置0〜1, volRatio=出来高/平均, decisionSec=止めて考えた秒数, speed=再生速度[秒/秒]）, ops=保有中の操作, tags, note',
    '```jsonl',
    ...list.map((t) => JSON.stringify({
      sym: t.sym, tf: t.tf, acc: t.acc, dir: t.dir, entryTime: iso(t.entryT), exitTime: iso(t.exitT), holdMin: Math.round(t.holdSec / 60),
      entry: t.entry, exit: t.exit, pnl: +t.pnl.toFixed(2), pnlPctEquity: t.pnlPctEquity == null ? null : +t.pnlPctEquity.toFixed(2), R: t.R == null ? null : +t.R.toFixed(2),
      mfe: +(t.mfe || 0).toFixed(2), mae: +(t.mae || 0).toFixed(2), entryReason: t.entryReason, exitReason: t.exitReason, initSL: t.initSL, initTP: t.initTP,
      marginPct: t.marginPct == null ? null : +t.marginPct.toFixed(1),
      e: t.ctxEntry && Object.fromEntries(CTX_KEYS.filter((k) => t.ctxEntry[k] != null).map((k) => [k, t.ctxEntry[k]])),
      ops: (t.ops || []).map((o) => o.type + (o.data?.to != null ? ':' + o.data.to : '')).join(',') || undefined,
      tags: t.tags?.length ? t.tags : undefined, note: t.note || undefined, strategy: t.strategy || undefined,
    })),
    '```',
  ];
  return lines.filter((l) => l !== '').join('\n');
}

export function download(name, text, type = 'text/plain') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: type + ';charset=utf-8' }));
  a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
export { iso as fmtISO, alignTF };
