// データ取得: 暗号資産は Binance の公開 API、FX は同梱の Dukascopy データ
import { alignTF, DAY } from './util.js';

export const SYMBOLS = [
  { id: 'BTCUSDT', name: 'ビットコイン / テザー', type: 'crypto', digits: 2, qtyStep: 0.001, qty: 0.1, quote: 'USDT' },
  { id: 'ETHUSDT', name: 'イーサリアム / テザー', type: 'crypto', digits: 2, qtyStep: 0.01, qty: 1, quote: 'USDT' },
  { id: 'SOLUSDT', name: 'ソラナ / テザー', type: 'crypto', digits: 2, qtyStep: 0.1, qty: 10, quote: 'USDT' },
  { id: 'XRPUSDT', name: 'リップル / テザー', type: 'crypto', digits: 4, qtyStep: 1, qty: 1000, quote: 'USDT' },
  { id: 'BNBUSDT', name: 'BNB / テザー', type: 'crypto', digits: 2, qtyStep: 0.01, qty: 1, quote: 'USDT' },
  { id: 'DOGEUSDT', name: 'ドージコイン / テザー', type: 'crypto', digits: 5, qtyStep: 1, qty: 10000, quote: 'USDT' },
  { id: 'USDJPY', name: '米ドル / 円', type: 'fx', digits: 3, pip: 0.01, spread: 0.2, qtyStep: 1000, qty: 10000, quote: 'JPY' },
  { id: 'EURUSD', name: 'ユーロ / 米ドル', type: 'fx', digits: 5, pip: 0.0001, spread: 0.3, qtyStep: 1000, qty: 10000, quote: 'USD' },
  { id: 'GBPJPY', name: '英ポンド / 円', type: 'fx', digits: 3, pip: 0.01, spread: 0.9, qtyStep: 1000, qty: 10000, quote: 'JPY' },
  { id: 'EURJPY', name: 'ユーロ / 円', type: 'fx', digits: 3, pip: 0.01, spread: 0.4, qtyStep: 1000, qty: 10000, quote: 'JPY' },
  { id: 'GBPUSD', name: '英ポンド / 米ドル', type: 'fx', digits: 5, pip: 0.0001, spread: 0.7, qtyStep: 1000, qty: 10000, quote: 'USD' },
];

export function symbolInfo(id) {
  id = id.toUpperCase();
  const s = SYMBOLS.find((x) => x.id === id);
  if (s) return s;
  // 一覧にない Binance の銘柄
  const quote = ['USDT', 'USDC', 'FDUSD', 'BTC', 'ETH', 'JPY'].find((q) => id.endsWith(q)) || 'USDT';
  return { id, name: id, type: 'crypto', digits: 4, qtyStep: 0.001, qty: 1, quote, custom: true };
}

// 日足以上の区切り（FX は NY クローズ相当の 22:00 UTC）
export const dayOffset = (sym) => (sym.type === 'fx' ? -2 * 3600 : 0);

export function aggregate(bars, tf, off = 0) {
  if (tf === 60) return bars.slice();
  const out = [];
  let cur = null;
  for (const b of bars) {
    const k = alignTF(b.t, tf, off);
    if (!cur || cur.t !== k) {
      cur = { t: k, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v };
      out.push(cur);
    } else {
      if (b.h > cur.h) cur.h = b.h;
      if (b.l < cur.l) cur.l = b.l;
      cur.c = b.c;
      cur.v += b.v;
    }
  }
  return out;
}

// ---------------- Binance ----------------
const BINANCE = 'https://data-api.binance.vision/api/v3/klines';
const BI = { 60: '1m', 180: '3m', 300: '5m', 900: '15m', 1800: '30m', 3600: '1h', 7200: '2h', 14400: '4h', 86400: '1d', 604800: '1w' };

async function klines(symbol, interval, params) {
  const q = new URLSearchParams({ symbol, interval, limit: 1000, ...params });
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(`${BINANCE}?${q}`);
      if (r.status === 400) throw Object.assign(new Error('銘柄が見つかりません: ' + symbol), { fatal: true });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      return j.map((k) => ({ t: k[0] / 1000, o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5] }));
    } catch (e) {
      if (e.fatal || i === 3) throw e;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
}

const binance = {
  // [from, to) の1分足
  async load1m(sym, from, to) {
    const out = [];
    let s = from;
    while (s < to) {
      const part = await klines(sym.id, '1m', { startTime: s * 1000, endTime: (to - 60) * 1000 });
      if (!part.length) break;
      out.push(...part);
      s = part[part.length - 1].t + 60;
      if (part.length < 1000) break;
    }
    return out.filter((b) => b.t >= from && b.t < to);
  },
  // end より前に確定した足を count 本
  async loadTF(sym, tf, end, count) {
    let out = [];
    let endT = end - tf;
    while (out.length < count) {
      const part = await klines(sym.id, BI[tf], { endTime: endT * 1000, limit: Math.min(1000, count - out.length) });
      if (!part.length) break;
      out = part.concat(out);
      endT = part[0].t - 1;
      if (part.length < 1000 && out.length < count) break;
    }
    return out.filter((b) => b.t + tf <= end);
  },
  async range(sym) {
    const first = await klines(sym.id, '1m', { startTime: 0, limit: 1 });
    return { min: first[0]?.t ?? 0, max: Math.floor(Date.now() / 1000 / 60) * 60 };
  },
};

