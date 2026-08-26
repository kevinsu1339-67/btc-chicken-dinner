'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createApi, makeNonce } = require('../src/api.js');
const { validateSubmission, ROSTER } = require('../src/lib.js');

function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m
  };
}

const okResponse = (body) => ({ ok: true, status: 200, json: async () => body });

test('makeNonce 每次都不一樣', () => {
  const s = new Set();
  for (let i = 0; i < 200; i++) s.add(makeNonce());
  assert.strictEqual(s.size, 200);
});

// makeNonce 用 toString(36) 組字串，三段偶爾會全部剛好是純數字（例如
// '12345678-123456-4567'），這會符合 lib.js breaksSheetRoundTrip 裡
// 「數字加 - . : 分隔」的日期外觀正規表達式，被伺服器判定為破壞冪等而拒絕。
// 機率雖低，但一旦發生就是一次莫名其妙、卡在送出那一刻的「缺少 nonce」
// 類錯誤。大量生成並實際跑一次 validateSubmission，確保這種情況不會發生。
test('makeNonce 大量生成都能通過 validateSubmission 的 nonce 規則', () => {
  const name = ROSTER[0];
  for (let i = 0; i < 5000; i++) {
    const nonce = makeNonce();
    const res = validateSubmission({ name, pin: '1234', bet: 82000, nonce });
    assert.strictEqual(res.ok, true, 'nonce 被拒絕：' + nonce + '（原因：' + (res.reason || '') + '）');
  }
});

test('getState 打 GET 並回傳解析後的 JSON', async () => {
  const calls = [];
  const api = createApi({
    url: 'https://example.test/exec',
    fetch: async (u, o) => { calls.push([u, o]); return okResponse({ ok: true, mkt: 78000 }); },
    storage: fakeStorage()
  });
  const s = await api.getState();
  assert.strictEqual(s.mkt, 78000);
  assert.strictEqual(calls[0][1].method, 'GET');
});

test('placeBet 用 text/plain 送出，避免觸發 CORS preflight', async () => {
  let seen = null;
  const api = createApi({
    url: 'https://example.test/exec',
    fetch: async (u, o) => { seen = o; return okResponse({ ok: true, seq: 1 }); },
    storage: fakeStorage()
  });
  await api.placeBet({ name: '阿明', pin: '1234', bet: 82000 });
  assert.strictEqual(seen.method, 'POST');
  assert.strictEqual(seen.headers['Content-Type'], 'text/plain;charset=utf-8');
  const body = JSON.parse(seen.body);
  assert.strictEqual(body.bet, 82000);
  assert.ok(body.nonce, '沒帶 nonce 就無法冪等');
});

test('placeBet 只送四個欄位，不送任何伺服器該自己算的值', async () => {
  let seen = null;
  const api = createApi({
    url: 'https://example.test/exec',
    fetch: async (u, o) => { seen = o; return okResponse({ ok: true }); },
    storage: fakeStorage()
  });
  await api.placeBet({ name: '阿明', pin: '1234', bet: 82000, mkt: 1, tol: 99, ts: 'fake' });
  assert.deepStrictEqual(Object.keys(JSON.parse(seen.body)).sort(), ['bet', 'name', 'nonce', 'pin']);
});

test('placeBet 失敗時把這筆暫存起來並把錯誤往上丟', async () => {
  const store = fakeStorage();
  const api = createApi({
    url: 'https://example.test/exec',
    fetch: async () => { throw new Error('network down'); },
    storage: store
  });
  await assert.rejects(() => api.placeBet({ name: '阿明', pin: '1234', bet: 82000 }));
  const pending = api.loadPending();
  assert.strictEqual(pending.bet, 82000);
  assert.ok(pending.nonce);
});

test('重送暫存時沿用同一個 nonce，伺服器才擋得掉重複', async () => {
  const store = fakeStorage();
  let fail = true;
  const api = createApi({
    url: 'https://example.test/exec',
    fetch: async (u, o) => {
      if (fail) throw new Error('network down');
      return okResponse({ ok: true, seq: 1, _echo: JSON.parse(o.body) });
    },
    storage: store
  });
  await assert.rejects(() => api.placeBet({ name: '阿明', pin: '1234', bet: 82000 }));
  const first = api.loadPending().nonce;
  fail = false;
  const res = await api.placeBet(api.loadPending());
  assert.strictEqual(res._echo.nonce, first);
  assert.strictEqual(api.loadPending(), null, '成功後應清掉暫存');
});

test('HTTP 非 2xx 視為失敗並暫存', async () => {
  const store = fakeStorage();
  const api = createApi({
    url: 'https://example.test/exec',
    fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    storage: store
  });
  await assert.rejects(() => api.placeBet({ name: '阿明', pin: '1234', bet: 82000 }));
  assert.ok(api.loadPending());
});

test('伺服器回 ok:false 時不丟例外，由呼叫端判讀 reason', async () => {
  const store = fakeStorage();
  const api = createApi({
    url: 'https://example.test/exec',
    fetch: async () => okResponse({ ok: false, reason: 'wrong_pin', message: 'PIN 不對' }),
    storage: store
  });
  const res = await api.placeBet({ name: '阿明', pin: '9999', bet: 82000 });
  assert.strictEqual(res.reason, 'wrong_pin');
  assert.strictEqual(api.loadPending(), null, 'PIN 錯不該留成待重送');
});

test('saveMe / loadMe 記得身分，免得每次重打', () => {
  const api = createApi({ url: 'x', fetch: async () => okResponse({}), storage: fakeStorage() });
  assert.strictEqual(api.loadMe(), null);
  api.saveMe('阿明', '1234');
  assert.deepStrictEqual(api.loadMe(), { name: '阿明', pin: '1234' });
});

test('storage 整個壞掉時不可讓下注流程炸掉', async () => {
  const broken = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
    removeItem: () => { throw new Error('blocked'); }
  };
  const api = createApi({ url: 'x', fetch: async () => okResponse({ ok: true }), storage: broken });
  assert.strictEqual(api.loadPending(), null);
  assert.strictEqual(api.loadMe(), null);
  const res = await api.placeBet({ name: '阿明', pin: '1234', bet: 82000 });
  assert.strictEqual(res.ok, true);
});
