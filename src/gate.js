// © 2026 KILL-STAR SX · https://github.com/KILLSTARSX/dsh-bili-gate
// build: 1ca433438bad1131 ​‍‌‍​‍​‍‌‍​‍‌‍‌‍​‍‌‍​‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍‌‍​‍​‍​‍‌‍​‍​‍‌‍‌‍​‍​‍​‍​‍‌‍​‍‌‍‌‍​‍‌‍​‍‌‍​‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍‌‍​‍‌‍​‍​‍​‍‌‍​‍​‍​‍​‍​‍‌‍​‍‌‍​‍‌‍​‍​‍‌‍​‍​‍​‍‌‍​‍​‍​‍​‍​‍​‍‌‍​‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍‌‍‌‍​‍​‍​‍​‍​‍‌‍​‍​‍​‍​‍​‍​‍​‍‌‍​‍‌‍‌‍‌‍‌‍​‍​‍‌‍​‍​‍​‍​‍​‍​‍‌‍‌‍​‍​‍‌‍​‍​‍​‍‌‍‌‍‌‍​‍​‍‌‍‌‍​‍‌‍‌‍​‍‌‍​‍​‍​‍​‍​‍‌‍​‍‌‍‌‍​‍‌‍​‍‌‍‌‍​‍​‍​‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍​‍‌‍​‍‌‍‌‍​‍‌‍‌‍​‍​‍​‍‌‍‌‍​‍‌‍​‍​‍‌‍​‍​‍‌‍​‍‌‍‌‍​‍‌‍​‍‌‍‌‍​‍​‍‌‍‌‍‌‍​‍‌‍‌‍​‍​‍​‍​‍‌‍​‍‌‍‌‍‌‍​‍‌‍​‍​‍​‍‌‍‌‍​‍​‍‌‍​‍‌
// 门卫协议 v2 的实现（动作：hello / context / ownerMessages / notify）。
// 协议原文见 dsh-bili-eyes 的 docs/门卫协议.md，这里只挑这个桥接用得到的部分。
// 约束：每个方法要在 3 秒内返回（notify 是 20 秒），超时 dsh-bili-eyes 按失败处理。
import { createHash } from 'node:crypto';
import { renderPrompt } from './config.js';
import { extractOwnerMessages } from './owner.js';
import { isBusyError, isMissingSessionError } from './session.js';

const PROTOCOL = 2;
const ACTIONS = ['hello', 'context', 'ownerMessages', 'notify'];

/**
 * bili-eyes 的通知开头是「B站小号刚收到 N 条新消息（22:46，是新消息，不是过期提醒）：」，
 * 这串机器话模型用不上，能去掉就去掉 —— 不然会话里每条消息都顶着一长串前缀。
 * 格式对不上就原样返回，不硬猜。
 */
export function tidyText(text) {
  const t = String(text ?? '').trim();
  const cleaned = t
    // bili-eyes 的机器话前缀
    .replace(/^B站[^：\n]{0,40}刚收到\s*\d+\s*条新消息[^：\n]{0,40}：\s*/u, '')
    // 每条前面的收件箱编号 [d123456-2674423136133127]，模型看见了会拿它当话讲
    .replace(/^\s*\[d\d+-\d+\]\s*/gmu, '')
    .trim();
  return cleaned || t;
}

