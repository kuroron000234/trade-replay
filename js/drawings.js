// チャート上の重ね描き: 描画ツール・注文/ポジションのライン・インジケーターの塗り・リプレイ開始位置の選択
import { Emitter, uid, fmtNum, fmtSigned, fmtDur, fmtTime, el, alignTF } from './util.js';
import { C } from './chart.js';

export const TOOLS = [
  { id: 'cursor', label: '十字カーソル', key: 'Esc' },
  { id: 'trend', label: 'トレンドライン', key: 'Alt+T', pts: 2 },
  { id: 'ray', label: 'レイ', pts: 2 },
  { id: 'hline', label: '水平線', key: 'Alt+H', pts: 1 },
  { id: 'hray', label: '水平レイ', key: 'Alt+J', pts: 1 },
  { id: 'vline', label: '垂直線', key: 'Alt+V', pts: 1 },
  { id: 'rect', label: '長方形', key: 'Alt+Shift+R', pts: 2 },
  { id: 'fib', label: 'フィボナッチ・リトレースメント', key: 'Alt+F', pts: 2 },
  { id: 'long', label: 'ロングポジション', pts: 1 },
  { id: 'short', label: 'ショートポジション', pts: 1 },
  { id: 'measure', label: '計測（Shift+ドラッグでも可）', pts: 2 },
];
const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const FIB_COL = ['#787b86', '#f23645', '#ff9800', '#4caf50', '#089981', '#00bcd4', '#787b86'];
export const COLORS = ['#2962ff', '#f23645', '#089981', '#ff9800', '#ab47bc', '#ffeb3b', '#00bcd4', '#d1d4dc'];

export class Overlay extends Emitter {
  constructor(box, cv, app) {
    super();
    this.box = box; this.cv = cv; this.app = app;
    this.canvas = el('canvas', { class: 'overlay' });
    box.append(this.canvas);
    this.g = this.canvas.getContext('2d');
    this.drawings = [];
    this.tool = 'cursor';
    this.magnet = false;
    this.hidden = false;
    this.sel = null;
    this.drag = null;
    this.placing = null;
    this.mouse = null;
    this.pickMode = false;
    this.lines = [];
    this.buildSelBar();
    const cap = { capture: true };
    box.addEventListener('pointerdown', (e) => this.onDown(e), cap);
    box.addEventListener('mousedown', (e) => { if (this.swallow) { e.stopPropagation(); e.preventDefault(); } }, cap);
    box.addEventListener('touchstart', (e) => { if (this.swallow) e.stopPropagation(); }, cap);
    box.addEventListener('pointermove', (e) => this.onMove(e), cap);
    box.addEventListener('pointerleave', () => { this.mouse = null; });
    box.addEventListener('dblclick', (e) => this.onDbl(e), cap);
    box.addEventListener('contextmenu', (e) => this.onContext(e));
    window.addEventListener('pointermove', (e) => { if (this.drag) this.onDragMove(e); });
    window.addEventListener('pointerup', (e) => this.onUp(e));
  }

