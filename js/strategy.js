// ストラテジー実行環境（Pine Script 風）。確定足ごとに onBar(s, inputs) を呼ぶ。
import * as I from './indicators.js';
import { Account, barPath } from './broker.js';

class Series {
  constructor(rt, id, compute, vals) {
    this.rt = rt; this.id = id; this.compute = compute; this.vals = vals || []; this.upto = -1;
  }
  get(j) {
    if (j < 0) return NaN;
    if (j > this.upto) { this.compute(this.upto + 1, j + 1); this.upto = j; }
    return this.vals[j];
  }
  at(n = 0) { return this.get(this.rt.i - n); }
  valueOf() { return this.at(0); }
  toString() { return String(this.at(0)); }
}

const v = (x, n = 0) => (typeof x === 'number' ? x : x?.at ? x.at(n) : NaN);

export function compile(code) {
  let r;
  try {
    // eslint-disable-next-line no-new-func
    r = new Function(`"use strict";\n${code}\n;return { name: typeof name !== 'undefined' ? name : '', inputs: typeof inputs !== 'undefined' ? inputs : {}, onBar: typeof onBar === 'function' ? onBar : null };`)();
  } catch (e) {
    throw new Error('コードの読み込みに失敗: ' + e.message);
  }
  if (!r.onBar) throw new Error('onBar(s, inputs) 関数がありません');
  const inputs = {};
  for (const [k, x] of Object.entries(r.inputs || {})) {
    inputs[k] = typeof x === 'object' && x ? { label: x.label || k, value: x.value, step: x.step } : { label: k, value: x };
  }
  return { name: r.name || '無題のストラテジー', inputs, onBar: r.onBar };
}

export class StrategyRunner {
  constructor(compiled, inputValues, account, sym, tf, off) {
    this.c = compiled; this.inp = inputValues; this.acc = account; this.sym = sym; this.tf = tf; this.off = off;
    this.S = new I.Source(); this.S.off = off; this.S.tf = tf;
    this.qty = inputValues.qty ?? sym.qty;
    this.error = null;
    this.reset();
  }
  reset() {
    this.cache = new Map();
    this.i = -1;
    this.plots = new Map();
    const S = this.S;
    const src = (id, arr) => new Series(this, id, () => {}, arr);
    this.base = { open: src('open', S.o), high: src('high', S.h), low: src('low', S.l), close: src('close', S.c), volume: src('volume', S.v), hl2: src('hl2', S.hl2), hlc3: src('hlc3', S.hlc3), ohlc4: src('ohlc4', S.ohlc4) };
    for (const s of Object.values(this.base)) s.get = (j) => (j < 0 ? NaN : s.vals[j]);
    this.ta = this.makeTA();
  }
  // 足の配列が差し替わったとき（追加だけなら from に既存の本数を渡す）
  sync(bars, from = 0) {
    if (from === 0) this.reset();
    this.S.sync(bars, from);
  }

