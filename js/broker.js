// デモ口座（ネッティング方式: 銘柄ごとに1ポジション、反対売買で決済・ドテン）
// 価格は Bid 基準。買いは Ask(=Bid+スプレッド) で約定する。

let seq = 1;

export class Account {
  constructor(sym, cfg, name = '手動') {
    this.sym = sym;
    this.name = name;
    this.cfg = { ...cfg }; // balance, leverage, fee(率), spread(価格), stopOut
    this.reset();
  }
  reset() {
    this.balance = this.cfg.balance;
    this.pos = { qty: 0, avg: 0, sl: null, tp: null, t: 0, fee: 0 };
    this.orders = [];
    this.trades = [];
    this.execs = [];
    this.curve = [];
    this.queued = [];
    this.bid = null;
    this.t = 0;
    this.version = 0;
    this.peak = this.balance;
    this.maxDD = 0;
    this.maxDDpct = 0;
    this.log = [];
  }
  get ask() { return this.bid == null ? null : this.bid + this.cfg.spread; }
  get side() { return Math.sign(this.pos.qty); }
  unrealized(bid = this.bid) {
    const p = this.pos;
    if (!p.qty || bid == null) return 0;
    const exit = p.qty > 0 ? bid : bid + this.cfg.spread;
    return (exit - p.avg) * p.qty;
  }
  equity() { return this.balance + this.unrealized(); }
  marginUsed(price = this.bid) { return price == null ? 0 : (Math.abs(this.pos.qty) * price) / this.cfg.leverage; }
  marginLevel() { const m = this.marginUsed(); return m > 0 ? (this.equity() / m) * 100 : null; }
  freeMargin() { return this.equity() - this.marginUsed(); }

  note(msg) { this.log.push({ t: this.t, msg }); this.version++; }

  // 新規分の証拠金チェック
  canTrade(side, qty, px) {
    const after = Math.abs(this.pos.qty + side * qty);
    if (after <= Math.abs(this.pos.qty)) return true;
    return (after * px) / this.cfg.leverage <= this.equity() + 1e-9;
  }

  // ---------- 約定 ----------
  fill(side, qty, px, reason, extra = {}) {
    if (qty <= 0) return;
    const p = this.pos;
    const fee = qty * px * this.cfg.fee;
    this.balance -= fee;
    this.execs.push({ t: this.t, side, qty, px, reason, id: seq++ });
    let remain = qty;
    if (p.qty && Math.sign(p.qty) !== side) {
      const cq = Math.min(remain, Math.abs(p.qty));
      const dir = Math.sign(p.qty);
      const pnl = (px - p.avg) * cq * dir;
      const entryFee = (p.fee * cq) / Math.abs(p.qty);
      const exitFee = (fee * cq) / qty;
      p.fee -= entryFee;
      this.balance += pnl;
      this.trades.push({ id: seq++, dir, qty: cq, entry: p.avg, exit: px, entryT: p.t, exitT: this.t, pnl: pnl - entryFee - exitFee, gross: pnl, fees: entryFee + exitFee, reason, mae: p.mae, mfe: p.mfe });
      p.qty += side * cq;
      remain -= cq;
      if (Math.abs(p.qty) < 1e-12) { p.qty = 0; p.avg = 0; p.sl = p.tp = null; p.fee = 0; }
    }
    if (remain > 1e-12) {
      const fresh = !p.qty;
      const aq = Math.abs(p.qty);
      p.avg = (aq * p.avg + remain * px) / (aq + remain);
      p.qty += side * remain;
      p.fee += (fee * remain) / qty;
      if (fresh) { p.t = this.t; p.sl = null; p.tp = null; p.mae = 0; p.mfe = 0; }
    }
    if (p.qty && Math.sign(p.qty) === side) {
      if (extra.sl != null) p.sl = extra.sl;
      if (extra.tp != null) p.tp = extra.tp;
    }
    this.markEquity();
    this.version++;
  }

  // 成行（手動）: 現在値で即約定
  market(side, qty, extra = {}) {
    if (this.bid == null) return '価格がありません';
    const px = side > 0 ? this.ask : this.bid;
    if (!this.canTrade(side, qty, px)) return '証拠金が足りません';
    this.fill(side, qty, px, extra.reason || '成行', extra);
    return null;
  }
  // 成行（ストラテジー）: 次の値動きで約定（バックテストと同じく次の足の始値相当）
  queueMarket(side, qty, extra = {}) { this.queued.push({ side, qty, extra }); }

