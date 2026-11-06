# dsh-pet-bridge

给桌宠（或任何本地小工具）用的 **DSH 消息桥**：在 DSH 自己的 HTTP 服务上挂一组只认回环的接口，把外部消息投进指定会话，并把助手回复取回来；需要的话，还能把回复直接发到 QQ。

- 版本：`0.2.0`
- 许可证：非商业使用许可（见 [LICENSE](LICENSE)）
- 第三方代码出处：见 [NOTICE](NOTICE)
- 运行平台：**仅 Windows + DeepSeek Harness（DSH）**

https://github.com/dangdongrui-cpu/dsh-pet-bridge

> 配套使用的桌面宠物（也是本机自家项目）：https://github.com/RYANFFY/deepseek-dafeiyu-pet 。它与本插件之间只走 HTTP，不存在代码依赖，也不需要任何第三方授权。

## 它解决什么问题

DSH 的会话是回合制的，外部进程没有入口。试过 `agent.inbox.prepend('next-step', message)`——不行：它只把消息写进持久收件箱，不会唤醒驱动，会话空闲时消息就一直躺着。

正确姿势是 `sessionController.resolveAgent(sessionId)` → `agent.followup(message)`。`followup` 会主动叫醒驱动：空闲时立刻开一轮，正在跑就排进下一轮。DSH 的定时任务插件也是这么做的。

## 功能

- **本地 HTTP 桥**：路由前缀 `/api/pet-bridge`，默认地址 `http://127.0.0.1:19387/api/pet-bridge/...`（端口跟着 DSH host 的 Web 服务走，不是插件自己另开的监听端口）。
- **四个端点**：`/health`（探活）、`/state`（取回复）、`/chat`（投文本）、`/observe`（截图搭话）。
- **只认回环**：任何非 `127.0.0.1` / `::1` 的请求一律 `403 loopback-only`。
- **QQ 直发**：请求里带 `notify.qq` 时，桥记住「这个会话的下一条回复发给谁」，等助手消息到了直连 NapCat（OneBot v11 WebSocket）发私聊。调用方投递完就能走，不用卡在那儿等 DSH 跑完。
- **截图搭话**：`/observe` 把 base64 截图落成文件，只把文件路径投进会话；默认投进一个自动创建的专属会话，主对话保持干净。
- **可选直听**：`qqListen: true` 时桥自己连 NapCat 收私聊，命中关键词（或小模型复核判定是派活）才投进 DSH；带 `/dsh` 前缀的一律不接，避免和 AstrBot 两边各回一遍。
- **长回复分片**：QQ 单条有长度限制，长文按结构边界切成多条，代码块和表格不会被切断，发出去一律纯文本（QQ 不渲染 Markdown）。

## 与 DSH 的版本约束

`package.json` 的 `engines` 原样照抄：

```json
"engines": {
  "node": ">=22.5.0",
  "dsh": ">=0.2.0-rc.1 <0.3.0"
}
```

配套的可选 peer 依赖（宿主没装就会走降级分支，不会硬报错）：

| 包 | 范围 | 用途 |
|---|---|---|
| `@deepseek-ai/dsh-llm` | `>=0.2.0-rc.1 <0.3.0` | 构造用户消息、直听模式的小模型复核 |
| `@deepseek-ai/dsh-tools` | `>=0.2.0-rc.1 <0.3.0` | 宿主工具服务 |
| `@deepseek-ai/schemastery` | `^3.18.4` | 配置声明（生成设置表单） |

## 安装

这个插件是 **profile 里的 bundle**，不是独立进程。以下路径里的 `<profile>` 换成你的 profile 名（Desktop 默认 `desktop`），`~` 指 `%USERPROFILE%`。

### 1. 链接进 profile 的 node_modules

```powershell
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-pet-bridge" `
  -Target "F:\path\to\dsh-pet-bridge"
