// デモ口座（ネッティング方式: 銘柄ごとに1ポジション、反対売買で決済・ドテン）
// 取引所と同じく、決済専用（reduce-only）の指値・逆指値で一部だけ利確・損切りでき、トレーリングストップも使える
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
    this.pos = { qty: 0, avg: 0, sl: null, tp: null, trail: null, t: 0, fee: 0 };
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
    if (!(qty > 0)) return false;
    const after = Math.abs(this.pos.qty + side * qty);
    if (after <= Math.abs(this.pos.qty)) return true;
    return (after * px) / this.cfg.leverage <= this.equity() + 1e-9;
  }

  // ---------- 約定 ----------
  fill(side, qty, px, reason, extra = {}) {
    if (qty <= 0) return;
    const p = this.pos;
    const eqBefore = this.equity();
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
      const tr = { id: seq++, dir, qty: cq, entry: p.avg, exit: px, entryT: p.t, exitT: this.t, pnl: pnl - entryFee - exitFee, gross: pnl, fees: entryFee + exitFee, reason, mae: p.mae * (cq / Math.abs(p.qty)), mfe: p.mfe * (cq / Math.abs(p.qty)), partial: cq < Math.abs(p.qty) - 1e-12,
        posId: p.id, ctx: p.ctx, entryReason: p.entryReason, initSL: p.initSL, initTP: p.initTP, openEquity: p.openEquity, slAtExit: p.sl, tpAtExit: p.tp };
      this.trades.push(tr);
      this.pendingTrades = (this.pendingTrades || []).concat(tr);
      p.qty += side * cq;
      remain -= cq;
      if (Math.abs(p.qty) < 1e-12) { p.qty = 0; p.avg = 0; p.sl = p.tp = p.trail = null; p.fee = 0; }
    }
    if (remain > 1e-12) {
      const fresh = !p.qty;
      const aq = Math.abs(p.qty);
      p.avg = (aq * p.avg + remain * px) / (aq + remain);
      p.qty += side * remain;
      p.fee += (fee * remain) / qty;
      if (fresh) {
        p.t = this.t; p.sl = null; p.tp = null; p.trail = null; p.mae = 0; p.mfe = 0;
        p.id = seq++; p.entryReason = reason; p.openEquity = eqBefore; p.initSL = p.initTP = null;
        p.ctx = this.hooks?.context ? this.hooks.context() : null;
      }
    }
    if (p.qty && Math.sign(p.qty) === side) {
      if (Number.isFinite(extra.sl)) p.sl = extra.sl;
      if (Number.isFinite(extra.tp)) p.tp = extra.tp;
      if (extra.trail > 0) p.trail = extra.trail;
      // 分割利確: 今回建てた数量を割合で分け、決済専用の指値にする（合計が 100% なら最後の段は端数ごと残り全部）
      if (remain > 1e-12 && Array.isArray(extra.tps) && extra.tps.length) {
        let left = remain, cum = 0;
        extra.tps.forEach((x, i) => {
          cum += x.pct;
          if (!Number.isFinite(x.price) || left <= 1e-12) return;
          const q = i === extra.tps.length - 1 && cum >= 99.5 ? left : Math.min(left, this.roundQty((remain * x.pct) / 100));
          if (q > 0) { this.placeOrder({ side: -side, type: 'limit', price: x.price, qty: q, reduceOnly: true, label: `利確${extra.tps.length > 1 ? i + 1 : ''}` }); left -= q; }
        });
      }
    }
    // ポジションが無くなった・向きが変わったら、前のポジション用の決済注文は取り消す（取引所と同じ）
    if (this.orders.some((o) => o.reduceOnly && (!p.qty || o.side === Math.sign(p.qty)))) this.orders = this.orders.filter((o) => !(o.reduceOnly && (!p.qty || o.side === Math.sign(p.qty))));
    if (p.qty) { if (p.initSL == null && p.sl != null) p.initSL = p.sl; if (p.initTP == null && p.tp != null) p.initTP = p.tp; }
    this.hooks?.fill?.({ side, qty, px, reason });
    // 決済した取引は約定処理が終わってから通知（ドテン後のポジション状態も確定している）
    if (this.pendingTrades) { const list = this.pendingTrades; this.pendingTrades = null; for (const t of list) this.hooks?.trade?.(t); }
    this.markEquity();
    this.version++;
  }

  roundQty(q) { const st = this.sym.qtyStep || 1e-8; return Math.max(st, Math.round(q / st) * st); }

  // 成行（手動）: 現在値で即約定
  market(side, qty, extra = {}) {
    if (this.bid == null) return '価格がありません';
    const px = side > 0 ? this.ask : this.bid;
    if (!this.canTrade(side, qty, px)) return '証拠金が足りません';
    this.fill(side, qty, px, extra.reason || '成行', extra);
    return null;
  }
  // 成行（ストラテジー）: 次の値動きで約定（バックテストと同じく次の足の始値相当）
  queueMarket(side, qty, extra = {}) { if (!(qty > 0)) return; this.queued.push({ side, qty, extra }); }

  placeOrder(o) {
    if (!Number.isFinite(o.price) || !(o.qty > 0)) { this.note('注文の価格・数量が正しくありません'); return null; }
    if (o.reduceOnly && (!this.pos.qty || Math.sign(this.pos.qty) === o.side)) { this.note('決済注文は、反対向きのポジションがあるときだけ置けます'); return null; }
    this.hooks?.op?.('order_place', { side: o.side, type: o.type, price: o.price, qty: o.qty, sl: o.sl ?? null, tp: o.tp ?? null, reduceOnly: !!o.reduceOnly });
    const ord = { id: seq++, side: o.side, type: o.type, price: o.price, qty: o.qty, sl: Number.isFinite(o.sl) ? o.sl : null, tp: Number.isFinite(o.tp) ? o.tp : null, t: this.t, comment: o.comment || '',
      reduceOnly: !!o.reduceOnly, label: o.label || '', tps: Array.isArray(o.tps) && o.tps.length ? o.tps : null, trail: o.trail > 0 ? o.trail : null };
    this.orders.push(ord);
    this.version++;
    return ord;
  }
  cancelOrder(id) { const o = this.orders.find((x) => x.id === id); if (o) this.hooks?.op?.('order_cancel', { side: o.side, type: o.type, price: o.price }); this.orders = this.orders.filter((o) => o.id !== id); this.version++; }
  cancelAll() { if (this.orders.length) { this.orders = []; this.version++; } }
  modifyOrder(id, patch) { const o = this.orders.find((x) => x.id === id); if (o) { this.hooks?.op?.('order_modify', { side: o.side, type: o.type, from: o.price, ...patch }); Object.assign(o, patch); this.version++; } }
  setBrackets(sl, tp) {
    if (!this.pos.qty) return;
    const p = this.pos, before = { sl: p.sl, tp: p.tp };
    if (sl !== undefined) p.sl = Number.isFinite(sl) ? sl : null;
    if (tp !== undefined) p.tp = Number.isFinite(tp) ? tp : null;
    if (p.initSL == null && p.sl != null) p.initSL = p.sl;
    if (p.initTP == null && p.tp != null) p.initTP = p.tp;
    if (before.sl !== p.sl) this.hooks?.op?.('sl_change', { from: before.sl, to: p.sl });
    if (before.tp !== p.tp) this.hooks?.op?.('tp_change', { from: before.tp, to: p.tp });
    this.version++;
  }
  // トレーリングストップ: 有利な方向の最高値（売りは最安値）から dist 離れた位置に損切りを付けて追いかける
  setTrail(dist) {
    const p = this.pos;
    if (!p.qty) return;
    const d = dist > 0 ? dist : null;
    if (d === p.trail) return;
    this.hooks?.op?.('trail_change', { from: p.trail, to: d });
    p.trail = d;
    if (d) this.updateTrail(p.qty > 0 ? this.bid : this.ask);
    this.version++;
  }
  updateTrail(px) {
    const p = this.pos;
    if (!p.trail || !p.qty || px == null) return;
    const dg = this.sym.digits ?? 8;
    const ns = +(p.qty > 0 ? px - p.trail : px + p.trail).toFixed(dg);
    if (p.sl == null || (p.qty > 0 ? ns > p.sl : ns < p.sl)) { p.sl = ns; if (p.initSL == null) p.initSL = ns; this.version++; }
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
        if (o.reduceOnly) {
          // 決済専用: ポジションを減らすだけ（持っている数量を超えた分は約定しない）
          const q = Math.min(o.qty, Math.abs(this.pos.qty));
          if (this.pos.qty && Math.sign(this.pos.qty) !== o.side && q > 0) this.fill(o.side, q, fpx, (o.label || (o.type === 'limit' ? '利確' : '損切り')) + (q < Math.abs(this.pos.qty) ? '（一部）' : ''));
          else this.version++;
        } else if (this.canTrade(o.side, o.qty, fpx)) this.fill(o.side, o.qty, fpx, o.type === 'limit' ? '指値' : '逆指値', { sl: o.sl, tp: o.tp, tps: o.tps, trail: o.trail });
        else { this.note('証拠金不足で注文を取り消しました'); this.version++; }
      } else {
        const p = this.pos;
        const lvlPx = best.kind === 'tp' ? (p.qty > 0 ? Math.max(px, p.tp) : Math.min(px, p.tp)) : px;
        this.fill(-Math.sign(p.qty), Math.abs(p.qty), lvlPx, best.kind === 'sl' ? '損切り' : '利確');
      }
      from = bestPx;
    }
    this.bid = b1;
    // 区間の中で値は単調に動くので、区間の終わりで追いかければ足の中の順序どおりになる
    if (this.pos.trail) this.updateTrail(this.pos.qty > 0 ? Math.max(b0, b1) : Math.min(b0, b1) + this.cfg.spread);
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
