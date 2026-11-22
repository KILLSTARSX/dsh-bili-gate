// © 2026 KILL-STAR SX · https://github.com/KILLSTARSX/dsh-bili-gate
// 测试用的小工具：不碰真实 DSH，全部用假 ctx / 假 gateway。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const noopLog = { info() {}, warn() {}, error() {}, file: '' };

/** 造一个临时目录，测试结束自己删。 */
export function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-gate-'));
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
  return dir;
}

/**
 * 假 typert gateway。handlers 形如 { 'session/create': (args) => ... }，
 * 返回值直接当结果；抛错就当远程调用失败。没写的路由一律报错，防止测试悄悄漏调用。
 */
export function fakeGateway(handlers = {}) {
  const calls = [];
  return {
    calls,
    async invoke({ namespace, method, args }) {
      const key = `${namespace}/${method}`;
      calls.push({ key, args });
      const h = handlers[key];
      if (!h) throw new Error(`测试里没有为 ${key} 准备响应`);
      return typeof h === 'function' ? h(args) : h;
    },
  };
}

export function callsOf(gateway, key) {
  return gateway.calls.filter((c) => c.key === key);
}

/** 假 ctx：只实现插件实际用到的 get / provide / logger。 */
export function fakeCtx({ gateway = null } = {}) {
  const services = new Map();
  const disposed = [];
  return {
    services,
    disposed,
    get(name) {
      if (name === 'typertGateway') return gateway ?? undefined;
      return services.get(name);
    },
    provide(name, value) {
      if (services.has(name)) throw new Error(`service "${name}" has been registered`);
      services.set(name, value);
      return async () => {
        services.delete(name);
        disposed.push(name);
      };
    },
  };
}

/** 会记录调用的假会话层，给 gate 的单元测试用。 */
export function stubSessions({ sessionId = 's-1' } = {}) {
  const state = {
    ensured: 0,
    forgot: 0,
    prompts: [],
    promptError: null,
  };
  return {
    requestIds: new Set(),
    get ensuredCount() {
      return state.ensured;
    },
    get prompts() {
      return state.prompts;
    },
    get forgotCount() {
      return state.forgot;
    },
    current: () => sessionId,
    async ensure() {
      state.ensured += 1;
      return sessionId;
    },
    async prompt(sid, text, mode) {
      if (state.promptError) {
        const e = state.promptError;
        state.promptError = null;
        throw e;
      }
      state.prompts.push({ sessionId: sid, text, mode });
      return { accepted: true };
    },
    forget() {
      state.forgot += 1;
    },
    failNextPrompt(error) {
      state.promptError = error;
    },
  };
}