```

### 2. 在 profile 的 package.json 里加依赖和 bundle

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-pet-bridge"
      ]
    }
  },
  "dependencies": {
    "dsh-pet-bridge": "link:F:/path/to/dsh-pet-bridge"
  }
}
```

`bundles` 里加上 `dsh-pet-bridge` 之后，本插件自带的 `cordis.patch.yml` 会被自动读入，把 id 为 `dsh-pet-bridge` 的插件行 insert 进组合——这一步就是「加 bundle」。

### 3.（可选）在 profile 的 cordis.patch.yml 里覆盖配置

```yaml
- id: dsh-pet-bridge
  name: dsh-pet-bridge
  config:
    qqEnabled: true
    qqWsUrl: 'ws://127.0.0.1:9178'
    qqToken: 'YOUR_TOKEN_HERE'
```

同一个 id 写一行 `config` 就能覆盖默认值；不写就全用默认。

### 4. 重启 DSH，探活

```powershell
curl.exe http://127.0.0.1:19387/api/pet-bridge/health
# {"ok":true,"sessionId":"...","qq":{"enabled":true,"connected":false}}
```

> 注意：由 Electron 独占管理的 Desktop profile 不能用 `dsh plugin --profile desktop add` 安装（会被拒），要走界面或直接改 profile 的 `package.json`。

## 接口