  placeOrder(o) {
    const ord = { id: seq++, side: o.side, type: o.type, price: o.price, qty: o.qty, sl: o.sl ?? null, tp: o.tp ?? null, t: this.t, comment: o.comment || '' };
    this.orders.push(ord);
    this.version++;
    return ord;
  }
  cancelOrder(id) { this.orders = this.orders.filter((o) => o.id !== id); this.version++; }
  cancelAll() { if (this.orders.length) { this.orders = []; this.version++; } }
  modifyOrder(id, patch) { const o = this.orders.find((x) => x.id === id); if (o) { Object.assign(o, patch); this.version++; } }
  setBrackets(sl, tp) {
    if (!this.pos.qty) return;
    if (sl !== undefined) this.pos.sl = sl;
    if (tp !== undefined) this.pos.tp = tp;
    this.version++;
  }
  closePosition(reason = '決済', qty) {
    const p = this.pos;
    if (!p.qty) return;
    const side = -Math.sign(p.qty);
    const q = Math.min(qty ?? Math.abs(p.qty), Math.abs(p.qty));
    this.fill(side, q, side > 0 ? this.ask : this.bid, reason);
  }
  closeAll(reason = '全決済') { this.cancelAll(); this.closePosition(reason); }

  // ---------- 値動き処理 ----------
  // 価格条件を Bid の閾値に変換: dirn=-1 は Bid がそれ以下で発動、+1 はそれ以上で発動
  triggers() {
    const sp = this.cfg.spread, p = this.pos, out = [];
    for (const o of this.orders) {
      const buy = o.side > 0;
      const lvl = buy ? o.price - sp : o.price;
      const dirn = o.type === 'limit' ? (buy ? -1 : 1) : buy ? 1 : -1;
      out.push({ kind: 'order', o, lvl, dirn, isLimit: o.type === 'limit', buy });
    }
    if (p.qty > 0) {
      if (p.sl != null) out.push({ kind: 'sl', lvl: p.sl, dirn: -1, buy: false });
      if (p.tp != null) out.push({ kind: 'tp', lvl: p.tp, dirn: 1, buy: false, isLimit: true });
    } else if (p.qty < 0) {
      if (p.sl != null) out.push({ kind: 'sl', lvl: p.sl - sp, dirn: 1, buy: true });
      if (p.tp != null) out.push({ kind: 'tp', lvl: p.tp - sp, dirn: -1, buy: true, isLimit: true });
    }
    return out;
  }

  // Bid が b0 → b1 へ（jump=true は窓開け・足の切れ目）動いたときの処理
  segment(b0, b1, t, jump = false) {
    this.t = t;
    if (this.bid == null) this.bid = b0;
    // ストラテジーの成行は次の値で約定
    if (this.queued.length) {
      const q = this.queued; this.queued = [];
      this.bid = jump ? b1 : b0;
      for (const m of q) {
        const px = m.side > 0 ? this.ask : this.bid;
        if (this.canTrade(m.side, m.qty, px)) this.fill(m.side, m.qty, px, m.extra.reason || '成行', m.extra);
        else this.note('証拠金不足で発注できませんでした');
      }
    }
    let from = b0, guard = 0;
    for (;;) {
      if (++guard > 50) break;
      let best = null, bestF = 2, bestPx = 0;
      for (const tr of this.triggers()) {
        let f = null, px;
        const already = tr.dirn < 0 ? from <= tr.lvl : from >= tr.lvl;
        if (already) { f = 0; px = from; }
        else if (tr.dirn < 0 ? b1 <= tr.lvl : b1 >= tr.lvl) {
          f = (from - tr.lvl) / (from - b1 || 1);
          px = jump ? b1 : tr.lvl;
        }
        if (f != null && f < bestF) { best = tr; bestF = f; bestPx = px; }
      }
      if (!best) break;
      this.bid = bestPx;
      const px = best.buy ? bestPx + this.cfg.spread : bestPx;
      if (best.kind === 'order') {
        const o = best.o;
        this.orders = this.orders.filter((x) => x !== o);
        // 指値は指定値より不利には約定しない
        const fpx = best.isLimit ? (o.side > 0 ? Math.min(px, o.price) : Math.max(px, o.price)) : px;
        if (this.canTrade(o.side, o.qty, fpx)) this.fill(o.side, o.qty, fpx, o.type === 'limit' ? '指値' : '逆指値', { sl: o.sl, tp: o.tp });
        else { this.note('証拠金不足で注文を取り消しました'); this.version++; }
      } else {
        const p = this.pos;
        const lvlPx = best.kind === 'tp' ? (p.qty > 0 ? Math.max(px, p.tp) : Math.min(px, p.tp)) : px;
        this.fill(-Math.sign(p.qty), Math.abs(p.qty), lvlPx, best.kind === 'sl' ? '損切り' : '利確');
      }
      from = bestPx;
    }
    this.bid = b1;
    // 含み損益の最大・最小
    const p = this.pos;
    if (p.qty) {
      const u = this.unrealized();
      if (u < p.mae) p.mae = u;
      if (u > p.mfe) p.mfe = u;
      // ロスカット
      const m = this.marginUsed();
      if (m > 0 && this.equity() <= m * this.cfg.stopOut) {
        this.closeAll('ロスカット');
        this.note('証拠金維持率が下がったためロスカットされました');
      }
    }
  }

