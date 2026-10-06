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

/** 依標題順序附加一列 */
export async function appendTxn(token, sheetId, header, txn, fetchImpl = fetch) {
  if (!header.length || header[0] !== 'id') throw new Error('Transactions 工作表標題列不符');
  const row = header.map(h => (txn[h] === undefined ? '' : txn[h]));
  return sheetsFetch(token,
    `/${sheetId}/values/${rng('A1')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { method: 'POST', body: JSON.stringify({ values: [row] }) }, fetchImpl);
}