  // ---------- 座標 ----------
  pos(e) { const r = this.box.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  inPane(p) { const r = this.cv.paneRect(); return p.x >= 0 && p.x <= r.w && p.y >= 0 && p.y <= r.h; }
  toTP(p, snap = this.magnet) {
    let t = this.cv.timeOfX(p.x), price = this.cv.priceOfY(p.y);
    const l = this.cv.logicalOfX(p.x);
    if (l != null) {
      const i = Math.round(l), b = this.cv.view[i];
      if (b && snap) {
        let best = null;
        for (const v of [b.o, b.h, b.l, b.c]) { const dy = Math.abs(this.cv.yOfPrice(v) - p.y); if (dy < 30 && (!best || dy < best.dy)) best = { v, dy }; }
        if (best) { price = best.v; t = b.t; }
      }
    }
    return { t, p: price };
  }
  X(t) { return this.cv.xOfTime(t); }
  Y(p) { return this.cv.yOfPrice(p); }

  setTool(t) {
    this.tool = t;
    this.placing = null;
    this.emit('tool', t);
  }

  // ---------- 入力 ----------
  onDown(e) {
    this.swallow = false;
    if (e.button === 2) return;
    const p = this.pos(e);
    if (!this.inPane(p)) return;
    const take = () => { this.swallow = true; e.stopPropagation(); e.preventDefault(); this.box.setPointerCapture?.(e.pointerId); };
    if (this.pickMode) { take(); const t = this.cv.timeOfX(p.x); if (t != null) this.emit('pickStart', t); return; }
    // 置いている途中の2点目
    if (this.placing) { take(); this.finishPlacing(p); return; }
    const tool = e.shiftKey && this.tool === 'cursor' ? 'measure' : this.tool;
    if (tool !== 'cursor') { take(); this.startTool(tool, p); return; }
    // 注文ライン
    const lh = this.hitLine(p);
    if (lh) {
      take();
      if (lh.btn === 'close') { this.emit('lineClose', lh.line); return; }
      if (!lh.line.drag) return;
      this.drag = { kind: 'line', line: lh.line, start: p, price: lh.line.price };
      return;
    }
    const h = this.hitDrawing(p);
    if (h) {
      take();
      this.select(h.d);
      if (h.d.locked) return;
      this.drag = { kind: 'drawing', d: h.d, handle: h.handle, start: p, orig: JSON.parse(JSON.stringify(h.d)), l0: this.cv.logicalOfX(p.x), p0: this.cv.priceOfY(p.y) };
      return;
    }
    if (this.sel) this.select(null);
  }
  startTool(tool, p) {
    const tp = this.toTP(p);
    if (tp.t == null || tp.p == null) return;
    const def = TOOLS.find((x) => x.id === tool);
    const d = { id: uid(), type: tool, pts: [tp], color: tool === 'measure' ? C.blue : COLORS[0], width: 2 };
    if (tool === 'long' || tool === 'short') {
      const r = this.cv.paneRect();
      const span = Math.abs(this.cv.priceOfY(0) - this.cv.priceOfY(r.h)) * 0.06;
      const sgn = tool === 'long' ? 1 : -1;
      d.tp = tp.p + sgn * span * 2; d.sl = tp.p - sgn * span;
      d.pts.push({ t: this.cv.logicalToTime(this.cv.timeToLogical(tp.t) + 20), p: tp.p });
      d.color = '#787b86'; d.width = 1;
      this.add(d);
      this.setTool('cursor');
      return;
    }
    if (def.pts === 1) { this.add(d); this.setTool('cursor'); return; }
    d.pts.push({ ...tp });
    if (tool === 'measure') this.measure = d; else this.drawings.push(d);
    this.placing = { d, start: p };
    this.drag = { kind: 'placing', d, start: p };
  }
  finishPlacing(p) {
    const d = this.placing.d;
    d.pts[1] = this.toTP(p);
    this.placing = null;
    this.drag = null;
    if (d.type === 'measure') { this.measureKeep = true; this.setTool('cursor'); return; }
    this.select(d);
    this.changed();
    this.setTool('cursor');
  }
  onMove(e) {
    const p = this.pos(e);
    this.mouse = p;
    if (this.drag) return;
    if (this.placing) { this.placing.d.pts[1] = this.toTP(p); return; }
    let cur = '';
    if (this.pickMode) cur = 'pick';
    else if (this.tool !== 'cursor') cur = 'crosshair';
    else if (this.inPane(p)) {
      const lh = this.hitLine(p);
      if (lh) cur = lh.btn === 'close' ? 'pointer' : lh.line.drag ? 'ns' : '';
      else { const h = this.hitDrawing(p); if (h) cur = h.handle != null ? 'pointer' : 'move'; }
    }
    this.box.dataset.cursor = cur;
  }
  onDragMove(e) {
    const p = this.pos(e);
    this.mouse = p;
    const dr = this.drag;
    if (dr.kind === 'placing') { dr.d.pts[1] = this.toTP(p); return; }
    if (dr.kind === 'line') { dr.price = this.cv.priceOfY(p.y); return; }
    if (dr.kind === 'drawing') {
      const d = dr.d, o = dr.orig;
      if (dr.handle != null) {
        const tp = this.toTP(p);
        if (dr.handle === 'tp') d.tp = tp.p;
        else if (dr.handle === 'sl') d.sl = tp.p;
        else if (dr.handle === 'right') d.pts[1] = { t: tp.t, p: d.pts[1].p };
        else if (d.type === 'long' || d.type === 'short') {
          const dp = tp.p - o.pts[0].p;
          d.pts[0] = tp; d.tp = o.tp + dp; d.sl = o.sl + dp;
          d.pts[1] = { t: this.cv.logicalToTime(this.cv.timeToLogical(o.pts[1].t) + (this.cv.timeToLogical(tp.t) - this.cv.timeToLogical(o.pts[0].t))), p: tp.p };
        } else d.pts[dr.handle] = tp;
      } else {
        const dl = this.cv.logicalOfX(p.x) - dr.l0, dp = this.cv.priceOfY(p.y) - dr.p0;
        const mv = (q) => ({ t: this.cv.logicalToTime(this.cv.timeToLogical(q.t) + dl), p: q.p + dp });
        d.pts = o.pts.map(mv);
        if (o.tp != null) { d.tp = o.tp + dp; d.sl = o.sl + dp; }
      }
    }
  }
  onUp(e) {
    const dr = this.drag;
    if (!dr) { this.swallow = false; return; }
    const p = this.pos(e);
    if (dr.kind === 'placing') {
      const moved = Math.hypot(p.x - dr.start.x, p.y - dr.start.y) > 6;
      this.drag = null;
      if (moved) this.finishPlacing(p);
      return;
    }
    this.drag = null;
    this.swallow = false;
    if (dr.kind === 'line') {
      if (Math.abs(p.y - dr.start.y) > 3 && dr.price != null) this.emit('lineMove', dr.line, dr.price);
      return;
    }
    if (dr.kind === 'drawing') this.changed();
  }
  onDbl(e) {
    const p = this.pos(e);
    if (!this.inPane(p)) return;
    const h = this.hitDrawing(p);
    if (h) { e.stopPropagation(); this.select(h.d); }
  }
  onContext(e) {
    e.preventDefault();
    const p = this.pos(e);
    if (!this.inPane(p)) return;
    if (this.placing) { this.cancelPlacing(); return; }
    const price = this.cv.priceOfY(p.y), t = this.cv.timeOfX(p.x);
    this.emit('context', { x: e.clientX, y: e.clientY, price, t, drawing: this.hitDrawing(p)?.d });
  }
  cancelPlacing() {
    if (!this.placing) return;
    const d = this.placing.d;
    this.drawings = this.drawings.filter((x) => x !== d);
    if (this.measure === d) this.measure = null;
    this.placing = null; this.drag = null;
  }
  escape() {
    if (this.placing) this.cancelPlacing();
    this.measure = null;
    this.select(null);
    this.setTool('cursor');
    if (this.pickMode) this.emit('pickCancel');
  }

  // ---------- 描画データ ----------
  add(d) { this.drawings.push(d); this.select(d); this.changed(); }
  remove(d) { this.drawings = this.drawings.filter((x) => x !== d); if (this.sel === d) this.select(null); this.changed(); }
  removeAll() { this.drawings = []; this.select(null); this.changed(); }
  load(list) { this.drawings = list || []; this.sel = null; this.selBar.hidden = true; }
  changed() { this.emit('changed', this.drawings); }
  select(d) {
    this.sel = d;
    this.selBar.hidden = !d;
    if (d) this.renderSelBar();
  }
  buildSelBar() {
    this.selBar = el('div', { class: 'selbar', hidden: true });
    this.box.append(this.selBar);
  }
  renderSelBar() {
    const d = this.sel;
    this.selBar.innerHTML = '';
    for (const c of COLORS) this.selBar.append(el('button', { class: 'sw' + (d.color === c ? ' on' : ''), style: { background: c }, onclick: () => { d.color = c; this.changed(); this.renderSelBar(); } }));
    const w = el('select', { onchange: (e) => { d.width = +e.target.value; this.changed(); } }, ...[1, 2, 3, 4].map((x) => el('option', { value: x, selected: d.width === x }, x + 'px')));
    this.selBar.append(w,
      el('button', { class: 'tb', title: d.locked ? 'ロック解除' : 'ロック', onclick: () => { d.locked = !d.locked; this.changed(); this.renderSelBar(); } }, d.locked ? '🔒' : '🔓'),
      el('button', { class: 'tb', title: '削除 (Delete)', onclick: () => this.remove(d) }, '🗑'));
  }

  // ---------- ヒットテスト ----------
  handles(d) {
    const out = [];
    if (d.type === 'hline') out.push({ k: 0, x: this.cv.paneRect().w / 2, y: this.Y(d.pts[0].p) });
    else if (d.type === 'vline') out.push({ k: 0, x: this.X(d.pts[0].t), y: this.cv.paneRect().h / 2 });
    else if (d.type === 'long' || d.type === 'short') {
      const x0 = this.X(d.pts[0].t), x1 = this.X(d.pts[1].t);
      out.push({ k: 0, x: x0, y: this.Y(d.pts[0].p) }, { k: 'tp', x: x0, y: this.Y(d.tp) }, { k: 'sl', x: x0, y: this.Y(d.sl) }, { k: 'right', x: x1, y: this.Y(d.pts[0].p) });
    } else d.pts.forEach((q, k) => out.push({ k, x: this.X(q.t), y: this.Y(q.p) }));
    return out;
  }
  hitDrawing(p) {
    if (this.hidden) return null;
    if (this.sel) for (const h of this.handles(this.sel)) if (h.x != null && h.y != null && Math.hypot(h.x - p.x, h.y - p.y) < 7) return { d: this.sel, handle: h.k };
    for (let i = this.drawings.length - 1; i >= 0; i--) {
      const d = this.drawings[i];
      if (this.hitShape(d, p)) return { d, handle: null };
    }
    return null;
  }
  hitShape(d, p) {
    const w = this.cv.paneRect().w;
    const pts = d.pts.map((q) => ({ x: this.X(q.t), y: this.Y(q.p) }));
    if (pts.some((q) => q.x == null || q.y == null)) return false;
    const T = 6;
    switch (d.type) {
      case 'hline': return Math.abs(p.y - pts[0].y) < T;
      case 'hray': return Math.abs(p.y - pts[0].y) < T && p.x >= pts[0].x - T;
      case 'vline': return Math.abs(p.x - pts[0].x) < T;
      case 'trend': return segDist(p, pts[0], pts[1]) < T;
      case 'ray': return segDist(p, pts[0], extend(pts[0], pts[1], w)) < T;
      case 'rect': case 'fib': case 'long': case 'short': {
        let x0 = Math.min(pts[0].x, pts[1].x), x1 = Math.max(pts[0].x, pts[1].x);
        let ys = d.type === 'long' || d.type === 'short' ? [this.Y(d.tp), this.Y(d.sl)] : [pts[0].y, pts[1].y];
        if (d.type === 'fib') x1 = Math.max(x1, x0 + 1) + 0;
        return p.x >= x0 - T && p.x <= x1 + T && p.y >= Math.min(...ys) - T && p.y <= Math.max(...ys) + T;
      }
    }
    return false;
  }
  hitLine(p) {
    for (const ln of this.lines) {
      if (ln.closeBox && p.x >= ln.closeBox.x && p.x <= ln.closeBox.x + ln.closeBox.w && Math.abs(p.y - ln.y) < 10) return { line: ln, btn: 'close' };
      if (ln.labelBox && p.x >= ln.labelBox.x && p.x <= ln.labelBox.x + ln.labelBox.w && Math.abs(p.y - ln.y) < 10) return { line: ln };
      if (ln.drag && Math.abs(p.y - ln.y) < 4) return { line: ln };
    }
    return null;
  }

  // ---------- 描画 ----------
  draw() {
    const dpr = window.devicePixelRatio || 1;
    const W = this.box.clientWidth, H = this.box.clientHeight;
    if (this.canvas.width !== Math.round(W * dpr) || this.canvas.height !== Math.round(H * dpr)) {
      this.canvas.width = Math.round(W * dpr); this.canvas.height = Math.round(H * dpr);
      this.canvas.style.width = W + 'px'; this.canvas.style.height = H + 'px';
    }
    const g = this.g;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    if (!this.cv.view.length) return;
    const r = this.cv.paneRect();
    this.axisW = W - r.w;
    g.save();
    g.beginPath(); g.rect(0, 0, r.w, r.h); g.clip();
    this.drawFills(g, r);
    if (!this.hidden) for (const d of this.drawings) this.drawOne(g, d, r);
    if (this.measure) this.drawMeasure(g, this.measure);
    if (this.sel && !this.hidden) for (const h of this.handles(this.sel)) if (h.x != null && h.y != null) { g.fillStyle = C.bg; g.strokeStyle = this.sel.color === '#787b86' ? C.blue : this.sel.color; g.lineWidth = 1.5; g.beginPath(); g.arc(h.x, h.y, 4.5, 0, 7); g.fill(); g.stroke(); }
    g.restore();
    this.drawTradeLines(g, r);
    this.drawCountdown(g, r);
    if (this.pickMode && this.mouse && this.inPane(this.mouse)) this.drawPick(g, r);
    // 選択中の描画のツールバー位置
    if (this.sel && !this.selBar.hidden) {
      const hs = this.handles(this.sel).filter((h) => h.x != null && h.y != null);
      if (hs.length) {
        const x = Math.min(Math.max(...hs.map((h) => h.x)) + 12, r.w - 260), y = Math.max(8, Math.min(...hs.map((h) => h.y)) - 44);
        this.selBar.style.left = Math.max(4, x) + 'px'; this.selBar.style.top = y + 'px';
      }
    }
  }
  drawFills(g, r) {
    const v = this.cv.view, n = v.length;
    const range = this.cv.chart.timeScale().getVisibleLogicalRange();
    if (!range) return;
    for (const ind of this.cv.inds) {
      if (!ind.visible || !ind.def.fills || !ind.def.overlay) continue;
      for (const f of ind.def.fills) {
        const pa = ind.def.plots.find((p) => p.k === f.a), shift = pa.shift ? pa.shift(ind.inputs) : 0;
        const A = ind.out[f.a], B = ind.out[f.b];
        if (!A || !B) continue;
        const i0 = Math.max(0, Math.floor(range.from) - shift - 1), i1 = Math.min(n - 1, Math.ceil(range.to) - shift + 1);
        for (let i = i0; i < i1; i++) {
          const a0 = A[i], b0 = B[i], a1 = A[i + 1], b1 = B[i + 1];
          if (!(a0 === a0 && b0 === b0 && a1 === a1 && b1 === b1)) continue;
          const x0 = this.cv.xOfLogical(i + shift), x1 = this.cv.xOfLogical(i + 1 + shift);
          g.fillStyle = f.color2 && a0 < b0 ? f.color2 : f.color;
          g.beginPath();
          g.moveTo(x0, this.Y(a0)); g.lineTo(x1, this.Y(a1)); g.lineTo(x1, this.Y(b1)); g.lineTo(x0, this.Y(b0));
          g.closePath(); g.fill();
        }
      }
    }
  }
  drawOne(g, d, r) {
    const pts = d.pts.map((q) => ({ x: this.X(q.t), y: this.Y(q.p) }));
    if (pts.some((q) => q.x == null || q.y == null)) return;
    g.strokeStyle = d.color; g.lineWidth = d.width; g.setLineDash([]);
    const dig = this.cv.digits;
    switch (d.type) {
      case 'trend': line(g, pts[0], pts[1]); break;
      case 'ray': line(g, pts[0], extend(pts[0], pts[1], r.w)); break;
      case 'hline': line(g, { x: 0, y: pts[0].y }, { x: r.w, y: pts[0].y }); break;
      case 'hray': line(g, pts[0], { x: r.w, y: pts[0].y }); break;
      case 'vline': line(g, { x: pts[0].x, y: 0 }, { x: pts[0].x, y: r.h }); break;
      case 'rect':
        g.fillStyle = hexA(d.color, 0.15);
        g.fillRect(Math.min(pts[0].x, pts[1].x), Math.min(pts[0].y, pts[1].y), Math.abs(pts[1].x - pts[0].x), Math.abs(pts[1].y - pts[0].y));
        g.strokeRect(Math.min(pts[0].x, pts[1].x), Math.min(pts[0].y, pts[1].y), Math.abs(pts[1].x - pts[0].x), Math.abs(pts[1].y - pts[0].y));
        break;
      case 'fib': {
        const x0 = Math.min(pts[0].x, pts[1].x), x1 = Math.max(pts[0].x, pts[1].x, x0 + 40);
        const p0 = d.pts[0].p, p1 = d.pts[1].p;
        g.font = '11px sans-serif'; g.lineWidth = 1;
        FIB.forEach((lv, k) => {
          const pr = p1 + (p0 - p1) * lv, y = this.Y(pr);
          if (k < FIB.length - 1) { const y2 = this.Y(p1 + (p0 - p1) * FIB[k + 1]); g.fillStyle = hexA(FIB_COL[k + 1], 0.08); g.fillRect(x0, Math.min(y, y2), x1 - x0, Math.abs(y2 - y)); }
          g.strokeStyle = FIB_COL[k]; line(g, { x: x0, y }, { x: x1, y });
          g.fillStyle = FIB_COL[k]; g.fillText(`${lv} (${fmtNum(pr, dig)})`, x0 + 4, y - 3);
        });
        g.setLineDash([4, 4]); g.strokeStyle = '#787b86'; line(g, pts[0], pts[1]); g.setLineDash([]);
        break;
      }
      case 'long': case 'short': {
        const x0 = pts[0].x, x1 = pts[1].x, ye = pts[0].y, yt = this.Y(d.tp), ys = this.Y(d.sl);
        const wd = Math.max(20, x1 - x0);
        g.fillStyle = 'rgba(8,153,129,0.2)'; g.fillRect(x0, Math.min(ye, yt), wd, Math.abs(yt - ye));
        g.fillStyle = 'rgba(242,54,69,0.2)'; g.fillRect(x0, Math.min(ye, ys), wd, Math.abs(ys - ye));
        g.strokeStyle = '#787b86'; g.lineWidth = 1; line(g, { x: x0, y: ye }, { x: x0 + wd, y: ye });
        const e = d.pts[0].p, rr = Math.abs(d.tp - e) / Math.abs(e - d.sl || 1);
        const pct = (x) => ((x / e) * 100).toFixed(2) + '%';
        g.font = '11px sans-serif';
        const tag = (y, txt, bg) => { const tw = g.measureText(txt).width + 10; const tx = x0 + wd / 2 - tw / 2; g.fillStyle = bg; g.fillRect(tx, y - 9, tw, 18); g.fillStyle = '#fff'; g.fillText(txt, tx + 5, y + 4); };
        tag(yt + (yt < ye ? -12 : 12), `利確 ${fmtNum(Math.abs(d.tp - e), dig)} (${pct(Math.abs(d.tp - e))})`, '#089981');
        tag(ys + (ys < ye ? -12 : 12), `損切 ${fmtNum(Math.abs(e - d.sl), dig)} (${pct(Math.abs(e - d.sl))})`, '#f23645');
        tag(ye, `RR ${rr.toFixed(2)}`, '#363a45');
        break;
      }
    }
  }
  drawMeasure(g, d) {
    const a = { x: this.X(d.pts[0].t), y: this.Y(d.pts[0].p) }, b = { x: this.X(d.pts[1].t), y: this.Y(d.pts[1].p) };
    if ([a.x, a.y, b.x, b.y].some((v) => v == null)) return;
    const dp = d.pts[1].p - d.pts[0].p, up = dp >= 0;
    g.fillStyle = up ? 'rgba(41,98,255,0.18)' : 'rgba(242,54,69,0.18)';
    g.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    const bars = Math.round(this.cv.timeToLogical(d.pts[1].t) - this.cv.timeToLogical(d.pts[0].t));
    const txt = [`${up ? '+' : ''}${fmtNum(dp, this.cv.digits)} (${((dp / d.pts[0].p) * 100).toFixed(2)}%)`, `${bars} 本, ${fmtDur(Math.abs(d.pts[1].t - d.pts[0].t))}`];
    g.font = '12px sans-serif';
    const tw = Math.max(...txt.map((t) => g.measureText(t).width)) + 16;
    const bx = (a.x + b.x) / 2 - tw / 2, by = up ? Math.min(a.y, b.y) - 46 : Math.max(a.y, b.y) + 6;
    g.fillStyle = up ? C.blue : C.dn; g.fillRect(bx, by, tw, 40);
    g.fillStyle = '#fff'; g.fillText(txt[0], bx + 8, by + 16); g.fillText(txt[1], bx + 8, by + 32);
  }

  // 口座から注文・ポジションのラインを作る
  buildLines() {
    const out = [];
    const { manual, strategy } = this.app.accounts();
    const dig = this.cv.digits;
    const add = (acc, own) => {
      if (!acc) return;
      const p = acc.pos;
      if (p.qty) {
        const pnl = acc.unrealized();
        out.push({ kind: 'pos', acc, own, price: p.avg, color: own ? (p.qty > 0 ? C.blue : C.dn) : '#26c6da', text: `${own ? '' : '◆ '}${p.qty > 0 ? '買' : '売'} ${fmtNum(Math.abs(p.qty), qtyDigits(acc.sym))}`, pnl, close: own, drag: own });
        if (p.sl != null) out.push({ kind: 'sl', acc, own, price: p.sl, color: C.dn, text: `損切 ${fmtSigned((p.sl - p.avg) * p.qty, 2)}`, close: own, drag: own });
        if (p.tp != null) out.push({ kind: 'tp', acc, own, price: p.tp, color: C.up, text: `利確 ${fmtSigned((p.tp - p.avg) * p.qty, 2)}`, close: own, drag: own });
      }
      for (const o of acc.orders) out.push({ kind: 'order', acc, own, order: o, price: o.price, color: o.side > 0 ? C.blue : C.dn, dash: true, text: `${own ? '' : '◆ '}${o.side > 0 ? '買' : '売'}${o.type === 'limit' ? '指値' : '逆指値'} ${fmtNum(o.qty, qtyDigits(acc.sym))}`, close: own, drag: own });
    };
    add(manual, true);
    add(strategy, false);
    void dig;
    return out;
  }
  drawTradeLines(g, r) {
    this.lines = this.buildLines();
    const dig = this.cv.digits;
    g.font = '11px sans-serif';
    let slot = 0;
    for (const ln of this.lines) {
      const price = this.drag?.kind === 'line' && this.drag.line.kind === ln.kind && this.drag.line.order?.id === ln.order?.id && this.drag.line.acc === ln.acc && this.drag.price != null ? this.drag.price : ln.price;
      const y = this.Y(price);
      ln.y = y;
      if (y == null || y < -20 || y > r.h + 20) { ln.labelBox = ln.closeBox = null; continue; }
      g.save();
      g.beginPath(); g.rect(0, 0, r.w, r.h); g.clip();
      g.strokeStyle = ln.color; g.lineWidth = 1; g.setLineDash(ln.dash || !ln.own ? [5, 4] : []);
      line(g, { x: 0, y }, { x: r.w, y });
      g.setLineDash([]);
      // ラベル（TradingView 風に左寄り）
      let txt = ln.text;
      let pnlTxt = '';
      if (ln.kind === 'pos') pnlTxt = fmtSigned(ln.pnl, 2);
      if (this.drag?.kind === 'line' && this.drag.line.kind === ln.kind && this.drag.line.order?.id === ln.order?.id && this.drag.line.acc === ln.acc) txt += ' → ' + fmtNum(price, dig);
      const x = 60 + (slot++ % 2) * 0;
      const tw = g.measureText(txt).width + 12;
      const pw = pnlTxt ? g.measureText(pnlTxt).width + 12 : 0;
      g.fillStyle = C.bg; g.fillRect(x, y - 9, tw + pw + (ln.close ? 18 : 0), 18);
      g.strokeStyle = ln.color; g.strokeRect(x + 0.5, y - 8.5, tw + pw + (ln.close ? 18 : 0) - 1, 17);
      g.fillStyle = ln.color; g.fillRect(x, y - 9, tw, 18);
      g.fillStyle = '#fff'; g.fillText(txt, x + 6, y + 4);
      if (pnlTxt) { g.fillStyle = ln.pnl >= 0 ? C.up : C.dn; g.fillText(pnlTxt, x + tw + 6, y + 4); }
      ln.labelBox = { x, w: tw + pw };
      if (ln.close) {
        const cx = x + tw + pw;
        g.strokeStyle = C.text; g.lineWidth = 1.2;
        line(g, { x: cx + 5, y: y - 4 }, { x: cx + 13, y: y + 4 }); line(g, { x: cx + 13, y: y - 4 }, { x: cx + 5, y: y + 4 });
        ln.closeBox = { x: cx, w: 18 };
      } else ln.closeBox = null;
      g.restore();
      // 価格軸のラベル
      const label = fmtNum(price, dig);
      g.fillStyle = ln.color;
      g.fillRect(r.w + 1, y - 9, this.axisW - 1, 18);
      g.fillStyle = '#fff'; g.fillText(label, r.w + 6, y + 4);
    }
  }
  drawCountdown(g, r) {
    const st = this.app.clock?.();
    if (!st) return;
    const v = this.cv.view, last = v[v.length - 1];
    if (!last) return;
    const y = this.Y(last.c);
    if (y == null || y < 0 || y > r.h) return;
    const rem = alignTF(st.T, this.cv.tf, this.cv.off) + this.cv.tf - st.T;
    const txt = fmtDur(rem);
    g.font = '11px sans-serif';
    g.fillStyle = last.c >= last.o ? C.up : C.dn;
    g.fillRect(r.w + 1, y + 10, this.axisW - 1, 16);
    g.fillStyle = '#fff'; g.fillText(txt, r.w + 6, y + 22);
  }
  drawPick(g, r) {
    const x = this.mouse.x;
    g.fillStyle = 'rgba(41,98,255,0.08)';
    g.fillRect(x, 0, r.w - x, r.h);
    g.strokeStyle = C.blue; g.lineWidth = 2;
    line(g, { x, y: 0 }, { x, y: r.h });
    const t = this.cv.timeOfX(x);
    if (t != null) {
      const txt = 'ここから開始: ' + fmtTime(alignTF(t, this.cv.tf, this.cv.off));
      g.font = '12px sans-serif';
      const tw = g.measureText(txt).width + 14;
      g.fillStyle = C.blue; g.fillRect(Math.min(x + 6, r.w - tw), 8, tw, 22);
      g.fillStyle = '#fff'; g.fillText(txt, Math.min(x + 6, r.w - tw) + 7, 23);
    }
  }
}

export const qtyDigits = (sym) => Math.max(0, -Math.floor(Math.log10(sym.qtyStep || 1)));

function line(g, a, b) { g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke(); }
function extend(a, b, w) {
  if (b.x === a.x) return b;
  const k = (b.y - a.y) / (b.x - a.x);
  const x = b.x > a.x ? w + 50 : -50;
  return { x, y: a.y + k * (x - a.x) };
}
function segDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
  let t = L ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}