// ---------------- FX（同梱データ） ----------------
let manifestP = null;
const fileCache = new Map();
function manifest() {
  return (manifestP ||= fetch('data/fx/index.json').then((r) => (r.ok ? r.json() : { pairs: {} })).catch(() => ({ pairs: {} })));
}

async function readBin(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('データがありません: ' + url);
  let buf = new Uint8Array(await r.arrayBuffer());
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    const ds = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
    buf = new Uint8Array(await new Response(ds).arrayBuffer());
  }
  const dv = new DataView(buf.buffer);
  const n = dv.getUint32(4, true), base = dv.getUint32(8, true), digits = dv.getUint32(12, true);
  const sc = 10 ** digits;
  const step = url.includes('/h1') ? 60 : 1;
  let p = 16;
  const rd = () => { let v = 0, m = 1, b; do { b = buf[p++]; v += (b & 127) * m; m *= 128; } while (b & 128); return v; };
  const uz = (v) => (v & 1 ? -(v + 1) / 2 : v / 2);
  const out = new Array(n);
  let tm = base, pc = null;
  for (let i = 0; i < n; i++) {
    tm += rd() * step;
    const o = (pc ?? 0) + uz(rd());
    const c = o + uz(rd());
    const h = Math.max(o, c) + rd();
    const l = Math.min(o, c) - rd();
    const v = rd();
    out[i] = { t: tm * 60, o: o / sc, h: h / sc, l: l / sc, c: c / sc, v };
    pc = c;
  }
  // 先頭の始値は前の終値からの差分として保存されている（先頭は前終値=始値）
  return out;
}
function loadFile(url) {
  if (!fileCache.has(url)) fileCache.set(url, readBin(url).catch((e) => { fileCache.delete(url); throw e; }));
  return fileCache.get(url);
}
const monthKey = (t) => new Date(t * 1000).toISOString().slice(0, 7);

const fx = {
  async months(sym) {
    const m = await manifest();
    return m.pairs[sym.id]?.m1 || [];
  },
  async load1m(sym, from, to) {
    const months = await this.months(sym);
    const need = months.filter((k) => {
      const [y, mo] = k.split('-').map(Number);
      const a = Date.UTC(y, mo - 1, 1) / 1000, b = Date.UTC(y, mo, 1) / 1000;
      return b > from && a < to;
    });
    const parts = await Promise.all(need.map((k) => loadFile(`data/fx/${sym.id}/m1-${k}.bin.gz`)));
    return parts.flat().filter((b) => b.t >= from && b.t < to);
  },
  async loadTF(sym, tf, end, count) {
    const off = dayOffset(sym);
    if (tf >= 3600) {
      const m = await manifest();
      let h1 = [];
      if (m.pairs[sym.id]?.h1) h1 = await loadFile(`data/fx/${sym.id}/h1.bin.gz`);
      // 1時間足データより新しい部分は1分足から補う
      const lastH = h1.length ? h1[h1.length - 1].t + 3600 : 0;
      let extra = [];
      if (end > lastH) {
        const from = Math.max(lastH, end - Math.min(count * tf, 120 * DAY));
        extra = aggregate(await this.load1m(sym, from, end), 3600);
      }
      const src = h1.filter((b) => b.t + 3600 <= end).concat(extra.filter((b) => b.t >= lastH));
      const agg = aggregate(src, tf, off).filter((b) => b.t + tf <= end);
      return agg.slice(-count);
    }
    const months = await this.months(sym);
    let bars = [];
    let cursor = end;
    const want = count * tf / 60;
    // 手持ちの最新月より先なら、最新月の終わりまで戻る
    const lastK = months[months.length - 1];
    if (lastK && monthKey(cursor - 1) > lastK) { const [ly, lm] = lastK.split('-').map(Number); cursor = Math.min(cursor, Date.UTC(ly, lm, 1) / 1000); }
    for (let i = 0; i < 4 && bars.length < want; i++) {
      const k = monthKey(cursor - 1);
      if (!months.includes(k)) break;
      const [y, mo] = k.split('-').map(Number);
      const a = Date.UTC(y, mo - 1, 1) / 1000;
      const part = (await loadFile(`data/fx/${sym.id}/m1-${k}.bin.gz`)).filter((b) => b.t < cursor);
      bars = part.concat(bars);
      cursor = a;
    }
    return aggregate(bars, tf, off).filter((b) => b.t + tf <= end).slice(-count);
  },
  async range(sym) {
    const months = await this.months(sym);
    if (!months.length) return null;
    const [y1, m1] = months[0].split('-').map(Number);
    const [y2, m2] = months[months.length - 1].split('-').map(Number);
    return { min: Date.UTC(y1, m1 - 1, 1) / 1000, max: Date.UTC(y2, m2, 1) / 1000 };
  },
};

export const sourceFor = (sym) => (sym.type === 'fx' ? fx : binance);
export { manifest as fxManifest };
