// 从会话事件里捞「主人自己说了什么」。
// 门卫协议里 ownerMessages 的用途：草稿发出前确认主人在草稿之后说过「可以」。
// 这里只负责把会话记录翻成人话，判不判断同意是 dsh-bili-eyes 的事。
//
// 两个坑：
//   1. 我们自己 notify 注入的唤醒词也会以 user/message 落进会话，必须排掉，
//      否则主人还没说话，草稿就被自己的通知「同意」了。
//   2. 事件里的 time 是毫秒时间戳，和 since 同一单位。

/**
 * 从宿主的 ctx.sessions 里取一个会话最近的事件。
 * Session 对象上公开的是 seq（事件总数）和 snapshotEvents(fromSeq, toSeqExclusive?)。
 * 会话不在内存里（没被 resume 过）时返回 null —— 这种时候就是读不到，别假装读到了。
 * @returns {Array|null}
 */
export function readSessionEvents(store, sessionId, limit = 400) {
  let session = null;
  try {
    session = store?.get?.(sessionId) ?? null;
  } catch {
    return null;
  }
  if (!session) return null;
  const total = Number(session.seq ?? session.log?.length ?? 0);
  if (!Number.isFinite(total) || total < 0) return null;
  const from = Math.max(0, total - Math.max(1, limit));
  try {
    if (typeof session.snapshotEvents === 'function') return session.snapshotEvents(from);
    const log = Array.isArray(session.log) ? session.log : [];
    return log.slice(from);
  } catch {
    return null;
  }
}

/** 内容块数组 → 纯文本。只取 text，图片/文件留个占位。 */
export function blocksToText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text);
    else if (b.type === 'image') parts.push('[图片]');
    else if (b.type === 'file') parts.push('[文件]');
  }
  return parts.join('\n').trim();
}

/**
 * @param {Array} records session.page 返回的 records（每项形如 {type:'event', event:{...}}）
 * @param {{since?:number, marker?:string, requestIds?:Set<string>, limit?:number}} opts
 * @returns {{at:number, text:string}[]} 按时间升序
 */
export function extractOwnerMessages(records, opts = {}) {
  const since = Number(opts.since) || 0;
  const marker = opts.marker || '';
  const requestIds = opts.requestIds instanceof Set ? opts.requestIds : new Set();
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : 50;
  const out = [];

  for (const record of records ?? []) {
    const ev = record?.event ?? record;
    if (!ev || ev.type !== 'user/message') continue;
    const at = Number(ev.time) || 0;
    if (at < since) continue;
    const data = ev.data ?? {};
    const rpcId = data?.source?.rpcId;
    if (rpcId && requestIds.has(String(rpcId))) continue; // 自己注入的
    const text = blocksToText(data.content);
    if (!text) continue;
    // 只有图片/文件的消息没有可读内容，判不了「同意」，直接跳过
    if (/^(?:\[(?:图片|文件)\]\s*)+$/.test(text)) continue;
    if (marker && text.startsWith(marker)) continue; // 老版本注入的，没留 requestId
    out.push({ at, text });
  }

  out.sort((a, b) => a.at - b.at);
  return out.length > limit ? out.slice(-limit) : out;
}