  mk(key, deps, fn, vals) {
    let s = this.cache.get(key);
    if (!s) {
      s = new Series(this, key, (f, n) => { for (const d of deps) d.get?.(n - 1); fn(f, n, s.vals); }, vals);
      this.cache.set(key, s);
    }
    return s;
  }
  ind(id, inputs) {
    const key = 'ind:' + id + JSON.stringify(inputs);
    let o = this.cache.get(key);
    if (!o) {
      const def = I.indicatorDef(id), out = {}, S = this.S;
      let upto = -1;
      const ensure = (j) => { if (j > upto) { def.calc(S, { ...I.defaultInputs(def), ...inputs }, out, upto + 1, j + 1); upto = j; } };
      o = {};
      for (const p of def.plots) {
        const s = new Series(this, key + p.k, () => {});
        s.get = (j) => { if (j < 0) return NaN; ensure(j); return out[p.k][j]; };
        o[p.k] = s;
      }
      o._out = out;
      this.cache.set(key, o);
    }
    return o;
  }
  makeTA() {
    const rt = this;
    const one = (name, f) => (src, len) => rt.mk(`${name}:${src.id}:${len}`, [src], (a, n, d) => f(src.vals, len, d, a, n));
    return {
      sma: one('sma', I.sma), ema: one('ema', I.ema), rma: one('rma', I.rma), wma: one('wma', I.wma),
      stdev: one('stdev', I.stdev), highest: one('hi', I.highest), lowest: one('lo', I.lowest),
      rsi: (src, len = 14) => { const o = {}; return rt.mk(`rsi:${src.id}:${len}`, [src], (a, n, d) => { o.rsi = d; I.rsiCalc(src.vals, len, o, a, n); }); },
      atr: (len = 14) => rt.ind('atr', { len }).v,
      macd: (fast = 12, slow = 26, sig = 9) => rt.ind('macd', { fast, slow, sig }),
      bb: (len = 20, mult = 2, src = 'close') => { const o = rt.ind('bb', { len, mult, src }); return { upper: o.up, basis: o.mid, lower: o.lo }; },
      stoch: (k = 14, ks = 3, d = 3) => rt.ind('stoch', { k, ks, d }),
      dmi: (len = 14, adx = 14) => rt.ind('dmi', { len, adx }),
      supertrend: (len = 10, mult = 3) => { const o = rt.ind('supertrend', { len, mult }); const dir = new Series(rt, 'stdir', () => {}); dir.get = (j) => (o.v.get(j), o._out._dir[j]); return { line: o.v, dir }; },
      donchian: (len = 20) => { const o = rt.ind('donchian', { len }); return { upper: o.up, basis: o.mid, lower: o.lo }; },
      ichimoku: (conv = 9, base = 26, spanb = 52, disp = 26) => rt.ind('ichimoku', { conv, base, spanb, disp }),
      sar: (start = 0.02, inc = 0.02, max = 0.2) => rt.ind('psar', { start, inc, max }).v,
      vwap: () => rt.ind('vwap', {}).v,
      crossover: (a, b) => v(a) > v(b) && v(a, 1) <= v(b, 1),
      crossunder: (a, b) => v(a) < v(b) && v(a, 1) >= v(b, 1),
      cross: (a, b) => (v(a) > v(b)) !== (v(a, 1) > v(b, 1)),
      change: (a, n = 1) => v(a) - v(a, n),
      rising: (a, n = 1) => { for (let k = 0; k < n; k++) if (!(v(a, k) > v(a, k + 1))) return false; return true; },
      falling: (a, n = 1) => { for (let k = 0; k < n; k++) if (!(v(a, k) < v(a, k + 1))) return false; return true; },
      nz: (x, d = 0) => (Number.isFinite(x) ? x : d),
    };
  }