全部挂在 `/api/pet-bridge` 下。

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/api/pet-bridge/health` | 探活，带 QQ 直发开关与连接状态 |
| `GET` | `/api/pet-bridge/state?sessionId=&since=` | 取最近一条回复、最近一次请求、待回 QQ 的登记 |
| `POST` | `/api/pet-bridge/chat` | 投递文本，body `{ sessionId?, text, notify?, context? }` |
| `POST` | `/api/pet-bridge/observe` | 截图搭话，body `{ sessionId?, image, note?, notify? }` |

### `GET /health`

```json
{ "ok": true, "sessionId": "session-xxxx", "qq": { "enabled": true, "connected": false } }
```

`sessionId` 是本次请求会投给哪个会话（按「显式 ≥ 最近活跃 ≥ 配置默认」算出来的）。

### `GET /state`

| 查询参数 | 说明 |
|---|---|
| `sessionId` | 可选，缺省同上 |
| `since` | 可选，毫秒时间戳；只要 `at` 比它新的那条 `lastReply`，用于调用方去重 |

返回 `{ ok, sessionId, since, lastReply, lastRequest, pendingNotify }`。插件只在 `session/event` 里缓存最近一条 `assistant/message`，不碰会话存储。

### `POST /chat`

```json
{ "sessionId": "session-xxxx", "text": "看看桌宠还开着没", "notify": { "qq": "123456789" } }
```

成功返回 `{ "ok": true, "messageId": "...", "notify": { "qq": "123456789" } }`；失败返回 `code`，HTTP 400 或 409。

`context: "none"` 可以让这条命令**不带** QQ 最近私聊当上下文（默认带）。

### `POST /observe`

```json
{ "image": "<base64，可带 data:image/png;base64, 前缀>", "note": "可选的一句说明" }
```

截图落盘到 `~/.dsh/pet-shots/shot-YYYYMMDD-HHmmss.png`（只留最新 60 张），消息里只带路径。返回里多出 `path`、`bytes`、`sessionId`、`isolated`。

### 错误码

| code | 场景 |
|---|---|
| `loopback-only` | 不是回环地址（403） |
| `session/not-found` | 会话没有持久化 header（冷会话没落过盘） |
| `session/writer-held` | 同一会话被别的窗口占着 |
| `no-session` | 没指定会话，也没等到最近活跃会话，配置里也没有默认 `sessionId` |
| `empty-text` / `text-too-long` | 正文为空 / 超过 `maxTextChars` |
| `bad-qq` / `bad-notify` / `no-notify` | `notify` 不合法 |
| `bad-json` / `bad-json-or-too-large` | 请求体不是 JSON 或超限 |
| `no-image` / `bad-base64` / `empty-image` / `image-too-large` | 截图有问题（超限 413） |
| `write-failed` | 截图落盘失败 |
| `unknown-route` | 路径不对（404） |

### QQ 直发规则

- 一条命令只回一条：发出去就把登记删掉；同一条助手消息按消息 id / seq / turn+step 判重，不会发两次。
- 只回「登记之后」产生的助手消息。
- 认轮次：登记时记下当前跑到第几轮，只有**更大的轮次**才算这条命令的回答。会话正忙时 `followup` 是排进下一轮的，光看时间会把当前这轮的中间消息错当成结果。
- 被替换/改写的副本（`surfaceOp` 不是 `append`）不算新话。
- 发失败只记日志——那一轮已经跑完了，重来太贵。

## 配置项

| 配置 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `sessionId` | `''` | 默认投递会话；请求里可以覆盖 |
| `recentTtlMinutes` | `10` | 多久没人说话就不算「活跃」（1–240） |
| `maxTextChars` | `4000` | 单条消息字符上限（100–20000） |
| `sourceKind` | `'user'` | 消息来源标识；改成 `plugin:dsh-pet-bridge` 能看出是桌宠推的 |
| `maxImageBytes` | `8388608` | 单张截图上限（8 MB） |
| `observeIsolated` | `true` | 截图搭话是否开专属会话 |
| `qqEnabled` | `true` | 命令结果直发 QQ |
| `qqWsUrl` | `'ws://127.0.0.1:9178'` | NapCat 的 OneBot v11 WS 地址 |
| `qqToken` | `''` | NapCat 的 access_token；URL 里带了就留空，不会重复拼 |
| `qqContextCount` | `10` | 投 QQ 命令前拉几条私聊历史（0–50，0 = 不拉） |
| `qqContextChars` | `1200` | QQ 上下文总字数上限 |
| `qqListen` | `false` | 桥自己连 NapCat 收私聊（AstrBot 关着时才建议开） |
| `qqOwner` | `''` | 主人 QQ 号；直听只认这一个 |
| `qqTriggers` | 桌宠,插件,桥,DSH,… | 命中就转 DSH 的关键词，逗号分隔 |
| `qqJudge` | `true` | 关键词没命中时，让一个小模型复核一遍 |
| `qqJudgeProvider` | `'deepseek-account'` | 复核用的 provider |
| `qqJudgeModel` | `'deepseek-flash'` | 复核用的 model |
| `qqJudgeChars` | `500` | 复核时最多带多少字（50–4000） |

QQ 直发是懒连接：不发就一条连接都不建；断了按 1s→2s→4s… 封顶 30s 退避重连，最多试 8 次，之后等下一次发消息再连。

## 测试

```powershell
node test/run.js
```

当前 **56 项全部通过**（v0.2.0 实测：`# tests 56 / # pass 56 / # fail 0`，Node v22.23.2）：

- 纯函数层：body 解析、回环判定、文本提取、投递校验、notify 登记与轮次判断、echo 匹配、退避、截图清理。
- 行为层：用假 WebSocket 顶替 NapCat 测直发器——懒连接、超时、回绝、断线重连、关闭。

不依赖宿主包，也不联网。`test/run.js` 是单进程入口（不 spawn 子进程，避开沙箱里的管道限制）。

## 平台说明（重要）

- **只支持 Windows**：安装脚本用的是 `New-Item -ItemType Junction` / `mklink /J`，路径分隔符和截图目录（`%USERPROFILE%\.dsh\pet-shots`）都按 Windows 写的。
- **只能跑在 DSH 里**：插件通过 `ctx.inject(['sessionController','agents','webServer'])` 拿宿主的会话服务和 Web 服务，单独 `node lib/index.js` 起不来；它也不自己监听端口，`127.0.0.1:19387` 是 DSH host 的 Web 端口。
- 只监听回环，**不提供**局域网访问；要远程用请自己架隧道（并自行承担风险）。
- QQ 直发依赖本机已运行的 NapCat（OneBot v11 正向 WS），本仓库不包含 NapCat。

