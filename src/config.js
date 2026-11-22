// 配置：把 cordis.patch.yml 里那一小块 config 归一化。
// 刻意不依赖 @deepseek-ai/schemastery —— 插件是 link 进 profile 的，
// 从插件真实路径解析不到 profile 的 node_modules，多一个依赖就多一次装不上。

export const DEFAULTS = {
  // 新建会话的工作目录。留空 = 交给 DSH 决定（默认工作区）。
  cwd: '',
  // 新建会话用的 agent preset。留空 = 用 profile 的默认 preset。
  agentPreset: '',
  // 建完会话顺手改个名字，方便在侧栏里认出来。
  sessionTitle: 'B站私信',
  // 主人 UID。0 = 不在唤醒词里提 UID。
  ownerMid: 0,
  // 唤醒词开头。也用来把「自己注入的通知」和「主人手打的话」区分开。
  marker: '【B站收件箱有新消息】',
  // 唤醒词模板。占位符：{marker} {text} {ownerMid} {ownerHint} {kind}
  // 只留 marker + 原文：bili-eyes 的正文里已经写好了怎么办（看详情、回复、标记），
  // 再加一层指令只是把会话撑长，模型也未必听。
  promptTemplate: '{marker} {text}',
  // 哪些 agentPreset 算桥接会话（不可信）。和 dsh-bili-eyes 的默认值保持一致。
  untrustedPresets: 'qq|wechat|weixin|wx|onebot|napcat|bot|group',
  // 哪些工作目录下算桥接会话（不可信）。一行一个，留空 = 不按目录判断。
  untrustedCwd: '',
  // 同一条通知在这个窗口内只投递一次（bili-eyes 转达失败会重试）。
  dedupeWindowMs: 60_000,
  // 单条通知正文上限，超了截断。bili-eyes 的通知本身带一长串前缀，400 够放了。
  maxTextLength: 400,
  // 排队上限。超了直接返回 ok:false，让 bili-eyes 下次再试。
  maxQueue: 20,
  // 同一个会话攒到这么多条消息就换一个新的，免得每次调用都重发整段历史。
  sessionMaxPrompts: 100,
  // 日志超过这个大小就滚成 .1。
  logMaxBytes: 1_048_576,
  // 空跑：只记日志，不建会话、不投递。本地联调时用。
  dryRun: false,
  // 覆盖状态/日志路径（测试用，留空 = $DSH_HOME/bili-gate.json）。
  stateFile: '',
  logFile: '',
};

function str(v, def) {
  return typeof v === 'string' ? v : v == null ? def : String(v);
}

function bool(v, def) {
  if (typeof v === 'boolean') return v;
  if (v === 'true' || v === 1 || v === '1') return true;
  if (v === 'false' || v === 0 || v === '0') return false;
  return def;
}

function int(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  const i = Math.trunc(n);
  if (i < min) return min;
  return max == null ? i : Math.min(i, max);
}

/**
 * 合并默认值并做类型收敛。永远返回一份新对象，不修改入参。
 * @param {object|undefined} raw
 * @returns {typeof DEFAULTS}
 */
export function normalizeConfig(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const key of Object.keys(DEFAULTS)) {
    const def = DEFAULTS[key];
    if (typeof def === 'boolean') out[key] = bool(r[key], def);
    else if (typeof def === 'number') out[key] = int(r[key], def, 0, null);
    else out[key] = str(r[key], def);
  }
  out.ownerMid = int(r.ownerMid, DEFAULTS.ownerMid, 0, null);
  out.dedupeWindowMs = int(r.dedupeWindowMs, DEFAULTS.dedupeWindowMs, 0, null);
  out.maxTextLength = int(r.maxTextLength, DEFAULTS.maxTextLength, 100, null);
  out.maxQueue = int(r.maxQueue, DEFAULTS.maxQueue, 1, null);
  out.logMaxBytes = int(r.logMaxBytes, DEFAULTS.logMaxBytes, 4096, null);
  if (!out.marker) out.marker = DEFAULTS.marker;
  if (!out.promptTemplate) out.promptTemplate = DEFAULTS.promptTemplate;
  // cwd 末尾的分隔符去掉，方便后面做前缀比较
  out.cwd = out.cwd.replace(/[\\/]+$/, '');
  return out;
}

/** 把模板里的占位符换掉。认不出的占位符原样留着，方便排查。 */
export function renderPrompt(config, { text, kind = 'inbox' }) {
  const ownerHint = config.ownerMid > 0 ? `（UID ${config.ownerMid}）` : '';
  return config.promptTemplate
    .replaceAll('{marker}', config.marker)
    .replaceAll('{text}', text)
    .replaceAll('{ownerMid}', String(config.ownerMid))
    .replaceAll('{ownerHint}', ownerHint)
    .replaceAll('{kind}', kind);
}
