// © 2026 KILL-STAR SX · https://github.com/KILLSTARSX/dsh-bili-gate
// 对 typert 会话接口的一层薄封装。
// 参数形状是硬约束：gateway.invoke 的 args 必须和远程方法声明的参数名逐一对应，
// 多一个少一个都会在 assertExactArguments 里被拒。所以这里集中写死、别处不再拼：
//   session.create({ request: { cwd?, agentPreset? } })
//   session.rename({ request: { sessionId, title } })
//   session.prompt({ request: { requestId, sessionId, mode, content } })
//
// 注意：session.page 的 throughSeq 不接受 -1 当「到最新」用（服务端会算出空页），
// 读会话记录改走宿主内的 ctx.sessions（见 owner.js），别在这里加回来。
import { randomUUID } from 'node:crypto';

export function createSessionApi({ call, store, config, log, uuid = randomUUID, archive = null }) {
  let creating = null; // 同一时刻只建一次，避免并发 notify 各建一个会话
  const requestIds = new Set(); // 自己注入过的 prompt id，ownerMessages 要排掉

  async function create() {
    const request = {};
    if (config.cwd) request.cwd = config.cwd;
    if (config.agentPreset) request.agentPreset = config.agentPreset;
    const r = await call('session', 'create', { request });
    const sessionId = r?.sessionId ?? null;
    if (!sessionId) throw new Error(`session.create 没有返回 sessionId：${JSON.stringify(r)}`);
    store.patch({ sessionId, createdAt: Date.now() });
    log?.info?.('已创建会话', sessionId);
    if (config.sessionTitle) {
      try {
        await call('session', 'rename', { request: { sessionId, title: config.sessionTitle } });
      } catch (e) {
        // 改不了名字不影响用，最多是侧栏里认不出来
        log?.warn?.('会话改名失败', String(e));
      }
    }
    return sessionId;
  }

  async function ensure() {
    const st = store.get();
    if (st.sessionId) {
      const used = Number(st.promptCount) || 0;
      if (config.sessionMaxPrompts > 0 && used >= config.sessionMaxPrompts) {
        // 攒够了：先把这段对话导出归档，再换新的。直接 clear 会把历史整个丢掉。
        log?.info?.('会话攒满，先归档再换新的', used);
        if (typeof archive === 'function') {
          try {
            const file = await archive(st.sessionId);
            if (file) log?.info?.('已归档', file);
          } catch (e) {
            log?.warn?.('归档失败，照样换新会话', String(e));
          }
        }
        store.clearSession();
      } else {
        return st.sessionId;
      }
    }
    if (creating) return creating;
    creating = create().finally(() => {
      creating = null;
    });
    return creating;
  }

  async function prompt(sessionId, text, mode = 'steer') {
    const requestId = uuid();
    requestIds.add(requestId);
    if (requestIds.size > 500) {
      // 只留最近的，防止长跑之后无限涨
      const keep = [...requestIds].slice(-200);
      requestIds.clear();
      for (const id of keep) requestIds.add(id);
    }
    const r = await call('session', 'prompt', {
      request: { requestId, sessionId, mode, content: [{ type: 'text', text }] },
    });
    // 记一笔：攒够了 ensure() 会换会话。
    const used = Number(store.get().promptCount) || 0;
    store.patch({ promptCount: used + 1 });
    return r;
  }

  return {
    ensure,
    prompt,
    forget: () => store.clearSession(),
    current: () => store.get().sessionId ?? '',
    requestIds,
  };
}

/** 会话被删 / 宿主重启后残留的 id：值得重建一次再试。 */
export function isMissingSessionError(e) {
  const s = `${e?.code ?? ''} ${e?.message ?? e}`;
  return /not-found|not found|no longer|disposed|unknown session|会话不存在/i.test(s);
}

/** 会话正忙：steer 插不进去时退成 queue。 */
export function isBusyError(e) {
  const s = `${e?.code ?? ''} ${e?.message ?? e}`;
  return /agent-busy|busy|steer-unavailable/i.test(s);
}
