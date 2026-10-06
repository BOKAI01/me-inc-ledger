/* LINE Messaging API：簽章驗證、回覆、卡片 */
import { DEPARTMENTS, INCOME_CATS, catLabel, fmt } from './ledger.js';

export async function verifySignature(secret, body, signature) {
  if (!secret || !signature) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  let s = '';
  for (const b of mac) s += String.fromCharCode(b);
  const expected = btoa(s);
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

export async function reply(token, replyToken, messages, fetchImpl = fetch) {
  const res = await fetchImpl('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ replyToken, messages: (Array.isArray(messages) ? messages : [messages]).slice(0, 5) }),
  });
  if (!res.ok) console.error('LINE reply failed', res.status, await res.text().catch(() => ''));
  return res.ok;
}

export const text = (t, quickReply) => (quickReply ? { type: 'text', text: t, quickReply } : { type: 'text', text: t });

const row = (label, value) => ({
  type: 'box', layout: 'baseline', spacing: 'md',
  contents: [
    { type: 'text', text: label, size: 'sm', color: '#8A8A8A', flex: 2 },
    { type: 'text', text: value, size: 'sm', color: '#222222', flex: 5, wrap: true },
  ],
});

const btn = (label, data, style = 'secondary') => ({
  type: 'button', style, height: 'sm',
  ...(style === 'primary' ? { color: '#1F3A2E' } : {}),
  action: { type: 'postback', label, data, displayText: label },
});

/** 確認卡片 */
export function confirmCard(pid, e, ledgerName) {
  const isIn = e.type === 'inflow';
  return {
    type: 'flex',
    altText: `確認記帳：${e.client} $${fmt(e.amount)}`,
    contents: {
      type: 'bubble', size: 'kilo',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: isIn ? '#5B8C5A' : '#1F3A2E', paddingAll: '14px',
        contents: [
          { type: 'text', text: isIn ? '確認收入' : '確認支出', color: '#FFFFFF', size: 'sm' },
          { type: 'text', text: `${isIn ? '+' : '-'}$${fmt(e.amount)}`, color: '#FFFFFF', size: 'xxl', weight: 'bold' },
        ],
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          row('項目', e.client),
          row('分類', catLabel(e.type, e.category)),
          row('日期', e.date),
          row('帳本', ledgerName || '主帳本'),
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          btn('確認寫入', `a=ok&p=${pid}`, 'primary'),
          {
            type: 'box', layout: 'horizontal', spacing: 'sm',
            contents: [btn('改分類', `a=pick&p=${pid}`), btn('取消', `a=no&p=${pid}`)],
          },
        ],
      },
    },
  };
}

/** 改分類的快速選單 */
export function categoryQuickReply(pid, type) {
  const cats = type === 'inflow'
    ? INCOME_CATS.map(c => ({ id: c.id, label: `${c.emoji} ${c.name}` }))
    : DEPARTMENTS.map(d => ({ id: d.id, label: `${d.emoji} ${d.fullName}` }));
  const items = cats.map(c => ({
    type: 'action',
    action: { type: 'postback', label: c.label.slice(0, 20), data: `a=cat&p=${pid}&c=${c.id}`, displayText: c.label },
  }));
  items.push({
    type: 'action',
    action: {
      type: 'postback',
      label: type === 'inflow' ? '↔ 改成支出' : '↔ 改成收入',
      data: `a=type&p=${pid}&t=${type === 'inflow' ? 'outflow' : 'inflow'}`,
      displayText: type === 'inflow' ? '改成支出' : '改成收入',
    },
  });
  return { items };
}