  // 確定した足 i でスクリプトを実行
  onBar(i) {
    if (this.error) return;
    this.i = i;
    const acc = this.acc, rt = this;
    const p = acc.pos;
    const sideOf = (d) => (d === 'short' || d === -1 || d === 'sell' ? -1 : 1);
    const pending = () => acc.queued.reduce((a, q) => a + q.side * q.qty, 0);
    const s = {
      ...this.base,
      ta: this.ta, i, bar_index: i, time: this.S.t[i], tf: this.tf, symbol: this.sym.id,
      pip: this.sym.pip || 0, digits: this.sym.digits,
      position: { size: p.qty, side: Math.sign(p.qty), avg: p.avg, sl: p.sl, tp: p.tp, trail: p.trail, profit: acc.unrealized() },
      exitOrders: acc.orders.filter((o) => o.reduceOnly).map((o) => ({ type: o.type, price: o.price, qty: o.qty, comment: o.label })),
      equity: acc.equity(), balance: acc.balance,
      v,
      entry(dir, o = {}) {
        const side = sideOf(dir);
        const qty = o.qty ?? rt.qty;
        if (o.limit != null || o.stop != null) {
          acc.orders.filter((x) => x.comment === 'strategy-entry').forEach((x) => acc.cancelOrder(x.id));
          acc.placeOrder({ side, type: o.limit != null ? 'limit' : 'stop', price: o.limit ?? o.stop, qty, sl: o.sl, tp: o.tp, tps: o.tps, trail: o.trail, comment: 'strategy-entry' });
          return;
        }
        const cur = acc.pos.qty + pending();
        if (Math.sign(cur) === side && !o.add) return; // 同方向は追加しない（ピラミッディング無し）
        const q = Math.sign(cur) === -side ? Math.abs(cur) + qty : qty;
        acc.queueMarket(side, q, { sl: o.sl, tp: o.tp, tps: o.tps, trail: o.trail, reason: o.comment || (side > 0 ? '買い' : '売り') });
      },
      // qty を渡すとその数量だけ（一部決済）。{ pct: 50 } でも指定できる
      closePosition(comment, qty) {
        const cur = acc.pos.qty + pending();
        if (!cur) return;
        let q = Math.abs(cur);
        if (qty && typeof qty === 'object' && qty.pct > 0) q = Math.min(q, acc.roundQty((q * qty.pct) / 100));
        else if (qty > 0) q = Math.min(q, qty);
        acc.queueMarket(-Math.sign(cur), q, { reason: comment || (q < Math.abs(cur) ? '一部決済' : '決済') });
      },
      exit(o = {}) {
        if (acc.pos.qty) { acc.setBrackets(o.sl ?? acc.pos.sl, o.tp ?? acc.pos.tp); if (o.trail !== undefined) acc.setTrail(o.trail); }
        for (const q of acc.queued) { if (o.sl != null) q.extra.sl = o.sl; if (o.tp != null) q.extra.tp = o.tp; if (o.trail != null) q.extra.trail = o.trail; }
      },
      // 決済専用の指値（limit）・逆指値（stop）。ポジションの一部（qty か pct）だけ決済できる
      exitOrder(o = {}) {
        const p = acc.pos;
        if (!p.qty || (o.limit == null && o.stop == null)) return;
        const all = Math.abs(p.qty);
        const qty = o.qty > 0 ? Math.min(o.qty, all) : o.pct > 0 ? Math.min(all, acc.roundQty((all * o.pct) / 100)) : all;
        acc.placeOrder({ side: -Math.sign(p.qty), type: o.limit != null ? 'limit' : 'stop', price: o.limit ?? o.stop, qty, reduceOnly: true, label: o.comment || '' });
      },
      cancelExits() { for (const o of acc.orders.filter((x) => x.reduceOnly)) acc.cancelOrder(o.id); },
      cancel() { acc.cancelAll(); },
      plot(x, title = 'plot', color = '#ffeb3b') {
        let pl = rt.plots.get(title);
        if (!pl) { pl = { title, color, vals: [] }; rt.plots.set(title, pl); }
        pl.vals[i] = v(x);
      },
      log(msg) { acc.note(String(msg)); },
    };
    try {
      this.c.onBar(s, this.inp);
    } catch (e) {
      this.error = e.message;
      acc.note('ストラテジーのエラー: ' + e.message);
    }
  }
}

