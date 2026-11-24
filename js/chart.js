// チャート表示: ローソク足・インジケーター・売買マーカー・凡例
import { createChart, CandlestickSeries, BarSeries, LineSeries, AreaSeries, HistogramSeries, createSeriesMarkers, CrosshairMode, LineStyle } from '../vendor/lightweight-charts.mjs';
import { ct, el, fmtNum, fmtCompact, lowerIdx, alignTF, Emitter, uid } from './util.js';
import { Source, indicatorDef, defaultInputs } from './indicators.js';

export const C = {
  bg: '#131722', grid: '#1e222d', border: '#2a2e39', text: '#d1d4dc', sub: '#787b86',
  up: '#089981', dn: '#f23645', blue: '#2962ff',
};
export const CHART_TYPES = [
  { id: 'candle', label: 'ローソク足' }, { id: 'hollow', label: '中抜きローソク足' }, { id: 'bar', label: 'バー' },
  { id: 'ha', label: '平均足' }, { id: 'line', label: 'ライン' }, { id: 'area', label: 'エリア' },
];

export class ChartView extends Emitter {
  constructor(container) {
    super();
    this.box = container;
    this.chart = createChart(container, {
      autoSize: true,
      layout: { background: { type: 'solid', color: C.bg }, textColor: C.text, fontSize: 12, fontFamily: '-apple-system, BlinkMacSystemFont, "Trebuchet MS", "Hiragino Sans", "Noto Sans JP", sans-serif', panes: { separatorColor: C.border, separatorHoverColor: 'rgba(41,98,255,0.3)', enableResize: true }, attributionLogo: false },
      grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: '#758696', labelBackgroundColor: '#363a45' }, horzLine: { color: '#758696', labelBackgroundColor: '#363a45' } },
      rightPriceScale: { borderColor: C.border, scaleMargins: { top: 0.1, bottom: 0.12 } },
      timeScale: { borderColor: C.border, timeVisible: true, secondsVisible: false, rightOffset: 12, barSpacing: 8, minBarSpacing: 0.5 },
      localization: { locale: 'ja-JP', dateFormat: 'yyyy/MM/dd' },
      kineticScroll: { mouse: false, touch: true },
    });
    this.type = 'candle';
    this.digits = 2;
    this.view = [];
    this.inds = [];
    this.stratPlots = new Map();
    this.markersData = [];
    this.S = new Source();
    this.ha = [];
    this.makeMain();
    this.buildLegend();
    this.chart.subscribeCrosshairMove((p) => this.onCrosshair(p));
    this.chart.timeScale().subscribeVisibleLogicalRangeChange((r) => this.emit('range', r));
  }

  // ---------- メイン系列 ----------
  makeMain() {
    // 先に新しい系列を作ってから古い系列を消す（ペイン0が空になって消えるのを防ぐ）
    const old = this.main;
    if (old) this.markers?.detach?.();
    const pf = { type: 'price', precision: this.digits, minMove: 10 ** -this.digits };
    const common = { priceFormat: pf, lastValueVisible: true, priceLineVisible: true, priceLineStyle: LineStyle.Dotted };
    const t = this.type;
    if (t === 'bar') this.main = this.chart.addSeries(BarSeries, { ...common, upColor: C.up, downColor: C.dn, thinBars: false }, 0);
    else if (t === 'line') this.main = this.chart.addSeries(LineSeries, { ...common, color: C.blue, lineWidth: 2 }, 0);
    else if (t === 'area') this.main = this.chart.addSeries(AreaSeries, { ...common, lineColor: C.blue, topColor: 'rgba(41,98,255,0.35)', bottomColor: 'rgba(41,98,255,0.02)', lineWidth: 2 }, 0);
    else if (t === 'hollow') this.main = this.chart.addSeries(CandlestickSeries, { ...common, upColor: 'rgba(0,0,0,0)', downColor: C.dn, borderUpColor: C.up, borderDownColor: C.dn, wickUpColor: C.up, wickDownColor: C.dn }, 0);
    else this.main = this.chart.addSeries(CandlestickSeries, { ...common, upColor: C.up, downColor: C.dn, borderVisible: false, wickUpColor: C.up, wickDownColor: C.dn }, 0);
    if (old) this.chart.removeSeries(old);
    this.markers = createSeriesMarkers(this.main, []);
    this.markers.setMarkers(this.markersData);
  }
  setType(t) {
    this.type = t;
    this.makeMain();
    this.full();
  }
  setSymbol(sym, tf, off) {
    this.sym = sym; this.tf = tf; this.off = off;
    this.digits = sym.digits;
    this.main.applyOptions({ priceFormat: { type: 'price', precision: this.digits, minMove: 10 ** -this.digits } });
    for (const ind of this.inds) if (ind.def.overlay && !ind.def.volume) for (const s of ind.series) s.applyOptions({ priceFormat: { type: 'price', precision: this.digits, minMove: 10 ** -this.digits } });
    this.markersData = [];
    this.markers.setMarkers([]);
    this.legendTitle();
  }
  setDigits(d) { if (d !== this.digits) { this.digits = d; this.main.applyOptions({ priceFormat: { type: 'price', precision: d, minMove: 10 ** -d } }); } }

  point(b, i) {
    const time = ct(b.t);
    if (this.type === 'line' || this.type === 'area') return { time, value: b.c };
    if (this.type === 'ha') { const h = this.ha[i]; return { time, open: h.o, high: h.h, low: h.l, close: h.c }; }
    return { time, open: b.o, high: b.h, low: b.l, close: b.c };
  }
  calcHA(from) {
    const v = this.view;
    for (let i = from; i < v.length; i++) {
      const b = v[i], p = this.ha[i - 1];
      const c = (b.o + b.h + b.l + b.c) / 4;
      const o = p ? (p.o + p.c) / 2 : (b.o + b.c) / 2;
      this.ha[i] = { o, c, h: Math.max(b.h, o, c), l: Math.min(b.l, o, c) };
    }
    this.ha.length = v.length;
  }

  // view: 表示する足。from 以降が変わった（structural なら全体を描き直す）
  setBars(view, from = 0, structural = true) {
    const prevLen = this.prevLen ?? 0;
    this.view = view;
    const n = view.length;
    if (structural || from < prevLen - 1 || from > n) from = 0;
    this.S.off = this.off; this.S.tf = this.tf;
    this.S.sync(view, from);
    if (this.type === 'ha') this.calcHA(from);
    for (const ind of this.inds) this.calcInd(ind, from);
    if (from === 0) this.full();
    else {
      for (let i = from; i < n; i++) this.main.update(this.point(view[i], i));
      for (const ind of this.inds) this.pushInd(ind, from);
    }
    this.prevLen = n;
    this.lastIdx = n - 1;
    if (!this.hoverIdx) this.updateLegend(n - 1);
    this.emit('bars');
  }
  full() {
    const v = this.view;
    if (this.type === 'ha') this.calcHA(0);
    this.main.setData(v.map((b, i) => this.point(b, i)));
    for (const ind of this.inds) this.pushInd(ind, 0);
    this.updateStrategyPlots();
    this.markers.setMarkers(this.markersData);
    this.updateLegend(v.length - 1);
  }

  // 時刻（UTC 秒）⇔ 論理インデックス（足の外は時間足で外挿）
  timeToLogical(t) {
    const v = this.view;
    if (!v.length) return null;
    const tf = this.tf;
    if (t >= v[v.length - 1].t) return v.length - 1 + (t - v[v.length - 1].t) / tf;
    if (t <= v[0].t) return (t - v[0].t) / tf;
    const i = lowerIdx(v, t);
    const a = v[i], b = v[i + 1];
    return i + Math.min(1, (t - a.t) / Math.max(tf, b.t - a.t));
  }
  logicalToTime(l) {
    const v = this.view;
    if (!v.length) return null;
    const n = v.length;
    if (l >= n - 1) return v[n - 1].t + (l - (n - 1)) * this.tf;
    if (l <= 0) return v[0].t + l * this.tf;
    const i = Math.floor(l);
    return v[i].t + (l - i) * this.tf;
  }
  xOfLogical(l) {
    const ts = this.chart.timeScale();
    const x0 = ts.logicalToCoordinate(0), x1 = ts.logicalToCoordinate(1);
    if (x0 == null || x1 == null) return null;
    return x0 + (x1 - x0) * l;
  }
  logicalOfX(x) {
    const ts = this.chart.timeScale();
    const x0 = ts.logicalToCoordinate(0), x1 = ts.logicalToCoordinate(1);
    if (x0 == null || x1 == null || x1 === x0) return null;
    return (x - x0) / (x1 - x0);
  }
  xOfTime(t) { const l = this.timeToLogical(t); return l == null ? null : this.xOfLogical(l); }
  timeOfX(x) { const l = this.logicalOfX(x); return l == null ? null : this.logicalToTime(l); }
  yOfPrice(p) { return this.main.priceToCoordinate(p); }
  priceOfY(y) { return this.main.coordinateToPrice(y); }
  paneRect() {
    const ps = this.chart.paneSize(0);
    return { w: this.chart.timeScale().width(), h: ps.height };
  }

  // ---------- インジケーター ----------
  addIndicator(id, inputs, styles, opts = {}) {
    const def = indicatorDef(id);
    if (!def) return null;
    const ind = {
      uid: opts.uid || uid(), id, def, inputs: { ...defaultInputs(def), ...(inputs || {}) },
      styles: def.plots.map((p, k) => ({ color: p.color, width: p.width ?? (p.type === 'hist' ? 1 : 1.5), visible: true, ...(styles?.[k] || {}) })),
      visible: opts.visible ?? true, out: {}, series: [], levelLines: [],
    };
    this.inds.push(ind);
    this.makeIndSeries(ind);
    this.calcInd(ind, 0);
    this.pushInd(ind, 0);
    this.layoutPanes();
    this.renderLegendRows();
    this.emit('indicators');
    return ind;
  }
  makeIndSeries(ind) {
    for (const s of ind.series) this.chart.removeSeries(s);
    ind.series = [];
    const def = ind.def;
    let pane = 0;
    if (!def.overlay) pane = this.chart.panes().length;
    def.plots.forEach((p, k) => {
      const st = ind.styles[k];
      const base = { lastValueVisible: !def.volume && st.visible, priceLineVisible: false, visible: ind.visible && st.visible, title: '', crosshairMarkerVisible: p.type !== 'hist' };
      if (!def.overlay || def.volume) base.priceFormat = def.volume ? { type: 'volume' } : { type: 'price', precision: def.precision ?? 2, minMove: 0.01 };
      if (def.overlay && !def.volume) base.priceFormat = { type: 'price', precision: this.digits, minMove: 10 ** -this.digits };
      let s;
      if (p.type === 'hist') s = this.chart.addSeries(HistogramSeries, { ...base, color: st.color, base: 0 }, pane);
      else if (p.type === 'points') s = this.chart.addSeries(LineSeries, { ...base, color: st.color, lineVisible: false, pointMarkersVisible: true, pointMarkersRadius: 1.5 }, pane);
      else s = this.chart.addSeries(LineSeries, { ...base, color: st.color, lineWidth: st.width }, pane);
      if (def.volume) {
        s.applyOptions({ priceScaleId: 'vol' });
        s.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      }
      if (def.range) s.applyOptions({ autoscaleInfoProvider: () => ({ priceRange: { minValue: def.range[0], maxValue: def.range[1] } }) });
      if (k === 0 && def.levels) {
        for (const lv of def.levels) s.createPriceLine({ price: lv, color: '#787b86', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false });
      }
      ind.series.push(s);
      if (k === 0 && !def.overlay) pane = s.getPane().paneIndex();
    });
  }
  calcInd(ind, from) {
    const n = this.S.n;
    if (from === 0) ind.out = {};
    try { ind.def.calc(this.S, ind.inputs, ind.out, from, n); ind.error = null; } catch (e) { ind.error = e.message; }
    for (const p of ind.def.plots) if (ind.out[p.k]) ind.out[p.k].length = n;
  }
  plotPoint(ind, p, k, i, shift) {
    const val = ind.out[p.k]?.[i];
    const j = i + shift;
    const n = this.view.length;
    let t;
    if (j < 0) return null;
    if (j < n) t = this.view[j].t;
    else t = this.view[n - 1].t + (j - n + 1) * this.tf;
    if (!(val === val) || val == null) return { time: ct(t) };
    const pt = { time: ct(t), value: val };
    if (p.colorFn) pt.color = p.colorFn(i, ind.out, this.S);
    return pt;
  }
  pushInd(ind, from) {
    const n = this.view.length;
    ind.def.plots.forEach((p, k) => {
      const s = ind.series[k];
      if (!s) return;
      const shift = p.shift ? p.shift(ind.inputs) : 0;
      if (from === 0 || shift) {
        const data = [];
        for (let i = 0; i < n; i++) { const pt = this.plotPoint(ind, p, k, i, shift); if (pt) data.push(pt); }
        s.setData(data);
      } else {
        for (let i = from; i < n; i++) { const pt = this.plotPoint(ind, p, k, i, 0); if (pt) s.update(pt); }
      }
    });
  }
  removeIndicator(u) {
    const ind = this.inds.find((x) => x.uid === u);
    if (!ind) return;
    for (const s of ind.series) this.chart.removeSeries(s);
    this.inds = this.inds.filter((x) => x !== ind);
    this.layoutPanes();
    this.renderLegendRows();
    this.emit('indicators');
  }
  updateIndicator(u, patch) {
    const ind = this.inds.find((x) => x.uid === u);
    if (!ind) return;
    if (patch.inputs) ind.inputs = { ...ind.inputs, ...patch.inputs };
    if (patch.styles) ind.styles = patch.styles;
    if (patch.visible != null) ind.visible = patch.visible;
    ind.def.plots.forEach((p, k) => {
      const st = ind.styles[k];
      ind.series[k]?.applyOptions({ visible: ind.visible && st.visible, color: st.color, ...(p.type ? {} : { lineWidth: st.width }) });
    });
    if (patch.inputs) { this.calcInd(ind, 0); this.pushInd(ind, 0); }
    this.renderLegendRows();
    this.emit('indicators');
  }
  clearIndicators() { for (const i of [...this.inds]) this.removeIndicator(i.uid); }
  rebuildIndicatorSeries() {
    // 種類変更などでメイン系列を作り直したあと順番を保つ
    const list = this.inds.map((i) => ({ id: i.id, inputs: i.inputs, styles: i.styles, uid: i.uid, visible: i.visible }));
    this.clearIndicators();
    for (const x of list) this.addIndicator(x.id, x.inputs, x.styles, x);
  }
  layoutPanes() {
    const panes = this.chart.panes();
    panes.forEach((p, i) => p.setStretchFactor(i === 0 ? Math.max(2, panes.length) * 1.4 : 1));
    requestAnimationFrame(() => this.positionPaneLegends());
  }
  serialize() { return this.inds.map((i) => ({ id: i.id, inputs: i.inputs, styles: i.styles, visible: i.visible })); }

  // ---------- ストラテジーの描画 ----------
  setStrategyPlots(plots) {
    // plots: Map(title -> {color, vals}) 。足の index で値を持つ
    this.stratSrc = plots;
    for (const [title, s] of this.stratPlots) if (!plots?.has(title)) { this.chart.removeSeries(s); this.stratPlots.delete(title); }
    this.updateStrategyPlots();
  }
  updateStrategyPlots() {
    if (!this.stratSrc) return;
    const v = this.view;
    for (const [title, pl] of this.stratSrc) {
      let s = this.stratPlots.get(title);
      if (!s) {
        s = this.chart.addSeries(LineSeries, { color: pl.color, lineWidth: 1.5, lineStyle: LineStyle.Solid, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, priceFormat: { type: 'price', precision: this.digits, minMove: 10 ** -this.digits } }, 0);
        this.stratPlots.set(title, s);
      }
      const data = [];
      const n = Math.min(v.length, pl.vals.length);
      for (let i = 0; i < n; i++) {
        const x = pl.vals[i];
        data.push(x === x && x != null ? { time: ct(v[i].t), value: x } : { time: ct(v[i].t) });
      }
      s.setData(data);
    }
  }

  // fills: [{t, side, qty, price, reason, acc}]
  setFills(fills) {
    const m = [];
    const v = this.view;
    if (!v.length) return;
    const first = v[0].t;
    for (const f of fills.slice(-600)) {
      const bt = alignTF(f.t, this.tf, this.off);
      if (bt < first) continue;
      const idx = lowerIdx(v, f.t);
      if (idx < 0) continue;
      const strat = f.acc === 'strategy';
      const buy = f.side > 0;
      m.push({
        time: ct(v[idx].t), position: buy ? 'belowBar' : 'aboveBar', shape: buy ? 'arrowUp' : 'arrowDown',
        color: strat ? (buy ? '#26c6da' : '#ff7043') : buy ? C.blue : C.dn,
        text: (strat ? '◆' : '') + (f.reason || '') + (f.qty ? ' ' + fmtCompact(f.qty) : ''), size: 1,
      });
    }
    m.sort((a, b) => a.time - b.time);
    this.markersData = m;
    this.markers.setMarkers(m);
  }

  // ---------- 凡例 ----------
  buildLegend() {
    this.legend = el('div', { class: 'legend' });
    this.legTitle = el('div', { class: 'leg-title' });
    this.legOHLC = el('div', { class: 'leg-ohlc' });
    this.legRows = el('div', { class: 'leg-rows' });
    this.legend.append(el('div', { class: 'leg-head' }, this.legTitle, this.legOHLC), this.legRows);
    this.paneLegends = el('div', { class: 'pane-legends' });
    this.box.append(this.legend, this.paneLegends);
  }
  legendTitle() {
    if (!this.sym) return;
    this.legTitle.innerHTML = '';
    this.legTitle.append(el('b', {}, this.sym.id), el('span', {}, ' · ' + (this.tfLabel || '') + ' · ' + (this.sym.type === 'fx' ? 'Dukascopy' : 'Binance')));
  }
  onCrosshair(p) {
    if (p.logical == null || !p.point) { this.hoverIdx = null; this.updateLegend(this.view.length - 1); this.emit('crosshair', null); return; }
    const idx = Math.round(p.logical);
    this.hoverIdx = idx;
    this.updateLegend(Math.min(idx, this.view.length - 1));
    this.emit('crosshair', p);
  }
  updateLegend(i) {
    const b = this.view[i];
    const d = this.digits;
    if (!b) { this.legOHLC.textContent = ''; return; }
    const pb = this.view[i - 1];
    const chg = pb ? b.c - pb.c : b.c - b.o;
    const pct = (chg / (pb ? pb.c : b.o)) * 100;
    const cls = b.c >= b.o ? 'up' : 'dn';
    this.legOHLC.innerHTML = `<span>始<i class="${cls}">${fmtNum(b.o, d)}</i></span><span>高<i class="${cls}">${fmtNum(b.h, d)}</i></span><span>安<i class="${cls}">${fmtNum(b.l, d)}</i></span><span>終<i class="${cls}">${fmtNum(b.c, d)}</i></span><span><i class="${chg >= 0 ? 'up' : 'dn'}">${chg >= 0 ? '+' : ''}${fmtNum(chg, d)} (${chg >= 0 ? '+' : ''}${pct.toFixed(2)}%)</i></span>`;
    for (const ind of this.inds) {
      if (!ind.valEl) continue;
      ind.valEl.innerHTML = ind.def.plots.map((p, k) => {
        const shift = p.shift ? p.shift(ind.inputs) : 0;
        const val = ind.out[p.k]?.[i - shift];
        if (!ind.styles[k].visible) return '';
        const prec = ind.def.overlay && !ind.def.volume ? d : 2;
        const txt = val === val && val != null ? (ind.def.volume ? fmtCompact(val) : fmtNum(val, prec)) : '∅';
        return `<i style="color:${p.colorFn ? (ind.out[p.k] ? p.colorFn(Math.max(0, i - shift), ind.out, this.S) : ind.styles[k].color) : ind.styles[k].color}">${txt}</i>`;
      }).join(' ');
    }
  }
  renderLegendRows() {
    this.legRows.innerHTML = '';
    this.paneLegends.innerHTML = '';
    for (const ind of this.inds) {
      const args = ind.def.inputs.filter((x) => !x.opts || ind.inputs[x.k] !== 'close').map((x) => ind.inputs[x.k]).join(', ');
      ind.valEl = el('span', { class: 'leg-vals' });
      const row = el('div', { class: 'leg-row' + (ind.visible ? '' : ' hidden') },
        el('span', { class: 'leg-name' }, ind.def.short + (args ? ' ' + args : '')),
        el('span', { class: 'leg-btns' },
          el('button', { title: ind.visible ? '非表示' : '表示', onclick: () => this.updateIndicator(ind.uid, { visible: !ind.visible }), html: ind.visible ? ICON.eye : ICON.eyeOff }),
          el('button', { title: '設定', onclick: () => this.emit('editIndicator', ind), html: ICON.gear }),
          el('button', { title: '削除', onclick: () => this.removeIndicator(ind.uid), html: ICON.x })),
        ind.valEl);
      if (ind.error) row.append(el('span', { class: 'leg-err' }, '⚠ ' + ind.error));
      row.addEventListener('dblclick', () => this.emit('editIndicator', ind));
      ind.legendRow = row;
      if (ind.def.overlay) this.legRows.append(row);
      else this.paneLegends.append(row);
    }
    this.updateLegend(this.hoverIdx ?? this.view.length - 1);
    this.positionPaneLegends();
  }
  positionPaneLegends() {
    const boxTop = this.box.getBoundingClientRect().top;
    for (const ind of this.inds) {
      if (ind.def.overlay || !ind.series[0] || !ind.legendRow) continue;
      const pel = ind.series[0].getPane().getHTMLElement?.();
      if (!pel) continue;
      ind.legendRow.style.top = pel.getBoundingClientRect().top - boxTop + 4 + 'px';
    }
  }
  setTFLabel(s) { this.tfLabel = s; this.legendTitle(); }
}

