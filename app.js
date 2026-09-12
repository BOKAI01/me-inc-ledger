import { html, render, useState, useEffect, useMemo, useCallback, useRef } from './vendor.js';

/* ============================================================
   Me, Inc. 個人營運帳本
   v2 — 無 CDN 依賴、期間制、防重複
   ============================================================ */

const K_API    = 'meinc_api_url';
const K_QUEUE  = 'meinc_offline_queue';
const K_CACHE  = 'meinc_data_cache';
const K_CYCLE  = 'meinc_cycle_day';   // 僅作離線快取，真值存於 Google Sheet

const INCOME_CATS = [
  { id: 'salary',     name: '主要薪資',   emoji: '💼' },
  { id: 'side',       name: '副業 / 兼職', emoji: '💻' },
  { id: 'investment', name: '投資收益',   emoji: '📈' },
  { id: 'bonus',      name: '獎金 / 紅利', emoji: '🎁' },
  { id: 'other_in',   name: '其他收入',   emoji: '📦' },
];

const DEPARTMENTS = [
  { id: 'food',      name: '食',   fullName: '食 · 餐飲部',   emoji: '🍱', color: '#D97B3E', desc: '三餐、咖啡飲料、聚餐、買菜、零食' },
  { id: 'cloth',     name: '衣',   fullName: '衣 · 形象部',   emoji: '👔', color: '#A87B3D', desc: '服飾、鞋包、美容美髮' },
  { id: 'housing',   name: '住',   fullName: '住 · 後勤部',   emoji: '🏠', color: '#1F3A2E', desc: '房租、水電、網路、家具、日用品' },
  { id: 'transport', name: '行',   fullName: '行 · 移動部',   emoji: '🚗', color: '#5B8C5A', desc: '大眾運輸、油錢、計程車、停車、保養' },
  { id: 'leisure',   name: '娛',   fullName: '娛 · 文化部',   emoji: '🎬', color: '#7A5A9F', desc: '訂閱、電影、旅遊、運動、興趣' },
  { id: 'other_out', name: '其他', fullName: '其他 · 雜項部', emoji: '📂', color: '#888888', desc: '貸款、卡費、醫療、人情禮金、稅務' },
];

const findDept   = (id) => DEPARTMENTS.find(d => d.id === id) || DEPARTMENTS[5];
const findIncome = (id) => INCOME_CATS.find(c => c.id === id) || INCOME_CATS[4];

/* ---------- 格式 ---------- */
const fmt = (n) => new Intl.NumberFormat('zh-TW').format(Math.round(Number(n) || 0));
const fmtK = (n) => {
  const v = Math.round(Number(n) || 0);
  if (Math.abs(v) >= 10000) return (v / 10000).toFixed(1) + '萬';
  if (Math.abs(v) >= 1000)  return (v / 1000).toFixed(0) + 'k';
  return String(v);
};
const pad = (n) => String(n).padStart(2, '0');
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const ymOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const isOnline = () => navigator.onLine !== false;

/* ---------- 期間（以「起始月」命名）----------
   cycleDay = 5 → periodKey '2026-07' 代表 7/5 – 8/4
   cycleDay = 1 → periodKey '2026-07' 代表 7/1 – 7/31
------------------------------------------------ */
function getCurrentPeriod(cycleDay) {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth() + 1, d = now.getDate();
  if (cycleDay === 1 || d >= cycleDay) return `${y}-${pad(m)}`;
  return ymOf(new Date(y, m - 2, 1));
}
function getPeriodRange(periodKey, cycleDay) {
  const [y, m] = periodKey.split('-').map(Number);
  if (cycleDay === 1) {
    return { start: new Date(y, m - 1, 1, 0, 0, 0), end: new Date(y, m, 0, 23, 59, 59) };
  }
  return { start: new Date(y, m - 1, cycleDay, 0, 0, 0), end: new Date(y, m, cycleDay - 1, 23, 59, 59) };
}
function getPeriodLabel(periodKey, cycleDay) {
  const { start, end } = getPeriodRange(periodKey, cycleDay);
  if (cycleDay === 1) return `${start.getFullYear()}/${start.getMonth() + 1}`;
  return `${start.getMonth() + 1}/${start.getDate()}–${end.getMonth() + 1}/${end.getDate()}`;
}
function getPeriodLabelFull(periodKey, cycleDay) {
  const { start, end } = getPeriodRange(periodKey, cycleDay);
  if (cycleDay === 1) return `${start.getFullYear()} 年 ${start.getMonth() + 1} 月（${start.getMonth() + 1}/1–${end.getMonth() + 1}/${end.getDate()}）`;
  return `${start.getFullYear()}/${start.getMonth() + 1}/${start.getDate()} – ${end.getFullYear()}/${end.getMonth() + 1}/${end.getDate()}`;
}
function shiftPeriod(periodKey, delta) {
  const [y, m] = periodKey.split('-').map(Number);
  return ymOf(new Date(y, m - 1 + delta, 1));
}
/** 交易日期 → 本地 Date（只取 yyyy-MM-dd，避免 UTC 位移） */
function txDate(tx) {
  if (!tx || !tx.date) return null;
  const s = String(tx.date).slice(0, 10);
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d, 12, 0, 0);
}
function isInPeriod(tx, periodKey, cycleDay) {
  const td = txDate(tx);
  if (!td) return false;
  const { start, end } = getPeriodRange(periodKey, cycleDay);
  return td >= start && td <= end;
}