// 確定足 bars 全体で一括バックテスト。続きを追加できるよう runner と account を返す
export class Backtest {
  // fromT（UNIX 秒）を渡すと、その時刻より前に確定した足では売買しない（インジケーターの計算と描画だけ）
  constructor(compiled, inputs, sym, tf, off, cfg, fromT = null) {
    this.fromT = fromT;
    this.acc = new Account(sym, cfg, 'バックテスト');
    this.runner = new StrategyRunner(compiled, inputs, this.acc, sym, tf, off);
    this.tf = tf;
    this.bars = [];
  }
  run(bars) {
    this.acc.reset();
    this.bars = bars;
    this.runner.sync(bars, 0);
    for (let i = 0; i < bars.length; i++) this.step(i);
  }
  extend(bars) {
    const from = this.bars.length;
    this.bars = bars;
    this.runner.sync(bars, from);
    for (let i = from; i < bars.length; i++) this.step(i);
  }
  step(i) {
    const b = this.bars[i], acc = this.acc;
    if (this.fromT != null && b.t + this.tf <= this.fromT) {
      // 計測開始より前: 戦略は動かす（変数や描画のため）が、出た注文は捨てる
      acc.bid = b.c; acc.t = b.t;
      this.runner.onBar(i);
      acc.queued = []; acc.orders = [];
      return;
    }
    const path = barPath(b);
    if (i > 0) acc.segment(this.bars[i - 1].c, b.o, b.t, true);
    else { acc.bid = b.o; acc.t = b.t; }
    for (let k = 0; k < 3; k++) acc.segment(path[k], path[k + 1], b.t, false);
    acc.markEquity();
    this.runner.onBar(i);
  }
}

// ---------- プリセット ----------
export const PRESETS = [
  {
    id: 'ma-cross', code: `const name = 'MAクロス';
const inputs = {
  fast: { label: '短期MA', value: 9 },
  slow: { label: '長期MA', value: 21 },
};

// 確定足ごとに呼ばれる。s.close などは系列で、.at(1) で1本前
function onBar(s, inp) {
  const fast = s.ta.sma(s.close, inp.fast);
  const slow = s.ta.sma(s.close, inp.slow);
  s.plot(fast, '短期MA', '#2962ff');
  s.plot(slow, '長期MA', '#ff9800');

  if (s.ta.crossover(fast, slow)) s.entry('long');   // ゴールデンクロスで買い（売りなら途転）
  if (s.ta.crossunder(fast, slow)) s.entry('short'); // デッドクロスで売り
}
` },
  {
    id: 'rsi', code: `const name = 'RSI 逆張り';
const inputs = {
  len: { label: 'RSI期間', value: 14 },
  low: { label: '売られすぎ', value: 30 },
  high: { label: '買われすぎ', value: 70 },
};

function onBar(s, inp) {
  const rsi = s.ta.rsi(s.close, inp.len);
  if (s.ta.crossover(rsi, inp.low)) s.entry('long');
  if (s.ta.crossunder(rsi, inp.high)) s.entry('short');
  // 50 を回復したら決済
  if (s.position.side > 0 && rsi.at(0) > 50) s.closePosition('RSI50');
  if (s.position.side < 0 && rsi.at(0) < 50) s.closePosition('RSI50');
}
` },
  {
    id: 'bb', code: `const name = 'ボリンジャー逆張り';
const inputs = {
  len: { label: '期間', value: 20 },
  mult: { label: '標準偏差', value: 2, step: 0.1 },
};

function onBar(s, inp) {
  const bb = s.ta.bb(inp.len, inp.mult);
  s.plot(bb.upper, '上限', '#f23645');
  s.plot(bb.lower, '下限', '#089981');
  if (s.close.at(0) < bb.lower.at(0)) s.entry('long', { tp: bb.basis.at(0) });
  if (s.close.at(0) > bb.upper.at(0)) s.entry('short', { tp: bb.basis.at(0) });
}
` },
  {
    id: 'donchian', code: `const name = 'ドンチャン・ブレイクアウト';
const inputs = {
  entry: { label: 'ブレイク期間', value: 20 },
  exit: { label: '手仕舞い期間', value: 10 },
  atrMult: { label: '損切り(ATR倍)', value: 2, step: 0.5 },
};

function onBar(s, inp) {
  const hi = s.ta.highest(s.high, inp.entry), lo = s.ta.lowest(s.low, inp.entry);
  const xhi = s.ta.highest(s.high, inp.exit), xlo = s.ta.lowest(s.low, inp.exit);
  const atr = s.ta.atr(14).at(0);
  s.plot(hi.at(1), '上限', '#2962ff');
  s.plot(lo.at(1), '下限', '#2962ff');

  // 前の足までの高値・安値を更新したらエントリー（損切りは ATR の倍数）
  if (s.position.side <= 0 && s.close.at(0) > hi.at(1)) s.entry('long', { sl: s.close.at(0) - atr * inp.atrMult });
  if (s.position.side >= 0 && s.close.at(0) < lo.at(1)) s.entry('short', { sl: s.close.at(0) + atr * inp.atrMult });
  if (s.position.side > 0 && s.close.at(0) < xlo.at(1)) s.closePosition('手仕舞い');
  if (s.position.side < 0 && s.close.at(0) > xhi.at(1)) s.closePosition('手仕舞い');
}
` },
  {
    id: 'macd', code: `const name = 'MACD クロス';
const inputs = {
  fast: { label: '短期', value: 12 },
  slow: { label: '長期', value: 26 },
  sig: { label: 'シグナル', value: 9 },
};

function onBar(s, inp) {
  const m = s.ta.macd(inp.fast, inp.slow, inp.sig);
  // ゼロより下でのゴールデンクロスで買い、上でのデッドクロスで売り
  if (s.ta.crossover(m.macd, m.signal) && m.macd.at(0) < 0) s.entry('long');
  if (s.ta.crossunder(m.macd, m.signal) && m.macd.at(0) > 0) s.entry('short');
}
` },
  {
    id: 'supertrend', code: `const name = 'スーパートレンド';
const inputs = {
  len: { label: 'ATR期間', value: 10 },
  mult: { label: '係数', value: 3, step: 0.1 },
};

function onBar(s, inp) {
  const st = s.ta.supertrend(inp.len, inp.mult);
  s.plot(st.line, 'スーパートレンド', '#ab47bc');
  if (st.dir.at(0) > 0 && st.dir.at(1) < 0) s.entry('long');
  if (st.dir.at(0) < 0 && st.dir.at(1) > 0) s.entry('short');
}
` },
];

