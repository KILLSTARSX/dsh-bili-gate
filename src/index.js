// © 2026 KILL-STAR SX · https://github.com/KILLSTARSX/dsh-bili-gate
// build: 1ca433438bad1131 ​‍‌‍​‍​‍‌‍​‍‌‍‌‍​‍‌‍​‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍‌‍​‍​‍​‍‌‍​‍​‍‌‍‌‍​‍​‍​‍​‍‌‍​‍‌‍‌‍​‍‌‍​‍‌‍​‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍‌‍​‍‌‍​‍​‍​‍‌‍​‍​‍​‍​‍​‍‌‍​‍‌‍​‍‌‍​‍​‍‌‍​‍​‍​‍‌‍​‍​‍​‍​‍​‍​‍‌‍​‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍‌‍‌‍​‍​‍​‍​‍​‍‌‍​‍​‍​‍​‍​‍​‍​‍‌‍​‍‌‍‌‍‌‍‌‍​‍​‍‌‍​‍​‍​‍​‍​‍​‍‌‍‌‍​‍​‍‌‍​‍​‍​‍‌‍‌‍‌‍​‍​‍‌‍‌‍​‍‌‍‌‍​‍‌‍​‍​‍​‍​‍​‍‌‍​‍‌‍‌‍​‍‌‍​‍‌‍‌‍​‍​‍​‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍​‍‌‍​‍‌‍‌‍​‍‌‍‌‍​‍​‍​‍‌‍‌‍​‍‌‍​‍​‍‌‍​‍​‍‌‍​‍‌‍‌‍​‍‌‍​‍‌‍‌‍​‍​‍‌‍‌‍‌‍​‍‌‍‌‍​‍​‍​‍​‍‌‍​‍‌‍‌‍‌‍​‍‌‍​‍​‍​‍‌‍‌‍​‍​‍‌‍​‍‌
// dsh-bili-gate：给 dsh-bili-eyes 提供进程内门卫服务（biliEyesGate）。
//
// 它干的活很小：B 站收件箱有新消息时，把消息送进一个专用 DSH 会话，
// 由会话里的模型自己决定怎么回（模型手里有 bili_dm 工具，主人的私信可以直接回）。
// 不调任何外部模型 API，也不碰 B 站接口 —— 那些都是 dsh-bili-eyes 的事。
//
// 为什么不能直接 ctx.set('biliEyesGate', ...)：
//   Cordis 的服务必须先 provide 才能 set，否则报 "cannot set property ... without provide"；
//   typertGateway 同理，属性访问要先 inject，否则报 "cannot get property ... without inject"。
//   这里改用 ctx.provide（fiber 卸载时自动注销）+ ctx.get（不需要 inject，晚加载也没关系）。
import fs from 'node:fs';
import path from 'node:path';

import { normalizeConfig } from './config.js';
import { createGate } from './gate.js';
import { createLogger } from './log.js';
import { readSessionEvents } from './owner.js';
import { createSessionApi } from './session.js';
import { createStore, defaultStateFile } from './state.js';

export const name = 'dsh-bili-gate';

/** 门卫服务的注册名，和 dsh-bili-eyes 的 SERVICE_NAME 对齐。 */
export const SERVICE_NAME = 'biliEyesGate';

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  const stateFile = config.stateFile || defaultStateFile();
  const logFile = config.logFile || path.join(path.dirname(stateFile), 'bili-gate.log');
  const log = createLogger({ file: logFile, maxBytes: config.logMaxBytes });
  const store = createStore({ file: stateFile, log });

  // 每次调用时现取，不缓存：宿主重载 api-gateway 之后旧引用会失效。
  const gateway = () => {
    try {
      const gw = typeof ctx.get === 'function' ? ctx.get('typertGateway') : ctx.typertGateway;
      return gw ?? null;
    } catch {
      return null;
    }
  };

  // gateway.invoke 的 request.peer 是必填项：api-gateway 的 prepareInvocation
  // 第一件事就是 assertPeerLive(request.peer) —— peer 没传就抛
  // "Cannot read properties of undefined (reading 'signal')"。
  // 本地插件没有远程连接，自己造一个 owner peer（dsh-im 的 Xu() 也是这么做的）：
  // principal.kind = 'owner' 才不用走 remoteAccess 的资源决策。
  // 取不到就下次再试，不把 null 缓存下来；插件卸载时 dispose。
  let peer = null;
  const getPeer = () => {
    if (peer) return peer;
    try {
      const conn = typeof ctx.get === 'function' ? ctx.get('connection') : ctx.connection;
      if (conn && typeof conn.createPeer === 'function') {
        peer = conn.createPeer({ principal: { kind: 'owner' }, interactions: 'none' });
      }
    } catch (e) {
      log.warn?.('createPeer 失败', String(e));
    }
    return peer;
  };

  const call = async (namespace, method, args) => {
    const gw = gateway();
    if (!gw || typeof gw.invoke !== 'function') throw new Error('typertGateway 不可用');
    const p = getPeer();
    const request = { namespace, method, args };
    if (p) request.peer = p;
    return gw.invoke(request);
  };

  // 会话攒满换新之前，把整段历史导出成 json 存到旁边。
  // 存档不占会话，主机那边的同步脚本会把它拉回去做总结。
  const archiveSession = (sessionId) => {
    let svc = null;
    try {
      svc = typeof ctx.get === 'function' ? ctx.get('sessions') : ctx.sessions;
    } catch {
      return null;
    }
    const session = svc?.get?.(sessionId) ?? null;
    if (!session) return null;
    const total = Number(session.seq ?? 0);
    let events = [];
    try {
      events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents(0, total) : [];
    } catch {
      return null;
    }
    const dir = path.join(path.dirname(stateFile), 'bili-gate-archive');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${sessionId}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify({ sessionId, exportedAt: Date.now(), seq: total, events }),
      'utf8',
    );
    return file;
  };

  const sessions = createSessionApi({ call, store, config, log, archive: archiveSession });

  // ownerMessages 走宿主内的会话表，不走 typert：Session 对象上有 seq 和
  // snapshotEvents，能直接读到最后几百条事件，而且不需要先知道游标。
  const readOwnerEvents = (sessionId) => {
    let store2 = null;
    try {
      store2 = typeof ctx.get === 'function' ? ctx.get('sessions') : ctx.sessions;
    } catch {
      return null;
    }
    return readSessionEvents(store2, sessionId);
  };

  const gate = createGate({ config, sessions, log, readOwnerEvents });

  log.info('apply', {
    cwd: config.cwd || '(默认)',
    title: config.sessionTitle,
    dryRun: config.dryRun,
    gateway: !!gateway(),
  });

  let dispose = null;
  try {
    // 优先用 provide：它把服务登记在当前 fiber 上，插件卸载时会自动注销，
    // 重载插件也不会留下一个指向旧闭包的服务。
    if (typeof ctx.provide === 'function') {
      dispose = ctx.provide(SERVICE_NAME, gate);
    } else {
      ctx.set(SERVICE_NAME, gate);
    }
    log.info('biliEyesGate 已注册');
  } catch (e) {
    log.error('注册 biliEyesGate 失败（是不是已经有别的桥接占了？）', String(e));
  }

  return () => {
    try {
      peer?.dispose?.();
      peer = null;
    } catch {
      /* peer 已经跟着连接回收了 */
    }
    try {
      dispose?.();
    } catch {
      /* 注销失败不影响进程退出 */
    }
  };
}
