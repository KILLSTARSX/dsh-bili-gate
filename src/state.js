// 状态：目前只有一个 sessionId（外加创建时间、版本号）。
// 写坏了不能把插件带崩 —— 读失败就当空的，下次重建会话。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const STATE_VERSION = 2;

export function defaultStateFile() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'bili-gate.json');
}

export function createStore({ file = defaultStateFile(), log } = {}) {
  let cache = null;

  const read = () => {
    if (cache) return cache;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      cache = raw && typeof raw === 'object' ? raw : {};
    } catch {
      cache = {};
    }
    return cache;
  };

  const write = (next) => {
    cache = next;
    const tmp = `${file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ ...next, version: STATE_VERSION }, null, 2));
      fs.renameSync(tmp, file);
    } catch (e) {
      log?.error?.('状态写入失败', String(e));
    }
  };

  return {
    file,
    get: () => ({ ...read() }),
    /** 合并写入。 */
    patch: (delta) => write({ ...read(), ...delta }),
    /** 清掉会话记录（会话被删了、或投递时发现 sessionId 无效）。 */
    clearSession: () => {
      const next = { ...read() };
      delete next.sessionId;
      delete next.createdAt;
      delete next.promptCount;
      write(next);
    },
    /** 测试用：丢掉内存缓存，强制下次重新读盘。 */
    reload: () => {
      cache = null;
      return read();
    },
  };
}