export const TEMPLATE = `const name = '自作ストラテジー';
const inputs = {
  len: { label: '期間', value: 20 },
  qty: { label: '数量', value: 1 },
};

// 確定足ごとに呼ばれます。
//   s.open / s.high / s.low / s.close / s.volume : 系列（.at(0) が今の足、.at(1) が1本前）
//   s.ta.sma(src, len) ema rma wma rsi atr macd bb stoch dmi supertrend donchian ichimoku sar vwap
//   s.ta.highest(src, len) lowest crossover(a, b) crossunder cross change rising falling
//   s.entry('long' | 'short', { qty, sl, tp, limit, stop })  次の足の始値で約定（反対ポジションは途転）
//   s.closePosition()  決済（s.closePosition('半分', { pct: 50 }) で一部決済）/ s.exit({ sl, tp, trail }) 損切り・利確・トレールを設定
//   s.exitOrder({ limit | stop, pct | qty })  一部だけ決済する指値・逆指値 / s.cancel() 待機注文を取消
//   s.position.side (1 / -1 / 0), s.position.avg, s.position.profit / s.equity
//   s.plot(値, '名前', '#色')  チャートに線を描く / s.log('メッセージ')
//   入力に qty があれば数量として使われます
function onBar(s, inp) {
  const ma = s.ta.ema(s.close, inp.len);
  s.plot(ma, 'EMA', '#ffeb3b');
  if (s.ta.crossover(s.close, ma)) s.entry('long');
  if (s.ta.crossunder(s.close, ma)) s.closePosition();
}
`;