export function createGate({ config, sessions, log, readOwnerEvents, now = Date.now }) {
  const recent = new Map(); // 去重：通知指纹 → 上次成功的毫秒时间
  const inflight = new Set(); // 正在投递的指纹：重试撞上第一次还没投完时别再投一遍
  let pending = 0;
  let untrustedRe = null;
  let untrustedReSrc = '';

  function untrustedRegex() {
    if (untrustedRe && untrustedReSrc === config.untrustedPresets) return untrustedRe;
    untrustedReSrc = config.untrustedPresets;
    try {
      untrustedRe = new RegExp(config.untrustedPresets || '$^', 'i');
    } catch (e) {
      log?.warn?.('untrustedPresets 不是合法正则，退回不按 preset 判断', String(e));
      untrustedRe = /$^/;
    }
    return untrustedRe;
  }

  /** 统一成小写、正斜杠、不带尾斜杠，两个目录才比得准。 */
  const normDir = (value) =>
    String(value ?? '')
      .trim()
      .replace(/\\/g, '/')
      .replace(/\/+$/, '')
      .toLowerCase();

  const untrustedDirs = () =>
    String(config.untrustedCwd || '')
      .split(/\r?\n/)
      .map(normDir)
      .filter(Boolean);

  /** 这个会话是不是主人本人。拿不准一律不可信 —— 协议里就是这么规定的。 */
  function judge(input = {}) {
    const sessionId = String(input.sessionId ?? '');
    const preset = String(input.session?.agentPreset ?? '');
    const cwd = normDir(input.session?.cwd);

    if (sessionId && sessionId === sessions.current()) {
      return { trusted: true, label: 'B站私信（主人）' };
    }
    if (preset && untrustedRegex().test(preset)) {
      return { trusted: false, label: `桥接会话（${preset}）` };
    }
    const dir = cwd && untrustedDirs().find((d) => cwd === d || cwd.startsWith(`${d}/`));
    if (dir) return { trusted: false, label: '桥接会话（工作目录）' };
    return { trusted: true, label: preset ? `本机会话（${preset}）` : '本机会话' };
  }

  function pruneDedupe(t) {
    if (config.dedupeWindowMs <= 0) {
      recent.clear();
      return;
    }
    for (const [k, at] of recent) {
      if (t - at >= config.dedupeWindowMs) recent.delete(k);
    }
  }

  function fingerprint(kind, text) {
    return createHash('sha1').update(`${kind}\u0000${text}`).digest('hex');
  }

  async function deliver(text) {
    let sid = await sessions.ensure();
    try {
      await sessions.prompt(sid, text, 'steer');
      return sid;
    } catch (e) {
      if (isBusyError(e)) {
        log?.warn?.('会话正忙，改成排队投递', String(e));
        await sessions.prompt(sid, text, 'queue');
        return sid;
      }
      if (!isMissingSessionError(e)) throw e;
      log?.warn?.('会话已失效，重建后重投', String(e));
      sessions.forget();
      sid = await sessions.ensure();
      await sessions.prompt(sid, text, 'steer');
      return sid;
    }
  }

  return {
    async hello() {
      return { protocol: PROTOCOL, actions: [...ACTIONS], name: 'dsh-bili-gate' };
    },

    async context(input) {
      const r = judge(input);
      log?.info?.('context', input?.sessionId ?? '?', r.trusted ? 'trusted' : 'untrusted', r.label);
      return r;
    },

    async ownerMessages(input = {}) {
      const since = Number(input.since) || 0;
      const sessionId = String(input.sessionId ?? '');
      if (!sessionId || sessionId === 'gate-test') return { messages: [] };
      if (!judge(input).trusted) return { messages: [] }; // 别人的会话不翻
      if (typeof readOwnerEvents !== 'function') return { messages: [] };
      try {
        const events = readOwnerEvents(sessionId);
        if (!events) return { messages: [] }; // 会话不在内存里，读不到
        return { messages: extractOwnerMessages(events, { since, marker: config.marker, requestIds: sessions.requestIds }) };
      } catch (e) {
        log?.warn?.('ownerMessages 读会话失败', String(e));
        return { messages: [] };
      }
    },

    async notify(input = {}) {
      const kind = typeof input?.kind === 'string' && input.kind ? input.kind : 'inbox';
      const raw = tidyText(typeof input?.text === 'string' ? input.text : '');
      if (!raw) return { ok: false, reason: 'empty-text' };
      const text = raw.length > config.maxTextLength ? `${raw.slice(0, config.maxTextLength)}…（已截断）` : raw;

      if (config.dryRun) {
        log?.info?.('dryRun notify', kind, text.slice(0, 120));
        return { ok: true, dryRun: true };
      }

      const t = now();
      pruneDedupe(t);
      const key = fingerprint(kind, text);
      const last = recent.get(key);
      if (last != null) {
        log?.info?.('重复通知，跳过投递', kind, text.slice(0, 60));
        return { ok: true, deduped: true };
      }

      if (inflight.has(key)) {
        // 不能回 ok：调用方会把条目标成「已转达」而不再重试，
        // 万一第一次投递最后失败了，这条消息就真丢了。
        log?.info?.('同一条通知正在投递，让调用方稍后再试', kind);
        return { ok: false, reason: 'in-flight' };
      }

      if (pending >= config.maxQueue) {
        log?.warn?.('投递队列已满，让调用方稍后重试', pending);
        return { ok: false, reason: 'queue-full' };
      }

      pending += 1;
      inflight.add(key);
      try {
        const sid = await deliver(renderPrompt(config, { text, kind }));
        recent.set(key, now());
        log?.info?.('已转达', kind, `session=${sid}`, text.slice(0, 80));
        return { ok: true };
      } catch (e) {
        log?.error?.('转达失败', String(e));
        return { ok: false, reason: 'deliver-failed' };
      } finally {
        inflight.delete(key);
        pending -= 1;
      }
    },
  };
}
