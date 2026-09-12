/**
 * Me, Inc. 個人營運帳本 — Google Apps Script 後端 v2
 * ============================================================
 * 本版重點（對應前端 v2）
 *   1. LockService：同一時間只允許一個寫入，避免併發產生重複列
 *   2. addTxn 具「冪等性」：同 id 重送不會再新增；同日/同額/同對象且
 *      60 秒內的近似重複也視為同一筆（防連點、防離線佇列重送）
 *   3. updateTxn / deleteTxn 找不到 id 時回成功，避免佇列卡死無限重試
 *   4. Settings 支援 cycleDay（結算日存雲端，換手機不會遺失）
 *   5. dedupe：掃描並清除完全重複列，另回報疑似重複供人工判斷
 *
 * 部署：擴充功能 → Apps Script → 貼上 → 部署 → 網頁應用程式
 *      執行身分「我」、存取權「所有人 Anyone」
 *      改版後請到「管理部署作業」選「新版本」，網址不變
 */

const TXN_SHEET_NAME = 'Transactions';
const SETTINGS_SHEET_NAME = 'Settings';
const TXN_HEADERS = ['id', 'type', 'category', 'date', 'amount', 'client', 'description', 'paymentTerm', 'received', 'createdAt'];
const DUP_WINDOW_MS = 60 * 1000;   // 近似重複判定視窗

/* ========== 入口 ========== */
function doPost(e) {
  try {
    var data = null;
    if (e && e.parameter && e.parameter.payload) data = JSON.parse(e.parameter.payload);
    else if (e && e.postData && e.postData.contents) { try { data = JSON.parse(e.postData.contents); } catch (_) {} }
    if (!data || !data.action) throw new Error('缺少 action 參數');
    return jsonResponse({ ok: true, data: dispatch(data) });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err.message || err) });
  }
}

function doGet(e) {
  if (e && e.parameter && e.parameter.action === 'load') {
    try { return jsonResponse({ ok: true, data: loadAll() }); }
    catch (err) { return jsonResponse({ ok: false, error: String(err.message || err) }); }
  }
  return jsonResponse({ ok: true, message: 'Me, Inc. 帳本 API 部署成功' });
}

function dispatch(data) {
  if (data.action === 'load') return loadAll();          // 讀取不必上鎖

  var lock = LockService.getScriptLock();
  lock.waitLock(25000);                                   // 寫入序列化
  try {
    switch (data.action) {
      case 'addTxn':     return addTxn(data.txn);
      case 'updateTxn':  return updateTxn(data.id, data.fields);
      case 'deleteTxn':  return deleteTxn(data.id);
      case 'setOpening': return setSetting('openingBalance', Number(data.value) || 0);
      case 'setSetting': return setSetting(String(data.key), data.value);
      case 'dedupe':     return dedupe();
      default: throw new Error('未知的指令：' + data.action);
    }
  } finally { lock.releaseLock(); }
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/* ========== 初始化 ========== */
function ensureSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var txnSheet = ss.getSheetByName(TXN_SHEET_NAME);
  if (!txnSheet) {
    txnSheet = ss.insertSheet(TXN_SHEET_NAME);
    txnSheet.getRange(1, 1, 1, TXN_HEADERS.length).setValues([TXN_HEADERS])
      .setFontWeight('bold').setBackground('#1F3A2E').setFontColor('#FFFFFF');
    txnSheet.setFrozenRows(1);
  }

  var settingsSheet = ss.getSheetByName(SETTINGS_SHEET_NAME);
  if (!settingsSheet) {
    settingsSheet = ss.insertSheet(SETTINGS_SHEET_NAME);
    settingsSheet.getRange(1, 1, 3, 2).setValues([['key', 'value'], ['openingBalance', 0], ['cycleDay', 1]]);
    settingsSheet.getRange(1, 1, 1, 2).setFontWeight('bold').setBackground('#1F3A2E').setFontColor('#FFFFFF');
  }
  return { txnSheet: txnSheet, settingsSheet: settingsSheet };
}

/* ========== 讀取 ========== */
function toDateStr(v) {
  if (!v) return '';
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Taipei', 'yyyy-MM-dd');
  var s = String(v);
  if (s.length > 10) return Utilities.formatDate(new Date(s), 'Asia/Taipei', 'yyyy-MM-dd');
  return s;
}