// AI にストラテジーを書いてもらうときに渡す API の説明
export const STRATEGY_API = `## このサイトのストラテジーの書き方（JavaScript）
次の形のコードを 1 つだけ書く。グローバルに name・inputs・onBar を定義する（import や外部通信、DOM、setTimeout は使えない）。

\`\`\`strategy
const name = 'ストラテジー名';
const inputs = {
  fast: { label: '短期MA', value: 9 },          // 数値の入力。step も付けられる: { label, value, step }
  qty: { label: '数量', value: 0.1 },           // qty があれば発注数量に使われる（無ければ注文パネルの既定数量）
};
function onBar(s, inp) {
  // 足が確定するたびに 1 回呼ばれる。inp.fast のように入力値を読む
}
\`\`\`

### 系列（Series）
- s.open / s.high / s.low / s.close / s.volume / s.hl2 / s.hlc3 / s.ohlc4
- 系列.at(0) が今の確定足、.at(1) が 1 本前。最初のうちは NaN になるので Number.isFinite で確認する
- 未来の足は見えない（参照する方法もない）

### インジケーター（s.ta）
- s.ta.sma(src, len) / ema / rma / wma / stdev / highest(src, len) / lowest(src, len) → 系列
- s.ta.rsi(src, len) → 系列、s.ta.atr(len) → 系列、s.ta.vwap() → 系列、s.ta.sar(start, inc, max) → 系列
- s.ta.macd(fast, slow, sig) → { macd, signal, hist }、s.ta.bb(len, mult) → { upper, basis, lower }
- s.ta.stoch(k, kSmooth, d) → { k, d }、s.ta.dmi(len, adxSmooth) → { adx, pdi, mdi }
- s.ta.supertrend(len, mult) → { line, dir }（dir は 1 / -1）、s.ta.donchian(len) → { upper, basis, lower }
- s.ta.ichimoku(conv, base, spanB, disp) → { tenkan, kijun, spanA, spanB, chikou }（spanA/spanB は disp ずらす前の値）
- s.ta.crossover(a, b) / crossunder(a, b) / cross(a, b)（a, b は系列か数値）、s.ta.change(a, n)、s.ta.rising(a, n)、s.ta.falling(a, n)、s.ta.nz(x, d)
- src には上の系列か、ta が返した系列を渡せる（例: s.ta.sma(s.ta.rsi(s.close, 14), 5)）

### 発注
- s.entry('long' | 'short', { qty, sl, tp, limit, stop, comment, add })
  - 成行は次の足の始値で約定。反対のポジションがあれば途転。同じ向きは積み増ししない（add: true で積み増し）
  - sl / tp は価格。limit / stop を付けると指値・逆指値の待機注文（新しい entry で置き換わる）
  - tps: [{ price, pct }, …] で分割利確（例: [{ price: a, pct: 50 }, { price: b, pct: 50 }]。最後の段は残り全部）。trail: 幅 でトレーリングストップ
- s.closePosition(comment, qty) 決済。qty に数量か { pct: 50 } を渡すと一部だけ決済（次の足の始値）
- s.exit({ sl, tp, trail }) 今のポジションの損切り・利確・トレール幅を変更（trail: null で解除）。トレールは有利な方向の最高値（売りは最安値）から trail 離れた位置に損切りを付けて追いかける
- s.exitOrder({ limit | stop, pct | qty, comment }) ポジションの一部を決済する決済専用の指値（limit）・逆指値（stop）。ポジションを超えては約定せず、ポジションが無くなると自動で取り消される。毎足呼ぶと注文が積み重なるので、s.exitOrders.length が 0 のときだけ置く。s.cancelExits() でこの注文だけ取消
- s.cancel() 待機注文をすべて取消
- s.position: { size, side（1 / -1 / 0）, avg, sl, tp, trail, profit }、s.exitOrders: [{ type, price, qty, comment }]、s.equity、s.balance
- s.time（足の開始時刻、UTC の秒）。日本時間の時: new Date((s.time + 9 * 3600) * 1000).getUTCHours()、曜日: getUTCDay()
- s.symbol、s.tf（秒）、s.pip（FX の 1pips の値幅。暗号資産は 0）、s.digits、s.bar_index
- s.plot(値または系列, '名前', '#色') でチャートに線を描く、s.log('メッセージ')
- 損失を口座の r% に抑える数量の例: const q = (s.equity * r / 100) / Math.abs(entry - sl)（数量の刻みに注意して丸める）`;
