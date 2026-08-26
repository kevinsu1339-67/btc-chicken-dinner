(function (global) {
  'use strict';

  const PENDING_KEY = 'chickendinner:pending';
  const ME_KEY = 'chickendinner:me';

  // makeNonce 用 toString(36) 組出三段字串，每一段都有機率剛好全部是
  // 數字字元（例如 Math.random() 湊巧落在讓 toString(36) 只吐出數字的
  // 區間）。三段若剛好都是純數字，組出來的字串（如
  // '12345678-123456-4567'）會符合 lib.js 裡「數字加 -.: 分隔」的日期
  // 外觀正規表達式，被伺服器判定為寫進 Sheet 會變型別、破壞冪等而拒絕。
  // 機率雖低，但一旦中獎就是下注當下一次莫名其妙的「缺少 nonce」錯誤。
  // 用固定字母開頭、且保證整串至少有一個字母，從根本避開這個判斷式。
  function makeNonce() {
    return 'n' + Math.random().toString(36).slice(2, 10) +
           '-' + Date.now().toString(36) +
           '-' + Math.random().toString(36).slice(2, 6);
  }

  function createApi(opts) {
    const url = opts.url;
    const doFetch = opts.fetch || global.fetch.bind(global);
    const store = opts.storage || global.localStorage;

    // localStorage 在無痕視窗或封鎖 cookie 時，光是存取就會丟例外。
    // 全部包起來，儲存壞掉不能讓下注流程跟著掛掉。
    function readKey(k) {
      try { const v = store.getItem(k); return v ? JSON.parse(v) : null; }
      catch (e) { return null; }
    }
    function writeKey(k, v) {
      try { store.setItem(k, JSON.stringify(v)); } catch (e) { /* 忽略 */ }
    }
    function dropKey(k) {
      try { store.removeItem(k); } catch (e) { /* 忽略 */ }
    }

    async function getState() {
      const res = await doFetch(url, { method: 'GET' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }

    async function placeBet(payload) {
      // 只送這四個欄位。ts、mkt、tol、days_left 一律由伺服器產生，
      // 呼叫端傳了也會在這裡被丟掉，不會原樣轉送出去。
      const body = {
        name: payload.name,
        pin: payload.pin,
        bet: Number(payload.bet),
        nonce: payload.nonce || makeNonce()
      };
      let data;
      try {
        const res = await doFetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        data = await res.json();
      } catch (err) {
        // 送不出去才暫存。伺服器有回應（即使是 ok:false）就代表這個
        // nonce 已經到過伺服器，重送只會被冪等擋掉，沒有意義。
        writeKey(PENDING_KEY, body);
        throw err;
      }
      dropKey(PENDING_KEY);
      return data;
    }

    return {
      getState: getState,
      placeBet: placeBet,
      loadPending: () => readKey(PENDING_KEY),
      clearPending: () => dropKey(PENDING_KEY),
      saveMe: (name, pin) => writeKey(ME_KEY, { name: name, pin: pin }),
      loadMe: () => readKey(ME_KEY),
      makeNonce: makeNonce
    };
  }

  const api = { createApi: createApi, makeNonce: makeNonce, PENDING_KEY: PENDING_KEY, ME_KEY: ME_KEY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.ChickenApi = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
