/**
 * 顧問現金流帳本 — Google Apps Script 後端
 * ============================================
 * 部署方式：
 *   1. 在 Google Sheet 中：擴充功能（Extensions） → Apps Script
 *   2. 把整份程式碼貼進去，按儲存
 *   3. 部署（Deploy） → 新增部署作業 → 類型「網頁應用程式」
 *   4. 執行身分：我（您自己）
 *   5. 存取權：「所有人 Anyone」 (※ 不是「擁有 Google 帳戶的所有人」)
 *   6. 部署 → 授權 → 取得網頁應用程式網址
 *   7. 把網址貼到 HTML 檔的設定畫面
 *
 *   ⚠ 注意：每次修改程式碼後，到「管理部署作業」點鉛筆，版本選「新版本」即可（網址不變）
 */

const TXN_SHEET_NAME = 'Transactions';
const SETTINGS_SHEET_NAME = 'Settings';
const TXN_HEADERS = ['id', 'type', 'category', 'date', 'amount', 'client', 'description', 'paymentTerm', 'received', 'createdAt'];

// ============================================
// 主入口（同時相容 FormData 與 JSON 傳輸）
// ============================================
function doPost(e) {
  try {
    let data = null;

    // 方式 1：FormData (瀏覽器最相容的方式)
    if (e && e.parameter && e.parameter.payload) {
      data = JSON.parse(e.parameter.payload);
    }
    // 方式 2：純 JSON body
    else if (e && e.postData && e.postData.contents) {
      try { data = JSON.parse(e.postData.contents); } catch (_) {}
    }

    if (!data || !data.action) {
      throw new Error('缺少 action 參數');
    }

    let result;
    if (data.action === 'load') {
      result = loadAll();
    } else if (data.action === 'addTxn') {
      result = addTxn(data.txn);
    } else if (data.action === 'deleteTxn') {
      result = deleteTxn(data.id);
    } else if (data.action === 'updateTxn') {
      result = updateTxn(data.id, data.fields);
    } else if (data.action === 'setOpening') {
      result = setOpening(Number(data.value) || 0);
    } else {
      throw new Error('未知的指令：' + data.action);
    }

    return jsonResponse({ ok: true, data: result });

  } catch (err) {
    return jsonResponse({ ok: false, error: String(err.message || err) });
  }
}

function doGet(e) {
  // 用瀏覽器直接訪問此 URL 時可看到此訊息，方便確認部署成功
  // 也支援透過 GET ?action=load 觸發載入（備援方案）
  if (e && e.parameter && e.parameter.action) {
    try {
      let result;
      if (e.parameter.action === 'load') {
        result = loadAll();
      } else {
        throw new Error('GET 僅支援 action=load');
      }
      return jsonResponse({ ok: true, data: result });
    } catch (err) {
      return jsonResponse({ ok: false, error: String(err.message || err) });
    }
  }
  return jsonResponse({ ok: true, message: '顧問現金流帳本 API 部署成功' });
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================
// 初始化（自動建立工作表與標題列）
// ============================================
function ensureSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  let txnSheet = ss.getSheetByName(TXN_SHEET_NAME);
  if (!txnSheet) {
    txnSheet = ss.insertSheet(TXN_SHEET_NAME);
    txnSheet.getRange(1, 1, 1, TXN_HEADERS.length).setValues([TXN_HEADERS]);
    txnSheet.getRange(1, 1, 1, TXN_HEADERS.length).setFontWeight('bold').setBackground('#1F3A2E').setFontColor('#FFFFFF');
    txnSheet.setFrozenRows(1);
  }

  let settingsSheet = ss.getSheetByName(SETTINGS_SHEET_NAME);
  if (!settingsSheet) {
    settingsSheet = ss.insertSheet(SETTINGS_SHEET_NAME);
    settingsSheet.getRange(1, 1, 2, 2).setValues([
      ['key', 'value'],
      ['openingBalance', 0]
    ]);
    settingsSheet.getRange(1, 1, 1, 2).setFontWeight('bold').setBackground('#1F3A2E').setFontColor('#FFFFFF');
  }

  return { txnSheet, settingsSheet };
}

// ============================================
// 載入全部資料
// ============================================
function loadAll() {
  const { txnSheet, settingsSheet } = ensureSheets();

  const txnData = txnSheet.getDataRange().getValues();
  const transactions = [];
  for (let i = 1; i < txnData.length; i++) {
    const row = txnData[i];
    if (!row[0]) continue;
    const t = {};
    TXN_HEADERS.forEach((h, idx) => { t[h] = row[idx]; });
    t.amount = Number(t.amount) || 0;
    t.paymentTerm = Number(t.paymentTerm) || 0;
    t.received = (t.received === true || t.received === 'TRUE' || t.received === 'true' || t.received === 1);
    if (t.date instanceof Date) {
      t.date = Utilities.formatDate(t.date, 'Asia/Taipei', 'yyyy-MM-dd');
    }
    if (t.createdAt instanceof Date) {
      t.createdAt = t.createdAt.toISOString();
    }
    t.id = String(t.id);
    transactions.push(t);
  }

  const settingsData = settingsSheet.getDataRange().getValues();
  const settings = {};
  for (let i = 1; i < settingsData.length; i++) {
    settings[settingsData[i][0]] = settingsData[i][1];
  }

  return {
    transactions: transactions,
    openingBalance: Number(settings.openingBalance) || 0
  };
}

function addTxn(txn) {
  const { txnSheet } = ensureSheets();
  const row = TXN_HEADERS.map(h => {
    let v = txn[h];
    if (v === undefined || v === null) return '';
    if (h === 'received') return v ? true : false;
    return v;
  });
  txnSheet.appendRow(row);
  return txn;
}

function deleteTxn(id) {
  const { txnSheet } = ensureSheets();
  const data = txnSheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id)) {
      txnSheet.deleteRow(i + 1);
      return { id: id };
    }
  }
  throw new Error('找不到該筆交易：' + id);
}

function updateTxn(id, fields) {
  const { txnSheet } = ensureSheets();
  const data = txnSheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id)) {
      Object.keys(fields).forEach(key => {
        const colIdx = TXN_HEADERS.indexOf(key);
        if (colIdx >= 0) {
          let v = fields[key];
          if (key === 'received') v = v ? true : false;
          txnSheet.getRange(i + 1, colIdx + 1).setValue(v);
        }
      });
      return { id: id, fields: fields };
    }
  }
  throw new Error('找不到該筆交易：' + id);
}

function setOpening(value) {
  const { settingsSheet } = ensureSheets();
  const data = settingsSheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === 'openingBalance') {
      settingsSheet.getRange(i + 1, 2).setValue(value);
      return { openingBalance: value };
    }
  }
  settingsSheet.appendRow(['openingBalance', value]);
  return { openingBalance: value };
}
