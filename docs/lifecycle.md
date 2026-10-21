# 生命周期与事务边界

> 下文命令/状态针对legacy `--db`。六核心新模式对应subject-wake/sleep，使用同库CAS与typed事件；每次成功say会另增两个revision，见[运行接线](subject-runtime.md)。两种模式的sleep均不是本实例队列内的即时生成抢占。

## 当前生命周期操作

主体核心提供 `wake`、`sleep` 两种生命周期操作，可通过内存存储或显式打开的 SQLite 持久存储运行。SQLite schema v1 的写操作使用 `BEGIN IMMEDIATE`，检查调用方的预期 revision 后 CAS 更新完整状态快照并在同一事务中追加 lifecycle 事件。冲突时显式失败，调用方应读取最新状态并由上层决定是否重新发起；不能静默覆盖。把状态设为当前已有值是 no-op，不增加 revision 或事件。打开数据库时校验 bootstrap、当前快照与事件回放一致。

CLI 数据库操作为：

```bash
DB="$HOME/.local/share/shuguang-intelligence/dawn.sqlite"
npm start -- init --db "$DB" --id dawn-local --name 曙光智慧
npm start -- status --db "$DB"
npm start -- wake --db "$DB" --revision 0
npm start -- sleep --db "$DB" --revision 1
npm start -- events --db "$DB"
```

示例仅供手动执行；`init` 才会创建库。父目录需要预先存在，所有命令均须使用绝对 `--db`。请先查询当前 revision 后再执行变更。更多参数、备份和风险限制见[持久化说明](persistence.md)。

## 进程和宿主边界

- `--help` 展示本地数据库、凭据创建与 serve 命令；`--check` 只报告适配器能力，不打开库或启动监听，不检查实际模型/服务健康。
- 已初始化数据库中的主体状态可跨进程重启恢复；没有手动初始化/没有提供数据库并不触发内存以外的隐式持久化。
- SQLite 的 `awake` 标记只表示持久化生命周期字段，不是存活心跳，不保证进程正在运行。关闭 Pi 不隐式执行 `sleep`；配置后的 Pi 客户端可以访问单独启动的 serve。
- `serve` 是前台常驻控制服务，通过 HTTP 接受 status/wake/sleep；进程内请求串行化，close 等待已接纳工作，外部 owner 再关闭 SQLite。服务停止不隐式 sleep。
- 当前没有自主循环；模型与对话库需显式配置，清醒后 say 可依据有界对话记录交流。未配置模型返回未实现。同实例内 sleep 在串行请求中排队，不会抢占正在生成的回复；其他进程写入 sleep 也不会跨进程取消已发出的模型请求。Pi wake 只发送生命周期请求，不自动创建后台进程。参见[本机服务说明](local-service.md)。

## 取消与阻塞边界

数据库操作使用 Node 同步 SQLite API。AbortSignal 只在同步调用边界检查：操作执行中不能即时打断正在进行的 SQLite 调用。SQLite `busy_timeout` 为 1000 ms；同步阻塞可能持续到 SQLite 调用返回。

## 后续变更的安全条件

添加记忆仓库、事件投递或模型调用时，须明确崩溃与重复请求语义、CAS 冲突处理、身份/授权边界及测试覆盖。模型输出只能产生待校验提案，不得绕过事务和策略校验直接改状态。不得通过用户情感压力促使其保持主体运行或继续交互。
