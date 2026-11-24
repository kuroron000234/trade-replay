// リプレイエンジン: 1分足を時間どおりに再生し、表示中の時間足を組み立てる
import { alignTF, Emitter, DAY } from './util.js';
import { sourceFor, dayOffset, aggregate } from './data.js';

export const SPEEDS = [
  { v: 1, label: '実時間' }, { v: 5, label: '5倍' }, { v: 20, label: '20倍' },
  { v: 60, label: '1分/秒' }, { v: 180, label: '3分/秒' }, { v: 600, label: '10分/秒' },
  { v: 1800, label: '30分/秒' }, { v: 3600, label: '1時間/秒' }, { v: 14400, label: '4時間/秒' }, { v: 86400, label: '1日/秒' },
];
const HIST = 1500;

export class Replay extends Emitter {
  constructor() {
    super();
    this.mode = 'idle'; // idle | replay
    this.bars = [];
    this.view = [];
    this.M = [];
    this.accounts = [];
    this.speed = 60;
    this.playing = false;
    this.loading = false;
    this.ended = false;
    this.token = 0;
  }
  get off() { return dayOffset(this.sym); }
  get src() { return sourceFor(this.sym); }
  bucket(t) { return alignTF(t, this.tf, this.off); }
  price() { return this.lastPrice; }

  // ---------- 通常表示（リプレイ外） ----------
  async loadIdle(sym, tf) {
    const tok = ++this.token;
    this.sym = sym; this.tf = tf; this.mode = 'idle'; this.playing = false;
    this.emit('loading', true);
    try {
      const range = await this.src.range(sym);
      if (tok !== this.token) return;
      this.range = range;
      if (!range) throw new Error(`${sym.id} のデータがまだありません`);
      const end = Math.min(range.max, Math.floor(Date.now() / 1000));
      const bars = await this.src.loadTF(sym, tf, this.bucket(end) + (sym.type === 'fx' ? tf : 0), HIST);
      if (tok !== this.token) return;
      this.bars = bars; this.view = bars.slice(); this.M = [];
      this.lastPrice = bars.length ? bars[bars.length - 1].c : null;
      this.T = bars.length ? bars[bars.length - 1].t + tf : end;
      this.emit('reset');
    } finally {
      if (tok === this.token) this.emit('loading', false);
    }
  }

  // 左へスクロールしたときに過去の足を足す
  async loadOlder() {
    if (this.loadingOlder || !this.bars.length || this.noOlder) return 0;
    this.loadingOlder = true;
    const tok = this.token;
    try {
      const older = await this.src.loadTF(this.sym, this.tf, this.bars[0].t, 1000);
      if (tok !== this.token || !older.length) { if (!older.length) this.noOlder = true; return 0; }
      this.bars = older.concat(this.bars);
      this.view = older.concat(this.view);
      if (this.mi != null) this.histLen += older.length;
      this.emit('prepend', older.length);
      return older.length;
    } finally { this.loadingOlder = false; }
  }

  // ---------- リプレイ ----------
  // T0: この時刻の直前までが見えている状態から始める
  async start(T0, sym = this.sym, tf = this.tf) {
    const tok = ++this.token;
    this.sym = sym; this.tf = tf; this.mode = 'replay'; this.playing = false; this.ended = false; this.noOlder = false;
    this.emit('loading', true);
    try {
      const anchor = this.bucket(T0);
      const [hist, M] = await Promise.all([
        this.src.loadTF(sym, tf, anchor, HIST),
        this.src.load1m(sym, anchor, Math.max(T0, anchor) + (sym.type === 'fx' ? 7 : 2) * DAY),
      ]);
      if (tok !== this.token) return;
      if (!M.length || M[M.length - 1].t < T0) throw new Error('この日時以降のデータがありません');
      this.startT = T0;
      this.M = M;
      this.T = T0;
      this.rebuild(hist, anchor);
      this.emit('reset');
      this.emit('started');
    } finally {
      if (tok === this.token) this.emit('loading', false);
    }
  }

