# 本地 SQLite 持久化（schema v1）

> 本文仅描述原 `--db` 的legacy格式。六核心 `--subject-db` 使用独立DSW2/schema2与统一事务，见[主体运行接线](subject-runtime.md)；新旧不自动迁移。

## 实现范围

`packages/dawn` 使用 Node 内建 `node:sqlite`（项目要求 Node.js >= 24），每个 SQLite 数据库保存一个主体。当前 schema v1 包含完整 `subject_state` snapshot、用于校验事件重放的 `bootstrap` snapshot，以及生命周期变更事件。存储只实现 `wake` / `sleep` 生命周期写入；没有通用主体编辑接口或记忆条目仓库。snapshot 中的 `memoryIds` 只有引用 ID，不包含记忆正文。

创建库时要求初始主体 `revision=0`，但初始 snapshot 可以包含非空的合法主体字段。其 bootstrap 内容保存在库中，不会因 `wake` / `sleep` 被清空或重置。每次生命周期实际变更都在 `BEGIN IMMEDIATE` 事务中检查 expected revision，并将新 revision、完整 snapshot 和事件原子提交；重复设置为相同 lifecycle 是 no-op。打开时验证 application ID、schema 版本、snapshot 与 bootstrap，再按 revision 顺序重放 lifecycle 事件，并要求重放结果与当前 snapshot 一致。此校验覆盖当前支持的数据变化，不是防篡改机制。

## 显式命令

推荐数据位置为 `~/.local/share/shuguang-intelligence/dawn.sqlite`，这只是建议，**不是默认数据库**。运行程序不会自动创建用户数据库或父目录。以下只有在用户手动执行 `init` 后才创建该文件：

```bash
DB="$HOME/.local/share/shuguang-intelligence/dawn.sqlite"
mkdir -p -m 700 "$(dirname "$DB")"  # 用户显式准备私有父目录；已有目录需另外核对权限
npm start -- init --db "$DB" --id dawn-local --name 曙光智慧
npm start -- status --db "$DB"
npm start -- wake --db "$DB" --revision 0
npm start -- sleep --db "$DB" --revision 1
npm start -- events --db "$DB"
```

注意：

- 所有 SQLite 命令都要求绝对 `--db` 路径；父目录必须事先存在。
- `init` 必须同时提供 `--id`、`--name`，只以排他方式创建新文件，拒绝覆盖已有文件。
- `status`、`wake`、`sleep`、`events` 只打开已有库；缺失库不会被创建。`open` 拒绝 symlink。
- `wake` / `sleep` 必须显式给出从当前 `status` 读到的 `--revision`；过期值冲突失败，不自动覆盖或重试。重复设置现有 lifecycle 是成功 no-op，不产生新事件。
- `events` 是有界诊断历史（CLI 按版本升序取前 100 项；适配器支持 afterRevision/limit 分页），不是长期记忆，也不是外部事件投递保证。
- `--check` 仅报告 adapter 可用，不打开库、不检查某个数据库的完整性。

本次文档更新没有创建数据库，也没有初始化任何用户真实主体。

## 独立对话库

以上 schema v1 指主体库，未因聊天功能自动迁移。成功问答与不可退款调用台账由单独的主体绑定 sidecar 保存，需显式 `chat-init` 创建和 `--chat-db` 启用，参见[对话记录与预算](dialogue-memory.md)。不把聊天记录写回性格、情绪或知识快照。备份时需停止写入并保留两库及其绑定，次数额度不是防用户回滚/替换文件的计费系统。

## 格式与失败行为

- SQLite 文件记录 Dawn application ID 和 `user_version=1`。其他 application ID、旧版或未来版本不自动重置、降级或迁移；由用户保留数据并等待明确迁移方案。
- 新库初始化使用已存在父目录、排他文件创建和受事务保护的 schema/初始内容写入。初始化失败的残留文件不会自动清理、替换或重试；应先人工确认其内容和数据处置。
- `open` 只接受普通非 symlink 文件；状态结构会严格校验，snapshot 编码大小上限为 2 MiB。校验失败会拒绝打开，不能据此推断数据被篡改或损坏的具体原因。
- 关闭 SQLite store 会释放当前连接，不会隐式把 lifecycle 改为 `sleeping`。

## 安全、阻塞与备份限制

此实现只适用于数据库位于**可信且私有的父目录**的情形。符号链接检查并不能防恶意同 UID 用户，也不能消除文件检查到打开之间的竞态。SQLite 文件和目录没有由应用加密；事件回放和完整性校验不提供密码学防篡改，也不能抵御有权限的恶意修改。不要把数据库放在其他不可信主体可写的目录中，也不要当作加密或安全审计日志。

SQLite 适配器采用同步 API。`AbortSignal` 只在同步调用前后等调用边界检查，不保证同步 SQLite 工作可即时中断；`busy_timeout` 为 1000 毫秒。调用期间阻塞仍可能持续到 SQLite 返回。

当前使用 SQLite 默认 **DELETE journal**，不是 WAL。备份前应停止写入并关闭数据库连接，然后复制完整数据库文件；不要在数据库仍有写入/打开连接时直接复制单个文件并假定得到一致备份。恢复后按 schema v1 的打开流程校验。需要更强的保密性、篡改检测、并发备份或迁移能力时，当前实现不满足，必须另行设计。
