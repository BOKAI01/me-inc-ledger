/**
 * Me, Inc. LINE 記帳機器人（Cloudflare Worker）
 *   GET  /health        → ok
 *   POST /line/webhook  → LINE Messaging API webhook
 */
import { verifySignature, reply, text, confirmCard, categoryQuickReply, allocQuickReply } from './line.js';
import { parseEntry, guessCategory, allocEntry } from './parse.js';
import { getAccessToken, readHeaderAndIds, appendTxn, GoogleAuthError, SheetAccessError } from './google.js';
import { computePockets, computeSummary, taipeiToday, catLabel, fmt } from './ledger.js';
import { Entry, entryCall } from './entry.js';

export { Entry };

const HELP = [
  '📒 記帳方式：項目 + 金額',
  '・午餐 120',
  '・昨天 計程車 250',
  '・10/3 電影 300',
  '・+薪水 50000（開頭 + 代表收入）',
  '',
  '💱 撥款（口袋間配置，不算收支）：',
  '・撥款 緊急 5000（日常 → 緊急備用金）',
  '・撥款 儲蓄 3000（日常 → 儲蓄口袋）',
  '・撥回 儲蓄 2000（儲蓄 → 日常）',
  '',
  '其他指令：',
  '・餘額：帳戶總額與三個口袋',
  '・摘要：本期收支',
].join('\n');

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return new Response('ok', { headers: { 'Content-Type': 'text/plain' } });
    if (url.pathname === '/line/webhook' && request.method === 'POST') return webhook(request, env, ctx);
    return new Response('Not found', { status: 404 });
  },
};

async function webhook(request, env, ctx) {
  const body = await request.text();
  const ok = await verifySignature(env.LINE_CHANNEL_SECRET, body, request.headers.get('x-line-signature'));
  if (!ok) return new Response('Bad signature', { status: 401 });
  let payload;
  try { payload = JSON.parse(body); } catch { return new Response('Bad JSON', { status: 400 }); }
  const events = Array.isArray(payload.events) ? payload.events : [];
  ctx.waitUntil(Promise.all(events.map(ev => handleEvent(ev, env).catch(err => console.error('event failed', err)))));
  return new Response('ok');
}

