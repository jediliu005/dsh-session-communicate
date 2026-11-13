# dsh-session-communicate

让两个**已经存在**的 DSH 会话在每天固定时间自动对话若干轮。每一句都会带上同一份规则（双方身份、对话目的、当前第几条、字数上限），所以两边都清楚自己在做什么，也不用对方装任何插件。

- 零依赖：宿主只用 Node 内置模块（`fs` / `path` / `os` / `zlib` / `child_process`），客户端只用宿主提供的 `react`。
- 自带调度：插件内部每 30 秒检查一次「到点没 / 今天跑过没 / 是否正在跑」，不依赖任何外部定时任务插件。
- 双向读取：用 `sessionController.prompt` 投递，用会话日志读回，不需要被对话方配合。

## 安装

本机开发（不经过 npm）：

```bash
# 1) profile 的 package.json 里加一条依赖和 bundle
"dsh-session-communicate": "link:D:/path/to/dsh-session-communicate"
#    "dsh": { "profile": { "bundles": [ "...", "dsh-session-communicate" ] } }

# 2) 建链接（Windows 用 mklink /J，macOS/Linux 用 ln -s）
# 3) 重启 DSH —— 宿主代码只在启动时加载，没有热重载
```

从商店安装：条目按 npm 包分发，安装后同样需要重启一次。

## 配置（侧栏「会话对谈」面板）

| 字段 | 说明 |
| --- | --- |
| 会话 A / 会话 B | 从本机 `~/.dsh/sessions` 里选两个已有会话；「取名」按钮按对方首条用户消息填短名 |
| 发起方 | A 先说或 B 先说；发起方拿到一段固定开场提示词（含对话目的），先自己生成第一句 |
| 目的 | 发起方的基本目的，写进双方每一句的规则头 |
| 轮次 | 一轮 = 双方各说一次；轮次 3 表示共 6 条消息 |
| 时间 | 每天几点开始（DSH 到点后才启动时会补跑当天一次） |
| 每条字数 | 单条消息字数上限，靠提示词约束，不硬截断 |

## 工作方式

1. 到点后向发起方投递「开场提示词」；
2. 从发起方会话日志（`session.v4.jsonl.zstd`）读回它在**这一轮**产生的最后一条非空 assistant 文本；
3. 把这段文本连同规则头投给另一方，读回话；
4. 交替进行，直到 `轮次 × 2` 条全部说完。

每次运行写一份纯文本记录：`~/.dsh/session-communicate/conversations/YYYY-MM-DD-HHmm.md`，只记双方说的话，不记规则头。

## 调度与重试

- 插件自带 `setInterval`，每 30 秒 tick 一次；启动 8 秒后先 warm-up 一次。
- `lastRunDay` 只在**定时**触发时写入；手动 `POST /api/run` 不占用当天额度（曾出现过手动测试占用当天定时额度的问题，已修）。
- 失败按天计数重试：10 分钟后重试，连续 3 次失败才收工并记 `lastRunDay`。
- 单条投递有 20 秒超时保护，避免目标会话正忙时永久卡住。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET/POST | `/session-communicate/api/config` | 读写配置 |
| GET | `/session-communicate/api/sessions` | 列出本机会话 |
| GET | `/session-communicate/api/preview?sessionId=` | 预览会话标题与轮数 |
| GET | `/session-communicate/api/status` | 运行状态、`capability`、下一次时间 |
| GET | `/session-communicate/api/log?lines=100` | 最近 N 行运行日志 |
| POST | `/session-communicate/api/run` | 立刻跑一次（`{"dry":true}` 只回配置） |
| POST | `/session-communicate/api/tick` | 走一次调度判断 |
| POST | `/session-communicate/api/opendir` | 打开对话记录目录 |
| POST | `/session-communicate/api/stop` | 停止（按条生效） |

## 兼容性

- Node ≥ 22.15：会话日志是**追加式多帧 zstd**，插件逐帧解压，需要 `zlib.zstdDecompressSync`。
- 启动时自检 `prompt` / `webServer` / `zstd` 三项能力，缺哪项会直接显示在状态里，而不是等到投递时 404/500。
- 依赖 DSH 的两处内部契约：`sessionController.prompt(request, source)` 的信封和会话日志的存储格式。上游改动时插件会先失效并报出原因，不会静默跑错。
- 单份会话日志超过 400 MB 时拒绝读取（整份读入内存），而不是静默截断。

## 注意

- 两个会话必须都是本机 profile 里的普通会话（`standard` preset）；子代理会话不能作为一方。
- 对话期间对方会话若在跑别的任务，消息排队，读取会等到该轮结束或超时（默认 300 秒）。
- 配置存 `~/.dsh/session-communicate.json`，调度状态存 `~/.dsh/session-communicate.state.json`。

## License

MIT
