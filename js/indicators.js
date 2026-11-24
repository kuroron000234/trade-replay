// インジケーター計算。どれも「from 以降だけを計算し直す」差分方式で、
// リプレイ中は最後の足（形成中）だけを毎フレーム計算する。
import { alignTF, DAY } from './util.js';

const nan = NaN;
const ok = (v) => v === v && v != null; // NaN でない

// ---------- 基本関数: dst[from..n-1] を埋める ----------
export function sma(src, len, dst, from, n) {
  for (let i = from; i < n; i++) {
    if (i < len - 1) { dst[i] = nan; continue; }
    let s = 0, k = 0;
    for (let j = i - len + 1; j <= i; j++) { if (!ok(src[j])) { k = -1; break; } s += src[j]; }
    dst[i] = k < 0 ? nan : s / len;
  }
}
function emaLike(src, alpha, len, dst, from, n) {
  for (let i = from; i < n; i++) {
    const prev = i > 0 ? dst[i - 1] : nan;
    if (ok(prev)) { dst[i] = ok(src[i]) ? alpha * src[i] + (1 - alpha) * prev : prev; continue; }
    // 最初の len 本の単純平均で初期化
    if (i < len - 1) { dst[i] = nan; continue; }
    let s = 0, bad = false;
    for (let j = i - len + 1; j <= i; j++) { if (!ok(src[j])) { bad = true; break; } s += src[j]; }
    dst[i] = bad ? nan : s / len;
  }
}
export const ema = (src, len, dst, from, n) => emaLike(src, 2 / (len + 1), len, dst, from, n);
export const rma = (src, len, dst, from, n) => emaLike(src, 1 / len, len, dst, from, n);
export function wma(src, len, dst, from, n) {
  const den = (len * (len + 1)) / 2;
  for (let i = from; i < n; i++) {
    if (i < len - 1) { dst[i] = nan; continue; }
    let s = 0;
    for (let j = 0; j < len; j++) s += src[i - j] * (len - j);
    dst[i] = s / den;
  }
}
export function stdev(src, len, dst, from, n) {
  for (let i = from; i < n; i++) {
    if (i < len - 1) { dst[i] = nan; continue; }
    let s = 0;
    for (let j = i - len + 1; j <= i; j++) s += src[j];
    const m = s / len;
    let q = 0;
    for (let j = i - len + 1; j <= i; j++) q += (src[j] - m) ** 2;
    dst[i] = Math.sqrt(q / len);
  }
}
export function highest(src, len, dst, from, n) {
  for (let i = from; i < n; i++) {
    if (i < len - 1) { dst[i] = nan; continue; }
    let m = -Infinity;
    for (let j = i - len + 1; j <= i; j++) if (src[j] > m) m = src[j];
    dst[i] = m;
  }
}
export function lowest(src, len, dst, from, n) {
  for (let i = from; i < n; i++) {
    if (i < len - 1) { dst[i] = nan; continue; }
    let m = Infinity;
    for (let j = i - len + 1; j <= i; j++) if (src[j] < m) m = src[j];
    dst[i] = m;
  }
}
export function trueRange(S, dst, from, n) {
  for (let i = from; i < n; i++) {
    dst[i] = i === 0 ? S.h[i] - S.l[i] : Math.max(S.h[i] - S.l[i], Math.abs(S.h[i] - S.c[i - 1]), Math.abs(S.l[i] - S.c[i - 1]));
  }
}
export function rsiCalc(src, len, out, from, n) {
  const g = (out._g ||= []), l = (out._l ||= []), ag = (out._ag ||= []), al = (out._al ||= []), r = (out.rsi ||= []);
  for (let i = from; i < n; i++) {
    const d = i > 0 ? src[i] - src[i - 1] : nan;
    g[i] = ok(d) ? Math.max(d, 0) : nan;
    l[i] = ok(d) ? Math.max(-d, 0) : nan;
  }
  rma(g, len, ag, from, n);
  rma(l, len, al, from, n);
  for (let i = from; i < n; i++) r[i] = !ok(ag[i]) ? nan : al[i] === 0 ? 100 : 100 - 100 / (1 + ag[i] / al[i]);
  return r;
}

// 配列を必要なら用意
const A = (out, k) => (out[k] ||= []);

