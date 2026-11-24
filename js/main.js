// アプリ本体: 各部品をつなぐ
import { $, el, store, toast, fmtTime, fmtNum, TFS, tfInfo, alignTF, DAY, parseDateInput, fmtDateInput, TZ } from './util.js';
import { SYMBOLS, symbolInfo, dayOffset, sourceFor, fxManifest } from './data.js';
import { Replay, SPEEDS } from './replay.js';
import { ChartView, CHART_TYPES } from './chart.js';
import { Overlay, TOOLS } from './drawings.js';
import { Account } from './broker.js';
import { INDICATORS } from './indicators.js';
import { compile, StrategyRunner, Backtest, PRESETS } from './strategy.js';
import { modal, menu, closeMenu, form, tabs, SVG, modalOpen } from './ui.js';
import { TradingPanel, TesterPanel, EditorPanel, Ticket } from './panels.js';
import { Recorder } from './journal.js';
import { JournalPanel } from './journal-ui.js';
import { Coach } from './coach.js';

const DEFAULTS = {
  crypto: { balance: 10000, leverage: 10, fee: 0.05, stopOut: 50 },
  fx: { balanceJPY: 1000000, balanceUSD: 10000, leverage: 25, stopOut: 50 },
  spread: {},
  tz: 'JST',
};

class App {
  constructor() {
    this.settings = { ...DEFAULTS, ...store.get('settings', {}) };
    this.settings.crypto = { ...DEFAULTS.crypto, ...this.settings.crypto };
    this.settings.fx = { ...DEFAULTS.fx, ...this.settings.fx };
    TZ.offset = this.settings.tz === 'UTC' ? 0 : 9 * 3600;
    TZ.name = this.settings.tz;
    this.sym = symbolInfo(store.get('sym', 'BTCUSDT'));
    this.tf = store.get('tf', 900);
    this.replay = new Replay();
    this.replay.speed = store.get('speed', 60);
    this.cv = new ChartView($('#chart'));
    this.cv.type = store.get('chartType', 'candle');
    if (this.cv.type !== 'candle') this.cv.makeMain();
    this.ov = new Overlay($('#chart'), this.cv, this);
    this.manual = null;
    this.auto = null;
    this.autoOn = false;
    this.runner = null;
    this.bt = null;
    this.strat = null;
    this.showStratOnChart = store.get('showStrat', true);
    this.fillsKey = '';
    this.pickMode = false;
    this.recorder = new Recorder(this);
  }

  // ---------- 状態 ----------
  accounts() { return { manual: this.manual, strategy: this.autoOn ? this.auto : null }; }
  inReplay() { return this.replay.mode === 'replay'; }
  canTrade() { return this.inReplay() && !!this.manual; }
  price() { return this.replay.lastPrice ?? null; }
  clock() { return this.inReplay() ? { T: this.replay.T } : null; }
  off() { return dayOffset(this.sym); }
  accountCfg(sym = this.sym) {
    const s = this.settings;
    if (sym.type === 'fx') return { balance: sym.quote === 'JPY' ? s.fx.balanceJPY : s.fx.balanceUSD, leverage: s.fx.leverage, fee: 0, spread: (s.spread[sym.id] ?? sym.spread) * sym.pip, stopOut: s.fx.stopOut / 100 };
    return { balance: s.crypto.balance, leverage: s.crypto.leverage, fee: s.crypto.fee / 100, spread: 0, stopOut: s.crypto.stopOut / 100 };
  }
  spread() { return this.accountCfg().spread; }
  customStrategies() { return (this._customs ||= store.get('strategies', [])); }
  saveCustomStrategies(list) { this._customs = list; store.set('strategies', list); this.tester.renderHead(); }

