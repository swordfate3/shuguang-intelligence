# 本机协议 v1

协议定义位于 `packages/dawn/src/protocol/index.ts`，包含运行时字段校验；不能只依赖 TypeScript 类型信任网络数据。

> 六核心subject-db与legacy db共用协议；新模式一次成功say使revision增加2，并统一事务提交核心状态与问答。没有新增wire权限或模型可选数据库字段，见[运行接线](subject-runtime.md)。

## 请求期限

- 模型 `timeoutMs` 缺省8000、显式可配1..30000；不重试或退款。
- 上传/认证/解析以及控制请求保持10秒总期限。只有完整合法的say才扩展至从请求开始累计35秒，含FIFO排队、生成与提交。
- 客户端say期限40秒，控制请求10秒；用户AbortSignal仍可更早取消。长队列仍可能在调用前或生成中取消，不保证30秒模型时间总能全部用尽。
- 期限变化不放宽64KiB、连接/并发名额或ignore-abort占用规则；同步SQLite/核心运算仍不能即时打断。

## 传输与授权

- 显式前台 `serve` 才监听 `127.0.0.1`，不开放公网、不自动创建数据库或唤醒。
- 只接受 `POST /v1/request` 的 JSON 请求，正文和响应均限制为 64 KiB，聊天文本最多 16000 字符。
- 必须提供 Bearer service token。服务 token 与模型 API key、Pi 凭据完全分开，不打印到终端或写入 Git。
- 服务端验证 Host 并拒绝 Origin，不提供浏览器跨域访问；本机绑定不能代替鉴权。
- 客户端只连接显式的 `http://127.0.0.1:<port>`，不跟随重定向、不自动重试，不回退到 Pi 当前模型。

## 消息

请求公共字段：`version: 1`、`requestId`。请求 ID 为 1–128 个字母、数字、连字符或下划线。

- `status`：读取主体生命周期与 revision，并带当前进程 `instanceId`、`startedAt` 和 `autonomy: false`。
- `wake` / `sleep`：必须携带非负安全整数 `expectedRevision`；成功返回 status，冲突返回 `CONFLICT`，不自动覆盖或重试。
- `say`：未配置模型返回 `NOT_IMPLEMENTED`；显式配置模型和主体绑定对话库并清醒时可返回 reply，休眠不调用。成功问答保存为后续有界上下文，失败收费但不进入历史，不自动变成事实/知识。
- `model-status`：读取安全的服务进程模型选择状态，不访问上游。
- `model-list`：显式鉴权GET当前曙光模型入口的 `/models`，不生成、不发送历史；成功更新进程缓存，失败不替换。8秒发现期限仍受10秒控制请求总期限约束。
- `model-select`：携带 `expectedRevision`（**选择版本，不是主体版本**）和缓存目录中的 `model` ID。
- `thinking-select`：携带选择 `expectedRevision` 和 `thinking`（off/low/medium/high/xhigh/max）。off仅省略上游参数，不映射none，不认证模型能力。

后四者成功返回 `type:"model", state:{selectionRevision,model,thinking,levels,models,calls,maxCalls}`，不含key/入口/主体数据。模型ID最多256字符、禁控制/格式/行分隔符，目录最多128个唯一ID；当前model可在刷新目录之外。选择变化revision+1，同值no-op；不支持控制的模型返回NOT_IMPLEMENTED，过期版本返回CONFLICT，其余安全失败UNAVAILABLE。操作在现有FIFO内，不改主体或生成预算；适配器不重建，正在进行的生成不切换。选择不持久化、不改变独立学习进程。旧服务仍可能拒新命令，客户端不降档或重试。

响应保留同一个请求 ID。客户端校验 schema、相关 ID 与响应类型。未知字段、版本和非法数字会被拒绝。实例 ID 表示响应来自哪个服务实例，与持久主体身份不同；它不是跨实例唯一写入租约。

## 失败与取消

HTTP 鉴权、路径、格式和资源错误不泄露原始正文、凭据或 SQLite 异常。合法业务错误通过协议 error 响应表示；HTTP/网络失败由 transport 抛出安全错误。

客户端取消不能证明服务器未提交：如果修改已经提交而响应丢失，需重新查询 status，再决定下一步。requestId 用于关联；say另有持久预占去重，但不承诺恰好一次交付，其他控制操作没有持久去重。CAS 只阻止基于过期主体或选择revision的覆盖；模型选择版本在进程重启时归零，不能当跨服务实例的租约。

## 当前能力边界

已实现控制通道、独立服务与显式模型交流及有界持久对话历史；不包含实时流式聊天、长期知识提炼、自主活动、外部工具执行或通用主体编辑。Pi 仍只承接显式命令，不发送已有会话历史、文件内容或宿主模型上下文。