// ---------- ソース配列 ----------
export class Source {
  constructor() { this.reset(); }
  reset() {
    this.t = []; this.o = []; this.h = []; this.l = []; this.c = []; this.v = [];
    this.hl2 = []; this.hlc3 = []; this.ohlc4 = []; this.n = 0;
  }
  sync(bars, from) {
    for (let i = from; i < bars.length; i++) {
      const b = bars[i];
      this.t[i] = b.t; this.o[i] = b.o; this.h[i] = b.h; this.l[i] = b.l; this.c[i] = b.c; this.v[i] = b.v;
      this.hl2[i] = (b.h + b.l) / 2; this.hlc3[i] = (b.h + b.l + b.c) / 3; this.ohlc4[i] = (b.o + b.h + b.l + b.c) / 4;
    }
    this.n = bars.length;
    for (const k of ['t', 'o', 'h', 'l', 'c', 'v', 'hl2', 'hlc3', 'ohlc4']) this[k].length = this.n;
  }
}
const SRC_OPTS = [['close', '終値'], ['open', '始値'], ['high', '高値'], ['low', '安値'], ['hl2', '(高+安)/2'], ['hlc3', '(高+安+終)/3'], ['ohlc4', '(始+高+安+終)/4']];
const srcOf = (S, k) => ({ close: S.c, open: S.o, high: S.h, low: S.l, hl2: S.hl2, hlc3: S.hlc3, ohlc4: S.ohlc4 })[k] || S.c;

const UP = '#089981', DN = '#f23645';