  // ---------- 起動 ----------
  async init() {
    this.buildHeader();
    this.buildToolbar();
    this.buildBottom();
    this.ticket = new Ticket($('#right'), this);
    this.buildReplayBar();
    this.bindReplay();
    this.bindOverlay();
    this.bindKeys();
    this.cv.on('editIndicator', (ind) => this.indicatorSettings(ind));
    this.cv.on('indicators', () => store.set('inds', this.cv.serialize()));
    this.cv.on('range', (r) => this.onRange(r));
    for (const x of store.get('inds', [{ id: 'volume' }])) this.cv.addIndicator(x.id, x.inputs, x.styles, x);
    const sk = store.get('strat', null);
    if (sk) this.selectStrategy(sk, false, true);
    this.applySymbolUI();
    await this.loadIdle();
    this.offerResume();
    let last = performance.now(), lastUI = 0, lastSave = 0;
    const frame = (now) => {
      const dt = Math.min(0.25, (now - last) / 1000);
      last = now;
      try { this.frame(dt, now); } catch (e) { console.error(e); }
      if (now - lastUI > 200) { lastUI = now; this.refreshUI(); }
      if (now - lastSave > 5000) { lastSave = now; this.saveSession(); this.recorder.saveSession(); }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    window.addEventListener('beforeunload', () => this.saveSession());
  }

  frame(dt, now) {
    const r = this.replay;
    r.tick(dt);
    if (r.dirtyFrom != null || r.structural) {
      this.cv.setBars(r.view, r.dirtyFrom ?? 0, !!r.structural);
      r.dirtyFrom = null; r.structural = false;
    }
    if (this.btDirty && now - (this.btAt || 0) > 250) { this.btAt = now; this.btDirty = false; this.extendBacktest(); }
    this.ov.draw();
  }

  refreshUI() {
    this.trading.refresh();
    this.ticket.sync(true);
    this.updateReplayBar();
    this.updateFills();
    this.cv.positionPaneLegends();
    const vr = this.cv.chart.timeScale().getVisibleLogicalRange();
    $('#toRT').hidden = !vr || vr.to > this.cv.view.length + 2;
  }

  // ---------- データ読み込み ----------
  async loadIdle() {
    try {
      await this.replay.loadIdle(this.sym, this.tf);
    } catch (e) { toast(e.message, 'err', 5000); }
  }
  applySymbolUI() {
    $('#symBtn').innerHTML = `${SVG.search}<b>${this.sym.id}</b>`;
    document.title = `${this.sym.id} · Trade Replay`;
    this.cv.setSymbol(this.sym, this.tf, this.off());
    this.cv.setTFLabel(tfInfo(this.tf).label);
    this.ticket.setSymbol(this.sym);
    this.ov.load(store.get('draw.' + this.sym.id, []));
    document.querySelectorAll('.tf-btn').forEach((b) => b.classList.toggle('on', +b.dataset.tf === this.tf));
    $('#tfMore').textContent = TFS.slice(0, 0).length || (['60', '300', '900', '3600', '14400', '86400'].includes(String(this.tf)) ? '▾' : tfInfo(this.tf).short + ' ▾');
  }
  async setSymbol(id) {
    const sym = symbolInfo(id);
    if (sym.type === 'crypto' && sym.custom) {
      try { await sourceFor(sym).loadTF(sym, 86400, Math.floor(Date.now() / 1000), 1); } catch (e) { toast(e.message, 'err'); return; }
    }
    const wasReplay = this.inReplay(), T = this.replay.T;
    this.sym = sym;
    store.set('sym', sym.id);
    this.applySymbolUI();
    if (wasReplay) {
      this.replay.stop();
      await this.loadIdle();
      const rg = this.replay.range;
      if (rg && T > rg.min && T < rg.max) await this.startReplay(T);
      else { toast('この銘柄にはその日時のデータがないため、リプレイを終了しました'); this.endReplay(true); }
    } else await this.loadIdle();
  }
  async setTF(tf) {
    this.tf = tf;
    store.set('tf', tf);
    this.cv.tf = tf;
    this.cv.setTFLabel(tfInfo(tf).label);
    document.querySelectorAll('.tf-btn').forEach((b) => b.classList.toggle('on', +b.dataset.tf === tf));
    $('#tfMore').textContent = [60, 300, 900, 3600, 14400, 86400].includes(tf) ? '▾' : tfInfo(tf).short + ' ▾';
    this.recorder.op('tf', { tf }, 'app');
    try { await this.replay.setTF(tf); } catch (e) { toast(e.message, 'err'); }
  }

  bindReplay() {
    const r = this.replay;
    r.on('loading', (on) => { $('#loading').hidden = !on; });
    r.on('reset', () => {
      this.cv.tf = r.tf;
      this.cv.off = this.off();
      this.cv.setBars(r.view, 0, true);
      r.dirtyFrom = null; r.structural = false;
      this.cv.chart.timeScale().scrollToRealTime();
      this.resetRunners();
      this.fillsKey = '';
    });
    r.on('started', () => {
      this.manual = new Account(this.sym, this.accountCfg(), '手動');
      this.manual.bid = r.lastPrice; this.manual.t = r.T;
      const resumeId = this.pendingRestore ? this.pendingSessionId : null;
      if (this.pendingRestore) { this.manual.restore(this.pendingRestore); this.manual.bid = r.lastPrice; this.pendingRestore = null; }
      if (this.recorder.session) this.recorder.endSession();
      this.recorder.startSession(resumeId);
      this.recorder.attach(this.manual, 'manual');
      this.auto = null;
      if (this.autoOn) this.createAuto();
      r.accounts = [this.manual, this.auto].filter(Boolean);
      this.trading.refresh(true);
    });
    r.on('barclose', (from, to) => this.onBarClose(from, to));
    r.on('prepend', (n) => {
      const ts = this.cv.chart.timeScale();
      const vr = ts.getVisibleLogicalRange();
      this.cv.setBars(r.view, 0, true);
      if (vr) ts.setVisibleLogicalRange({ from: vr.from + n, to: vr.to + n });
      this.resetRunners();
    });
    r.on('ended', () => { toast('データの最後まで再生しました'); this.updateReplayBar(); });
    r.on('error', (e) => toast(e.message, 'err'));
  }
  onRange(r) {
    if (r && r.from < 30 && !this.replay.loadingOlder) this.replay.loadOlder().catch(() => {});
  }

  // ---------- リプレイ ----------
  enterPick() {
    if (this.pickMode) { this.cancelPick(); return; }
    this.pickMode = true;
    this.ov.pickMode = true;
    this.replay.playing = false;
    this.updateReplayBar();
  }
  cancelPick() { this.pickMode = false; this.ov.pickMode = false; this.updateReplayBar(); }
  async startReplay(T0) {
    this.cancelPick();
    const rg = this.replay.range;
    if (rg) {
      if (T0 >= rg.max - 60) { toast('もっと前の日時を選んでください（その先のデータが必要です）', 'err'); return; }
      if (T0 < rg.min) T0 = rg.min + 3600;
    }
    T0 = Math.floor(T0 / 60) * 60;
    if (this.manual?.trades.length && !this.pendingRestore && !confirm('新しいリプレイを始めると、今の口座はリセットされます。よろしいですか？')) return;
    try {
      await this.replay.start(T0, this.sym, this.tf);
      toast(`${fmtTime(T0)} からリプレイを開始しました。▶ または Shift+↓ で再生`);
    } catch (e) { toast(e.message, 'err', 5000); }
    this.updateReplayBar();
  }
  async endReplay(silent) {
    if (!silent && this.manual?.trades.length && !confirm('リプレイを終了しますか？（口座の記録は消えます）')) return;
    this.replay.stop();
    this.recorder.endSession();
    this.manual = null; this.auto = null;
    this.replay.accounts = [];
    store.set('session', null);
    await this.loadIdle();
    this.updateReplayBar();
  }
  togglePlay() {
    const r = this.replay;
    if (!this.inReplay()) { this.enterPick(); return; }
    if (r.ended) { toast('データの最後です'); return; }
    r.playing = !r.playing;
    this.recorder.playState(r.playing);
    this.updateReplayBar();
  }
  stepOne() { if (this.inReplay()) { if (this.replay.playing) this.recorder.playState(false); this.replay.playing = false; this.recorder.op('step', { tf: this.replay.tf }, 'app'); this.replay.step(); this.updateReplayBar(); } }
  async randomStart() {
    const rg = this.replay.range || (await sourceFor(this.sym).range(this.sym));
    if (!rg) return;
    const lo = rg.min + 20 * DAY, hi = rg.max - 5 * DAY;
    if (hi <= lo) { toast('データが足りません', 'err'); return; }
    await this.startReplay(alignTF(lo + Math.random() * (hi - lo), this.tf, this.off()));
  }
  dateDialog() {
    const rg = this.replay.range;
    const inp = el('input', { type: 'datetime-local', value: fmtDateInput(this.inReplay() ? this.replay.T : (rg?.max ?? Date.now() / 1000) - 30 * DAY) });
    modal('リプレイの開始日時', el('div', { class: 'form' },
      el('label', { class: 'form-row' }, el('span', {}, `日時（${TZ.name}）`), inp),
      el('p', { class: 'muted' }, rg ? `選べる範囲: ${fmtTime(rg.min)} 〜 ${fmtTime(rg.max)}` : ''),
      el('p', { class: 'muted' }, 'この日時の直前までが表示された状態で始まります。')),
    { buttons: [{ label: 'キャンセル' }, { label: '開始', primary: true, onclick: () => { const t = parseDateInput(inp.value); if (!isFinite(t)) return false; this.startReplay(t); } }] });
  }

  // ---------- ストラテジー ----------
  selectStrategy(key, fromEditor, silent) {
    store.set('strat', key);
    if (!key) { this.strat = null; this.bt = null; this.runner = null; this.cv.setStrategyPlots(null); this.tester.renderHead(); this.tester.render(); this.fillsKey = ''; return; }
    let code;
    if (key.startsWith('preset:')) code = PRESETS.find((p) => p.id === key.slice(7))?.code;
    else code = this.customStrategies().find((c) => c.id === key.slice(7))?.code;
    if (!code) { this.selectStrategy(null); return; }
    let compiled = null, error = null;
    try { compiled = compile(code); } catch (e) { error = e.message; }
    const inputs = {};
    if (compiled) for (const [k, x] of Object.entries(compiled.inputs)) inputs[k] = x.value;
    Object.assign(inputs, store.get('stratInputs.' + key, {}));
    this.strat = { key, code, compiled, inputs, error };
    this.resetRunners();
    this.tester.renderHead();
    this.tester.render();
    if (fromEditor) { this.showBottom(1); toast('ストラテジーをチャートに追加しました'); }
    void silent;
  }
  stratInputs() {
    const inp = { ...this.strat.inputs };
    if (inp.qty == null) inp.qty = store.get('stratQty.' + this.sym.id, this.sym.qty);
    return inp;
  }
  editStrategyInputs() {
    const st = this.strat;
    if (!st?.compiled) return;
    const fields = Object.entries(st.compiled.inputs).map(([k, x]) => ({ k, label: x.label, value: st.inputs[k] ?? x.value, step: x.step, type: typeof x.value === 'number' ? 'number' : typeof x.value === 'boolean' ? 'checkbox' : 'text' }));
    if (!('qty' in st.compiled.inputs)) fields.push({ k: '_qty', label: `数量（${this.sym.id}）`, value: store.get('stratQty.' + this.sym.id, this.sym.qty), step: this.sym.qtyStep });
    const f = form(fields);
    modal(st.compiled.name + ' の設定', el('div', {}, f, el('p', { class: 'muted' }, `初期資金・レバレッジ・手数料は右上の ⚙ 口座設定と同じです（${this.accountCfg().balance.toLocaleString()} ${this.sym.quote}, ${this.accountCfg().leverage}倍）`)), {
      buttons: [{ label: 'キャンセル' }, { label: 'OK', primary: true, onclick: () => {
        const v = f.values();
        if ('_qty' in v) { store.set('stratQty.' + this.sym.id, v._qty); delete v._qty; }
        st.inputs = { ...st.inputs, ...v };
        store.set('stratInputs.' + st.key, st.inputs);
        this.resetRunners();
        this.tester.render();
      } }],
    });
  }
  setShowStrat(on) { this.showStratOnChart = on; store.set('showStrat', on); this.cv.setStrategyPlots(on && this.bt ? this.bt.runner.plots : null); this.fillsKey = ''; }
  toggleAuto() {
    this.autoOn = !this.autoOn;
    if (this.autoOn && this.inReplay() && !this.auto) this.createAuto();
    if (!this.autoOn) { this.auto = null; this.runner = null; }
    this.replay.accounts = [this.manual, this.auto].filter(Boolean);
    this.tester.renderHead();
    this.trading.refresh(true);
    this.fillsKey = '';
    if (this.autoOn && !this.inReplay()) toast('リプレイを開始すると、ストラテジーが自動で売買します');
  }
  createAuto() {
    if (!this.strat?.compiled) { toast('ストラテジーにエラーがあります', 'err'); return; }
    this.auto = new Account(this.sym, this.accountCfg(), '自動売買');
    this.auto.bid = this.replay.lastPrice; this.auto.t = this.replay.T;
    this.recorder.attach(this.auto, 'auto');
    this.recorder.op('auto_on', { strategy: this.strat.compiled.name, inputs: this.stratInputs() }, 'app');
    this.makeLiveRunner();
  }
  makeLiveRunner() {
    if (!this.auto || !this.strat?.compiled) { this.runner = null; return; }
    this.runner = new StrategyRunner(this.strat.compiled, this.stratInputs(), this.auto, this.sym, this.replay.tf, this.off());
    this.runner.S.sync(this.replay.bars, 0, this.replay.countClosed());
  }
  // 足の並びが変わったときに作り直す
  resetRunners() {
    this.makeLiveRunner();
    this.runBacktest();
  }
  runBacktest() {
    this.bt = null;
    if (this.strat?.compiled) {
      const r = this.replay;
      this.bt = new Backtest(this.strat.compiled, this.stratInputs(), this.sym, r.tf ?? this.tf, this.off(), this.accountCfg());
      const n = r.mode === 'replay' ? r.countClosed() : r.bars.length;
      try { this.bt.run(r.bars.slice(0, n)); } catch (e) { this.strat.error = e.message; }
      this.strat.error = this.bt.runner.error || this.strat.error;
    }
    this.cv.setStrategyPlots(this.showStratOnChart && this.bt ? this.bt.runner.plots : null);
    this.tester.renderHead();
    this.tester.render();
    this.fillsKey = '';
  }
  extendBacktest() {
    if (!this.bt) return;
    const r = this.replay;
    const n = r.countClosed();
    if (n <= this.bt.bars.length) return;
    this.bt.extend(r.bars.slice(0, n));
    if (this.showStratOnChart) this.cv.updateStrategyPlots();
    this.tester.renderHead();
    this.tester.render();
  }
  onBarClose(from, to) {
    if (this.runner) {
      const S = this.runner.S;
      S.sync(this.replay.bars, Math.min(S.n, from), to);
      for (let i = from; i < to; i++) this.runner.onBar(i);
    }
    this.btDirty = true;
  }

  // ---------- 売買 ----------
  marketOrder(side, qty, br = {}) {
    if (!this.canTrade()) { toast('リプレイ中のみ取引できます', 'err'); return; }
    this.recorder.op('order_market', { side, qty, sl: br.sl ?? null, tp: br.tp ?? null });
    const err = this.manual.market(side, qty, { sl: br.sl, tp: br.tp, reason: side > 0 ? '成行買い' : '成行売り' });
    if (err) toast(err, 'err');
    return !err;
  }
  pendingOrder(o) {
    if (!this.canTrade()) { toast('リプレイ中のみ取引できます', 'err'); return false; }
    const bid = this.price(), ask = bid + this.spread();
    const px = o.side > 0 ? ask : bid;
    if (o.type === 'limit' && (o.side > 0 ? o.price >= px : o.price <= px)) { toast('指値が現在値より不利です。成行か逆指値を使ってください', 'err'); return false; }
    if (o.type === 'stop' && (o.side > 0 ? o.price <= px : o.price >= px)) { toast('逆指値が現在値より有利です。成行か指値を使ってください', 'err'); return false; }
    this.manual.placeOrder(o);
    toast(`${o.side > 0 ? '買い' : '売り'}${o.type === 'limit' ? '指値' : '逆指値'} を ${fmtNum(o.price, this.sym.digits)} に置きました`);
    return true;
  }
  closePosition(frac = 1) {
    const a = this.manual; if (!a?.pos.qty) return;
    const step = this.sym.qtyStep;
    const q = frac >= 1 ? Math.abs(a.pos.qty) : Math.max(step, Math.round((Math.abs(a.pos.qty) * frac) / step) * step);
    this.recorder.op('close', { qty: q, of: Math.abs(a.pos.qty) });
    a.closePosition('手動決済', q);
  }
  closeAllManual() { this.recorder.op('close_all', {}); this.manual?.closeAll('全決済'); }
  reverse() {
    const a = this.manual; if (!a?.pos.qty) return;
    this.recorder.op('reverse', { qty: Math.abs(a.pos.qty) });
    const err = a.market(-Math.sign(a.pos.qty), Math.abs(a.pos.qty) * 2, { reason: 'ドテン' });
    if (err) toast(err, 'err');
  }

  bindOverlay() {
    const ov = this.ov;
    ov.on('changed', (list) => { store.set('draw.' + this.sym.id, list); this.recorder.op('drawings', { count: list.length, types: list.map((d) => d.type).join(',') }, 'app'); });
    ov.on('tool', (t) => document.querySelectorAll('#tools .tool').forEach((b) => b.classList.toggle('on', b.dataset.tool === t)));
    ov.on('pickStart', (t) => this.startReplay(alignTF(t, this.tf, this.off()) + this.tf));
    ov.on('pickCancel', () => this.cancelPick());
    ov.on('lineDrag', (ln, price) => this.ticket.setDraft(ln.draft, price));
    ov.on('lineMove', (ln, price) => {
      if (ln.draft) { this.ticket.setDraft(ln.draft, price); return; }
      const a = this.manual; if (!a || ln.acc !== a) return;
      const p = a.pos, long = p.qty > 0, bid = this.price();
      price = +price.toFixed(this.sym.digits);
      if (ln.kind === 'order') a.modifyOrder(ln.order.id, { price });
      else if (ln.kind === 'sl') { if ((long && price >= bid) || (!long && price <= bid + this.spread())) toast('損切りは現在値の向こう側には置けません', 'err'); else a.setBrackets(price, undefined); }
      else if (ln.kind === 'tp') { if ((long && price <= bid) || (!long && price >= bid + this.spread())) toast('利確は現在値より利益側に置いてください', 'err'); else a.setBrackets(undefined, price); }
      else if (ln.kind === 'pos') {
        const profitSide = (price - p.avg) * Math.sign(p.qty) > 0;
        const cur = long ? bid : bid + this.spread();
        if (profitSide && (price - cur) * Math.sign(p.qty) > 0) a.setBrackets(undefined, price);
        else if (!profitSide && (cur - price) * Math.sign(p.qty) > 0) a.setBrackets(price, undefined);
        else toast('その位置には置けません（現在値をまたいでいます）', 'err');
      }
    });
    ov.on('lineClose', (ln) => {
      if (ln.draft) { this.ticket.toggleBracket(ln.draft, false); return; }
      const a = this.manual; if (!a || ln.acc !== a) return;
      if (ln.kind === 'pos') a.closePosition('手動決済');
      else if (ln.kind === 'sl') a.setBrackets(null, undefined);
      else if (ln.kind === 'tp') a.setBrackets(undefined, null);
      else if (ln.kind === 'order') a.cancelOrder(ln.order.id);
    });
    ov.on('context', ({ x, y, price, t, drawing }) => {
      const d = this.sym.digits, ps = fmtNum(price, d);
      const items = [];
      if (this.canTrade()) {
        const bid = this.price(), q = this.ticket.qty();
        if (price < bid) items.push({ label: `買い指値 ${ps}`, onclick: () => this.pendingOrder({ side: 1, type: 'limit', price, qty: q }) }, { label: `売り逆指値 ${ps}`, onclick: () => this.pendingOrder({ side: -1, type: 'stop', price, qty: q }) });
        else items.push({ label: `売り指値 ${ps}`, onclick: () => this.pendingOrder({ side: -1, type: 'limit', price, qty: q }) }, { label: `買い逆指値 ${ps}`, onclick: () => this.pendingOrder({ side: 1, type: 'stop', price, qty: q }) });
        items.push('-');
      } else if (t != null) items.push({ label: 'ここからリプレイを開始', icon: SVG.replay, onclick: () => this.startReplay(alignTF(t, this.tf, this.off()) + this.tf) }, '-');
      items.push({ label: `水平線を引く ${ps}`, onclick: () => this.ov.add({ id: Math.random().toString(36).slice(2), type: 'hline', pts: [{ t, p: price }], color: '#2962ff', width: 1 }) });
      if (drawing) items.push({ label: 'この描画を削除', onclick: () => this.ov.remove(drawing) });
      items.push({ label: 'すべての描画を削除', onclick: () => this.ov.removeAll() }, '-', { label: 'チャートをリセット', hint: 'Alt+R', onclick: () => this.resetChart() });
      menu(x, y, items);
    });
  }
  resetChart() {
    this.cv.chart.timeScale().resetTimeScale();
    this.cv.chart.priceScale('right').applyOptions({ autoScale: true });
    this.cv.chart.timeScale().scrollToRealTime();
  }
  scrollToTime(t1, t2) {
    const a = this.cv.timeToLogical(t1), b = this.cv.timeToLogical(t2);
    if (a == null) return;
    const pad = Math.max(20, (b - a) * 0.6);
    this.cv.chart.timeScale().setVisibleLogicalRange({ from: a - pad, to: b + pad });
  }
  updateFills() {
    const acc = this.manual, list = [];
    const s = this.autoOn && this.auto ? this.auto : this.showStratOnChart && this.bt ? this.bt.acc : null;
    const key = `${acc?.execs.length}|${s ? s.execs.length : -1}|${this.cv.view.length ? this.cv.view[0].t : 0}|${this.replay.tf}`;
    if (key === this.fillsKey) return;
    this.fillsKey = key;
    if (acc) for (const f of acc.execs) list.push({ t: f.t, side: f.side, qty: f.qty, reason: f.reason, acc: 'manual' });
    if (s) for (const f of s.execs) list.push({ t: f.t, side: f.side, qty: 0, reason: f.reason, acc: 'strategy' });
    list.sort((a, b) => a.t - b.t);
    this.cv.setFills(list);
  }

  // ---------- 前回の続き ----------
  saveSession() {
    if (!this.inReplay() || !this.manual) return;
    store.set('session', { sessionId: this.recorder.session?.id, sym: this.sym.id, tf: this.replay.tf, T: this.replay.T, speed: this.replay.speed, manual: this.manual.snapshot(), at: Date.now() });
  }
  offerResume() {
    const s = store.get('session', null);
    if (!s) return;
    const bar = el('div', { class: 'resume' },
      el('span', {}, `前回のリプレイ（${s.sym}・${fmtTime(s.T)} 時点・口座残高 ${fmtNum(s.manual.balance, 0)}）を続けますか？`),
      el('button', { class: 'btn small primary', onclick: async () => { bar.remove(); await this.resume(s); } }, '続ける'),
      el('button', { class: 'btn small', onclick: () => { bar.remove(); store.set('session', null); } }, '破棄'));
    $('#chartWrap').append(bar);
  }
  async resume(s) {
    if (s.sym !== this.sym.id) { this.sym = symbolInfo(s.sym); store.set('sym', s.sym); this.applySymbolUI(); await this.loadIdle(); }
    if (s.tf !== this.tf) { this.tf = s.tf; store.set('tf', s.tf); this.applySymbolUI(); }
    this.pendingRestore = s.manual;
    this.pendingSessionId = s.sessionId;
    await this.startReplay(s.T);
  }

  // ---------- 画面の組み立て ----------
  buildHeader() {
    const h = $('#top');
    const tfBtns = [60, 300, 900, 3600, 14400, 86400].map((s) => el('button', { class: 'tf-btn', 'data-tf': s, onclick: () => this.setTF(s), title: tfInfo(s).label }, tfInfo(s).short));
    const tfMore = el('button', { id: 'tfMore', class: 'tb', onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); menu(r.left, r.bottom + 4, TFS.map((t) => ({ label: t.label, hint: t.short, active: t.s === this.tf, onclick: () => this.setTF(t.s) }))); } }, '▾');
    h.append(
      el('div', { class: 'logo', title: 'Trade Replay' }, el('span', {}, 'TR')),
      el('button', { id: 'symBtn', class: 'tb sym', onclick: () => this.symbolDialog() }),
      el('div', { class: 'sep' }), ...tfBtns, tfMore,
      el('div', { class: 'sep' }),
      el('button', { class: 'tb', title: 'チャートの種類', onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); menu(r.left, r.bottom + 4, CHART_TYPES.map((c) => ({ label: c.label, active: c.id === this.cv.type, onclick: () => { this.cv.setType(c.id); store.set('chartType', c.id); } }))); }, html: SVG.candle }),
      el('button', { class: 'tb wide', onclick: () => this.indicatorDialog(), html: SVG.fx + '<span>インジケーター</span>' }),
      el('button', { class: 'tb wide', onclick: () => this.showBottom(1), html: SVG.strat + '<span>ストラテジー</span>' }),
      el('div', { class: 'sep' }),
      el('button', { id: 'replayBtn', class: 'tb wide', onclick: () => (this.inReplay() ? this.enterPick() : this.enterPick()), html: SVG.replay + '<span>リプレイ</span>' }),
      el('div', { class: 'grow' }),
      el('div', { id: 'clock', class: 'clock' }),
      el('button', { class: 'tb', title: '口座・表示の設定', onclick: () => this.settingsDialog(), html: SVG.gear }),
      el('button', { class: 'tb', title: '使い方・ショートカット', onclick: () => this.helpDialog(), html: SVG.help }));
  }
  buildToolbar() {
    const t = $('#tools');
    for (const tool of TOOLS) {
      t.append(el('button', { class: 'tool' + (tool.id === 'cursor' ? ' on' : ''), 'data-tool': tool.id, title: tool.label + (tool.key ? `（${tool.key}）` : ''), html: SVG[tool.id], onclick: () => this.ov.setTool(tool.id) }));
      if (tool.id === 'cursor' || tool.id === 'vline' || tool.id === 'fib' || tool.id === 'short') t.append(el('div', { class: 'tsep' }));
    }
    const mag = el('button', { class: 'tool', title: 'マグネット（足の始値・高値・安値・終値に吸着）', html: SVG.magnet, onclick: () => { this.ov.magnet = !this.ov.magnet; mag.classList.toggle('on', this.ov.magnet); } });
    const hide = el('button', { class: 'tool', title: '描画を隠す', html: SVG.eye, onclick: () => { this.ov.hidden = !this.ov.hidden; hide.classList.toggle('on', this.ov.hidden); } });
    t.append(mag, hide, el('button', { class: 'tool', title: 'すべての描画を削除', html: SVG.trash, onclick: () => { if (this.ov.drawings.length && confirm('この銘柄の描画をすべて削除しますか？')) this.ov.removeAll(); } }));
  }
  buildBottom() {
    const b = $('#bottom');
    const body = el('div', { class: 'bottom-body' });
    const panes = [0, 1, 2, 3, 4].map((i) => el('div', { class: 'bpane', hidden: i > 0 }));
    body.append(...panes);
    this.bottomTabs = tabs(['取引パネル', 'ストラテジーテスター', 'ストラテジーエディター', 'トレード記録', 'AI トレーナー'], (i) => {
      panes.forEach((p, k) => (p.hidden = k !== i));
      b.classList.remove('collapsed');
      store.set('bottomTab', i);
      if (i === 1) this.tester.render();
      this.journal.visible = i === 3;
      if (i === 3) this.journal.render();
    });
    const collapse = el('button', { class: 'tb', title: 'パネルを開閉', onclick: () => { b.classList.toggle('collapsed'); store.set('bottomCollapsed', b.classList.contains('collapsed')); } }, '▾');
    b.append(el('div', { class: 'bottom-head' }, this.bottomTabs, el('div', { class: 'grow' }), collapse), body);
    this.trading = new TradingPanel(panes[0], this);
    this.tester = new TesterPanel(panes[1], this);
    this.editor = new EditorPanel(panes[2], this);
    this.journal = new JournalPanel(panes[3], this);
    this.coach = new Coach(panes[4], this);
    this.coach.offerSetup();
    this.bottomTabs.select(store.get('bottomTab', 0));
    if (store.get('bottomCollapsed', false)) b.classList.add('collapsed');
    b.style.height = store.get('bottomH', 260) + 'px';
    // 高さの変更
    const sp = $('#splitter');
    sp.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const y0 = e.clientY, h0 = b.offsetHeight;
      const mv = (ev) => { const hh = Math.max(120, Math.min(innerHeight - 220, h0 - (ev.clientY - y0))); b.style.height = hh + 'px'; b.classList.remove('collapsed'); };
      const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); store.set('bottomH', b.offsetHeight); this.cv.positionPaneLegends(); };
      window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
    });
  }
  showBottom(i, minH) {
    this.bottomTabs.select(i);
    const b = $('#bottom');
    b.classList.remove('collapsed');
    if (minH && b.offsetHeight < minH) { b.style.height = Math.min(minH, innerHeight - 220) + 'px'; this.cv.positionPaneLegends(); }
  }

  buildReplayBar() {
    this.rb = el('div', { id: 'replayBar', class: 'replay-bar', hidden: true });
    $('#replayBtn').after(this.rb);
    $('#chartWrap').append(
      el('button', { id: 'toRT', class: 'to-rt', title: '最新の足へ', hidden: true, html: SVG.realtime, onclick: () => this.cv.chart.timeScale().scrollToRealTime() }),
      el('div', { id: 'loading', class: 'loading', hidden: true }, el('div', { class: 'spin' })));
    this.rbState = '';
  }
  updateReplayBar() {
    const r = this.replay, rb = this.rb;
    const state = this.pickMode ? 'pick' : this.inReplay() ? 'replay:' + r.playing + ':' + r.speed + ':' + r.ended : 'idle';
    $('#replayBtn').classList.toggle('on', this.pickMode || this.inReplay());
    $('#clock').textContent = this.inReplay() ? `▶ ${fmtTime(r.T, true)} ${TZ.name}` : '';
    if (state !== this.rbState) {
      this.rbState = state;
      rb.innerHTML = '';
      rb.hidden = state === 'idle';
      if (this.pickMode) {
        rb.append(el('span', { class: 'rb-msg' }, '開始する足をクリック'),
          el('button', { class: 'rb-btn', title: '日付を選ぶ', html: SVG.cal + '<span>日付</span>', onclick: () => this.dateDialog() }),
          el('button', { class: 'rb-btn', title: 'ランダムな日時', html: SVG.dice + '<span>ランダム</span>', onclick: () => this.randomStart() }),
          el('button', { class: 'rb-btn', onclick: () => this.cancelPick() }, 'キャンセル'));
      } else if (this.inReplay()) {
        const sp = el('select', { class: 'rb-speed', title: '再生速度', onchange: (e) => { r.speed = +e.target.value; store.set('speed', r.speed); this.recorder.op('speed', { speed: r.speed }, 'app'); } }, ...SPEEDS.map((s) => el('option', { value: s.v, selected: s.v === r.speed }, s.label)));
        rb.append(
          el('button', { class: 'rb-btn', title: '開始位置を選び直す', html: SVG.replay, onclick: () => this.enterPick() }),
          el('button', { class: 'rb-btn play', title: '再生 / 一時停止（Shift+↓ または Space）', html: r.playing ? SVG.pause : SVG.play, onclick: () => this.togglePlay() }),
          el('button', { class: 'rb-btn', title: '1本進める（Shift+→）', html: SVG.step, onclick: () => this.stepOne() }),
          sp,
          this.rbTime = el('span', { class: 'rb-time' }),
          el('button', { class: 'rb-btn', title: 'リプレイを終了', html: SVG.stop, onclick: () => this.endReplay() }));
      }
    }
    if (this.inReplay() && this.rbTime) this.rbTime.textContent = r.ended ? 'データの最後' : r.loading && r.needData ? '読み込み中…' : fmtTime(r.T, true);
  }

  // ---------- ダイアログ ----------
  async symbolDialog() {
    const man = await fxManifest();
    const q = el('input', { type: 'text', placeholder: '銘柄を検索（例: BTC, USDJPY, PEPEUSDT）', class: 'search' });
    const list = el('div', { class: 'sym-list' });
    const render = () => {
      const s = q.value.trim().toUpperCase();
      list.innerHTML = '';
      const items = SYMBOLS.filter((x) => !s || x.id.includes(s) || x.name.includes(q.value.trim()));
      for (const [type, label] of [['crypto', '暗号資産（Binance）'], ['fx', 'FX（Dukascopy・同梱データ）']]) {
        const g = items.filter((x) => x.type === type);
        if (!g.length) continue;
        list.append(el('div', { class: 'sym-group' }, label));
        for (const x of g) {
          const m = man.pairs[x.id];
          const note = x.type === 'fx' ? (m?.m1?.length ? `${m.m1[0]} 〜 ${m.m1[m.m1.length - 1]}` : 'データ準備中') : '';
          list.append(el('div', { class: 'sym-item' + (x.id === this.sym.id ? ' on' : ''), onclick: () => { dlg.close(); this.setSymbol(x.id); } }, el('b', {}, x.id), el('span', {}, x.name), el('small', {}, note)));
        }
      }
      if (s && /^[A-Z0-9]{5,}$/.test(s) && !SYMBOLS.some((x) => x.id === s)) list.append(el('div', { class: 'sym-item', onclick: () => { dlg.close(); this.setSymbol(s); } }, el('b', {}, s), el('span', {}, 'Binance の銘柄として開く'), el('small', {}, 'Enter')));
    };
    q.addEventListener('input', render);
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const s = q.value.trim().toUpperCase(); const hit = SYMBOLS.find((x) => x.id.includes(s)); dlg.close(); this.setSymbol(hit && s.length < 6 ? hit.id : s); } });
    const dlg = modal('銘柄の検索', el('div', {}, q, list), { width: 520 });
    render();
  }
  indicatorDialog() {
    const q = el('input', { type: 'text', placeholder: '検索（例: RSI, 一目, bollinger）', class: 'search' });
    const list = el('div', { class: 'ind-list' });
    const render = () => {
      const s = q.value.trim().toLowerCase();
      list.innerHTML = '';
      for (const d of INDICATORS.filter((x) => !s || (x.name + x.short + x.kw).toLowerCase().includes(s))) {
        list.append(el('div', { class: 'ind-item', onclick: () => { this.cv.addIndicator(d.id); toast(d.name + ' を追加しました'); } }, el('span', {}, d.name), el('small', {}, d.overlay ? 'チャート上' : '別ペイン')));
      }
    };
    q.addEventListener('input', render);
    modal('インジケーター', el('div', {}, q, list), { width: 480 });
    render();
  }
  indicatorSettings(ind) {
    const d = ind.def;
    const f = form([
      ...(d.inputs.length ? [{ section: 'パラメーター' }] : []),
      ...d.inputs.map((x) => (x.opts ? { k: 'i_' + x.k, label: x.label, type: 'select', value: ind.inputs[x.k], opts: x.opts } : { k: 'i_' + x.k, label: x.label, value: ind.inputs[x.k], step: x.step ?? 1 })),
      { section: 'スタイル' },
      ...d.plots.flatMap((p, k) => [{ k: 'c_' + k, label: p.label + ' の色', type: 'color', value: toHex(ind.styles[k].color) }, { k: 'v_' + k, label: p.label + ' を表示', type: 'checkbox', value: ind.styles[k].visible }]),
    ]);
    modal(d.name, f, { buttons: [{ label: 'キャンセル' }, { label: 'OK', primary: true, onclick: () => {
      const v = f.values(), inputs = {}, styles = ind.styles.map((s) => ({ ...s }));
      for (const x of d.inputs) inputs[x.k] = v['i_' + x.k];
      d.plots.forEach((p, k) => { styles[k].color = v['c_' + k]; styles[k].visible = v['v_' + k]; });
      this.cv.updateIndicator(ind.uid, { inputs, styles });
    } }] });
  }
  settingsDialog() {
    const s = this.settings, sym = this.sym;
    const f = form([
      { section: '暗号資産の口座' },
      { k: 'cb', label: '初期資金 (USDT)', value: s.crypto.balance, step: 100 },
      { k: 'cl', label: 'レバレッジ（倍）', value: s.crypto.leverage, step: 1 },
      { k: 'cf', label: '手数料（片道 %）', value: s.crypto.fee, step: 0.01 },
      { section: 'FX の口座' },
      { k: 'fj', label: '初期資金（円・クロス円）', value: s.fx.balanceJPY, step: 10000 },
      { k: 'fu', label: '初期資金（ドル・ドルストレート）', value: s.fx.balanceUSD, step: 100 },
      { k: 'fl', label: 'レバレッジ（倍）', value: s.fx.leverage, step: 1 },
      ...(sym.type === 'fx' ? [{ k: 'sp', label: `${sym.id} のスプレッド (pips)`, value: s.spread[sym.id] ?? sym.spread, step: 0.1 }] : []),
      { section: '共通' },
      { k: 'so', label: 'ロスカット水準（証拠金維持率 %）', value: s.crypto.stopOut, step: 10 },
      { k: 'tz', label: 'タイムゾーン', type: 'select', value: s.tz, opts: [['JST', '日本時間 (UTC+9)'], ['UTC', 'UTC']] },
    ]);
    modal('設定', el('div', {}, f, el('p', { class: 'muted' }, '口座の設定は次にリプレイを開始したときから使われます。')), { buttons: [{ label: 'キャンセル' }, { label: '保存', primary: true, onclick: () => {
      const v = f.values();
      s.crypto = { balance: v.cb, leverage: v.cl, fee: v.cf, stopOut: v.so };
      s.fx = { balanceJPY: v.fj, balanceUSD: v.fu, leverage: v.fl, stopOut: v.so };
      if (v.sp != null) s.spread[sym.id] = v.sp;
      const tzChanged = v.tz !== s.tz;
      s.tz = v.tz;
      store.set('settings', s);
      if (tzChanged) location.reload();
      this.runBacktest();
      this.ticket.sync();
    } }] });
  }
  helpDialog() {
    const k = (a, b) => el('tr', {}, el('td', {}, el('kbd', {}, a)), el('td', {}, b));
    modal('使い方', el('div', { class: 'help' },
      el('h4', {}, 'リプレイ'),
      el('p', {}, '上の「リプレイ」を押してチャート上の足をクリックすると、その時点からトレードを始められます（日付指定・ランダムも可）。1分足を元に、上位足でも足の中の値動きを時間どおりに再現します。週末などデータのない時間は飛ばします。'),
      el('h4', {}, '取引'),
      el('p', {}, '右の注文パネル、またはチャートを右クリックして指値・逆指値を置けます。チャート上のポジション・注文・損切り・利確のラインはドラッグで動かせ、× で決済・取消できます。ポジションのラインを利益側にドラッグすると利確、損失側にドラッグすると損切りを置けます。'),
      el('h4', {}, 'ストラテジー'),
      el('p', {}, 'ストラテジーテスターでプリセットや自作のストラテジーを選ぶと、チャート上の確定足でバックテストします（リプレイが進むと結果も伸びます）。「自動売買」を ON にすると、リプレイ中に別の口座で実際に売買し、手動の成績と比べられます。'),
      el('h4', {}, 'ショートカット'),
      el('table', { class: 'keys' },
        k('Shift+↓ / Space', '再生・一時停止'), k('Shift+→', '1本進める'), k('Shift+B / Shift+S', '成行で買い / 売り'),
        k('Alt+T / Alt+H / Alt+J / Alt+V', 'トレンドライン / 水平線 / 水平レイ / 垂直線'), k('Alt+F / Alt+Shift+R', 'フィボナッチ / 長方形'),
        k('Shift+ドラッグ', '計測'), k('Delete', '選択中の描画を削除'), k('Esc', 'ツール・選択の解除'), k('Alt+R', 'チャートをリセット'),
        k('数字 + Enter', '時間足の切り替え（例: 5 → 5分、1h、4h、D）')),
      el('p', { class: 'muted' }, 'データ: 暗号資産は Binance の公開 API、FX は Dukascopy の過去データ（BID）。チャート: TradingView Lightweight Charts™。これは学習用のデモで、実際のお金は動きません。')), { width: 620 });
  }

  // ---------- キーボード ----------
  bindKeys() {
    let tfBuf = '', tfTimer = null;
    const tfBox = el('div', { class: 'tfbox', hidden: true });
    $('#chartWrap').append(tfBox);
    document.addEventListener('keydown', (e) => {
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || modalOpen()) return;
      const k = e.key.toLowerCase();
      if (e.key === 'Escape') { closeMenu(); this.ov.escape(); tfBuf = ''; tfBox.hidden = true; return; }
      if ((e.shiftKey && e.key === 'ArrowDown') || (e.key === ' ' && !e.shiftKey)) { e.preventDefault(); this.togglePlay(); return; }
      if (e.shiftKey && e.key === 'ArrowRight') { e.preventDefault(); this.stepOne(); return; }
      if (e.shiftKey && !e.altKey && !e.ctrlKey && (k === 'b' || k === 's')) { e.preventDefault(); this.marketOrder(k === 'b' ? 1 : -1, this.ticket.qty()); return; }
      if ((e.key === 'Delete' || e.key === 'Backspace') && this.ov.sel) { this.ov.remove(this.ov.sel); return; }
      if (e.altKey && !e.ctrlKey) {
        const map = { t: 'trend', h: 'hline', j: 'hray', v: 'vline', f: 'fib' };
        const code = e.code.replace('Key', '').toLowerCase();
        if (e.shiftKey && code === 'r') { e.preventDefault(); this.ov.setTool('rect'); return; }
        if (code === 'r') { e.preventDefault(); this.resetChart(); return; }
        if (map[code]) { e.preventDefault(); this.ov.setTool(map[code]); return; }
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (/^[0-9hdwm]$/.test(k) && !e.shiftKey) {
        tfBuf += k; tfBox.hidden = false; tfBox.textContent = tfBuf;
        clearTimeout(tfTimer); tfTimer = setTimeout(() => { tfBuf = ''; tfBox.hidden = true; }, 2500);
        return;
      }
      if (e.key === 'Enter' && tfBuf) {
        const m = tfBuf.match(/^(\d*)([hdwm]?)$/);
        let s = null;
        if (m) { const n = +(m[1] || 1); s = m[2] === 'h' ? n * 3600 : m[2] === 'd' ? 86400 * n : m[2] === 'w' ? 604800 * n : n * 60; }
        tfBuf = ''; tfBox.hidden = true;
        if (TFS.some((t) => t.s === s)) this.setTF(s); else toast('その時間足はありません', 'err');
      }
    });
  }
}

function toHex(c) {
  if (c.startsWith('#')) return c.length === 7 ? c : '#2962ff';
  const m = c.match(/\d+/g);
  return m ? '#' + m.slice(0, 3).map((x) => (+x).toString(16).padStart(2, '0')).join('') : '#2962ff';
}

const app = new App();
window.app = app;
app.init();