function loadAll() {
  var sheets = ensureSheets();
  var rows = sheets.txnSheet.getDataRange().getValues();
  var transactions = [];
  for (var i = 1; i < rows.length; i++) {
    if (!rows[i][0]) continue;
    var t = {};
    for (var c = 0; c < TXN_HEADERS.length; c++) t[TXN_HEADERS[c]] = rows[i][c];
    t.id = String(t.id);
    t.amount = Number(t.amount) || 0;
    t.paymentTerm = Number(t.paymentTerm) || 0;
    t.received = (t.received === true || t.received === 'TRUE' || t.received === 'true' || t.received === 1);
    t.date = toDateStr(t.date);
    if (t.createdAt instanceof Date) {
      t.createdAt = Utilities.formatDate(t.createdAt, 'Asia/Taipei', "yyyy-MM-dd'T'HH:mm:ss");
    } else if (t.createdAt) {
      t.createdAt = String(t.createdAt);
    }
    transactions.push(t);
  }

  var sRows = sheets.settingsSheet.getDataRange().getValues();
  var settings = {};
  for (var j = 1; j < sRows.length; j++) settings[sRows[j][0]] = sRows[j][1];

  var cycleDay = Number(settings.cycleDay) || 1;
  if (cycleDay < 1 || cycleDay > 28) cycleDay = 1;

  return {
    transactions: transactions,
    openingBalance: Number(settings.openingBalance) || 0,
    cycleDay: cycleDay
  };
}

/* ========== 寫入（冪等） ========== */
function sameCore(row, txn) {
  return String(row[1]) === String(txn.type || '') &&
         String(row[2]) === String(txn.category || '') &&
         toDateStr(row[3]) === toDateStr(txn.date) &&
         Number(row[4]) === Number(txn.amount) &&
         String(row[5] || '') === String(txn.client || '');
}

function addTxn(txn) {
  if (!txn || !txn.id) throw new Error('缺少交易 id');
  var sheets = ensureSheets();
  var rows = sheets.txnSheet.getDataRange().getValues();
  var newTime = txn.createdAt ? new Date(txn.createdAt).getTime() : Date.now();

  for (var i = 1; i < rows.length; i++) {
    if (!rows[i][0]) continue;
    // ① 同一 id 已存在（離線佇列重送、網路逾時重試）
    if (String(rows[i][0]) === String(txn.id)) return { id: txn.id, duplicate: 'id' };
    // ② 內容相同且建立時間相近（連點兩下、同一筆送兩次）
    if (sameCore(rows[i], txn)) {
      var oldTime = rows[i][9] ? new Date(rows[i][9]).getTime() : 0;
      if (oldTime && Math.abs(newTime - oldTime) < DUP_WINDOW_MS) return { id: String(rows[i][0]), duplicate: 'near' };
    }
  }

  var row = TXN_HEADERS.map(function (h) {
    var v = txn[h];
    if (v === undefined || v === null) return '';
    if (h === 'received') return !!v;
    if (h === 'date') return toDateStr(v);
    return v;
  });
  sheets.txnSheet.appendRow(row);
  return { id: txn.id, duplicate: null };
}

function updateTxn(id, fields) {
  var sheets = ensureSheets();
  var rows = sheets.txnSheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === String(id)) {
      Object.keys(fields).forEach(function (key) {
        var col = TXN_HEADERS.indexOf(key);
        if (col < 0) return;
        var v = fields[key];
        if (key === 'received') v = !!v;
        if (key === 'date') v = toDateStr(v);
        sheets.txnSheet.getRange(i + 1, col + 1).setValue(v);
      });
      return { id: id, updated: true };
    }
  }
  return { id: id, updated: false };   // 找不到就當作已處理，避免佇列卡住
}

function deleteTxn(id) {
  var sheets = ensureSheets();
  var rows = sheets.txnSheet.getDataRange().getValues();
  for (var i = rows.length - 1; i >= 1; i--) {
    if (String(rows[i][0]) === String(id)) {
      sheets.txnSheet.deleteRow(i + 1);
      return { id: id, deleted: true };
    }
  }
  return { id: id, deleted: false };
}

/* ========== 設定 ========== */
function setSetting(key, value) {
  var sheets = ensureSheets();
  var rows = sheets.settingsSheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === key) {
      sheets.settingsSheet.getRange(i + 1, 2).setValue(value);
      return { key: key, value: value };
    }
  }
  sheets.settingsSheet.appendRow([key, value]);
  return { key: key, value: value };
}

/* ========== 重複清理 ========== */
/**
 * removed    ：id 完全相同的重複列（保留第一列，其餘刪除）
 * suspicious ：同 type/category/date/amount/client 但 id 不同 → 只回報，不刪除
 */
function dedupe() {
  var sheets = ensureSheets();
  var rows = sheets.txnSheet.getDataRange().getValues();
  var seenId = {}, toDelete = [], keyCount = {};

  for (var i = 1; i < rows.length; i++) {
    if (!rows[i][0]) continue;
    var id = String(rows[i][0]);
    if (seenId[id]) { toDelete.push(i + 1); continue; }
    seenId[id] = true;
    var k = [rows[i][1], rows[i][2], toDateStr(rows[i][3]), Number(rows[i][4]), String(rows[i][5] || '')].join('|');
    keyCount[k] = (keyCount[k] || 0) + 1;
  }

  for (var d = toDelete.length - 1; d >= 0; d--) sheets.txnSheet.deleteRow(toDelete[d]);

  var suspicious = 0;
  Object.keys(keyCount).forEach(function (k) { if (keyCount[k] > 1) suspicious += keyCount[k] - 1; });

  return { removed: toDelete.length, suspicious: suspicious };
}