// ---------- インジケーター定義 ----------
export const INDICATORS = [
  {
    id: 'sma', name: '単純移動平均線 (SMA)', short: 'SMA', overlay: true, kw: 'ma moving average 移動平均',
    inputs: [{ k: 'len', label: '期間', def: 20 }, { k: 'src', label: 'ソース', def: 'close', opts: SRC_OPTS }],
    plots: [{ k: 'v', label: 'SMA', color: '#2962ff' }],
    calc(S, I, o, f, n) { sma(srcOf(S, I.src), I.len, A(o, 'v'), f, n); },
  },
  {
    id: 'ema', name: '指数平滑移動平均線 (EMA)', short: 'EMA', overlay: true, kw: 'ma exponential 移動平均',
    inputs: [{ k: 'len', label: '期間', def: 20 }, { k: 'src', label: 'ソース', def: 'close', opts: SRC_OPTS }],
    plots: [{ k: 'v', label: 'EMA', color: '#ff9800' }],
    calc(S, I, o, f, n) { ema(srcOf(S, I.src), I.len, A(o, 'v'), f, n); },
  },
  {
    id: 'wma', name: '加重移動平均線 (WMA)', short: 'WMA', overlay: true, kw: 'ma weighted 移動平均',
    inputs: [{ k: 'len', label: '期間', def: 20 }, { k: 'src', label: 'ソース', def: 'close', opts: SRC_OPTS }],
    plots: [{ k: 'v', label: 'WMA', color: '#e91e63' }],
    calc(S, I, o, f, n) { wma(srcOf(S, I.src), I.len, A(o, 'v'), f, n); },
  },
  {
    id: 'bb', name: 'ボリンジャーバンド', short: 'BB', overlay: true, kw: 'bollinger bands',
    inputs: [{ k: 'len', label: '期間', def: 20 }, { k: 'mult', label: '標準偏差', def: 2, step: 0.1 }, { k: 'src', label: 'ソース', def: 'close', opts: SRC_OPTS }],
    plots: [{ k: 'mid', label: '基準線', color: '#2962ff' }, { k: 'up', label: '上限', color: '#f23645' }, { k: 'lo', label: '下限', color: '#089981' }],
    fills: [{ a: 'up', b: 'lo', color: 'rgba(33,150,243,0.07)' }],
    calc(S, I, o, f, n) {
      const s = srcOf(S, I.src), m = A(o, 'mid'), sd = A(o, '_sd'), u = A(o, 'up'), l = A(o, 'lo');
      sma(s, I.len, m, f, n); stdev(s, I.len, sd, f, n);
      for (let i = f; i < n; i++) { u[i] = m[i] + I.mult * sd[i]; l[i] = m[i] - I.mult * sd[i]; }
    },
  },
  {
    id: 'ichimoku', name: '一目均衡表', short: '一目', overlay: true, kw: 'ichimoku cloud 雲',
    inputs: [{ k: 'conv', label: '転換線', def: 9 }, { k: 'base', label: '基準線', def: 26 }, { k: 'spanb', label: '先行スパン2', def: 52 }, { k: 'disp', label: '遅行・先行', def: 26 }],
    plots: [
      { k: 'tenkan', label: '転換線', color: '#2962ff' },
      { k: 'kijun', label: '基準線', color: '#b71c1c' },
      { k: 'chikou', label: '遅行スパン', color: '#43a047', shift: (I) => -(I.disp - 1) },
      { k: 'spanA', label: '先行スパン1', color: '#a5d6a7', shift: (I) => I.disp - 1 },
      { k: 'spanB', label: '先行スパン2', color: '#ef9a9a', shift: (I) => I.disp - 1 },
    ],
    fills: [{ a: 'spanA', b: 'spanB', color: 'rgba(67,160,71,0.12)', color2: 'rgba(244,67,54,0.12)' }],
    calc(S, I, o, f, n) {
      const hh = (len, k) => { highest(S.h, len, A(o, '_h' + k), f, n); lowest(S.l, len, A(o, '_l' + k), f, n); };
      hh(I.conv, 'c'); hh(I.base, 'b'); hh(I.spanb, 's');
      const t = A(o, 'tenkan'), k = A(o, 'kijun'), a = A(o, 'spanA'), b = A(o, 'spanB'), ch = A(o, 'chikou');
      for (let i = f; i < n; i++) {
        t[i] = (o._hc[i] + o._lc[i]) / 2; k[i] = (o._hb[i] + o._lb[i]) / 2;
        a[i] = (t[i] + k[i]) / 2; b[i] = (o._hs[i] + o._ls[i]) / 2; ch[i] = S.c[i];
      }
    },
  },
  {
    id: 'vwap', name: 'VWAP（日中）', short: 'VWAP', overlay: true, kw: 'volume weighted average price',
    inputs: [],
    plots: [{ k: 'v', label: 'VWAP', color: '#ab47bc' }],
    calc(S, I, o, f, n) {
      const pv = A(o, '_pv'), vv = A(o, '_vv'), d = A(o, 'v');
      for (let i = f; i < n; i++) {
        const same = i > 0 && alignTF(S.t[i], DAY, S.off) === alignTF(S.t[i - 1], DAY, S.off);
        pv[i] = (same ? pv[i - 1] : 0) + S.hlc3[i] * S.v[i];
        vv[i] = (same ? vv[i - 1] : 0) + S.v[i];
        d[i] = vv[i] > 0 ? pv[i] / vv[i] : S.hlc3[i];
      }
    },
  },
  {
    id: 'psar', name: 'パラボリック SAR', short: 'SAR', overlay: true, kw: 'parabolic sar',
    inputs: [{ k: 'start', label: '開始', def: 0.02, step: 0.01 }, { k: 'inc', label: '増分', def: 0.02, step: 0.01 }, { k: 'max', label: '最大', def: 0.2, step: 0.01 }],
    plots: [{ k: 'v', label: 'SAR', color: '#2196f3', type: 'points' }],
    calc(S, I, o, f, n) {
      const v = A(o, 'v'), up = A(o, '_up'), ep = A(o, '_ep'), af = A(o, '_af');
      for (let i = Math.max(f, 0); i < n; i++) {
        if (i === 0) { v[0] = nan; up[0] = true; ep[0] = S.h[0]; af[0] = I.start; continue; }
        if (i === 1) { up[1] = S.c[1] >= S.c[0]; v[1] = up[1] ? S.l[0] : S.h[0]; ep[1] = up[1] ? S.h[1] : S.l[1]; af[1] = I.start; continue; }
        let sar = v[i - 1] + af[i - 1] * (ep[i - 1] - v[i - 1]);
        let u = up[i - 1], e = ep[i - 1], a = af[i - 1];
        if (u) {
          sar = Math.min(sar, S.l[i - 1], S.l[i - 2]);
          if (S.l[i] < sar) { u = false; sar = e; e = S.l[i]; a = I.start; }
          else if (S.h[i] > e) { e = S.h[i]; a = Math.min(a + I.inc, I.max); }
        } else {
          sar = Math.max(sar, S.h[i - 1], S.h[i - 2]);
          if (S.h[i] > sar) { u = true; sar = e; e = S.h[i]; a = I.start; }
          else if (S.l[i] < e) { e = S.l[i]; a = Math.min(a + I.inc, I.max); }
        }
        v[i] = sar; up[i] = u; ep[i] = e; af[i] = a;
      }
    },
  },
  {
    id: 'donchian', name: 'ドンチャンチャネル', short: 'DC', overlay: true, kw: 'donchian channel breakout',
    inputs: [{ k: 'len', label: '期間', def: 20 }],
    plots: [{ k: 'up', label: '上限', color: '#2962ff' }, { k: 'mid', label: '中央', color: '#ff6d00' }, { k: 'lo', label: '下限', color: '#2962ff' }],
    fills: [{ a: 'up', b: 'lo', color: 'rgba(41,98,255,0.06)' }],
    calc(S, I, o, f, n) {
      const u = A(o, 'up'), l = A(o, 'lo'), m = A(o, 'mid');
      highest(S.h, I.len, u, f, n); lowest(S.l, I.len, l, f, n);
      for (let i = f; i < n; i++) m[i] = (u[i] + l[i]) / 2;
    },
  },
  {
    id: 'supertrend', name: 'スーパートレンド', short: 'ST', overlay: true, kw: 'supertrend atr',
    inputs: [{ k: 'len', label: 'ATR期間', def: 10 }, { k: 'mult', label: '係数', def: 3, step: 0.1 }],
    plots: [{ k: 'v', label: 'スーパートレンド', color: UP, colorFn: (i, o) => (o._dir[i] > 0 ? UP : DN) }],
    calc(S, I, o, f, n) {
      const tr = A(o, '_tr'), atr = A(o, '_atr'), ub = A(o, '_ub'), lb = A(o, '_lb'), dir = A(o, '_dir'), v = A(o, 'v');
      trueRange(S, tr, f, n); rma(tr, I.len, atr, f, n);
      for (let i = f; i < n; i++) {
        if (!ok(atr[i])) { ub[i] = lb[i] = v[i] = nan; dir[i] = 1; continue; }
        let u = S.hl2[i] + I.mult * atr[i], l = S.hl2[i] - I.mult * atr[i];
        const pu = ub[i - 1], pl = lb[i - 1], pc = S.c[i - 1];
        if (ok(pl) && !(l > pl || pc < pl)) l = pl;
        if (ok(pu) && !(u < pu || pc > pu)) u = pu;
        let d = dir[i - 1] ?? 1;
        if (!ok(pu)) d = 1;
        else if (d < 0 && S.c[i] > pu) d = 1;
        else if (d > 0 && S.c[i] < pl) d = -1;
        ub[i] = u; lb[i] = l; dir[i] = d; v[i] = d > 0 ? l : u;
      }
    },
  },
  {
    id: 'volume', name: '出来高', short: '出来高', overlay: true, volume: true, kw: 'volume',
    inputs: [{ k: 'ma', label: '移動平均', def: 20 }],
    plots: [
      { k: 'v', label: '出来高', color: UP, type: 'hist', colorFn: (i, o, S) => (S.c[i] >= S.o[i] ? 'rgba(8,153,129,0.45)' : 'rgba(242,54,69,0.45)') },
      { k: 'ma', label: 'MA', color: '#2962ff', width: 1 },
    ],
    calc(S, I, o, f, n) {
      const v = A(o, 'v');
      for (let i = f; i < n; i++) v[i] = S.v[i];
      sma(S.v, I.ma, A(o, 'ma'), f, n);
    },
  },
  {
    id: 'rsi', name: 'RSI（相対力指数）', short: 'RSI', kw: 'relative strength index',
    inputs: [{ k: 'len', label: '期間', def: 14 }, { k: 'src', label: 'ソース', def: 'close', opts: SRC_OPTS }],
    plots: [{ k: 'rsi', label: 'RSI', color: '#7e57c2' }],
    levels: [70, 50, 30], range: [0, 100],
    calc(S, I, o, f, n) { rsiCalc(srcOf(S, I.src), I.len, o, f, n); },
  },
  {
    id: 'macd', name: 'MACD', short: 'MACD', kw: 'moving average convergence divergence',
    inputs: [{ k: 'fast', label: '短期', def: 12 }, { k: 'slow', label: '長期', def: 26 }, { k: 'sig', label: 'シグナル', def: 9 }],
    plots: [
      { k: 'hist', label: 'ヒストグラム', color: '#26a69a', type: 'hist', colorFn: (i, o) => { const h = o.hist[i], p = o.hist[i - 1]; return h >= 0 ? (h >= p ? '#26a69a' : '#b2dfdb') : (h < p ? '#ff5252' : '#ffcdd2'); } },
      { k: 'macd', label: 'MACD', color: '#2962ff' },
      { k: 'signal', label: 'シグナル', color: '#ff6d00' },
    ],
    levels: [0],
    calc(S, I, o, f, n) {
      const a = A(o, '_f'), b = A(o, '_s'), m = A(o, 'macd'), s = A(o, 'signal'), h = A(o, 'hist');
      ema(S.c, I.fast, a, f, n); ema(S.c, I.slow, b, f, n);
      for (let i = f; i < n; i++) m[i] = a[i] - b[i];
      ema(m, I.sig, s, f, n);
      for (let i = f; i < n; i++) h[i] = m[i] - s[i];
    },
  },
  {
    id: 'stoch', name: 'ストキャスティクス', short: 'Stoch', kw: 'stochastic',
    inputs: [{ k: 'k', label: '%K期間', def: 14 }, { k: 'ks', label: '%K平滑', def: 3 }, { k: 'd', label: '%D期間', def: 3 }],
    plots: [{ k: 'k', label: '%K', color: '#2962ff' }, { k: 'd', label: '%D', color: '#ff6d00' }],
    levels: [80, 20], range: [0, 100],
    calc(S, I, o, f, n) {
      const hh = A(o, '_hh'), ll = A(o, '_ll'), raw = A(o, '_raw');
      highest(S.h, I.k, hh, f, n); lowest(S.l, I.k, ll, f, n);
      for (let i = f; i < n; i++) raw[i] = hh[i] === ll[i] ? 50 : (100 * (S.c[i] - ll[i])) / (hh[i] - ll[i]);
      sma(raw, I.ks, A(o, 'k'), f, n); sma(o.k, I.d, A(o, 'd'), f, n);
    },
  },
  {
    id: 'atr', name: 'ATR（平均真の値幅）', short: 'ATR', kw: 'average true range volatility',
    inputs: [{ k: 'len', label: '期間', def: 14 }],
    plots: [{ k: 'v', label: 'ATR', color: '#e91e63' }],
    calc(S, I, o, f, n) { trueRange(S, A(o, '_tr'), f, n); rma(o._tr, I.len, A(o, 'v'), f, n); },
  },
  {
    id: 'dmi', name: 'DMI / ADX', short: 'DMI', kw: 'adx directional movement',
    inputs: [{ k: 'len', label: 'DI期間', def: 14 }, { k: 'adx', label: 'ADX平滑', def: 14 }],
    plots: [{ k: 'adx', label: 'ADX', color: '#ff6d00' }, { k: 'pdi', label: '+DI', color: '#2962ff' }, { k: 'mdi', label: '-DI', color: '#f23645' }],
    levels: [20],
    calc(S, I, o, f, n) {
      const pdm = A(o, '_p'), mdm = A(o, '_m'), tr = A(o, '_tr');
      for (let i = f; i < n; i++) {
        const up = i ? S.h[i] - S.h[i - 1] : nan, dn = i ? S.l[i - 1] - S.l[i] : nan;
        pdm[i] = i ? (up > dn && up > 0 ? up : 0) : nan;
        mdm[i] = i ? (dn > up && dn > 0 ? dn : 0) : nan;
      }
      trueRange(S, tr, f, n);
      rma(tr, I.len, A(o, '_atr'), f, n); rma(pdm, I.len, A(o, '_ps'), f, n); rma(mdm, I.len, A(o, '_ms'), f, n);
      const p = A(o, 'pdi'), m = A(o, 'mdi'), dx = A(o, '_dx');
      for (let i = f; i < n; i++) {
        p[i] = (100 * o._ps[i]) / o._atr[i]; m[i] = (100 * o._ms[i]) / o._atr[i];
        dx[i] = p[i] + m[i] === 0 ? 0 : (100 * Math.abs(p[i] - m[i])) / (p[i] + m[i]);
      }
      rma(dx, I.adx, A(o, 'adx'), f, n);
    },
  },
  {
    id: 'cci', name: 'CCI（商品チャネル指数）', short: 'CCI', kw: 'commodity channel index',
    inputs: [{ k: 'len', label: '期間', def: 20 }],
    plots: [{ k: 'v', label: 'CCI', color: '#2196f3' }],
    levels: [100, 0, -100],
    calc(S, I, o, f, n) {
      const ma = A(o, '_ma'), v = A(o, 'v');
      sma(S.hlc3, I.len, ma, f, n);
      for (let i = f; i < n; i++) {
        if (!ok(ma[i])) { v[i] = nan; continue; }
        let md = 0;
        for (let j = i - I.len + 1; j <= i; j++) md += Math.abs(S.hlc3[j] - ma[i]);
        md /= I.len;
        v[i] = md === 0 ? 0 : (S.hlc3[i] - ma[i]) / (0.015 * md);
      }
    },
  },
];

export const indicatorDef = (id) => INDICATORS.find((d) => d.id === id);

export function defaultInputs(def) {
  const o = {};
  for (const i of def.inputs) o[i.k] = i.def;
  return o;
}