export const ICON = {
  eye: '<svg viewBox="0 0 18 18" width="16" height="16"><path fill="none" stroke="currentColor" stroke-width="1.2" d="M1.5 9s2.8-5 7.5-5 7.5 5 7.5 5-2.8 5-7.5 5-7.5-5-7.5-5z"/><circle cx="9" cy="9" r="2.3" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
  eyeOff: '<svg viewBox="0 0 18 18" width="16" height="16"><path fill="none" stroke="currentColor" stroke-width="1.2" d="M1.5 9s2.8-5 7.5-5 7.5 5 7.5 5-2.8 5-7.5 5-7.5-5-7.5-5zM3 15 15 3"/></svg>',
  gear: '<svg viewBox="0 0 18 18" width="16" height="16"><circle cx="9" cy="9" r="2.4" fill="none" stroke="currentColor" stroke-width="1.2"/><path fill="none" stroke="currentColor" stroke-width="1.2" d="M9 1.8v2.1M9 14.1v2.1M1.8 9h2.1M14.1 9h2.1M3.9 3.9l1.5 1.5M12.6 12.6l1.5 1.5M3.9 14.1l1.5-1.5M12.6 5.4l1.5-1.5"/></svg>',
  x: '<svg viewBox="0 0 18 18" width="16" height="16"><path stroke="currentColor" stroke-width="1.3" d="m4.5 4.5 9 9m0-9-9 9"/></svg>',
};
