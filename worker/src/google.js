/* Google Sheets：服務帳戶 JWT 授權 + 讀寫 */

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://sheets.googleapis.com/v4/spreadsheets';
export const TXN_SHEET = 'Transactions';

let cached = null; // { token, exp, email }

const b64url = (buf) => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const b64urlStr = (str) => b64url(new TextEncoder().encode(str));

function pemToDer(pem) {
  const body = pem.replace(/-----[^-]+-----/g, '').replace(/\\n/g, '').replace(/\s+/g, '');
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function parseServiceAccount(json) {
  let sa;
  try { sa = typeof json === 'string' ? JSON.parse(json) : json; } catch { throw new GoogleAuthError('GOOGLE_SA_JSON 不是有效的 JSON'); }
  if (!sa || !sa.client_email || !sa.private_key) throw new GoogleAuthError('GOOGLE_SA_JSON 缺少 client_email 或 private_key');
  return sa;
}

export class GoogleAuthError extends Error {}
export class SheetAccessError extends Error {}

export async function getAccessToken(saJson, fetchImpl = fetch) {
  const sa = parseServiceAccount(saJson);
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.email === sa.client_email && cached.exp - 60 > now) return cached.token;

  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = { iss: sa.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 };
  const unsigned = `${b64urlStr(JSON.stringify(header))}.${b64urlStr(JSON.stringify(claim))}`;
  let key;
  try {
    key = await crypto.subtle.importKey('pkcs8', pemToDer(sa.private_key),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  } catch { throw new GoogleAuthError('私鑰格式錯誤'); }
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${b64url(sig)}`;

  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  if (!res.ok) throw new GoogleAuthError(`取得 Google 權杖失敗（HTTP ${res.status}）`);
  const j = await res.json();
  cached = { token: j.access_token, exp: now + Number(j.expires_in || 3600), email: sa.client_email };
  return cached.token;
}

export function resetTokenCache() { cached = null; }

async function sheetsFetch(token, path, init = {}, fetchImpl = fetch) {
  const res = await fetchImpl(API + path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  if (res.status === 403 || res.status === 404) throw new SheetAccessError(`無法存取試算表（HTTP ${res.status}）`);
  if (res.status === 401) throw new GoogleAuthError('Google 授權失敗（HTTP 401）');
  if (!res.ok) throw new Error(`Sheets API 錯誤（HTTP ${res.status}）`);
  return res.json();
}

const rng = (a1) => encodeURIComponent(`'${TXN_SHEET}'!${a1}`);

/** 讀標題列與 id 欄 */
export async function readHeaderAndIds(token, sheetId, fetchImpl = fetch) {
  const j = await sheetsFetch(token,
    `/${sheetId}/values:batchGet?ranges=${rng('1:1')}&ranges=${rng('A:A')}&majorDimension=ROWS`, {}, fetchImpl);
  const header = (j.valueRanges?.[0]?.values?.[0] || []).map(String);
  const ids = (j.valueRanges?.[1]?.values || []).slice(1).map(r => String(r[0] ?? ''));
  return { header, ids };
}

/* 試算表日期序號（1899-12-30 起算的天數）→ yyyy-MM-dd */
function serialToDate(n) {
  const d = new Date(Math.round((Number(n) - 25569) * 86400000));
  return d.toISOString().slice(0, 10);
}
/** 日期欄正規化：與 Apps Script load 相同，字串取前 10 碼，日期儲存格轉 yyyy-MM-dd */
export function normDate(v) {
  if (typeof v === 'number') return serialToDate(v);
  const s = String(v ?? '').trim();
  const m = s.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  return s.slice(0, 10);
}

/** 直接讀整本帳（交易＋設定），取代 Apps Script 的 load */
export async function readLedger(token, sheetId, fetchImpl = fetch) {
  const set = encodeURIComponent(`'Settings'!A:B`);
  const j = await sheetsFetch(token,
    `/${sheetId}/values:batchGet?ranges=${rng('A:Z')}&ranges=${set}`
    + `&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=SERIAL_NUMBER`, {}, fetchImpl);
  const rows = j.valueRanges?.[0]?.values || [];
  const header = (rows[0] || []).map(String);
  const transactions = rows.slice(1)
    .filter(r => r.some(c => c !== '' && c != null))
    .map(r => {
      const t = Object.fromEntries(header.map((h, i) => [h, r[i] ?? '']));
      t.id = String(t.id ?? '');
      t.date = normDate(t.date);
      t.amount = Number(String(t.amount).replace(/,/g, '')) || 0;
      t.account = String(t.account ?? '');
      return t;
    });
  const settings = {};
  for (const r of (j.valueRanges?.[1]?.values || []).slice(1)) if (r[0]) settings[String(r[0])] = r[1];
  return {
    transactions,
    openingBalance: Number(settings.openingBalance) || 0,
    cycleDay: Number(settings.cycleDay) || 1,
    fundTarget: Number(settings.fundTarget) || 50000,
  };
}

/** 依標題順序附加多列（一次 API 呼叫） */
export async function appendTxns(token, sheetId, header, txns, fetchImpl = fetch) {
  if (!header.length || header[0] !== 'id') throw new Error('Transactions 工作表標題列不符');
  if (!txns.length) return null;
  const values = txns.map(txn => header.map(h => (txn[h] === undefined ? '' : txn[h])));
  return sheetsFetch(token,
    `/${sheetId}/values/${rng('A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { method: 'POST', body: JSON.stringify({ values }) }, fetchImpl);
}
export const appendTxn = (token, sheetId, header, txn, fetchImpl = fetch) =>
  appendTxns(token, sheetId, header, [txn], fetchImpl);
