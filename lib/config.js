/**
 * dsh-pet-bridge 配置。
 *
 * 用 schemastery 声明，让宿主生成设置表单并校验类型；归一化在 index.js 里做。
 */

import z from '@deepseek-ai/schemastery'

export const DEFAULTS = {
  enabled: true,
  /** 目标会话 id；桌宠请求里也可以带 sessionId 覆盖。 */
  sessionId: '',
  /**
   * 自动选收件会话：多久没说话就不算「活跃」。
   * 请求没显式带 sessionId 时，投给这个时间窗口内最后有人说话的那个会话。
   */
  recentTtlMinutes: 10,
  /** 单条消息字符上限。 */
  maxTextChars: 4000,
  /**
   * 投递消息的 source kind。
   * 默认 `user`：在会话里看起来就是用户自己说的，模型会正常回。
   * 如果要区分来源，可以改成 `plugin:dsh-pet-bridge`（v4 允许生产者自有的 kind）。
   */
  sourceKind: 'user',
  /** 单张截图上限（字节）。屏幕截图 PNG 一般 1–4MB。 */
  maxImageBytes: 8 * 1024 * 1024,
  /**
   * 主动搭话是否开专属会话。
   * true：第一次 /observe 建一个新会话，之后都投那里，主对话保持干净；
   * false：投回配置里的 sessionId。
   */
  observeIsolated: true,
  /**
   * 命令结果是否直发 QQ（桥自己连 NapCat，不再等 AstrBot 轮询）。
   * 只有 /chat、/observe 带了 notify 才真的发，平时一条都不会发。
   */
  qqEnabled: true,
  /** NapCat 的 OneBot v11 WS 地址。 */
  qqWsUrl: 'ws://127.0.0.1:9178',
  /** NapCat 的 access_token；已经在 qqWsUrl 里带了就留空。 */
  qqToken: '',
  /** 投递 QQ 命令前拉几条私聊历史当上下文。0 = 不拉。 */
  qqContextCount: 10,
  /** QQ 上下文总字数上限，超了从最早那条开始丢。 */
  qqContextChars: 1200,
  /**
   * 直听 QQ：关掉 AstrBot 时由桥自己接私聊。
   *
   * true = 桥连 NapCat 的 WS 收消息，命中关键词就投 DSH；
   * 带 /dsh 前缀的一律不接（那条给 AstrBot 的插件），免得两边各回一遍。
   * 默认关：AstrBot 开着的时候别抢它的活。
   */
  qqListen: false,
  /** 主人 QQ 号。直听只认这一个。 */
  qqOwner: '',
  /** 命中就转 DSH 的关键词，逗号分隔。 */
  qqTriggers: '桌宠,插件,桥,DSH,dsh,项目,代码,脚本,文件,安装,重启,部署,git,日志,端口,会话,打包,编译,报错,终端',
  /** 关键词没命中时，要不要再让一个小模型复核一遍。 */
  qqJudge: true,
  /** 复核用的 provider / model，默认跟主模型一致。 */
  qqJudgeProvider: 'deepseek-account',
  qqJudgeModel: 'deepseek-flash',
  /** 复核时最多带多少字，省 token。 */
  qqJudgeChars: 500
}

export const Config = z.object({
  enabled: z.boolean().default(DEFAULTS.enabled),
  sessionId: z.string().default(DEFAULTS.sessionId),
  recentTtlMinutes: z.number().step(1).min(1).max(240).default(DEFAULTS.recentTtlMinutes),
  maxTextChars: z.number().step(1).min(100).max(20000).default(DEFAULTS.maxTextChars),
  sourceKind: z.string().default(DEFAULTS.sourceKind),
  maxImageBytes: z.number().step(1024).min(65536).max(32 * 1024 * 1024).default(DEFAULTS.maxImageBytes),
  observeIsolated: z.boolean().default(DEFAULTS.observeIsolated),
  qqEnabled: z.boolean().default(DEFAULTS.qqEnabled),
  qqWsUrl: z.string().default(DEFAULTS.qqWsUrl),
  qqToken: z.string().default(DEFAULTS.qqToken),
  qqContextCount: z.number().step(1).min(0).max(50).default(DEFAULTS.qqContextCount),
  qqContextChars: z.number().step(1).min(0).max(8000).default(DEFAULTS.qqContextChars),
  qqListen: z.boolean().default(DEFAULTS.qqListen),
  qqOwner: z.string().default(DEFAULTS.qqOwner),
  qqTriggers: z.string().default(DEFAULTS.qqTriggers),
  qqJudge: z.boolean().default(DEFAULTS.qqJudge),
  qqJudgeProvider: z.string().default(DEFAULTS.qqJudgeProvider),
  qqJudgeModel: z.string().default(DEFAULTS.qqJudgeModel),
  qqJudgeChars: z.number().step(1).min(50).max(4000).default(DEFAULTS.qqJudgeChars)
})
