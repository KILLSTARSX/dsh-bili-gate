import assert from 'node:assert/strict';
import { test } from 'node:test';

import { blocksToText, extractOwnerMessages, readSessionEvents } from '../src/owner.js';

const rec = (type, time, data) => ({ type: 'event', event: { type, seq: 0, time, data } });
const userText = (time, text, extra = {}) =>
  rec('user/message', time, { id: 'm', role: 'user', content: [{ type: 'text', text }], ...extra });

test('blocksToText 只取文本，图片和文件留占位', () => {
  assert.equal(blocksToText([{ type: 'text', text: ' 你好 ' }]), '你好');
  assert.equal(blocksToText([{ type: 'image', data: 'x' }, { type: 'text', text: '看图' }]), '[图片]\n看图');
  assert.equal(blocksToText('直接给字符串'), '直接给字符串');
  assert.equal(blocksToText(null), '');
  assert.equal(blocksToText([{ type: 'reasoning' }]), '');
});

test('只保留 since 之后的主人消息，按时间升序', () => {
  const records = [userText(3000, '后'), userText(1000, '前'), userText(2000, '中')];
  const out = extractOwnerMessages(records, { since: 2000 });
  assert.deepEqual(out.map((m) => m.text), ['中', '后']);
});

test('排掉自己注入的唤醒词（按 requestId）', () => {
  const records = [
    userText(1000, '【B站收件箱有新消息】 她发了条私信', { source: { kind: 'user', rpcId: 'r-1' } }),
    userText(2000, '可以', { source: { kind: 'user', rpcId: 'r-2' } }),
  ];
  const out = extractOwnerMessages(records, { since: 0, requestIds: new Set(['r-1']) });
  assert.deepEqual(out.map((m) => m.text), ['可以']);
});

test('没有 requestId 的旧记录按 marker 前缀排掉', () => {
  const records = [
    userText(1000, '【B站收件箱有新消息】 老版本注入的'),
    userText(2000, '那就回她一句吧'),
  ];
  const out = extractOwnerMessages(records, { since: 0, marker: '【B站收件箱有新消息】' });
  assert.deepEqual(out.map((m) => m.text), ['那就回她一句吧']);
});

test('忽略非 user/message 事件、空文本和纯图片消息', () => {
  const records = [
    rec('assistant/message', 1000, { content: [{ type: 'text', text: '她自己说的' }] }),
    rec('user/message', 2000, { content: [{ type: 'image', data: 'x' }] }),
    rec('user/message', 3000, { content: [{ type: 'text', text: '   ' }] }),
    userText(4000, '真正的主人发言'),
  ];
  assert.deepEqual(extractOwnerMessages(records, { since: 0 }).map((m) => m.text), ['真正的主人发言']);
});

test('超过上限只留最近的', () => {
  const records = Array.from({ length: 8 }, (_, i) => userText(i * 10, `m${i}`));
  const out = extractOwnerMessages(records, { since: 0, limit: 3 });
  assert.deepEqual(out.map((m) => m.text), ['m5', 'm6', 'm7']);
});

test('record 直接是 event（兼容两种形状）', () => {
  const records = [{ type: 'user/message', seq: 0, time: 5000, data: { content: [{ type: 'text', text: 'hi' }] } }];
  assert.deepEqual(extractOwnerMessages(records, {}).map((m) => m.text), ['hi']);
});

test('readSessionEvents：走 snapshotEvents，只取最后 limit 条', () => {
  const calls = [];
  const session = {
    seq: 1000,
    snapshotEvents(from) {
      calls.push(from);
      return [{ type: 'user/message', seq: from, time: 1, data: { content: [{ type: 'text', text: `from-${from}` }] } }];
    },
  };
  const store = { get: (id) => (id === 's-1' ? session : undefined) };
  const events = readSessionEvents(store, 's-1', 400);
  assert.deepEqual(calls, [600]);
  assert.equal(events.length, 1);
});

test('readSessionEvents：没有 snapshotEvents 就退回读 log', () => {
  const session = { seq: 3, log: [{ n: 0 }, { n: 1 }, { n: 2 }] };
  assert.deepEqual(readSessionEvents({ get: () => session }, 's-1', 2), [{ n: 1 }, { n: 2 }]);
});

test('readSessionEvents：会话不在、接口报错都返回 null', () => {
  assert.equal(readSessionEvents({ get: () => undefined }, 's-x'), null);
  assert.equal(readSessionEvents(null, 's-x'), null);
  assert.equal(
    readSessionEvents(
      {
        get: () => {
          throw new Error('nope');
        },
      },
      's-x',
    ),
    null,
  );
  assert.equal(
    readSessionEvents(
      {
        get: () => ({
          seq: 10,
          snapshotEvents() {
            throw new Error('bad');
          },
        }),
      },
      's-x',
    ),
    null,
  );
});