export async function handleEvent(ev, env, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const today = deps.today || taipeiToday();
  const uid = ev.source?.userId;
  const send = (msgs) => (ev.replyToken ? reply(env.LINE_CHANNEL_ACCESS_TOKEN, ev.replyToken, msgs, fetchImpl) : null);
  if (!uid) return;

  const bind = await env.KV.get(`bind:${uid}`, 'json');
  if (!bind || !bind.sheetId) {
    if (ev.type === 'message' || ev.type === 'follow') {
      await send(text(`這個 LINE 帳號還沒綁定帳本。\n你的 User ID：${uid}\n請在 Cloudflare KV 新增 bind:${uid}`));
    }
    return;
  }
  const ledgerName = bind.ledgerName || '主帳本';

  if (ev.type === 'message' && ev.message?.type === 'text') {
    const msg = ev.message.text.trim();
    if (/^(餘額|余額|結餘)$/.test(msg)) return send(text(await balanceText(env, fetchImpl)));
    if (/^(摘要|本期|本月)$/.test(msg)) return send(text(await summaryText(env, today, fetchImpl)));
    if (/^(說明|幫助|help|\?|？)$/i.test(msg)) return send(text(HELP));
    if (/^調整/.test(msg)) return send(text('「調整」類型要等網站改版後才開放，目前請在網站上操作。'));

    const entry = parseEntry(msg, today);
    if (!entry) return send(text(`看不懂這筆，請用「項目 金額」，例如：午餐 120\n輸入「說明」看更多用法。`));

    const mem = entry.type === 'alloc' ? null : await env.KV.get(`cat:${uid}:${entry.client}`, 'json');
    if (mem && mem.type && mem.category) { entry.type = mem.type; entry.category = mem.category; }

    const pid = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    const txnId = `${Date.now()}${pid.slice(0, 4)}`;
    await entryCall(env, pid, 'create', { uid, sheetId: bind.sheetId, ledgerName, txnId, entry, hadMemory: !!mem });
    return send(confirmCard(pid, entry, ledgerName));
  }

  if (ev.type === 'postback') {
    const p = new URLSearchParams(ev.postback?.data || '');
    const a = p.get('a'), pid = p.get('p');
    if (!pid || !/^[0-9a-f]{16}$/.test(pid)) return;

    if (a === 'ok') return send(text(await confirmWrite(env, pid, uid, fetchImpl)));

    if (a === 'no') {
      const r = await entryCall(env, pid, 'cancel');
      return send(text(r.ok ? '已取消，這筆不會寫入。' : stateMsg(r.reason)));
    }

    if (a === 'pick') {
      const r = await entryCall(env, pid, 'get');
      if (!r.ok || r.rec.state !== 'pending') return send(text(stateMsg(r.ok ? r.rec.state : 'missing')));
      if (r.rec.entry.type === 'alloc') return send(text('請選擇撥款方向：', allocQuickReply(pid)));
      return send(text('請選擇分類：', categoryQuickReply(pid, r.rec.entry.type)));
    }

    if (a === 'cat' || a === 'type' || a === 'alloc') {
      const g = await entryCall(env, pid, 'get');
      if (!g.ok || g.rec.state !== 'pending') return send(text(stateMsg(g.ok ? g.rec.state : 'missing')));
      const cur = g.rec.entry;
      const origClient = cur.origClient || cur.client;
      let patch;
      if (a === 'cat') {
        patch = { category: p.get('c') };
      } else if (a === 'alloc') {
        const d = p.get('d') === 'out' ? 'out' : 'in';
        const k = p.get('k') === 'savings' ? 'savings' : 'emergency';
        patch = { ...allocEntry(d, k), origClient: cur.type === 'alloc' ? cur.origClient : cur.client };
      } else {
        const t = p.get('t') === 'inflow' ? 'inflow' : 'outflow';
        patch = { type: t, client: origClient, account: '', category: guessCategory(origClient, t) };
      }
      const r = await entryCall(env, pid, 'update', patch);
      if (!r.ok) return send(text(stateMsg(r.reason)));
      return send(confirmCard(pid, r.rec.entry, r.rec.ledgerName));
    }
  }
}

function stateMsg(reason) {
  switch (reason) {
    case 'done': return '這筆已經寫入過了 ✅';
    case 'writing': return '這筆正在寫入，請稍候…';
    case 'cancelled': return '這筆已取消。';
    default: return '這張卡片已失效，請重新輸入一次。';
  }
}

async function confirmWrite(env, pid, uid, fetchImpl) {
  const r = await entryCall(env, pid, 'acquire');
  if (!r.ok) return stateMsg(r.reason);
  const rec = r.rec;
  if (rec.uid !== uid) { await entryCall(env, pid, 'release'); return '這張卡片不是你的。'; }
  const e = rec.entry;

  try {
    const token = await getAccessToken(env.GOOGLE_SA_JSON, fetchImpl);
    const { header, ids } = await readHeaderAndIds(token, rec.sheetId, fetchImpl);
    if (!ids.includes(rec.txnId)) {
      await appendTxn(token, rec.sheetId, header, {
        id: rec.txnId, type: e.type, category: e.category, date: e.date, amount: e.amount,
        client: e.client, description: '', paymentTerm: 0, received: true,
        createdAt: new Date().toISOString(), account: e.account || '',
      }, fetchImpl);
    }
  } catch (err) {
    await entryCall(env, pid, 'release');
    console.error('write failed', err);
    if (err instanceof SheetAccessError) return '❌ 無法存取試算表：請確認已共用給服務帳戶，且權限為編輯者。可再按一次「確認寫入」重試。';
    if (err instanceof GoogleAuthError) return `❌ Google 授權失敗：${err.message}。請檢查 GOOGLE_SA_JSON。`;
    return '❌ 寫入失敗，請稍後再按一次「確認寫入」。';
  }
  await entryCall(env, pid, 'finish');

  // 記住使用者改過的分類（撥款不記）
  if (e.type !== 'alloc') try {
    const key = `cat:${uid}:${e.client}`;
    const guessType = parseEntry(`${e.client} 1`, '2000-01-01')?.type || 'outflow';
    const changed = e.type !== guessType || e.category !== guessCategory(e.client, e.type);
    if (changed) await env.KV.put(key, JSON.stringify({ type: e.type, category: e.category }));
    else if (rec.hadMemory) await env.KV.delete(key);
  } catch (err) { console.error('memory failed', err); }

  const cache = await clearLegacyCache(env, fetchImpl);
  const sign = e.type === 'inflow' ? '+' : e.type === 'alloc' ? '' : '-';
  const label = e.type === 'alloc' ? '撥款' : e.client;
  return `✅ 已寫入【${rec.ledgerName}】\n${label} ${sign}$${fmt(e.amount)}\n${catLabel(e.type, e.category, e.account)}・${e.date}`
    + (cache ? '' : '\n（網站快取未清除，若網站沒看到，請在網站設定頁重新整理）');
}