/* ---------- API ---------- */
const callApi = async (url, action, payload = {}) => {
  if (!url) throw new Error('尚未設定 API 網址');
  const fd = new FormData();
  fd.append('payload', JSON.stringify({ action, ...payload }));
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(url, { method: 'POST', body: fd, redirect: 'follow', signal: ctl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    if (!json.ok) throw new Error(json.error || '未知錯誤');
    return json.data;
  } finally { clearTimeout(timer); }
};
const api = (action, payload = {}) => callApi(localStorage.getItem(K_API), action, payload);

/* ---------- 離線佇列（單線同步，避免重複送出）---------- */
const getQueue = () => { try { return JSON.parse(localStorage.getItem(K_QUEUE) || '[]'); } catch { return []; } };
const setQueue = (q) => localStorage.setItem(K_QUEUE, JSON.stringify(q));
const queueOp  = (op) => { const q = getQueue(); q.push({ ...op, ts: Date.now() }); setQueue(q); };

let flushing = null;
const flushQueue = () => {
  if (flushing) return flushing;              // 同時只允許一次沖銷
  flushing = (async () => {
    const q = getQueue();
    if (!q.length) return { synced: 0, failed: 0 };
    const rest = []; let synced = 0;
    for (const op of q) {
      try { await api(op.action, op.payload); synced++; }
      catch (e) { rest.push(op); }
    }
    setQueue(rest);
    return { synced, failed: rest.length };
  })().finally(() => { flushing = null; });
  return flushing;
};

/* ---------- Service Worker ---------- */
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

/* ---------- 圖示 ---------- */
const ic = (paths, s = 16, sw = 2) => html`
  <svg viewBox="0 0 24 24" width=${s} height=${s} fill="none" stroke="currentColor"
       stroke-width=${sw} stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const IPlus  = (s = 24) => ic(html`<path d="M5 12h14"/><path d="M12 5v14"/>`, s, 2.5);
const ITrash = (s = 16) => ic(html`<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>`, s);
const IX     = (s = 20) => ic(html`<path d="M18 6 6 18"/><path d="m6 6 12 12"/>`, s);
const ILeft  = (s = 18) => ic(html`<polyline points="15 18 9 12 15 6"/>`, s);
const IRight = (s = 18) => ic(html`<polyline points="9 18 15 12 9 6"/>`, s);
const IDown  = (s = 13) => ic(html`<polyline points="6 9 12 15 18 9"/>`, s);
const IRef   = (s = 16) => ic(html`<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M3 21v-5h5"/>`, s);
const ICog   = (s = 16) => ic(html`<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>`, s);
const ICloudOff = (s = 15) => ic(html`<line x1="2" y1="2" x2="22" y2="22"/><path d="M5.78 5.78A7 7 0 0 0 9 19h8.5"/><path d="M10.93 5.09A7 7 0 0 1 22 12a7 7 0 0 1-.5 2.59"/>`, s);
const IBag   = (s = 16) => ic(html`<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/>`, s);
const IUp    = (s = 12) => ic(html`<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>`, s);
const IDn    = (s = 12) => ic(html`<polyline points="22 17 13.5 8.5 8.5 13.5 2 7"/><polyline points="16 17 22 17 22 11"/>`, s);
const IFlame = (s = 14) => ic(html`<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>`, s);
const IChart = (s = 14) => ic(html`<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>`, s);
const ICal   = (s = 14) => ic(html`<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>`, s);

/* ============================================================
   設定精靈
   ============================================================ */
function SetupScreen({ onSaved }) {
  const [url, setUrl] = useState('');
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');

  const test = async () => {
    setError(''); setTesting(true);
    try {
      const u = url.trim();
      if (!u.startsWith('https://script.google.com/')) throw new Error('網址格式不正確');
      await callApi(u, 'load');
      localStorage.setItem(K_API, u);
      onSaved(u);
    } catch (e) {
      const msg = String(e.message || e);
      setError(/Failed to fetch|NetworkError|abort/i.test(msg)
        ? '連線失敗。最常見原因：部署存取權必須設為「所有人 Anyone」。'
        : msg);
    } finally { setTesting(false); }
  };

  return html`
    <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px">
      <div class="card" style="max-width:420px;width:100%">
        <div class="card-hd tinted" style="display:block">
          <div class="row" style="gap:6px;margin-bottom:6px;color:var(--ink)">${IBag(15)}<span class="brand">Setup</span></div>
          <div style="font-size:19px;font-weight:700;color:var(--ink)">歡迎來到 Me, Inc.</div>
          <div class="sub" style="margin-top:2px">連結你的 Google Sheet 後台</div>
        </div>
        <div class="card-bd" style="display:flex;flex-direction:column;gap:14px">
          <ol class="note" style="padding-left:18px;margin:0">
            <li>建立 Google 試算表 → 擴充功能 → Apps Script</li>
            <li>貼上 <code>google-apps-script.gs</code> 並儲存</li>
            <li>部署 → 網頁應用程式 → 存取權「所有人 Anyone」</li>
            <li>複製網址貼到下方</li>
          </ol>
          <input class="inp mono" type="text" value=${url} onInput=${e => setUrl(e.target.value)}
                 placeholder="https://script.google.com/macros/s/.../exec" style="font-size:12px" />
          ${error && html`<div class="err">${error}</div>`}
          <button class="btn btn-p" disabled=${testing || !url.trim()} onClick=${test}>
            ${testing ? '測試連線中⋯' : '開始營運'}
          </button>
        </div>
      </div>
    </div>`;
}

/* ============================================================
   期間選擇器
   ============================================================ */
function PeriodPicker({ value, onChange, onClose, cycleDay }) {
  const [y, m] = value.split('-').map(Number);
  const [year, setYear] = useState(y);
  const curKey = getCurrentPeriod(cycleDay);
  const [curY, curM] = curKey.split('-').map(Number);

  return html`
    <div class="mask" onClick=${onClose}>
      <div class="sheet" onClick=${e => e.stopPropagation()}>
        <div class="grab"></div>
        <div class="between" style="padding:8px 16px;border-bottom:1px solid var(--line-2)">
          <button class="iconbtn" onClick=${() => setYear(year - 1)}>${ILeft(20)}</button>
          <div class="mono" style="font-size:17px;font-weight:700;color:var(--ink)">${year} 年</div>
          <button class="iconbtn" onClick=${() => setYear(year + 1)} disabled=${year >= curY + 5}
                  style=${{ opacity: year >= curY + 5 ? .3 : 1 }}>${IRight(20)}</button>
        </div>
        <div style="padding:16px;display:grid;grid-template-columns:1fr 1fr;gap:8px">
          ${Array.from({ length: 12 }, (_, i) => i + 1).map(mm => {
            const key = `${year}-${pad(mm)}`;
            const sel = year === y && mm === m;
            const cur = year === curY && mm === curM;
            const future = year > curY || (year === curY && mm > curM);
            return html`
              <button key=${mm} disabled=${future} onClick=${() => { onChange(key); onClose(); }}
                class="mono"
                style=${{
                  padding: '12px 4px', borderRadius: '3px', fontSize: '13px', fontWeight: 600,
                  background: sel ? '#1F3A2E' : 'transparent',
                  color: sel ? '#fff' : (future ? '#D6D3CA' : '#3F3B35'),
                  border: `${cur && !sel ? 2 : 1}px solid ${sel ? '#1F3A2E' : (cur ? '#A87B3D' : '#E7E2D6')}`,
                }}>
                ${getPeriodLabel(key, cycleDay)}
              </button>`;
          })}
        </div>
        <div class="sheet-ft">
          <button class="btn btn-g" onClick=${() => { onChange(curKey); onClose(); }}>回到本期</button>
          <button class="btn btn-g" onClick=${onClose}>關閉</button>
        </div>
      </div>
    </div>`;
}

/* ============================================================
   圖表
   ============================================================ */
function AssetTrendChart({ history }) {
  if (history.length < 2) return null;
  const W = 320, H = 160, PL = 38, PR = 12, PT = 16, PB = 28;
  const values = history.map(h => h.endingCash);
  let max = Math.max(...values), min = Math.min(...values);
  if (max === min) { max += 1000; min -= 1000; }
  const r0 = max - min; max += r0 * 0.1; min -= r0 * 0.1;
  const rng = max - min;
  const sx = (i) => PL + (i / (history.length - 1)) * (W - PL - PR);
  const sy = (v) => PT + (1 - (v - min) / rng) * (H - PT - PB);
  const pts = history.map((h, i) => ({ x: sx(i), y: sy(h.endingCash), val: h.endingCash, key: h.period }));
  const path = pts.map((p, i) => `${i ? 'L' : 'M'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const area = `${path} L ${pts[pts.length - 1].x.toFixed(1)} ${H - PB} L ${PL} ${H - PB} Z`;
  const change = values[values.length - 1] - values[0];
  const pct = values[0] !== 0 ? (change / Math.abs(values[0])) * 100 : 0;
  const up = change >= 0;
  let drop = null;
  for (let i = 1; i < history.length; i++) {
    const d = history[i].endingCash - history[i - 1].endingCash;
    if (d < 0 && (!drop || d < drop.d)) drop = { i, d, label: history[i].label };
  }
  return html`
    <section class="card">
      <div class="card-hd">
        <div class="row" style="gap:6px;color:var(--ink)">${IChart()}<span class="eyebrow">資產走勢</span></div>
        <div class="row" style="gap:6px">
          <span class="mono" style=${{ fontSize: '12px', color: up ? '#15803d' : '#b91c1c' }}>${up ? '↑' : '↓'} ${Math.abs(pct).toFixed(1)}%</span>
          <span class="sub">近 ${history.length} 期</span>
        </div>
      </div>
      <div style="padding:14px 10px">
        <svg viewBox=${`0 0 ${W} ${H}`} style="width:100%;height:auto" preserveAspectRatio="xMidYMid meet">
          ${[0, .5, 1].map(t => {
            const v = min + (1 - t) * rng, yy = PT + t * (H - PT - PB);
            return html`<g><line x1=${PL} y1=${yy} x2=${W - PR} y2=${yy} stroke="#EFEBE1" stroke-width="1"/>
              <text x=${PL - 5} y=${yy + 3} text-anchor="end" font-size="9" fill="#A8A29E">${fmtK(v)}</text></g>`;
          })}
          <path d=${area} fill="#1F3A2E" fill-opacity="0.08"/>
          <path d=${path} fill="none" stroke="#1F3A2E" stroke-width="2"/>
          ${pts.map((p, i) => {
            const show = history.length <= 6 || i % Math.ceil(history.length / 6) === 0 || i === history.length - 1;
            const last = i === pts.length - 1, isDrop = drop && drop.i === i;
            return html`<g>
              ${show && html`<text x=${p.x} y=${H - 10} text-anchor="middle" font-size="8" fill="#A8A29E">${history[i].label}</text>`}
              <circle cx=${p.x} cy=${p.y} r=${last ? 4 : isDrop ? 3.5 : 2.5} fill=${isDrop ? '#A0421C' : '#1F3A2E'} stroke="#fff" stroke-width="1.5"/>
              ${last && html`<text x=${p.x} y=${p.y - 9} text-anchor="middle" font-size="10" font-weight="bold" fill="#1F3A2E">${fmtK(p.val)}</text>`}
            </g>`;
          })}
        </svg>
      </div>
      <div class="g2" style="padding:12px 20px;border-top:1px solid var(--line)">
        <div><span class="sub">期間變動</span>
          <div class="mono" style=${{ fontSize: '13px', fontWeight: 600, color: up ? '#15803d' : '#b91c1c' }}>${up ? '+' : '−'}$${fmt(Math.abs(change))}</div></div>
        <div><span class="sub">最大單期跌幅</span>
          ${drop
            ? html`<div class="mono" style="font-size:13px;font-weight:600;color:#b91c1c">${drop.label} · −$${fmt(Math.abs(drop.d))}</div>`
            : html`<div class="sub">無下跌週期 🎉</div>`}</div>
      </div>
    </section>`;
}

function PLBarChart({ history }) {
  if (history.length < 2) return null;
  const W = 320, H = 150, PL = 34, PR = 12, PT = 14, PB = 26;
  const absMax = Math.max(...history.map(h => Math.abs(h.netProfit)), 100);
  const yMid = PT + (H - PT - PB) / 2;
  const gw = (W - PL - PR) / history.length;
  const bw = Math.min(22, gw * 0.6);
  return html`
    <section class="card">
      <div class="card-hd">
        <div class="row" style="gap:6px;color:var(--ink)">${IBag(14)}<span class="eyebrow">期間損益</span></div>
        <span class="sub">淨利 = 收入 − 支出</span>
      </div>
      <div style="padding:14px 10px">
        <svg viewBox=${`0 0 ${W} ${H}`} style="width:100%;height:auto" preserveAspectRatio="xMidYMid meet">
          <line x1=${PL} y1=${yMid} x2=${W - PR} y2=${yMid} stroke="#E7E2D6"/>
          <text x=${PL - 4} y=${yMid + 3} text-anchor="end" font-size="9" fill="#A8A29E">0</text>
          <text x=${PL - 4} y=${PT + 8} text-anchor="end" font-size="9" fill="#A8A29E">+${fmtK(absMax)}</text>
          <text x=${PL - 4} y=${H - PB + 3} text-anchor="end" font-size="9" fill="#A8A29E">−${fmtK(absMax)}</text>
          ${history.map((h, i) => {
            const cx = PL + gw * (i + 0.5);
            const bh = (Math.abs(h.netProfit) / absMax) * ((H - PT - PB) / 2);
            const pos = h.netProfit >= 0;
            const show = history.length <= 6 || i % Math.ceil(history.length / 6) === 0 || i === history.length - 1;
            return html`<g>
              <rect x=${cx - bw / 2} y=${pos ? yMid - bh : yMid} width=${bw} height=${Math.max(bh, 1)}
                    fill=${pos ? '#1F3A2E' : '#A0421C'} rx="1" opacity="0.85"/>
              ${show && html`<text x=${cx} y=${H - 9} text-anchor="middle" font-size="8" fill="#A8A29E">${h.label}</text>`}
            </g>`;
          })}
        </svg>
      </div>
    </section>`;
}

/* ============================================================
   記錄表單
   ============================================================ */
function EntryForm({ initial, onClose, onSave, onDelete }) {
  const [type, setType] = useState(initial?.type || 'outflow');
  const [category, setCategory] = useState(initial?.category || (initial?.type === 'inflow' ? 'salary' : 'food'));
  const [date, setDate] = useState((initial?.date || todayStr()).slice(0, 10));
  const [amount, setAmount] = useState(initial ? String(initial.amount) : '');
  const [client, setClient] = useState(initial?.client || '');
  const [description, setDescription] = useState(initial?.description || '');
  const [busy, setBusy] = useState(false);          // ← 防連點重複送出
  const busyRef = useRef(false);                    // 同一個 tick 內也擋得住
  const cats = type === 'inflow' ? INCOME_CATS : DEPARTMENTS;
  const isEdit = !!initial;

  const submit = () => {
    if (busyRef.current) return;
    const amt = parseFloat(amount);
    if (!amount || isNaN(amt)) { alert('請填寫金額'); return; }
    busyRef.current = true; setBusy(true);
    onSave({ type, category, date, amount: amt, client: client.trim(), description: description.trim() });
  };

  return html`
    <div class="mask" onClick=${onClose}>
      <div class="sheet" onClick=${e => e.stopPropagation()}>
        <div class="grab"></div>
        <div class="sheet-hd">
          <h3>${isEdit ? '編輯記錄' : '新增記錄'}</h3>
          <button class="iconbtn" onClick=${onClose} style="color:var(--t3)">${IX()}</button>
        </div>
        <div class="sheet-bd">
          <div class="g2" style="gap:8px">
            <button class=${'seg' + (type === 'outflow' ? ' on' : '')}
              style=${type === 'outflow' ? { background: '#A0421C' } : {}}
              onClick=${() => { setType('outflow'); setCategory('food'); }}>支出 Expense</button>
            <button class=${'seg' + (type === 'inflow' ? ' on' : '')}
              style=${type === 'inflow' ? { background: '#1F3A2E' } : {}}
              onClick=${() => { setType('inflow'); setCategory('salary'); }}>收入 Revenue</button>
          </div>
          <div>
            <div class="lbl" style="margin-bottom:8px">${type === 'inflow' ? '收入來源' : '部門 Department'}</div>
            <div class="g3">
              ${cats.map(c => html`
                <button key=${c.id} class=${'opt' + (category === c.id ? ' on' : '')}
                  style=${category === c.id ? { background: type === 'inflow' ? '#1F3A2E' : c.color } : {}}
                  onClick=${() => setCategory(c.id)}>
                  <div class="em">${c.emoji}</div><div class="nm">${c.name}</div>
                </button>`)}
            </div>
          </div>
          <div>
            <div class="lbl" style="margin-bottom:8px">金額 (NT$)</div>
            <input class="inp big" type="number" inputmode="decimal" placeholder="0"
                   value=${amount} onInput=${e => setAmount(e.target.value)} />
          </div>
          <div>
            <div class="lbl" style="margin-bottom:8px">日期</div>
            <input class="inp" type="date" value=${date} onInput=${e => setDate(e.target.value)} />
          </div>
          <div>
            <div class="lbl" style="margin-bottom:8px">${type === 'inflow' ? '收入來源（公司／單位）' : '商家 / 對象'}</div>
            <input class="inp" type="text" value=${client} onInput=${e => setClient(e.target.value)}
                   placeholder=${type === 'inflow' ? '例：典試科技、五蘊' : '例：房租、信用卡、全家'} />
          </div>
          <div>
            <div class="lbl" style="margin-bottom:8px">備註（選填）</div>
            <input class="inp" type="text" value=${description} onInput=${e => setDescription(e.target.value)} placeholder="例：午餐便當" />
          </div>
        </div>
        <div class="sheet-ft">
          ${onDelete && html`<button class="btn btn-d" onClick=${onDelete}>${ITrash()}</button>`}
          <button class="btn btn-g" onClick=${onClose}>取消</button>
          <button class="btn btn-p" disabled=${busy} onClick=${submit}>${busy ? '儲存中⋯' : (isEdit ? '儲存修改' : '記一筆')}</button>
        </div>
      </div>
    </div>`;
}

/* ============================================================
   設定
   ============================================================ */
function SettingsSheet({ apiUrl, openingBalance, currentBalance, cycleDay, onChangeCycle, onClose, onReset, onSaveOpening, onDedupe }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(String(openingBalance));
  const [tmp, setTmp] = useState(cycleDay);
  const [dirty, setDirty] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const preview = getPeriodLabelFull(getCurrentPeriod(tmp), tmp);

  return html`
    <div class="mask" onClick=${onClose}>
      <div class="sheet" onClick=${e => e.stopPropagation()}>
        <div class="grab"></div>
        <div class="sheet-hd">
          <h3>設定 · 經營後台</h3>
          <button class="iconbtn" onClick=${onClose} style="color:var(--t3)">${IX()}</button>
        </div>
        <div class="sheet-bd">

          <div class="box box-w">
            <div class="row" style="gap:6px;margin-bottom:6px;color:var(--gold)">
              ${ICal(15)}<span style="font-size:14px;font-weight:700;color:var(--ink-2)">結算週期</span>
            </div>
            <p class="note" style="margin:0 0 12px;color:var(--ink-2)">
              設定每月結算起始日。設 5 → 一期為 5 日至隔月 4 日，全 App 的期間、圖表、燃燒率都依此計算。上期期末自動成為下期期初。
            </p>
            <div class="row" style="gap:8px;margin-bottom:8px">
              <button class="box" style="padding:10px" onClick=${() => { setTmp(Math.max(1, tmp - 1)); setDirty(true); }}>${ILeft()}</button>
              <div class="box" style="flex:1;text-align:center;padding:8px">
                <span class="mono" style="font-size:22px;font-weight:700;color:var(--ink)">${tmp}</span>
                <span class="sub"> 號</span>
              </div>
              <button class="box" style="padding:10px" onClick=${() => { setTmp(Math.min(28, tmp + 1)); setDirty(true); }}>${IRight()}</button>
            </div>
            <div class="note" style="color:var(--ink-2);margin-bottom:10px">目前當期：<strong>${preview}</strong></div>
            ${dirty && html`<button class="btn" style="width:100%;background:#A87B3D;color:#fff"
              onClick=${() => { onChangeCycle(tmp); setDirty(false); }}>套用結算日 ${tmp} 號</button>`}
            <div class="mini">此設定儲存於 Google Sheet，換手機或清除瀏覽器資料都不會遺失</div>
          </div>

          <div>
            <div class="lbl" style="margin-bottom:6px">期初餘額（公司開張資本）</div>
            ${editing
              ? html`<div class="row" style="gap:8px">
                  <input class="inp mono" type="number" inputmode="decimal" value=${val} onInput=${e => setVal(e.target.value)} />
                  <button class="btn btn-p" style="flex:0 0 auto" onClick=${() => { onSaveOpening(parseFloat(val) || 0); setEditing(false); }}>儲存</button>
                </div>`
              : html`<button class="mono" style="font-size:17px;font-weight:600;color:var(--ink)" onClick=${() => setEditing(true)}>
                  $${fmt(openingBalance)} <span class="sub">編輯</span></button>`}
            <div class="mini">只在首次設定，之後系統自動延續</div>
          </div>

          <div>
            <div class="lbl" style="margin-bottom:6px">目前公司現金</div>
            <div class="mono" style=${{ fontSize: '17px', fontWeight: 600, color: currentBalance >= 0 ? '#1F3A2E' : '#A0421C' }}>$${fmt(currentBalance)}</div>
            <div class="mini">期初 + 累計收入 − 累計支出</div>
          </div>

          <div>
            <div class="lbl" style="margin-bottom:6px">資料維護</div>
            <button class="btn btn-g" style="width:100%" disabled=${cleaning}
              onClick=${async () => { setCleaning(true); await onDedupe(); setCleaning(false); }}>
              ${cleaning ? '檢查中⋯' : '掃描並清除重複記錄'}</button>
            <div class="mini">只刪除 id 完全相同的重複列；疑似重複（同日同額）僅提示，不自動刪除</div>
          </div>

          <div>
            <div class="lbl" style="margin-bottom:6px">後台 API 網址</div>
            <div class="code">${apiUrl}</div>
            <button class="btn btn-g" style="width:100%;margin-top:8px" onClick=${onReset}>重新設定 API 網址</button>
          </div>

          <div>
            <div class="lbl" style="margin-bottom:8px">部門說明</div>
            <div style="display:flex;flex-direction:column;gap:8px">
              ${DEPARTMENTS.map(d => html`
                <div key=${d.id} class="row" style="gap:10px;padding:10px;background:#FAFAF8;border-radius:3px">
                  <div style="font-size:19px">${d.emoji}</div>
                  <div>
                    <div style=${{ fontSize: '13px', fontWeight: 600, color: d.color }}>${d.fullName}</div>
                    <div class="sub">${d.desc}</div>
                  </div>
                </div>`)}
            </div>
          </div>
        </div>
      </div>
    </div>`;
}

/* ============================================================
   主程式
   ============================================================ */
function App() {
  const [apiUrl, setApiUrl] = useState(() => localStorage.getItem(K_API));
  const cached = useMemo(() => { try { return JSON.parse(localStorage.getItem(K_CACHE) || 'null'); } catch { return null; } }, []);

  const [transactions, setTransactions] = useState(() => (cached?.transactions) || []);
  const [openingBalance, setOpeningBalance] = useState(() => cached?.openingBalance || 0);
  const [cycleDay, setCycleDay] = useState(() => Number(cached?.cycleDay || localStorage.getItem(K_CYCLE)) || 1);
  const [booted, setBooted] = useState(() => !!cached);     // 有快取 → 立刻顯示畫面
  const [syncing, setSyncing] = useState(false);
  const [online, setOnline] = useState(isOnline());
  const [toast, setToast] = useState(null);
  const [period, setPeriod] = useState(() => getCurrentPeriod(Number(cached?.cycleDay || localStorage.getItem(K_CYCLE)) || 1));
  const [periodTouched, setPeriodTouched] = useState(false);
  const [filter, setFilter] = useState('all');
  const [showForm, setShowForm] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [editingTx, setEditingTx] = useState(null);
  const loadingRef = useRef(null);

  const showToast = useCallback((msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 2600);
  }, []);

  /* 讀取（單線，避免並行造成佇列重複沖銷） */
  const reload = useCallback(async () => {
    if (!apiUrl) return;
    if (loadingRef.current) return loadingRef.current;
    setSyncing(true);
    loadingRef.current = (async () => {
      try {
        if (isOnline() && getQueue().length) {
          const r = await flushQueue();
          if (r.synced) showToast(`已同步 ${r.synced} 筆離線記錄`);
        }
        const data = await api('load');
        const txns = (data.transactions || []).map(t => ({ ...t, date: String(t.date || '').slice(0, 10) }));
        setTransactions(txns);
        setOpeningBalance(Number(data.openingBalance) || 0);
        const cd = Number(data.cycleDay) || 1;
        setCycleDay(cd);
        localStorage.setItem(K_CYCLE, String(cd));
        localStorage.setItem(K_CACHE, JSON.stringify({ transactions: txns, openingBalance: data.openingBalance, cycleDay: cd }));
      } catch (e) {
        if (!isOnline()) showToast('離線中，顯示快取資料', 'info');
        else showToast('連線失敗，顯示快取資料', 'error');
      } finally {
        setSyncing(false); setBooted(true); loadingRef.current = null;
      }
    })();
    return loadingRef.current;
  }, [apiUrl, showToast]);

  useEffect(() => { if (apiUrl) reload(); else setBooted(true); }, [apiUrl, reload]);

  /* 連線狀態 + 回到前景時背景更新 */
  useEffect(() => {
    const on = () => { setOnline(true); reload(); };
    const off = () => setOnline(false);
    const vis = () => { if (document.visibilityState === 'visible') reload(); };
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    document.addEventListener('visibilitychange', vis);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); document.removeEventListener('visibilitychange', vis); };
  }, [reload]);

  /* 結算日改變 → 若使用者沒手動選期間，跳回當期 */
  useEffect(() => {
    if (!periodTouched) setPeriod(getCurrentPeriod(cycleDay));
  }, [cycleDay]);

  /* ---- 期間統計 ---- */
  const periodTx = useMemo(() => transactions.filter(t => isInPeriod(t, period, cycleDay)), [transactions, period, cycleDay]);
  const inc = periodTx.filter(t => t.type === 'inflow').reduce((s, t) => s + Number(t.amount || 0), 0);
  const exp = periodTx.filter(t => t.type === 'outflow').reduce((s, t) => s + Number(t.amount || 0), 0);
  const netProfit = inc - exp;
  const margin = inc > 0 ? (netProfit / inc) * 100 : 0;

  const periodStartCash = useMemo(() => {
    const { start } = getPeriodRange(period, cycleDay);
    let v = openingBalance;
    for (const t of transactions) {
      const td = txDate(t); if (!td || td >= start) continue;
      v += (t.type === 'inflow' ? 1 : -1) * Number(t.amount || 0);
    }
    return v;
  }, [transactions, period, cycleDay, openingBalance]);
  const periodEndCash = periodStartCash + netProfit;

  const deptStats = useMemo(() => DEPARTMENTS.map(d => {
    const txs = periodTx.filter(t => t.type === 'outflow' && t.category === d.id);
    const total = txs.reduce((s, t) => s + Number(t.amount || 0), 0);
    return { ...d, total, count: txs.length, pct: exp > 0 ? (total / exp) * 100 : 0 };
  }).sort((a, b) => b.total - a.total), [periodTx, exp]);

  const totals = useMemo(() => {
    let i = 0, o = 0;
    for (const t of transactions) {
      if (t.type === 'inflow') i += Number(t.amount || 0); else o += Number(t.amount || 0);
    }
    return { i, o };
  }, [transactions]);
  const currentBalance = openingBalance + totals.i - totals.o;

  const history = useMemo(() => {
    const out = [];
    const curK = getCurrentPeriod(cycleDay);
    for (let k = 11; k >= 0; k--) {
      const key = shiftPeriod(curK, -k);
      const { end } = getPeriodRange(key, cycleDay);
      let cash = openingBalance, pi = 0, pe = 0;
      for (const t of transactions) {
        const td = txDate(t); if (!td) continue;
        const amt = Number(t.amount || 0);
        if (td <= end) cash += (t.type === 'inflow' ? 1 : -1) * amt;
        if (isInPeriod(t, key, cycleDay)) { if (t.type === 'inflow') pi += amt; else pe += amt; }
      }
      out.push({ period: key, label: getPeriodLabel(key, cycleDay), endingCash: cash, netProfit: pi - pe });
    }
    const first = out.findIndex(h => h.netProfit !== 0 || h.endingCash !== openingBalance);
    return first > 0 ? out.slice(Math.max(0, first - 1)) : out;
  }, [transactions, cycleDay, openingBalance]);

  const burnRate = useMemo(() => {
    const curK = getCurrentPeriod(cycleDay);
    const arr = [];
    for (let i = 1; i <= 3; i++) {
      const key = shiftPeriod(curK, -i);
      const e = transactions.filter(t => t.type === 'outflow' && isInPeriod(t, key, cycleDay))
                            .reduce((s, t) => s + Number(t.amount || 0), 0);
      if (e > 0) arr.push(e);
    }
    return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0;
  }, [transactions, cycleDay]);
  const runway = burnRate > 0 ? currentBalance / burnRate : Infinity;

  const filteredTx = useMemo(() => periodTx.filter(t => {
    if (filter === 'all') return true;
    if (filter === 'income') return t.type === 'inflow';
    if (filter === 'expense') return t.type === 'outflow';
    return t.type === 'outflow' && t.category === filter;
  }).sort((a, b) => String(b.date).localeCompare(String(a.date))), [periodTx, filter]);

  /* ---- 動作 ---- */
  const handleSave = async (data) => {
    const isEdit = !!editingTx;
    const tx = isEdit
      ? { ...editingTx, ...data }
      : { id: `${Date.now()}${Math.random().toString(36).slice(2, 6)}`, ...data, received: true, paymentTerm: 0, createdAt: new Date().toISOString() };
    setTransactions(prev => isEdit ? prev.map(t => (t.id === tx.id ? tx : t)) : [tx, ...prev]);
    setShowForm(false); setEditingTx(null);
    setSyncing(true);
    const op = isEdit
      ? { action: 'updateTxn', payload: { id: tx.id, fields: { type: tx.type, category: tx.category, date: tx.date, amount: tx.amount, client: tx.client, description: tx.description } } }
      : { action: 'addTxn', payload: { txn: tx } };
    try {
      if (!isOnline()) throw new Error('offline');
      await api(op.action, op.payload);
      showToast('已同步到 Google Sheet');
    } catch (e) {
      queueOp(op);
      showToast(isOnline() ? '暫存到佇列，稍後自動重送' : '離線儲存，連線後自動同步', 'info');
    } finally { setSyncing(false); }
  };

  const handleDelete = async (id) => {
    if (!confirm('確定刪除？')) return;
    setTransactions(prev => prev.filter(t => t.id !== id));
    setShowForm(false); setEditingTx(null);
    setSyncing(true);
    try {
      if (!isOnline()) throw new Error('offline');
      await api('deleteTxn', { id }); showToast('已刪除');
    } catch (e) {
      queueOp({ action: 'deleteTxn', payload: { id } });
      showToast('離線刪除，連線後同步', 'info');
    } finally { setSyncing(false); }
  };

  const handleDedupe = async () => {
    try {
      const r = await api('dedupe');
      await reload();
      const s = r.removed > 0 ? `已清除 ${r.removed} 筆重複` : '沒有完全重複的記錄';
      showToast(r.suspicious > 0 ? `${s}；另有 ${r.suspicious} 筆疑似重複待你確認` : s, r.suspicious > 0 ? 'info' : 'success');
    } catch (e) { showToast('清理失敗：' + e.message, 'error'); }
  };

  const changeCycle = async (d) => {
    const prev = cycleDay;
    setCycleDay(d); setPeriodTouched(false); localStorage.setItem(K_CYCLE, String(d));
    try { await api('setSetting', { key: 'cycleDay', value: d }); showToast(`結算日已設為每月 ${d} 號`); }
    catch (e) { setCycleDay(prev); showToast('儲存失敗：' + e.message, 'error'); }
  };

  const saveOpening = async (v) => {
    const prev = openingBalance;
    setOpeningBalance(v);
    try { await api('setOpening', { value: v }); showToast('期初餘額已更新'); }
    catch (e) { setOpeningBalance(prev); showToast('儲存失敗：' + e.message, 'error'); }
  };

  /* ---- 畫面 ---- */
  if (!apiUrl) return html`<${SetupScreen} onSaved=${setApiUrl} />`;
  if (!booted) return html`<div class="boot"><span class="spin">${IRef()}</span>載入中⋯</div>`;

  const label = getPeriodLabel(period, cycleDay);
  const isCur = period === getCurrentPeriod(cycleDay);

  return html`
    <div class="app">
      ${toast && html`<div class="toast" style=${{
        background: toast.type === 'error' ? '#FEE2E2' : toast.type === 'info' ? '#FEF3C7' : '#E8F0EA',
        color:      toast.type === 'error' ? '#991B1B' : toast.type === 'info' ? '#92400E' : '#1F3A2E',
        border: `1px solid ${toast.type === 'error' ? '#FCA5A5' : toast.type === 'info' ? '#FCD34D' : '#A8D5B5'}`,
      }}>${toast.msg}</div>`}

      <header class="hdr">
        <div class="hdr-in">
          <div class="between" style="margin-bottom:8px">
            <div class="row" style="gap:6px;color:var(--ink)">
              ${IBag(15)}<span class="brand">Me, Inc.</span>
              ${syncing && html`<span class="spin" style="color:var(--t3)">${IRef(13)}</span>`}
              ${!online && html`<span style="color:#B45309">${ICloudOff()}</span>`}
            </div>
            <div class="row">
              <button class="iconbtn" style="color:var(--t2)" onClick=${reload}>${IRef()}</button>
              <button class="iconbtn" style="color:var(--t2)" onClick=${() => setShowSettings(true)}>${ICog()}</button>
            </div>
          </div>
          <div class="between" style="align-items:flex-end">
            <div>
              <h1 class="h1">個人營運帳本</h1>
              <div class="sub">${isCur ? '本期營運中' : '歷史期間檢視'}</div>
            </div>
            <button class="periodbtn" onClick=${() => setShowPicker(true)}>
              <span style="color:var(--t2)">${ICal()}</span>
              <span class="rng">${label}</span>
              <span style="color:var(--t3)">${IDown()}</span>
            </button>
          </div>
        </div>
      </header>

      <main class="main">
        <!-- 本期損益 -->
        <section class="card">
          <div class="card-hd tinted">
            <span class="eyebrow">Period P&L</span>
            <span class="sub mono">${getPeriodLabelFull(period, cycleDay)}</span>
          </div>
          <div class="card-bd">
            <div class="lbl" style="margin-bottom:4px">本期淨利</div>
            <div class="row" style="gap:8px;flex-wrap:wrap">
              <span class="big" style=${{ color: netProfit >= 0 ? '#1F3A2E' : '#A0421C' }}>
                ${netProfit >= 0 ? '+' : '−'}$${fmt(Math.abs(netProfit))}
              </span>
              ${inc > 0 && html`<span class="badge" style=${{
                background: margin >= 20 ? '#E8F0EA' : margin >= 0 ? '#FFF3DC' : '#FEE2E2',
                color:      margin >= 20 ? '#1F3A2E' : margin >= 0 ? '#7A5A2C' : '#991B1B',
              }}>淨利率 ${margin.toFixed(1)}%</span>`}
            </div>
            <div class="g2 divider-t">
              <div>
                <div class="row" style="gap:5px;margin-bottom:2px;color:var(--ink)">${IUp()}<span class="lbl">營運收入</span></div>
                <div class="kpi" style="color:#1F3A2E">$${fmt(inc)}</div>
              </div>
              <div>
                <div class="row" style="gap:5px;margin-bottom:2px;color:var(--red)">${IDn()}<span class="lbl">營運支出</span></div>
                <div class="kpi" style="color:#A0421C">$${fmt(exp)}</div>
              </div>
            </div>
            <div class="g2 divider-t">
              <div>
                <span class="lbl">期初現金</span>
                <div class="kpi-s" style="color:#7A5A2C">$${fmt(periodStartCash)}</div>
                <div class="mini">自上期期末延續</div>
              </div>
              <div>
                <span class="lbl">期末現金</span>
                <div class="kpi-s" style=${{ color: periodEndCash >= 0 ? '#1F3A2E' : '#A0421C' }}>$${fmt(periodEndCash)}</div>
                <div class="mini">= 期初 + 淨利</div>
              </div>
            </div>
          </div>
        </section>

        <!-- 部門支出 -->
        ${exp > 0 && html`
        <section class="card">
          <div class="card-hd"><span class="eyebrow">各部門支出佔比</span><span class="sub">by Department</span></div>
          <div class="card-bd" style="display:flex;flex-direction:column;gap:10px">
            ${deptStats.filter(d => d.total > 0).map(d => html`
              <button key=${d.id} class="deptrow" onClick=${() => setFilter(d.id)}>
                <div class="between" style="margin-bottom:4px">
                  <div class="row" style="gap:8px">
                    <span style="font-size:16px">${d.emoji}</span>
                    <span style="font-size:14px;font-weight:500">${d.name}</span>
                    <span class="sub">${d.count} 筆</span>
                  </div>
                  <div class="row" style="gap:8px">
                    <span class="sub mono">${d.pct.toFixed(0)}%</span>
                    <span class="mono" style="font-size:14px;font-weight:600">$${fmt(d.total)}</span>
                  </div>
                </div>
                <div class="bar"><i style=${{ width: d.pct + '%', background: d.color }}></i></div>
              </button>`)}
          </div>
        </section>`}

        ${history.length >= 2 && html`<${AssetTrendChart} history=${history} />`}
        ${history.length >= 2 && html`<${PLBarChart} history=${history} />`}

        <!-- 指標 -->
        <section class="g2">
          <div class="card" style="padding:14px">
            <div class="row" style="gap:6px;margin-bottom:6px;color:var(--red)">${IFlame()}<span class="lbl">期燃燒率</span></div>
            <div class="kpi" style="color:#1F3A2E">$${fmt(burnRate)}</div>
            <div class="mini">近 3 期平均支出</div>
          </div>
          <div class="card" style="padding:14px">
            <div class="row" style="gap:6px;margin-bottom:6px;color:var(--ink)">${IBag(14)}<span class="lbl">公司跑道</span></div>
            <div class="kpi" style=${{ color: runway >= 6 ? '#1F3A2E' : runway >= 3 ? '#A87B3D' : '#A0421C' }}>
              ${runway === Infinity ? '∞' : runway.toFixed(1) + ' 期'}
            </div>
            <div class="mini">沒收入還能撐多久</div>
          </div>
        </section>

        <!-- 篩選 -->
        <section class="chips">
          ${[{ k: 'all', l: '全部' }, { k: 'income', l: '收入' }, { k: 'expense', l: '支出' },
             ...DEPARTMENTS.map(d => ({ k: d.id, l: d.emoji + ' ' + d.name }))].map(f => html`
            <button key=${f.k} class=${'chip' + (filter === f.k ? ' on' : '')} onClick=${() => setFilter(f.k)}>${f.l}</button>`)}
        </section>

        <!-- 明細 -->
        <section class="card">
          <div class="card-hd"><span class="eyebrow">交易明細</span><span class="sub">${filteredTx.length} 筆</span></div>
          ${filteredTx.length === 0
            ? html`<div style="padding:48px 20px;text-align:center;color:var(--t3);font-size:14px">本期此類別暫無記錄</div>`
            : filteredTx.map(tx => {
                const isInc = tx.type === 'inflow';
                const cat = isInc ? findIncome(tx.category) : findDept(tx.category);
                return html`
                  <button key=${tx.id} class="tx" onClick=${() => { setEditingTx(tx); setShowForm(true); }}>
                    <div class="tx-ic" style=${{ background: isInc ? '#E8F0EA' : cat.color + '22' }}>${cat.emoji}</div>
                    <div style="flex:1;min-width:0">
                      <div class="tx-nm">${tx.client || cat.name}</div>
                      <div class="tx-mt">${cat.name} · ${tx.date}${tx.description ? ' · ' + tx.description : ''}</div>
                    </div>
                    <div class="tx-am" style=${{ color: isInc ? '#1F3A2E' : '#A0421C' }}>
                      ${isInc ? '+' : '−'}$${fmt(tx.amount)}
                    </div>
                  </button>`;
              })}
        </section>

        <footer class="sub" style="text-align:center;padding:16px 0">
          資料儲存於你的 Google Sheet · ${online ? '線上' : '離線'} · Me, Inc.
        </footer>
      </main>

      <button class="fab" onClick=${() => { setEditingTx(null); setShowForm(true); }}>${IPlus()}</button>

      ${showPicker && html`<${PeriodPicker} value=${period} cycleDay=${cycleDay}
        onChange=${(k) => { setPeriod(k); setPeriodTouched(true); }} onClose=${() => setShowPicker(false)} />`}

      ${showForm && html`<${EntryForm} initial=${editingTx}
        onClose=${() => { setShowForm(false); setEditingTx(null); }}
        onSave=${handleSave}
        onDelete=${editingTx ? () => handleDelete(editingTx.id) : null} />`}

      ${showSettings && html`<${SettingsSheet} apiUrl=${apiUrl} openingBalance=${openingBalance}
        currentBalance=${currentBalance} cycleDay=${cycleDay}
        onChangeCycle=${changeCycle} onSaveOpening=${saveOpening} onDedupe=${handleDedupe}
        onClose=${() => setShowSettings(false)}
        onReset=${() => { localStorage.removeItem(K_API); setApiUrl(null); }} />`}
    </div>`;
}

render(html`<${App} />`, document.getElementById('root'));

/* 測試用匯出（瀏覽器不影響） */
export { getCurrentPeriod, getPeriodRange, getPeriodLabel, getPeriodLabelFull, shiftPeriod, isInPeriod, txDate };