## 常见问题

**Q：`/chat` 返回 `409 session/not-found`？**
A：那个会话还没有持久化的 header（从没落过盘）。先在 DSH 界面里打开它说一句话，再投。

**Q：`409 session/writer-held`？**
A：同一会话正被别的窗口占着。换一个会话，或等那个窗口那一轮跑完。

**Q：投递成功了，但轮询 `/state` 一直没内容？**
A：`lastReply` 只在 `assistant/message` 事件里更新，一轮跑完才有。轮询时带上 `since=<上次拿到的时间戳>`，别重复拿同一条。

**Q：QQ 没收到？**
A：按顺序查——`qqEnabled` 是不是 `true`；`/health` 里 `qq.enabled` 是不是 `true`（`connected` 要等第一次真发或直听才变 `true`，懒连接）；NapCat 有没有起、`qqWsUrl` 端口对不对；`qqToken` 和 NapCat 的 `access_token` 一不一致。发失败只记日志，不重试。

**Q：端口不是 19387？**
A：桥跟着 host 的 Web 端口走，19387 只是默认值。看 DSH 启动日志或 `/health` 实际地址。

**Q：为什么主对话里看不到截图搭话？**
A：默认 `observeIsolated: true`，截图投进一个自动创建的专属会话。要投回主对话，在请求里显式带 `sessionId`，或把它关掉。

**Q：直听会不会和 AstrBot 抢消息、回两遍？**
A：带 `/dsh` 前缀的一律不接，留给 AstrBot 的插件；`qqListen` 默认关，AstrBot 开着时别抢它的活。

**Q：截图把磁盘堆满了？**
A：`~/.dsh/pet-shots` 只留最新 60 张，每次 `/observe` 顺手清旧的。

**Q：能商用吗？**
A：不能。本仓库是《非商业使用许可》，允许免费使用、修改、再分发（保留版权与许可），禁止商业用途。商用请联系版权人。

## 目录结构

```
dsh-pet-bridge/
├── lib/
│   ├── index.js              # 插件入口：路由、会话投递、notify 登记、直听
│   ├── config.js             # schemastery 配置声明
│   ├── pure.js               # 纯函数层（好单测）
│   ├── qq.js                 # NapCat 直发器（懒连接 + 退避重连）
│   └── markdown-chunks.mjs   # 长文分片（移植自 dsh-im，见 NOTICE）
├── test/
│   ├── run.js                # 单进程测试入口
│   ├── pure.test.js          # 纯函数测试
│   └── qq.test.js            # 直发器行为测试（假 WebSocket）
├── cordis.patch.yml          # bundle patch：把插件行 insert 进组合
├── package.json
├── README.md
├── NOTICE                    # 第三方代码出处与 MIT 声明
├── LICENSE                   # 非商业使用许可（中英）
└── .gitignore
```

## 致谢

Markdown 分片逻辑移植自 [dsh-im](https://github.com/xmanrui/dsh-im) 的 `shared/markdown-chunks.mjs`（MIT License），版权归其原作者；详细声明见 [NOTICE](NOTICE)。

dangdongrui-cpu · https://github.com/dangdongrui-cpu/dsh-pet-bridge

## 免责声明

- 本项目**仅供个人自用与学习**，没有针对生产环境做加固，也不承诺长期维护。
- 按现状（AS IS）提供，**不保证适用于任何特定用途**；因使用产生的数据丢失、服务异常、账号风险，作者不承担责任。
- 发现 bug 欢迎提 issue，但不承诺修复时限；急用请自行 fork 修改（改完保留原版权声明即可）。
- 涉及第三方服务的部分（AstrBot / LivingMemory / NapCat / SD WebUI / ComfyUI / OpenAI 兼容接口等）请遵守各自的服务条款。