  markEquity() {
    const eq = this.equity();
    if (eq > this.peak) this.peak = eq;
    const dd = this.peak - eq;
    if (dd > this.maxDD) this.maxDD = dd;
    const pct = this.peak > 0 ? (dd / this.peak) * 100 : 0;
    if (pct > this.maxDDpct) this.maxDDpct = pct;
    const last = this.curve[this.curve.length - 1];
    if (last && last.t === this.t) { last.eq = eq; last.bal = this.balance; }
    else this.curve.push({ t: this.t, eq, bal: this.balance });
  }

  stats() {
    const tr = this.trades;
    const wins = tr.filter((x) => x.pnl > 0), losses = tr.filter((x) => x.pnl <= 0);
    const gp = wins.reduce((a, x) => a + x.pnl, 0), gl = -losses.reduce((a, x) => a + x.pnl, 0);
    let streak = 0, maxLossStreak = 0;
    for (const x of tr) { if (x.pnl <= 0) { streak++; maxLossStreak = Math.max(maxLossStreak, streak); } else streak = 0; }
    const side = (d) => {
      const s = tr.filter((x) => x.dir === d);
      return { n: s.length, net: s.reduce((a, x) => a + x.pnl, 0), win: s.length ? (s.filter((x) => x.pnl > 0).length / s.length) * 100 : 0 };
    };
    return {
      net: this.balance - this.cfg.balance,
      netPct: ((this.balance - this.cfg.balance) / this.cfg.balance) * 100,
      open: this.unrealized(),
      n: tr.length, wins: wins.length, losses: losses.length,
      winRate: tr.length ? (wins.length / tr.length) * 100 : 0,
      gp, gl, pf: gl > 0 ? gp / gl : gp > 0 ? Infinity : 0,
      avg: tr.length ? tr.reduce((a, x) => a + x.pnl, 0) / tr.length : 0,
      avgWin: wins.length ? gp / wins.length : 0,
      avgLoss: losses.length ? -gl / losses.length : 0,
      maxWin: wins.length ? Math.max(...wins.map((x) => x.pnl)) : 0,
      maxLoss: losses.length ? Math.min(...losses.map((x) => x.pnl)) : 0,
      maxDD: this.maxDD, maxDDpct: this.maxDDpct, maxLossStreak,
      fees: tr.reduce((a, x) => a + x.fees, 0),
      long: side(1), short: side(-1),
    };
  }

  snapshot() {
    return JSON.parse(JSON.stringify({ cfg: this.cfg, balance: this.balance, pos: this.pos, orders: this.orders, trades: this.trades, execs: this.execs, curve: this.curve, peak: this.peak, maxDD: this.maxDD, maxDDpct: this.maxDDpct, t: this.t, bid: this.bid }));
  }
  restore(s) { Object.assign(this, s); this.queued = []; this.log = []; this.version++; }
}

// 足の中の値動き（陽線は 始→安→高→終、陰線は 始→高→安→終）
export function barPath(b) {
  return b.c >= b.o ? [b.o, b.l, b.h, b.c] : [b.o, b.h, b.l, b.c];
}
