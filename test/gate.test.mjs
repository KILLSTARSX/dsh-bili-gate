import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeConfig } from '../src/config.js';
import { createGate } from '../src/gate.js';
import { noopLog, stubSessions } from './helpers.mjs';

function setup({ config = {}, sessions = stubSessions(), now = () => 1000, events = [] } = {}) {
  const gate = createGate({
    config: normalizeConfig(config),
    sessions,
    log: noopLog,
    now,
    readOwnerEvents: () => events,
  });
  return { gate, sessions };
}

test('hello 报协议 2，且不承诺自己做不到的 recentMessages', async () => {
  const { gate } = setup();
  assert.deepEqual(await gate.hello(), {
    protocol: 2,
    actions: ['hello', 'context', 'ownerMessages', 'notify'],
    name: 'dsh-bili-gate',
  });
});

test('context：自己那个会话算主人', async () => {
  const { gate } = setup({ sessions: stubSessions({ sessionId: 's-1' }) });
  assert.deepEqual(await gate.context({ sessionId: 's-1' }), { trusted: true, label: 'B站私信（主人）' });
});

test('context：桥接会话一律不可信', async () => {
  const { gate } = setup();
  const r = await gate.context({ sessionId: 's-9', session: { agentPreset: 'qq-chat' } });
  assert.equal(r.trusted, false);
  assert.match(r.label, /qq-chat/);
});

test('context：普通桌面会话算主人', async () => {
  const { gate } = setup();
  assert.deepEqual(await gate.context({ sessionId: 's-2', session: { agentPreset: 'standard' } }), {
    trusted: true,
    label: '本机会话（standard）',
  });
  assert.deepEqual(await gate.context({ sessionId: 'gate-test' }), { trusted: true, label: '本机会话' });
});

test('context：不可信目录也算桥接', async () => {
  const { gate } = setup({ config: { untrustedCwd: 'E:\\fish\\qq\nD:\\bots' } });
  const r = await gate.context({ sessionId: 's-3', session: { cwd: 'E:\\fish\\qq\\data' } });
  assert.equal(r.trusted, false);
  assert.match(r.label, /工作目录/);
});

test('context：目录分隔符混着写也算同一个目录', async () => {
  const { gate } = setup({ config: { untrustedCwd: 'E:/fish/qq/\nD:\\bots' } });
  const r = await gate.context({ sessionId: 's-3', session: { cwd: 'e:\\fish\\qq\\data' } });
  assert.equal(r.trusted, false);
  assert.match(r.label, /工作目录/);
});

test('context：正则写错了不能把插件带崩', async () => {
  const { gate } = setup({ config: { untrustedPresets: '(' } });
  const r = await gate.context({ sessionId: 's-4', session: { agentPreset: 'qq-chat' } });
  assert.equal(r.trusted, true, '退回「不按 preset 判断」');
});

test('notify：空正文直接拒绝', async () => {
  const { gate, sessions } = setup();
  assert.deepEqual(await gate.notify({ text: '   ' }), { ok: false, reason: 'empty-text' });
  assert.deepEqual(await gate.notify({}), { ok: false, reason: 'empty-text' });
  assert.equal(sessions.ensuredCount, 0);
});

test('notify：正常投递，唤醒词带 marker 和原文', async () => {
  const { gate, sessions } = setup();
  assert.deepEqual(await gate.notify({ kind: 'inbox', text: '主人：在吗' }), { ok: true });
  assert.equal(sessions.prompts.length, 1);
  assert.equal(sessions.prompts[0].mode, 'steer');
  assert.match(sessions.prompts[0].text, /^【B站收件箱有新消息】 主人：在吗/);
});

test('notify：窗口内重复的通知只投一次', async (t) => {
  let clock = 1000;
  const { gate, sessions } = setup({ config: { dedupeWindowMs: 60_000 }, now: () => clock });
  assert.deepEqual(await gate.notify({ text: '同一条' }), { ok: true });
  clock += 1000;
  assert.deepEqual(await gate.notify({ text: '同一条' }), { ok: true, deduped: true });
  assert.equal(sessions.prompts.length, 1);

  clock += 60_000;
  assert.deepEqual(await gate.notify({ text: '同一条' }), { ok: true });
  assert.equal(sessions.prompts.length, 2);
});

test('notify：正文超长截断', async () => {
  const { gate, sessions } = setup({ config: { maxTextLength: 100 } });
  await gate.notify({ text: 'x'.repeat(500) });
  assert.ok(sessions.prompts[0].text.length < 300);
  assert.match(sessions.prompts[0].text, /已截断/);
});

