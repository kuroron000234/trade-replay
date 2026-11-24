// 汎用 UI: モーダル・メニュー・入力フォーム
import { el } from './util.js';

let openModal = null;
export function modal(title, body, { buttons = [], width = 420, onClose, cls = '' } = {}) {
  closeModal();
  const close = () => { back.remove(); document.removeEventListener('keydown', key, true); if (openModal === api) openModal = null; onClose?.(); };
  const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const box = el('div', { class: 'modal ' + cls, style: { width: width + 'px' } },
    el('div', { class: 'modal-head' }, el('span', {}, title), el('button', { class: 'x', onclick: close, title: '閉じる' }, '×')),
    el('div', { class: 'modal-body' }, body),
    buttons.length ? el('div', { class: 'modal-foot' }, ...buttons.map((b) => el('button', { class: 'btn ' + (b.primary ? 'primary' : ''), onclick: () => { if (b.onclick?.() !== false) close(); } }, b.label))) : null);
  const back = el('div', { class: 'modal-back', onmousedown: (e) => { if (e.target === back) close(); } }, box);
  document.body.append(back);
  document.addEventListener('keydown', key, true);
  const api = { close, box };
  openModal = api;
  setTimeout(() => box.querySelector('input:not([type=checkbox]),select,textarea')?.focus(), 30);
  return api;
}
export function closeModal() { openModal?.close(); }
export const modalOpen = () => !!openModal;

let openMenu = null;
export function menu(x, y, items) {
  closeMenu();
  const m = el('div', { class: 'menu' });
  for (const it of items) {
    if (it === '-') { m.append(el('div', { class: 'menu-sep' })); continue; }
    if (it.header) { m.append(el('div', { class: 'menu-head' }, it.header)); continue; }
    m.append(el('div', { class: 'menu-item' + (it.active ? ' active' : '') + (it.disabled ? ' disabled' : ''), onclick: () => { if (it.disabled) return; closeMenu(); it.onclick?.(); } },
      el('span', { class: 'mi-icon', html: it.icon || '' }), el('span', { class: 'mi-label' }, it.label), it.hint ? el('span', { class: 'mi-hint' }, it.hint) : null));
  }
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 6) + 'px';
  m.style.top = Math.min(y, innerHeight - r.height - 6) + 'px';
  openMenu = m;
  setTimeout(() => document.addEventListener('mousedown', outside, true), 0);
  return m;
}
function outside(e) { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }
export function closeMenu() { openMenu?.remove(); openMenu = null; document.removeEventListener('mousedown', outside, true); }

// 入力フォーム: fields [{k,label,type:'number'|'select'|'color'|'checkbox'|'text', value, step, opts:[[v,label]] , hint}]
export function form(fields) {
  const vals = {};
  const rows = fields.map((f) => {
    if (f.section) return el('div', { class: 'form-sec' }, f.section);
    let inp;
    if (f.type === 'select') inp = el('select', {}, ...f.opts.map(([v, l]) => el('option', { value: v, selected: String(v) === String(f.value) }, l)));
    else if (f.type === 'checkbox') inp = el('input', { type: 'checkbox', checked: !!f.value });
    else if (f.type === 'color') inp = el('input', { type: 'color', value: f.value });
    else inp = el('input', { type: f.type || 'number', value: f.value, step: f.step ?? 'any', min: f.min });
    vals[f.k] = () => (f.type === 'checkbox' ? inp.checked : f.type === 'number' || f.type == null ? (inp.value === '' ? null : +inp.value) : f.type === 'select' && typeof f.value === 'number' ? +inp.value : inp.value);
    return el('label', { class: 'form-row' }, el('span', {}, f.label), inp, f.hint ? el('small', {}, f.hint) : null);
  });
  const root = el('div', { class: 'form' }, ...rows);
  root.values = () => Object.fromEntries(Object.entries(vals).map(([k, g]) => [k, g()]));
  return root;
}

export function tabs(names, onSelect, active = 0) {
  const bar = el('div', { class: 'tabs' });
  const btns = names.map((n, i) => el('button', { class: 'tab' + (i === active ? ' on' : ''), onclick: () => select(i) }, n));
  function select(i) { btns.forEach((b, k) => b.classList.toggle('on', k === i)); onSelect(i); }
  bar.append(...btns);
  bar.select = select;
  return bar;
}

