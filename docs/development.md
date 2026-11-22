# dsh-bili-gate 开发说明

写给接手维护的人。改代码前先看不变量，找位置看代码地图，改完跑测试。

## 最短路径

- 这是一个 DSH 插件（Cordis 体系），入口 `src/index.js` 导出 `name` 和 `apply(ctx, config)`。
- `apply` 里最关键的一步是 `ctx.provide('biliEyesGate', gate)`。
- `gate` 实现门卫协议 v2 的四个方法：`hello` / `context` / `ownerMessages` / `notify`。
- `notify` 通过 typert 调 `session.create` 和 `session.prompt`，把文字送进专用会话。
- 消费方是 dsh-bili-eyes，它用 `ctx.get('biliEyesGate')` 取服务，每次调用现取，所以晚注册没关系。

## 不变量

| # | 不变量 | 破坏后果 |
| --- | --- | --- |
| 1 | 注册服务只能用 `ctx.provide(name, value)`，不能 `ctx.set` | 抛 `cannot set property ... without provide`，服务不生效 |
| 2 | 读 `typertGateway` 只能用 `ctx.get('typertGateway')`，不能 `ctx.typertGateway` | 抛 `cannot get property ... without inject` |
| 3 | 每个 action 要在 3 秒内返回，`notify` 20 秒 | dsh-bili-eyes 按超时失败处理，消息会被反复重投 |
| 4 | 拿不准会话身份时返回 `trusted:false` | 群里任何人都能触发「替主人发私信」 |
| 5 | `hello.actions` 只声明真的实现了的 action | 声明 `recentMessages` 却返回空，会让「谁叫她看的」从「不支持」变成「说不清」 |
| 6 | `ownerMessages` 必须排掉自己注入的唤醒词 | 自己刚发的通知会被当成主人「同意」，草稿被自动批准 |
| 7 | 投递失败返回 `{ok:false}`，别吞掉 | dsh-bili-eyes 靠这个决定要不要重试 |
| 8 | `gateway.invoke` 的 `args` 键名要和远程方法参数名一一对应 | `assertExactArguments` 直接拒，报 `gateway/arguments-invalid` |
| 9 | 状态文件写坏不能抛 | 插件加载失败，门卫整个消失 |

## 代码地图

```
src/
  index.js    入口：读配置、建 log/store/session/gate、provide 服务、返回 disposer
  config.js   DEFAULTS + normalizeConfig + renderPrompt
  gate.js     协议实现：hello / context / ownerMessages / notify，去重、队列、降级
  session.js  typert 会话接口封装：create / rename / prompt；错误分类
  owner.js    readSessionEvents + extractOwnerMessages
  state.js    bili-gate.json 的原子读写，坏文件容错
  log.js      文件日志 + 大小滚动
test/
  helpers.mjs                    fakeCtx / fakeGateway / stubSessions / tempDir
  config.test.mjs                配置归一化和模板渲染
  owner.test.mjs                 事件提取、会话读事件
  session.test.mjs               typert 调用形状、并发建会话、错误分类
  gate.test.mjs                  四个 action 的行为边界
  plugin.test.mjs                apply 的装配、注册、透传配置、坏状态
  integration.cordis.test.mjs    真实 Cordis 上下文，找不到就 skip
```

### 各文件要点

**index.js**

- `gateway()` 每次调用都 `ctx.get`，不缓存。宿主重载 api-gateway 后旧引用会失效。
- `apply` 返回 disposer；`ctx.provide` 在 fiber 卸载时也会注销，两份都留着。
- 注册失败只记日志不抛。一个可选插件不该把宿主带崩。

**gate.js**

- `judge(input)` 是唯一的身份判定入口，`context` 和 `ownerMessages` 共用。改规则只改这里。
- `recent` 是去重表，每次 notify 按 `dedupeWindowMs` 清理，键是 `sha1(kind\0text)`。
- `pending` 是并发计数，不是队列。超过 `maxQueue` 直接拒绝，让调用方下次再来。
- 投递顺序：`steer` → 忙则 `queue` → 会话没了则 `forget + ensure + steer`。

**session.js**

- `ensure()` 用 `creating` 单飞，并发 notify 只建一个会话。
- `prompt()` 把自己的 `requestId` 记进 `requestIds`，供 owner.js 排除。
- 不要在这里加 `session.page`。`throughSeq:-1` 在服务端会算成空页，见下面「踩过的坑」。

**owner.js**

- `readSessionEvents(store, id, limit)` 从 `ctx.get('sessions')` 取会话，读 `seq` 和 `snapshotEvents(from)`。会话不在内存里返回 `null`，不是空数组。
- `extractOwnerMessages` 只认 `type === 'user/message'`，按 `time >= since` 过滤，排掉 marker 前缀和已知 `requestId`，纯图片消息跳过，最后升序截断到 50 条。