test('notify：会话被删了，重建后重投一次', async () => {
  const { gate, sessions } = setup();
  sessions.failNextPrompt(Object.assign(new Error('x'), { code: 'session/not-found' }));
  assert.deepEqual(await gate.notify({ text: '重投' }), { ok: true });
  assert.equal(sessions.forgotCount, 1);
  assert.equal(sessions.ensuredCount, 2);
  assert.equal(sessions.prompts.length, 1);
});

test('notify：会话忙就改成排队，不丢消息', async () => {
  const { gate, sessions } = setup();
  sessions.failNextPrompt(Object.assign(new Error('x'), { code: 'session/agent-busy' }));
  assert.deepEqual(await gate.notify({ text: '忙' }), { ok: true });
  assert.equal(sessions.prompts.length, 1);
  assert.equal(sessions.prompts[0].mode, 'queue');
});

test('notify：投递彻底失败返回 ok:false（让调用方下次重试）', async () => {
  const { gate, sessions } = setup();
  sessions.failNextPrompt(new Error('gateway 挂了'));
  assert.deepEqual(await gate.notify({ text: '发不出去' }), { ok: false, reason: 'deliver-failed' });
});

test('notify：同一条还在投递时再来一次，让调用方稍后重试（不能回 ok）', async () => {
  const sessions = stubSessions();
  sessions.prompt = () => new Promise(() => {}); // 第一次永远没投完
  const { gate } = setup({ config: { maxQueue: 5, dedupeWindowMs: 0 }, sessions });
  void gate.notify({ text: '同一条' });
  assert.deepEqual(await gate.notify({ text: '同一条' }), { ok: false, reason: 'in-flight' });
});

test('notify：队列满了直接拒绝，不无限堆', async () => {
  const sessions = stubSessions();
  sessions.prompt = () => new Promise(() => {}); // 永远不返回
  const { gate } = setup({ config: { maxQueue: 1 }, sessions });
  void gate.notify({ text: '占住队列' });
  assert.deepEqual(await gate.notify({ text: '第二条' }), { ok: false, reason: 'queue-full' });
});

test('notify：dryRun 只记日志，不建会话', async () => {
  const { gate, sessions } = setup({ config: { dryRun: true } });
  assert.deepEqual(await gate.notify({ text: '空跑' }), { ok: true, dryRun: true });
  assert.equal(sessions.ensuredCount, 0);
  assert.equal(sessions.prompts.length, 0);
});

test('ownerMessages：可信会话里捞出主人说过的话', async () => {
  const events = [
    {
      type: 'user/message',
      seq: 0,
      time: 1000,
      data: { content: [{ type: 'text', text: '【B站收件箱有新消息】自己注入的' }], source: { kind: 'user', rpcId: 'r-1' } },
    },
    {
      type: 'user/message',
      seq: 1,
      time: 2000,
      data: { content: [{ type: 'text', text: '可以' }], source: { kind: 'user', rpcId: 'r-2' } },
    },
  ];
  const { gate, sessions } = setup({ sessions: stubSessions({ sessionId: 's-1' }), events });
  sessions.requestIds.add('r-1');
  assert.deepEqual(await gate.ownerMessages({ sessionId: 's-1', since: 0 }), {
    messages: [{ at: 2000, text: '可以' }],
  });
});

test('ownerMessages：不可信会话不翻记录', async () => {
  const events = [{ type: 'user/message', time: 2000, data: { content: [{ type: 'text', text: 'x' }] } }];
  const { gate } = setup({ events });
  assert.deepEqual(await gate.ownerMessages({ sessionId: 's-9', since: 0, session: { agentPreset: 'qq-chat' } }), {
    messages: [],
  });
});

test('ownerMessages：读会话失败按「没说过」处理', async () => {
  const { gate } = setup();
  const throwing = createGate({
    config: normalizeConfig({}),
    sessions: stubSessions(),
    log: noopLog,
    readOwnerEvents: () => {
      throw new Error('boom');
    },
  });
  assert.deepEqual(await gate.ownerMessages({ sessionId: 's-1', since: 0 }), { messages: [] });
  assert.deepEqual(await throwing.ownerMessages({ sessionId: 's-1', since: 0 }), { messages: [] });
});

test('ownerMessages：会话不在内存里时返回空，而不是瞎猜', async () => {
  const gate = createGate({
    config: normalizeConfig({}),
    sessions: stubSessions(),
    log: noopLog,
    readOwnerEvents: () => null,
  });
  assert.deepEqual(await gate.ownerMessages({ sessionId: 's-1', since: 0 }), { messages: [] });
});
