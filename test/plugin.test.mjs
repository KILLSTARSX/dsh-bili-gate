import assert from 'node:assert/strict';
import { test } from 'node:test';

import { apply, name, SERVICE_NAME } from '../src/index.js';
import { callsOf, fakeCtx, fakeGateway, tempDir } from './helpers.mjs';

function config(dir, extra = {}) {
  return { stateFile: `${dir}/state.json`, logFile: `${dir}/gate.log`, ...extra };
}

test('插件导出的 name 和 dsh.plugin.json 对得上', () => {
  assert.equal(name, 'dsh-bili-gate');
  assert.equal(SERVICE_NAME, 'biliEyesGate');
});

test('apply 之后 biliEyesGate 能用，hello 走通', async (t) => {
  const dir = tempDir(t);
  const ctx = fakeCtx({ gateway: fakeGateway() });
  const dispose = apply(ctx, config(dir));
  const gate = ctx.services.get(SERVICE_NAME);
  assert.ok(gate, '服务应该已经注册');
  assert.equal((await gate.hello()).protocol, 2);
  await dispose();
  assert.equal(ctx.services.has(SERVICE_NAME), false, 'dispose 之后要注销');
});

test('没有 typertGateway 时插件照样活着，只是转达失败', async (t) => {
  const dir = tempDir(t);
  const ctx = fakeCtx({ gateway: null });
  apply(ctx, config(dir));
  const gate = ctx.services.get(SERVICE_NAME);
  assert.equal((await gate.hello()).protocol, 2);
  assert.equal((await gate.context({ sessionId: 'x' })).trusted, true);
  assert.deepEqual(await gate.notify({ text: '在吗' }), { ok: false, reason: 'deliver-failed' });
});

test('apply 把 config 透传到会话创建，并真的投递', async (t) => {
  const dir = tempDir(t);
  const gateway = fakeGateway({
    'session/create': () => ({ sessionId: 's-real' }),
    'session/rename': () => ({ title: 'B站私信' }),
    'session/prompt': () => ({ accepted: true }),
  });
  const ctx = fakeCtx({ gateway });
  apply(ctx, config(dir, { cwd: 'C:\\work\\bili', ownerMid: 100000001 }));

  const gate = ctx.services.get(SERVICE_NAME);
  assert.deepEqual(await gate.notify({ text: '你好' }), { ok: true });

  assert.deepEqual(callsOf(gateway, 'session/create')[0].args, { request: { cwd: 'C:\\work\\bili' } });
  const prompt = callsOf(gateway, 'session/prompt')[0].args.request;
  assert.equal(prompt.sessionId, 's-real');
  assert.equal(prompt.mode, 'steer');
  assert.match(prompt.content[0].text, /【B站收件箱有新消息】/);
  assert.match(prompt.content[0].text, /你好/);

  const state = JSON.parse((await import('node:fs')).readFileSync(`${dir}/state.json`, 'utf8'));
  assert.equal(state.sessionId, 's-real', 'sessionId 要落盘，重启后复用');
  assert.equal(state.version, 2);
});

test('第二次 apply 不会把宿主带崩（服务已被占用就记日志跳过）', async (t) => {
  const dir = tempDir(t);
  const ctx = fakeCtx({ gateway: fakeGateway() });
  apply(ctx, config(dir));
  const first = ctx.services.get(SERVICE_NAME);
  assert.doesNotThrow(() => apply(ctx, config(dir)));
  assert.equal(ctx.services.get(SERVICE_NAME), first, '原来的服务不能被顶掉');
});

test('ownerMessages 走宿主会话表，能读到主人原话', async (t) => {
  const dir = tempDir(t);
  const ctx = fakeCtx({ gateway: fakeGateway() });
  ctx.services.set('sessions', {
    get: (id) =>
      id === 's-1'
        ? {
            seq: 1,
            snapshotEvents: () => [
              { type: 'user/message', seq: 0, time: 5000, data: { content: [{ type: 'text', text: '可以' }] } },
            ],
          }
        : undefined,
  });
  apply(ctx, config(dir));
  assert.deepEqual(await ctx.services.get(SERVICE_NAME).ownerMessages({ sessionId: 's-1', since: 0 }), {
    messages: [{ at: 5000, text: '可以' }],
  });
});

test('状态文件坏了就当没状态，重新建会话', async (t) => {
  const dir = tempDir(t);
  const fs = await import('node:fs');
  fs.writeFileSync(`${dir}/state.json`, '{ 这不是 json');
  const gateway = fakeGateway({
    'session/create': () => ({ sessionId: 's-new' }),
    'session/rename': () => ({ title: 'x' }),
    'session/prompt': () => ({ accepted: true }),
  });
  const ctx = fakeCtx({ gateway });
  apply(ctx, config(dir));
  assert.deepEqual(await ctx.services.get(SERVICE_NAME).notify({ text: '你好' }), { ok: true });
  assert.equal(callsOf(gateway, 'session/create').length, 1);
});