  // hist と 1分足（anchor 〜 T）から足の配列を組み立てる
  rebuild(hist, anchor) {
    this.bars = hist.slice();
    this.histLen = hist.length;
    this.mi = this.M.findIndex((b) => b.t + 60 > this.T);
    if (this.mi < 0) this.mi = this.M.length;
    for (let i = 0; i < this.mi; i++) if (this.M[i].t >= anchor) this.applyMinute(this.M[i]);
    this.inMinute = this.mi < this.M.length && this.M[this.mi].t < this.T;
    const prev = this.mi > 0 ? this.M[this.mi - 1] : hist[hist.length - 1];
    this.lastPrice = this.inMinute ? this.pathPrice(this.M[this.mi], (this.T - this.M[this.mi].t) / 60) : prev?.c ?? this.M[0]?.o;
    this.view = this.bars.slice();
    this.closedCount = this.countClosed();
    this.updateLive();
    for (const a of this.accounts) { a.bid ??= this.lastPrice; a.t = this.T; }
  }

  async setTF(tf) {
    if (this.mode !== 'replay') return this.loadIdle(this.sym, tf);
    const tok = ++this.token;
    this.playing = false;
    this.tf = tf;
    this.emit('loading', true);
    try {
      const anchor = this.bucket(this.T);
      const need = anchor < this.M[0].t ? this.src.load1m(this.sym, anchor, this.M[0].t) : Promise.resolve([]);
      const [hist, pre] = await Promise.all([this.src.loadTF(this.sym, tf, anchor, HIST), need]);
      if (tok !== this.token) return;
      if (pre.length) this.M = pre.concat(this.M);
      this.rebuild(hist, anchor);
      this.emit('reset');
    } finally {
      if (tok === this.token) this.emit('loading', false);
    }
  }

  applyMinute(b) {
    const k = this.bucket(b.t);
    const bars = this.bars;
    const last = bars[bars.length - 1];
    if (last && last.t === k) {
      if (b.h > last.h) last.h = b.h;
      if (b.l < last.l) last.l = b.l;
      last.c = b.c; last.v += b.v;
    } else if (!last || k > last.t) {
      bars.push({ t: k, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v });
    }
    const i = bars.length - 1;
    this.view[i] = bars[i];
    if (this.dirtyFrom == null || i < this.dirtyFrom) this.dirtyFrom = i;
  }

  pathPrice(b, f) {
    const P = b.c >= b.o ? [b.o, b.l, b.h, b.c] : [b.o, b.h, b.l, b.c];
    if (f >= 1) return b.c;
    const x = Math.max(0, f) * 3, k = Math.min(2, Math.floor(x));
    return P[k] + (P[k + 1] - P[k]) * (x - k);
  }
  partial(b, f) {
    const P = b.c >= b.o ? [b.o, b.l, b.h, b.c] : [b.o, b.h, b.l, b.c];
    const c = this.pathPrice(b, f);
    let h = Math.max(b.o, c), l = Math.min(b.o, c);
    for (let k = 1; k <= 2; k++) if (f * 3 >= k) { h = Math.max(h, P[k]); l = Math.min(l, P[k]); }
    return { t: b.t, o: b.o, h, l, c, v: b.v * Math.min(1, f) };
  }

  // 形成中の1分足を表示用の最後の足に重ねる
  updateLive() {
    const n = this.bars.length;
    if (this.inMinute) {
      const b = this.M[this.mi];
      const p = this.partial(b, (this.T - b.t) / 60);
      const k = this.bucket(b.t);
      const last = this.bars[n - 1];
      if (last && last.t === k) {
        this.view[n - 1] = { t: k, o: last.o, h: Math.max(last.h, p.h), l: Math.min(last.l, p.l), c: p.c, v: last.v + p.v };
        this.view.length = n;
        this.markDirty(n - 1);
      } else {
        this.view[n] = { t: k, o: p.o, h: p.h, l: p.l, c: p.c, v: p.v };
        this.view.length = n + 1;
        this.markDirty(n);
      }
    } else {
      if (this.view.length > n) { this.view.length = n; this.structural = true; }
      if (n) { this.view[n - 1] = this.bars[n - 1]; }
    }
  }
  markDirty(i) { if (this.dirtyFrom == null || i < this.dirtyFrom) this.dirtyFrom = i; }

  countClosed() {
    const n = this.bars.length;
    if (!n) return 0;
    const last = this.bars[n - 1];
    return last.t + this.tf <= this.T ? n : n - 1;
  }

  // 確定足（ストラテジー用）
  closedBars() { return this.bars.slice(0, this.countClosed()); }