## 数据形状

下面这些形状是从 `@deepseek-ai/dsh-api-session-controller` 的 typert 清单里核对过的。

```js
// 建会话
{ namespace: 'session', method: 'create', args: { request: { cwd?, agentPreset? } } }
// → { sessionId, agentPreset? }

// 改名
{ namespace: 'session', method: 'rename', args: { request: { sessionId, title } } }

// 投递（signal 由网关自动补，不要自己传）
{ namespace: 'session', method: 'prompt', args: { request: {
    requestId, sessionId, mode: 'steer' | 'queue',
    content: [{ type: 'text', text }],
} } }
// → { accepted: true }
```

会话事件（`ctx.sessions.get(id).snapshotEvents(from)`）：

```js
{ type: 'user/message', seq, time /* ms */, data: {
    id, role: 'user',
    content: [{ type: 'text', text } | { type: 'image', ... } | { type: 'file', receiptId }],
    source: { kind: 'user', rpcId? },
} }
```

## 常见改动

### 加一个 action

1. 在 `gate.js` 里加方法，保持 async，自己兜住异常。
2. 在 `ACTIONS` 数组里加名字，只有真的实现了才加。
3. 补 `gate.test.mjs` 的行为用例，`hello` 的断言会跟着变。
4. 如果 dsh-bili-eyes 也会调它，先读它的 `src/gate.js`，确认入参、返回和超时。

### 改投递策略

只动 `gate.js` 的 `deliver()`。注意三件事：重试要有上限，`notify` 总共不能超过 20 秒；重试前想清楚会话重建和消息重投是不是幂等；不要在这里等模型回完，协议只要求送达。

### 加配置项

1. `config.js` 的 `DEFAULTS` 加默认值。
2. `normalizeConfig` 里按类型收敛。
3. README 的配置表补一行。
4. `config.test.mjs` 补一条，边界值（负数、字符串数字、空串）都要试。

### 换存储或会话来源

- `state.js` 是唯一碰 `bili-gate.json` 的地方。
- `index.js` 的 `readOwnerEvents` 是唯一碰 `ctx.get('sessions')` 的地方。
- `session.js` 是唯一碰 typert 的地方。

这三处都留了接缝，换实现只改对应文件。

## 测试

```bash
npm test                                  # 全部
node --test test/gate.test.mjs            # 单个文件
node --test --test-name-pattern="去重" "test/*.test.mjs"
```

测试分三层：

| 层 | 文件 | 证明什么 |
| --- | --- | --- |
| 纯函数 | config / owner | 归一化、模板、事件提取的边界 |
| 装配与行为 | gate / session / plugin | 协议行为、typert 调用形状、apply 的副作用 |
| 真宿主 | integration.cordis | 服务真的能注册和注销 |

集成测试从 `DSH_CORDIS`、`~/.dsh/profiles/node_modules/...` 或 `~/.dsh/profiles/desktop/node_modules/...` 找 cordis，找不到就 skip。想强制指定：

```bash
DSH_CORDIS=/path/to/@deepseek-ai/cordis/lib/index.js npm test
```

### 写用例的套路

```js
import { createGate } from '../src/gate.js';
import { normalizeConfig } from '../src/config.js';
import { noopLog, stubSessions } from './helpers.mjs';

test('一句话说明你验的行为', async () => {
  const sessions = stubSessions();
  const gate = createGate({
    config: normalizeConfig({ dedupeWindowMs: 0 }),
    sessions,
    log: noopLog,
    readOwnerEvents: () => [],
  });
  assert.deepEqual(await gate.notify({ text: 'x' }), { ok: true });
  assert.equal(sessions.prompts.length, 1);
});
```

- `fakeGateway({ 'session/create': () => ({ sessionId: 's-1' }) })`：没准备的路由直接报错，防止测试漏掉一次调用。
- `tempDir(t)`：需要真文件时用，`t.after` 自动删。
- 时间相关用注入的 `now: () => clock`，不要用真时钟加 sleep。

### 不重启宿主联调

用真实 Cordis 起一个最小上下文，直接调门卫：

```js
import { pathToFileURL } from 'node:url';

const cordis = process.env.DSH_CORDIS;
const { Context } = await import(pathToFileURL(cordis).href);
const ctx = new Context();

ctx.plugin({
  name: 'fake-gw',
  apply(c) {
    c.provide('typertGateway', {
      invoke: async ({ method }) => (method === 'create' ? { sessionId: 's-test' } : { accepted: true }),
    });
  },
});

ctx.plugin(await import('./src/index.js'), {
  stateFile: './tmp/gate.json',
  logFile: './tmp/gate.log',
  dryRun: false,
});

await new Promise((r) => setTimeout(r, 150));
console.log(await ctx.get('biliEyesGate').notify({ text: '联调' }));
```