export const SVG = {
  cursor: '<svg viewBox="0 0 28 28" width="28" height="28"><path fill="none" stroke="currentColor" d="M14 4v8M14 16v8M4 14h8M16 14h8"/></svg>',
  trend: '<svg viewBox="0 0 28 28" width="28" height="28"><path stroke="currentColor" d="M6 22 22 6"/><circle cx="6" cy="22" r="2" fill="none" stroke="currentColor"/><circle cx="22" cy="6" r="2" fill="none" stroke="currentColor"/></svg>',
  ray: '<svg viewBox="0 0 28 28" width="28" height="28"><path stroke="currentColor" d="M6 20 26 8"/><circle cx="6" cy="20" r="2" fill="none" stroke="currentColor"/><circle cx="14" cy="15.2" r="2" fill="none" stroke="currentColor"/></svg>',
  hline: '<svg viewBox="0 0 28 28" width="28" height="28"><path stroke="currentColor" d="M3 14h22"/><circle cx="14" cy="14" r="2" fill="#131722" stroke="currentColor"/></svg>',
  hray: '<svg viewBox="0 0 28 28" width="28" height="28"><path stroke="currentColor" d="M8 14h18"/><circle cx="8" cy="14" r="2" fill="none" stroke="currentColor"/></svg>',
  vline: '<svg viewBox="0 0 28 28" width="28" height="28"><path stroke="currentColor" d="M14 3v22"/><circle cx="14" cy="14" r="2" fill="#131722" stroke="currentColor"/></svg>',
  rect: '<svg viewBox="0 0 28 28" width="28" height="28"><rect x="6" y="8" width="16" height="12" fill="none" stroke="currentColor"/></svg>',
  fib: '<svg viewBox="0 0 28 28" width="28" height="28"><path stroke="currentColor" d="M4 6h20M4 11h20M4 15h20M4 22h20"/></svg>',
  long: '<svg viewBox="0 0 28 28" width="28" height="28"><rect x="6" y="5" width="16" height="9" fill="rgba(8,153,129,.35)" stroke="#089981"/><rect x="6" y="14" width="16" height="7" fill="rgba(242,54,69,.3)" stroke="#f23645"/></svg>',
  short: '<svg viewBox="0 0 28 28" width="28" height="28"><rect x="6" y="7" width="16" height="7" fill="rgba(242,54,69,.3)" stroke="#f23645"/><rect x="6" y="14" width="16" height="9" fill="rgba(8,153,129,.35)" stroke="#089981"/></svg>',
  measure: '<svg viewBox="0 0 28 28" width="28" height="28"><path fill="none" stroke="currentColor" d="M5 21 21 5l2 2L7 23zM9 17l2 2M12 14l2 2M15 11l2 2"/></svg>',
  magnet: '<svg viewBox="0 0 28 28" width="28" height="28"><path fill="none" stroke="currentColor" d="M8 6v9a6 6 0 0 0 12 0V6h-4v9a2 2 0 0 1-4 0V6z"/></svg>',
  eye: '<svg viewBox="0 0 28 28" width="28" height="28"><path fill="none" stroke="currentColor" d="M4 14s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"/><circle cx="14" cy="14" r="3" fill="none" stroke="currentColor"/></svg>',
  trash: '<svg viewBox="0 0 28 28" width="28" height="28"><path fill="none" stroke="currentColor" d="M7 9h14M11 9V6h6v3M9 9l1 13h8l1-13"/></svg>',
  play: '<svg viewBox="0 0 20 20" width="18" height="18"><path fill="currentColor" d="M6 4l10 6-10 6z"/></svg>',
  pause: '<svg viewBox="0 0 20 20" width="18" height="18"><path fill="currentColor" d="M5 4h3.5v12H5zM11.5 4H15v12h-3.5z"/></svg>',
  step: '<svg viewBox="0 0 20 20" width="18" height="18"><path fill="currentColor" d="M4 4l8 6-8 6zM13 4h2.5v12H13z"/></svg>',
  replay: '<svg viewBox="0 0 20 20" width="18" height="18"><path fill="none" stroke="currentColor" stroke-width="1.5" d="M4 10a6 6 0 1 0 2-4.5"/><path fill="currentColor" d="M3 3v5h5z"/></svg>',
  fx: '<svg viewBox="0 0 20 20" width="18" height="18"><path fill="none" stroke="currentColor" stroke-width="1.4" d="M3 14c3 0 3-9 6-9M5 9h4M11 8l5 7M16 8l-5 7"/></svg>',
  strat: '<svg viewBox="0 0 20 20" width="18" height="18"><path fill="none" stroke="currentColor" stroke-width="1.4" d="M3 16 8 10l3 3 6-8M13 5h4v4"/></svg>',
  gear: '<svg viewBox="0 0 20 20" width="18" height="18"><circle cx="10" cy="10" r="2.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path fill="none" stroke="currentColor" stroke-width="1.3" d="M10 2v2.4M10 15.6V18M2 10h2.4M15.6 10H18M4.3 4.3 6 6M14 14l1.7 1.7M4.3 15.7 6 14M14 6l1.7-1.7"/></svg>',
  search: '<svg viewBox="0 0 20 20" width="18" height="18"><circle cx="8.5" cy="8.5" r="5" fill="none" stroke="currentColor" stroke-width="1.5"/><path stroke="currentColor" stroke-width="1.5" d="m12.5 12.5 4 4"/></svg>',
  candle: '<svg viewBox="0 0 20 20" width="18" height="18"><path stroke="currentColor" d="M6 3v14M14 3v14"/><rect x="4" y="6" width="4" height="7" fill="currentColor"/><rect x="12" y="8" width="4" height="5" fill="none" stroke="currentColor"/></svg>',
  help: '<svg viewBox="0 0 20 20" width="18" height="18"><circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path fill="none" stroke="currentColor" stroke-width="1.4" d="M7.8 7.8a2.3 2.3 0 1 1 3.2 2.1c-.7.3-1 .8-1 1.5v.6"/><circle cx="10" cy="14.3" r=".9" fill="currentColor"/></svg>',
  stop: '<svg viewBox="0 0 20 20" width="18" height="18"><rect x="5" y="5" width="10" height="10" fill="currentColor"/></svg>',
  dice: '<svg viewBox="0 0 20 20" width="18" height="18"><rect x="3" y="3" width="14" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="7" cy="7" r="1.2" fill="currentColor"/><circle cx="13" cy="13" r="1.2" fill="currentColor"/><circle cx="10" cy="10" r="1.2" fill="currentColor"/></svg>',
  cal: '<svg viewBox="0 0 20 20" width="18" height="18"><rect x="3" y="4.5" width="14" height="12" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path stroke="currentColor" stroke-width="1.3" d="M3 8.5h14M7 3v3M13 3v3"/></svg>',
  realtime: '<svg viewBox="0 0 20 20" width="16" height="16"><path fill="none" stroke="currentColor" stroke-width="1.6" d="m5 5 5 5-5 5M11 5l5 5-5 5"/></svg>',
};