  emitSeg(b0, b1, jump) {
    for (const a of this.accounts) a.segment(b0, b1, this.T, jump);
    this.lastPrice = b1;
  }

  checkClose() {
    const c = this.countClosed();
    if (c > this.closedCount) {
      const from = this.closedCount;
      this.closedCount = c;
      this.emit('barclose', from, c);
    }
  }

  // シミュレーション時間を進める。gapSkip のとき、データの隙間（週末など）は時間を消費しない
  advance(limit, gapSkip = true) {
    let target = limit;
    let guard = 0;
    while (this.T < target && guard++ < 200000) {
      if (this.mi >= this.M.length) { this.needData = true; break; }
      const b = this.M[this.mi];
      if (!this.inMinute) {
        if (this.T < b.t) {
          if (gapSkip) target += b.t - this.T;
          if (b.t > target) { this.T = target; break; }
          this.T = b.t;
        }
        this.checkClose();
        this.emitSeg(this.lastPrice ?? b.o, b.o, true);
        this.inMinute = true;
      }
      const f0 = (this.T - b.t) / 60;
      const end = Math.min(target, b.t + 60);
      const f1 = (end - b.t) / 60;
      // 経路の頂点ごとに区切って口座へ渡す
      let fa = f0;
      for (const v of [1 / 3, 2 / 3, 1]) {
        if (v <= fa) continue;
        const fb = Math.min(v, f1);
        this.T = b.t + fb * 60;
        this.emitSeg(this.pathPrice(b, fa), this.pathPrice(b, fb), false);
        fa = fb;
        if (fb >= f1) break;
      }
      this.T = end;
      if (end >= b.t + 60) {
        this.applyMinute(b);
        this.mi++;
        this.inMinute = false;
        this.lastPrice = b.c;
      }
    }
    this.checkCloseAtBoundary();
    this.updateLive();
    this.prefetch();
  }
  // 次の1分足がまだ無くても、足の終わりの時刻に達していれば確定扱い
  checkCloseAtBoundary() {
    if (this.inMinute) return;
    const next = this.M[this.mi];
    if (next && next.t > this.T) return; // 隙間の途中: 次の足が始まるときに確定
    this.checkClose();
  }

  // 実時間 dt 秒ぶん再生
  tick(dt) {
    if (this.mode !== 'replay' || !this.playing) return;
    if (this.mi >= this.M.length) { this.prefetch(); if (this.ended) { this.playing = false; this.emit('ended'); } return; }
    this.advance(this.T + dt * this.speed, true);
  }

  // 1本進める（表示中の時間足）
  step() {
    if (this.mode !== 'replay') return;
    if (this.mi >= this.M.length) { this.prefetch(); return; }
    const b = this.M[this.mi];
    const t = Math.max(this.T, b.t);
    const end = this.bucket(t) + this.tf;
    this.advance(end, false);
    // 足の終わりに1分足が無い場合（取引時間外）でも確定させる
    if (this.T < end) {
      const nb = this.M[this.mi];
      if (nb && nb.t >= end) { this.T = end; this.checkClose(); this.updateLive(); }
    }
  }

  async prefetch() {
    if (this.mode !== 'replay' || this.loading || this.ended) return;
    const last = this.M[this.M.length - 1];
    if (!last) return;
    const ahead = last.t - this.T;
    const want = Math.max(3 * 3600, this.speed * 40);
    if (ahead > want) return;
    this.loading = true;
    const tok = this.token;
    try {
      const span = this.sym.type === 'fx' ? 20 * DAY : 1000 * 60;
      let from = last.t + 60;
      let got = [];
      // データが空の期間（長期休場など）を少し先まで探す
      for (let k = 0; k < 6 && !got.length; k++) {
        const maxT = this.range?.max ?? Date.now() / 1000;
        if (from >= maxT) break;
        got = await this.src.load1m(this.sym, from, from + span);
        from += span;
      }
      if (tok !== this.token) return;
      if (!got.length) { this.ended = true; return; }
      this.M.push(...got);
      this.needData = false;
    } catch (e) {
      this.emit('error', e);
    } finally {
      this.loading = false;
    }
  }

  stop() {
    this.token++;
    this.mode = 'idle';
    this.playing = false;
  }
}

export { aggregate };