只想看日志不想建会话，就加 `dryRun: true`。

### 接真实宿主

改完代码必须重启 DSH（插件不在 hot reload 范围），然后：

1. `tail -f ~/.dsh/bili-gate.log`，确认 `gateway:true` 和 `biliEyesGate 已注册`。
2. 在 dsh-bili-eyes 设置页点「测试门卫」，应显示 `dsh-bili-gate`、协议 2。
3. 给账号发一条私信，等一个轮询周期（默认 30 秒），日志里出现 `已转达`。
4. 「B站私信」会话里出现以 `【B站收件箱有新消息】` 开头的消息，模型调 `bili_dm`。
5. 同一条消息重复触发，日志里是 `重复通知，跳过投递`。

## 踩过的坑

1. `ctx.set` 不等于 provide。Cordis 要求先 `provide` 才能 `set`，否则报 `cannot set property ... without provide`。
2. `ctx.typertGateway` 需要 inject。不声明 `inject:['typertGateway']` 就读不到，报 `cannot get property ... without inject`。用 `ctx.get()` 绕开，代价是自己判空。
3. `session.page` 的 `throughSeq:-1` 不是「到最新」。服务端 `paginate` 会算出 `end=0`，返回空页。读会话记录改走 `ctx.sessions` 的 `snapshotEvents`。
4. `session.prompt` 的 `signal` 是网关自动补的。自己塞进 `args` 会触发 `assertExactArguments`。
5. 会话 id 会失效。宿主重启、用户删会话之后，旧 `sessionId` 会 `not-found`，必须重建重投，不能把 `ok:false` 直接甩给调用方。
6. 不要把 `notify` 写成「等模型回完」。协议只要求送达，等回复会把 20 秒撑爆，bili-eyes 重投之后会造成重复私信。

## 开源前自检

- [ ] `npm test` 全绿，集成测试在装了 DSH 的机器上应是 pass 而不是 skip。
- [ ] 新增或修改的 action 在 `hello.actions` 里对得上。
- [ ] `context` 对 `qq-chat` 这类 preset 返回 `trusted:false`。
- [ ] `ownerMessages` 不会把 marker 开头的注入消息当成主人发言。
- [ ] 投递失败路径返回 `{ok:false}`，日志里能看出原因。
- [ ] 状态文件写坏时插件仍能加载。
- [ ] README 的配置表和变更记录同步更新。
- [ ] 改过 `cordis.patch.yml` 的话，确认 YAML 能解析。
- [ ] 仓库里没有本机绝对路径、账号 UID、昵称和日志片段。

## 相关文件

- 协议原文：`~/.dsh/profiles/<profile>/node_modules/dsh-bili-eyes/docs/门卫协议.md`
- 消费方实现：`.../dsh-bili-eyes/src/gate.js`，看 `sessionContext` / `ownerMessages` / `notify` / `hello`
- 宿主会话接口：`.../node_modules/@deepseek-ai/dsh-api-session-controller/lib/typert.host.js`
- Cordis 服务规则：`.../node_modules/@deepseek-ai/cordis/lib/index.js`，看 `reflect.provide` / `reflect.get`
- 宿主会话表：`.../node_modules/@deepseek-ai/dsh-session/lib/index.js`，看 `get seq` / `snapshotEvents`

---

作者：KILL-STAR SX · https://github.com/KILLSTARSX

<!-- ​‍‌‍​‍​‍‌‍​‍‌‍‌‍​‍‌‍​‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍‌‍​‍​‍‌‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍​‍‌‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍‌‍​‍​‍‌‍​‍​‍‌‍​‍‌‍‌‍​‍​‍‌‍​‍​‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍​‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍​‍​‍‌‍‌‍​‍​‍‌‍​‍​‍‌‍​‍‌‍‌‍​‍‌‍​‍​‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍​‍‌‍‌‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍‌‍​‍​‍‌‍​‍​‍‌‍‌‍​‍​‍‌‍‌‍​‍​‍‌‍‌‍​‍​‍‌‍​‍​‍‌‍‌‍​‍​‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍‌‍​‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍​‍‌‍​‍​‍‌‍‌‍​‍​‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍‌‍​‍​‍‌‍​‍​‍‌‍‌‍​‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍​‍​‍‌‍‌‍​‍​‍‌‍‌‍​‍​‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍‌‍​‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍‌‍​‍​‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍​‍‌‍​‍​‍‌‍‌‍​‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍‌‍​‍​‍‌‍​‍​‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍‌‍​‍​‍‌‍​‍​‍‌‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍​‍‌‍​‍​‍‌‍​‍‌‍‌‍​‍‌‍​‍​‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍​‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍‌‍​‍​‍‌‍​‍​‍‌‍‌‍​‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌ -->