import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeConfig } from '../src/config.js';
import { createSessionApi, isBusyError, isMissingSessionError } from '../src/session.js';
import { createStore } from '../src/state.js';
import { callsOf, fakeGateway, noopLog, tempDir } from './helpers.mjs';

function setup(t, { config = {}, handlers = {}, uuid = () => 'r-1' } = {}) {
  const dir = tempDir(t);
  const store = createStore({ file: `${dir}/state.json`, log: noopLog });
  const gateway = fakeGateway({
    'session/create': () => ({ sessionId: 's-1' }),
    'session/rename': () => ({ title: 'B站私信' }),
    'session/prompt': () => ({ accepted: true }),
    'session/page': () => ({ records: [], hasMore: false }),
    ...handlers,
  });
  const api = createSessionApi({
    call: (namespace, method, args) => gateway.invoke({ namespace, method, args }),
    store,
    config: normalizeConfig(config),
    log: noopLog,
    uuid,
  });
  return { api, gateway, store, dir };
}

test('create 的参数名必须是 request，cwd 为空时不带', async (t) => {
  const { api, gateway } = setup(t, { config: { cwd: 'C:\\work\\bili' } });
  assert.equal(await api.ensure(), 's-1');
  assert.deepEqual(callsOf(gateway, 'session/create')[0].args, { request: { cwd: 'C:\\work\\bili' } });

  const b = setup(t, { config: {} });
  await b.api.ensure();
  assert.deepEqual(callsOf(b.gateway, 'session/create')[0].args, { request: {} });
});

test('建完会话顺手改名，改名失败不影响主流程', async (t) => {
  const ok = setup(t, { config: { sessionTitle: 'B站私信' } });
  await ok.api.ensure();
  assert.deepEqual(callsOf(ok.gateway, 'session/rename')[0].args, {
    request: { sessionId: 's-1', title: 'B站私信' },
  });

  const bad = setup(t, {
    config: { sessionTitle: 'B站私信' },
    handlers: { 'session/rename': () => { throw new Error('rename boom'); } },
  });
  assert.equal(await bad.api.ensure(), 's-1');
});

test('并发 ensure 只建一个会话', async (t) => {
  const { api, gateway } = setup(t);
  const [a, b] = await Promise.all([api.ensure(), api.ensure()]);
  assert.equal(a, b);
  assert.equal(callsOf(gateway, 'session/create').length, 1);
});

test('已有 sessionId 时不再 create', async (t) => {
  const { api, gateway, store } = setup(t);
  store.patch({ sessionId: 's-old' });
  assert.equal(await api.ensure(), 's-old');
  assert.equal(callsOf(gateway, 'session/create').length, 0);
});

test('prompt 的 payload 符合协议，requestId 会被记下来', async (t) => {
  const { api, gateway } = setup(t, { uuid: () => 'req-9' });
  await api.prompt('s-1', '正文', 'queue');
  assert.deepEqual(callsOf(gateway, 'session/prompt')[0].args, {
    request: { requestId: 'req-9', sessionId: 's-1', mode: 'queue', content: [{ type: 'text', text: '正文' }] },
  });
  assert.ok(api.requestIds.has('req-9'));
});

test('create 没返回 sessionId 要报错，不能悄悄用 undefined', async (t) => {
  const { api } = setup(t, { handlers: { 'session/create': () => ({}) } });
  await assert.rejects(() => api.ensure(), /没有返回 sessionId/);
});

test('错误分类：会话没了 vs 会话忙', () => {
  assert.equal(isMissingSessionError(Object.assign(new Error('x'), { code: 'session/not-found' })), true);
  assert.equal(isMissingSessionError(new Error('session "s-1" was disposed during prompt admission')), true);
  assert.equal(isMissingSessionError(new Error('门卫服务超时')), false);
  assert.equal(isBusyError(Object.assign(new Error('x'), { code: 'session/agent-busy' })), true);
  assert.equal(isBusyError(new Error('session/steer-unavailable')), true);
  assert.equal(isBusyError(new Error('network down')), false);
});
