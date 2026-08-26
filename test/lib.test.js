'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const lib = require('../src/lib.js');

const at = (iso) => Date.parse(iso);

test('SETTLE_MS 指向 2026-09-11 00:00 UTC+8', () => {
  assert.strictEqual(lib.SETTLE_MS, at('2026-09-11T00:00:00+08:00'));
});

test('daysLeftFrom 對得上原本的 DL 表', () => {
  assert.strictEqual(lib.daysLeftFrom(at('2026-08-26T14:03:11+08:00')), 16);
  assert.strictEqual(lib.daysLeftFrom(at('2026-08-31T09:00:00+08:00')), 11);
  assert.strictEqual(lib.daysLeftFrom(at('2026-09-05T23:00:00+08:00')), 6);
});

test('daysLeftFrom 跨午夜必須換一級', () => {
  assert.strictEqual(lib.daysLeftFrom(at('2026-09-09T23:59:00+08:00')), 2);
  assert.strictEqual(lib.daysLeftFrom(at('2026-09-10T00:01:00+08:00')), 1);
});

test('daysLeftFrom 下限是 1，不會給 0 或負數', () => {
  assert.strictEqual(lib.daysLeftFrom(at('2026-09-10T23:59:59+08:00')), 1);
  assert.strictEqual(lib.daysLeftFrom(at('2026-09-11T00:00:00+08:00')), 1);
  assert.strictEqual(lib.daysLeftFrom(at('2026-09-12T00:00:00+08:00')), 1);
});

test('tolFor 對得上公告的容許值表', () => {
  assert.strictEqual(lib.tolFor(16), 24);
  assert.strictEqual(lib.tolFor(11), 20);
  assert.strictEqual(lib.tolFor(6), 15);
  assert.strictEqual(lib.tolFor(3), 10);
  assert.strictEqual(lib.tolFor(2), 8);
  assert.strictEqual(lib.tolFor(1), 6);
});

test('gutsOf 是相對市價的百分比，方向不影響大小', () => {
  assert.ok(Math.abs(lib.gutsOf(85000, 78000) - 8.9743589) < 1e-6);
  assert.strictEqual(lib.gutsOf(78000, 78000), 0);
  assert.strictEqual(lib.gutsOf(70000, 80000), lib.gutsOf(90000, 80000));
});

test('multOf 重現規格中的六位範例玩家', () => {
  const r = (x) => Math.round(x * 100) / 100;
  assert.strictEqual(r(lib.multOf(108000, 108000, 115000, 25)), 0.76); // A 抄市價
  assert.strictEqual(r(lib.multOf(114500, 108000, 115000, 25)), 1.57); // B 早+敢+中
  assert.strictEqual(r(lib.multOf(103000, 110000, 115000, 19)), 0.74); // C 早但看反
  assert.strictEqual(r(lib.multOf(116000, 112000, 115000, 15)), 1.28); // D 中膽很準
  assert.strictEqual(r(lib.multOf(114800, 114500, 115000, 6)), 1.00);  // E 晚+保守+準
  assert.strictEqual(r(lib.multOf(110000, 114500, 115000, 6)), 0.38);  // F 晚+亂衝
});

test('multOf 誤差超過容許值時歸零，不會變負數', () => {
  assert.strictEqual(lib.multOf(80000, 78000, 115000, 6), 0);
});

test('normalizeName 讓全形、大小寫、多餘空白指向同一個人', () => {
  assert.strictEqual(lib.normalizeName('  阿明  '), '阿明');
  assert.strictEqual(lib.normalizeName('Ｋｅｖｉｎ'), 'kevin');
  assert.strictEqual(lib.normalizeName('KEVIN'), lib.normalizeName('kevin'));
  assert.strictEqual(lib.normalizeName('大  雄'), '大 雄');
});

test('isClosed 在截止瞬間就成立', () => {
  assert.strictEqual(lib.isClosed(at('2026-09-10T23:59:59+08:00')), false);
  assert.strictEqual(lib.isClosed(at('2026-09-11T00:00:00+08:00')), true);
});
