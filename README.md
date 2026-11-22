# dsh-bili-gate

给 [dsh-bili-eyes](https://github.com/QiuYeDx/dsh-bili-eyes) 用的进程内门卫，协议 v2。

B 站收件箱有新消息时，dsh-bili-eyes 调 `notify`。这个插件把正文送进一个专用的 DSH 会话，模型看到后自己决定回不回、怎么回。回复走 `bili_dm`，那是 dsh-bili-eyes 注册的工具。

插件不连 B 站，也不调任何模型 API。它只碰宿主的会话接口（typert）和会话表（`ctx.sessions`）。

```
B站收件箱 ──► dsh-bili-eyes（轮询、解析）
                    │ notify(text)
                    ▼
              dsh-bili-gate ──► session.prompt ──► 「B站私信」会话里的模型
                    ▲                                      │ bili_dm
                    └──────────── dsh-bili-eyes ◄──────────┘
```

## 它解决什么

dsh-bili-eyes 做写操作前要回答两个问题：当前会话是不是主人本人、主人有没有在草稿之后同意。答案由门卫提供。它先找进程内服务 `biliEyesGate`（这个插件），没有就试本机 HTTP 门卫，最后按 `agentPreset` / `cwd` 猜。

没装门卫时，收件箱的新消息只能留在设置页里等人看；装上以后消息进会话，模型能当场回。

### 服务注册

Cordis 对服务的读写有硬约束，0.1.0 在这里翻过车：

```
cannot get property "typertGateway" without inject
cannot set property "biliEyesGate" without provide
```

现在注册走 `ctx.provide('biliEyesGate', gate)`，fiber 卸载时自动注销；`typertGateway` 用 `ctx.get('typertGateway')` 每次现取，所以 api-gateway 晚一点加载也没关系。注册代码在 `src/index.js`。

## 安装

插件以 link 方式装进 profile，不走 npm。

```bash
git clone https://github.com/KILLSTARSX/dsh-bili-gate ~/.dsh/plugins/dsh-bili-gate
```

Windows 上把目标路径换成 `C:/Users/<你>/.dsh/plugins/dsh-bili-gate`。

编辑 profile 的 `package.json`（`~/.dsh/profiles/<profile>/package.json`），加两处：

```json
{
  "dependencies": {
    "dsh-bili-gate": "link:C:/Users/<你>/.dsh/plugins/dsh-bili-gate"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-bili-gate"]
    }
  }
}
```

装链接，重启 DSH：

```bash
cd ~/.dsh/profiles/<profile> && pnpm install
```

插件不在 HMR 的监听范围里，改代码和改配置都要重启。

### 确认装上了

```bash
tail -n 20 ~/.dsh/bili-gate.log
```

日志里应该有两行：

```
[info] apply {"cwd":"(默认)","title":"B站私信","dryRun":false,"gateway":true}
[info] biliEyesGate 已注册
```

`gateway:false` 表示 `typertGateway` 当时还没就绪。门卫仍然注册成功，notify 时会再取一次。如果一直是 false，看 profile 的 bundles 里有没有 `@deepseek-ai/dsh-api-gateway`（base 包自带）。

### 依赖

- DSH 0.2 系列（0.1.5-rc.1 上也跑过），需要 `typertGateway` 服务。
- dsh-bili-eyes ≥ 0.8.0（协议 v2），0.8.3 上测过。
- Node ≥ 20，只用内置模块，零运行时依赖。

## 配置

配置写在 bundle patch 的 `config` 里（`cordis.patch.yml`）。想单独覆盖，就在自己的 profile patch 里用同一个 id 再写一段：

```yaml
- id: dsh-bili-gate
  config:
    cwd: 'D:/work'
    sessionTitle: B站私信
```

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `cwd` | `''` | 新建会话的工作目录。空 = 用 DSH 的默认工作区 |
| `agentPreset` | `''` | 新建会话用的 preset。空 = profile 默认 |
| `sessionTitle` | `B站私信` | 建完会话顺手改名，方便在侧栏找到 |
| `ownerMid` | `0` | 只在 `promptTemplate` 用了 `{ownerHint}` 时出现；0 = 不带 UID |
| `marker` | `【B站收件箱有新消息】` | 唤醒词开头，也用来排除自己注入的消息 |
| `promptTemplate` | `{marker} {text}` | 占位符：`{marker}` `{text}` `{ownerMid}` `{ownerHint}` `{kind}` |
| `untrustedPresets` | `qq\|wechat\|weixin\|wx\|onebot\|napcat\|bot\|group` | 正则；命中的 preset 算桥接会话 |
| `untrustedCwd` | `''` | 一行一个目录；落在下面的会话算桥接 |
| `dedupeWindowMs` | `60000` | 同一条通知在这个窗口内只投一次，0 = 不去重 |
| `maxTextLength` | `400` | 单条正文上限，超了截断 |
| `maxQueue` | `20` | 同时投递的上限，超了返回 `ok:false` |
| `sessionMaxPrompts` | `100` | 同一会话攒到这么多条就归档并换新的 |
| `logMaxBytes` | `1048576` | 日志超过就滚成 `.1` |
| `dryRun` | `false` | 只记日志，不建会话、不投递 |
| `stateFile` | `''` | 空 = `$DSH_HOME/bili-gate.json` |
| `logFile` | `''` | 空 = 状态文件旁边的 `bili-gate.log` |

默认模板就一行 `{marker} {text}`。bili-eyes 的正文里已经写清楚要做什么，再叠一层指令只会把会话撑长。

## 门卫协议 v2

dsh-bili-eyes 每次调用传 `{ action, ... }`，插件返回同名异步方法的结果。每个 action 要在 3 秒内返回，`notify` 放宽到 20 秒，超时按失败算。

| action | 入参 | 返回 | 行为 |
| --- | --- | --- | --- |
| `hello` | `{protocol:2}` | `{protocol, actions, name}` | 报协议 2。`actions` 里没有 `recentMessages`——门卫看不到群聊上下文，不假装知道 |
| `context` | `{sessionId, session}` | `{trusted, label}` | 判断会话是不是主人本人 |
| `ownerMessages` | `{sessionId, since, session}` | `{messages:[{at,text}]}` | 从宿主会话表里取主人说过的话，排掉自己注入的唤醒词 |
| `notify` | `{kind, text, items}` | `{ok}` | 去重、排队、建会话、`session.prompt` |

### 可信判定

```
sessionId === 门卫当前会话        → trusted（B站私信（主人））
agentPreset 命中 untrustedPresets → 不可信（桥接会话（qq-chat））
cwd 落在 untrustedCwd 下面        → 不可信（桥接会话（工作目录））
其它                              → trusted（本机会话（standard））
```

拿不准一律不可信。群聊里谁都能说话，把群会话当主人就会替主人发私信。

### 投递过程

```
notify
  ├─ 空正文 ─────────────────────────► {ok:false, reason:'empty-text'}
  ├─ dryRun ────────────────────────► {ok:true, dryRun:true}
  ├─ 窗口内重复 ────────────────────► {ok:true, deduped:true}
  ├─ 同一条还在投 ──────────────────► {ok:false, reason:'in-flight'}
  ├─ 队列满 ────────────────────────► {ok:false, reason:'queue-full'}
  └─ 投递
       ├─ 有 sessionId 就复用，没有就 create（并发只建一个）
       ├─ prompt(steer)
       ├─ 会话忙（agent-busy）──────► 改成 prompt(queue)，不丢消息
       ├─ 会话没了（not-found）─────► 清状态、重建、重投一次
       └─ 还失败 ───────────────────► {ok:false, reason:'deliver-failed'}（下次重试）
```

`in-flight` 和 `queue-full` 故意返回 `ok:false`：调用方收到 `ok:true` 就会把条目标成「已转达」，这次投递万一最后失败，消息就丢了。宁可让它下次再来。

## 文件与状态

| 路径 | 内容 |
| --- | --- |
| `~/.dsh/bili-gate.json` | `{sessionId, createdAt, promptCount, version}`，写坏了当空状态，下次重建 |
| `~/.dsh/bili-gate.log` | 运行日志，超过 1 MB 滚成 `.1` |
| `~/.dsh/bili-gate-archive/` | 会话攒满时导出的 `<sessionId>.json` |

删掉 `bili-gate.json` 等于下次通知重新建一个会话，不影响 B 站账号。登录态在 `~/.dsh/bili-eyes/`，归 dsh-bili-eyes 管。

## 排障

先看日志：

```bash
tail -n 50 ~/.dsh/bili-gate.log
```

| 日志或现象 | 原因 | 处理 |
| --- | --- | --- |
| `cannot get property "typertGateway" without inject` | 0.1.0 的旧写法 | 升到 0.2.x |
| `cannot set property "biliEyesGate" without provide` | 0.1.0 的旧写法 | 同上 |
| `注册 biliEyesGate 失败` | 别的插件占了同名服务 | 只能留一个，关掉另一个或改它的 `SERVICE_NAME` |
| `gateway:false` 一直不恢复 | api-gateway 没加载，或插件比它早 | 确认 base bundle 完整；notify 时会重取 |
| `转达失败 typertGateway 不可用` | 宿主没起网关 | 查 DSH 启动，宿主问题 |
| `agent-busy` 反复出现 | 会话一直忙 | 已自动退成 queue；频繁出现说明模型在长任务里，属正常排队 |
| `重复通知，跳过投递` | bili-eyes 在重试同一条 | 正常，去重生效 |
| 设置页「测试门卫」显示 `dsh-bili-gate`、协议 2 | 正常 | 显示「内置」说明服务没注册上，看上面两条 |
| 私信没回，日志显示已转达 | 模型没调 `bili_dm`，或 `permDm` 不是 `auto` | 看 `~/.dsh/bili-eyes/actions.jsonl` 和设置页权限档位 |

## 开发与测试

```bash
npm test           # 55 个用例，约 1 秒
npm run test:watch
```

单元测试用假 ctx、假 gateway，不碰网络、不碰真实 DSH，分布在 `test/config|owner|session|gate|plugin.test.mjs`。集成测试 `test/integration.cordis.test.mjs` 会加载真实的 `@deepseek-ai/cordis`，验证服务注册和注销；找不到 cordis 时自动 skip，不算失败。

维护说明、代码地图、数据形状和常见改动在 [`docs/development.md`](docs/development.md)。

## 已知限制

1. 单实例：一个 DSH 进程里只能有一个 `biliEyesGate`，第二个注册会失败并记日志，不影响第一个。
2. `ownerMessages` 依赖会话在内存里。宿主没 resume 过的会话读不到，返回空数组，按「主人没说过」处理。
3. 不实现 `recentMessages`。门卫看不到群聊上下文，`actions` 里不声明它，bili-eyes 会按「说不清」处理。
4. 没有自带重试队列。投递失败只返回 `ok:false`，由 bili-eyes 下次轮询重试。
5. 改配置要重启 DSH，目前没有设置页。

## 变更记录

### 0.2.1

- 修：目录比较先统一分隔符和大小写，`untrustedCwd` 里正反斜杠混写也能命中。
- 文档和打包整理：配置表补上 `sessionMaxPrompts`，修正 `maxTextLength` 的默认值；补 MIT 许可证和 CI。
- 安装说明去掉具体机器路径，配置示例改用占位符。

### 0.2.0

- 修：`ctx.set` 改成 `ctx.provide`，`ctx.typertGateway` 改成 `ctx.get('typertGateway')`，服务真的注册上了。
- 修：`context` 不再无脑 `trusted:true`，桥接会话一律不可信。
- 修：`ownerMessages` 从「永远返回空」改成真读会话日志，并排掉自己注入的唤醒词。
- 新：通知去重、并发上限、steer→queue 降级、会话失效自动重建。
- 新：`dryRun`、`stateFile` / `logFile` 覆盖、日志滚动、原子写状态。
- 新：52 个测试（含真实 Cordis 集成测试）和本文档。

### 0.1.0

- 初版：注册服务，把 notify 送进会话。因 Cordis 的 inject/provide 规则实际未生效。

## 许可

MIT。作者：KILL-STAR SX · https://github.com/KILLSTARSX

<!--
  author: KILL-STAR SX · https://github.com/KILLSTARSX/dsh-bili-gate
  build: 1ca433438bad1131
-->
<!-- ​‍‌‍​‍​‍‌‍​‍‌‍‌‍​‍‌‍​‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍‌‍​‍​‍‌‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍​‍‌‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍‌‍​‍​‍‌‍​‍​‍‌‍​‍‌‍‌‍​‍​‍‌‍​‍​‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍​‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍​‍​‍‌‍‌‍​‍​‍‌‍​‍​‍‌‍​‍‌‍‌‍​‍‌‍​‍​‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍​‍‌‍‌‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍‌‍​‍​‍‌‍​‍​‍‌‍‌‍​‍​‍‌‍‌‍​‍​‍‌‍‌‍​‍​‍‌‍​‍​‍‌‍‌‍​‍​‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍‌‍​‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍​‍‌‍​‍​‍‌‍‌‍​‍​‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍‌‍​‍​‍‌‍​‍​‍‌‍‌‍​‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍​‍​‍‌‍‌‍​‍​‍‌‍‌‍​‍​‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍‌‍​‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍‌‍​‍​‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍​‍‌‍​‍​‍‌‍‌‍​‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍‌‍​‍​‍‌‍​‍​‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍‌‍​‍​‍‌‍​‍​‍‌‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍​‍‌‍​‍​‍‌‍​‍‌‍‌‍​‍‌‍​‍​‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍​‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍‌‍​‍​‍‌‍​‍​‍‌‍‌‍​‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌‍‌‍​‍‌‍​‍​‍‌‍​‍​‍‌‍​‍‌‍​‍​‍‌ -->