/* ---------- 舊後端（Apps Script） ---------- */
async function gasCall(env, action, fetchImpl, ms = 20000) {
  if (!env.LEGACY_GAS_URL) throw new Error('尚未設定 LEGACY_GAS_URL');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetchImpl(env.LEGACY_GAS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ payload: JSON.stringify({ action }) }),
      redirect: 'follow',
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = await res.json();
    if (!j.ok) throw new Error(j.error || '未知錯誤');
    return j.data;
  } finally { clearTimeout(timer); }
}

async function clearLegacyCache(env, fetchImpl) {
  try { await gasCall(env, 'clearCache', fetchImpl, 10000); return true; }
  catch (err) { console.error('clearCache failed', err); return false; }
}

async function loadLedger(env, fetchImpl) {
  const d = await gasCall(env, 'load', fetchImpl);
  return {
    transactions: (d.transactions || []).map(t => ({ ...t, date: String(t.date || '').slice(0, 10) })),
    openingBalance: Number(d.openingBalance) || 0,
    cycleDay: Number(d.cycleDay) || 1,
    fundTarget: Number(d.fundTarget) || 50000,
  };
}

async function balanceText(env, fetchImpl) {
  try {
    const d = await loadLedger(env, fetchImpl);
    const p = computePockets(d.transactions, d.openingBalance);
    const gap = d.fundTarget - p.emergency;
    return [
      `💰 帳戶總額 $${fmt(p.total)}`,
      `👛 日常口袋 $${fmt(p.daily)}${p.daily < 0 ? '（超支）' : ''}`,
      `🏦 儲蓄口袋 $${fmt(p.savings)}${p.savings < 0 ? '（超支）' : ''}`,
      `🛟 緊急備用金 $${fmt(p.emergency)} / $${fmt(d.fundTarget)}`,
      gap > 0 ? `　還差 $${fmt(gap)}` : '　已達標 🎉',
    ].join('\n');
  } catch (err) {
    console.error('balance failed', err);
    return `❌ 讀取帳本失敗：${err.message}`;
  }
}

async function summaryText(env, today, fetchImpl) {
  try {
    const d = await loadLedger(env, fetchImpl);
    const s = computeSummary(d.transactions, d.cycleDay, today);
    const lines = [
      `📊 本期 ${s.label}`,
      `收入 $${fmt(s.inc)}`,
      `支出 $${fmt(s.exp)}`,
      `淨利 ${s.net < 0 ? '-' : ''}$${fmt(Math.abs(s.net))}${s.inc > 0 ? `（${Math.round((s.net / s.inc) * 100)}%）` : ''}`,
    ];
    if (s.depts.length) {
      lines.push('', '支出前三名：');
      for (const dp of s.depts.slice(0, 3)) lines.push(`${dp.emoji} ${dp.fullName} $${fmt(dp.total)}`);
    }
    return lines.join('\n');
  } catch (err) {
    console.error('summary failed', err);
    return `❌ 讀取帳本失敗：${err.message}`;
  }
}
