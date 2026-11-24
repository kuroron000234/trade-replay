// 共通ユーティリティ

export const TFS = [
  { s: 60, label: '1分', short: '1m' },
  { s: 180, label: '3分', short: '3m' },
  { s: 300, label: '5分', short: '5m' },
  { s: 900, label: '15分', short: '15m' },
  { s: 1800, label: '30分', short: '30m' },
  { s: 3600, label: '1時間', short: '1H' },
  { s: 7200, label: '2時間', short: '2H' },
  { s: 14400, label: '4時間', short: '4H' },
  { s: 86400, label: '日足', short: 'D' },
  { s: 604800, label: '週足', short: 'W' },
];
export const tfInfo = (s) => TFS.find((t) => t.s === s) || TFS[0];

export const DAY = 86400, WEEK = 604800;
const MONDAY = 4 * DAY; // 1970-01-05 は月曜

// 足の開始時刻にそろえる。off は日足以上の区切りのずれ（FX は 22:00 UTC 始まり）
export function alignTF(t, tf, off = 0) {
  if (tf >= WEEK) return Math.floor((t - off - MONDAY) / WEEK) * WEEK + off + MONDAY;
  if (tf >= 14400) return Math.floor((t - off) / tf) * tf + off;
  return Math.floor(t / tf) * tf;
}

// 表示用タイムゾーン（秒）
export const TZ = { offset: 9 * 3600, name: 'JST' };
export const ct = (t) => t + TZ.offset;

export function fmtTime(t, withSec = false) {
  const d = new Date((t + TZ.offset) * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}${withSec ? ':' + p(d.getUTCSeconds()) : ''}`;
}
export function fmtDateInput(t) {
  const d = new Date((t + TZ.offset) * 1000);
  return d.toISOString().slice(0, 16);
}
export function parseDateInput(s) {
  return Math.floor(Date.parse(s + 'Z') / 1000) - TZ.offset;
}
export function fmtDur(sec) {
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / DAY), h = Math.floor((sec % DAY) / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = (n) => String(n).padStart(2, '0');
  if (d) return `${d}日 ${p(h)}:${p(m)}`;
  if (h) return `${p(h)}:${p(m)}:${p(s)}`;
  return `${p(m)}:${p(s)}`;
}

export function fmtNum(v, digits = 2) {
  if (v == null || !isFinite(v)) return '—';
  return v.toLocaleString('ja-JP', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
export function fmtSigned(v, digits = 2) {
  if (v == null || !isFinite(v)) return '—';
  return (v > 0 ? '+' : '') + fmtNum(v, digits);
}
export function fmtCompact(v) {
  if (v == null || !isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (v / 1e3).toFixed(2) + 'K';
  return v.toFixed(a < 10 ? 2 : 0);
}

// t 以下で最大の index（なければ -1）
export function lowerIdx(arr, t, key = 't') {
  let lo = 0, hi = arr.length - 1, r = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (arr[m][key] <= t) { r = m; lo = m + 1; } else hi = m - 1;
  }
  return r;
}

export const store = {
  get(k, def) {
    try { const v = localStorage.getItem('tr.' + k); return v == null ? def : JSON.parse(v); } catch { return def; }
  },
  set(k, v) {
    try { localStorage.setItem('tr.' + k, JSON.stringify(v)); } catch { /* 保存できない環境 */ }
  },
};

export function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'html') e.innerHTML = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
}
export const $ = (s, r = document) => r.querySelector(s);

export class Emitter {
  constructor() { this._h = {}; }
  on(ev, f) { (this._h[ev] ||= []).push(f); return () => this.off(ev, f); }
  off(ev, f) { this._h[ev] = (this._h[ev] || []).filter((x) => x !== f); }
  emit(ev, ...a) { for (const f of this._h[ev] || []) f(...a); }
}

export function toast(msg, kind = 'info', ms = 2600) {
  let box = document.getElementById('toasts');
  if (!box) { box = el('div', { id: 'toasts' }); document.body.append(box); }
  const t = el('div', { class: 'toast ' + kind }, msg);
  box.append(t);
  setTimeout(() => t.classList.add('out'), ms);
  setTimeout(() => t.remove(), ms + 400);
}

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const uid = () => Math.random().toString(36).slice(2, 10);
