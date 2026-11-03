# 贡献指南

曙光智慧是独立数字主体的原型：同一主体的六核心、持久交流、有界自主学习。欢迎提交 issue 和 pull request，但请先读完本页——这个项目有几条与普通应用不同的硬约束。

## 环境

- Node.js **>= 24**（使用内建 `node:sqlite` 与原生 TypeScript 执行）
- npm（workspace：`packages/dawn`、`packages/mcp`、`packages/pi-package`）
- 可选：Docker + Compose v2（只在跑容器相关测试或真实部署时需要）

```bash
git clone git@github.com:swordfate3/shuguang-intelligence.git
cd shuguang-intelligence
npm ci            # 必须用 ci，不要用 install 改锁文件
npm run check     # 严格 TypeScript
npm test          # 全量回归
```

测试全部使用临时目录、假模型和 loopback 假服务，**不会**连接真实模型、真实搜索供应商或正式数据库。

## 提交前必须做

1. **更新 `STATUS.md`**：做了什么、验证命令与结果、未完成/阻塞、下一项可执行任务。
2. **架构取舍写 `DECISIONS.md`**（追加 D-0xx），不要把决定埋在 PR 描述或代码注释里。
3. **证据写 `docs/verification.md`**，不要塞进 AGENTS/STATUS 全文日志。
4. 跑完 `npm run check` 与 `npm test`，把**真实输出**贴进 PR。

## 分支与 PR

- `main` 受保护，**不能直接 push**，一切走 PR。
- 分支命名：`feat/<主题>`、`fix/<主题>`、`docs/<主题>`、`chore/<主题>`。
- 一个 PR 只做一件事；跨模块大改先开 issue 讨论方案。
- 合并用 **Squash**，保持 `main` 线性。
- 需要的数据/证据请贴文本或临时目录路径，**不要**上传私有库、日志原件或截图中的个人信息。

## 契约变更

以下改动必须先有 ADR（`DECISIONS.md` 新增条目），再改代码：

| 契约 | 当前版本 |
|---|---|
| 应用版本 | 0.1.0 |
| 普通 MCP/HTTP 协议 | v1 |
| 私有 host 协议 | v1 |
| 领域 schema | 2 |
| SQLite 交流 / 学习 / 来源 / 研究 | v2 / v3 / v4 / v5 |

- **禁止**为图方便修改已发布版本的语义，或让旧库自动迁移。
- v4 / v5 必须显式新建；不得重建"唯一正式主体"来绕过迁移。
- 提高协议版本、改工具 schema、改事务边界，都算契约变更。

## 硬性禁止

- ❌ 提交 `*.sqlite`、`*.token`、`model.env`、`.pi-attachments/`、`config/dawn.local.json`、真实 API key、真实对话或记忆导出。
- ❌ 把合成测试（假模型、假搜索、假 Docker）说成"真实可用"或"已部署"。
- ❌ 为让测试变绿而弱化断言、删除校验（CAS、时间检查、容量上限、来源校验）。
- ❌ 让模型输出直接改主体身份、价值观、权限或边界。
- ❌ 在 PR 里引入新的运行时依赖或框架，而不先在 issue 说明理由。

## 报告方式

PR 描述里请分别写清：

- **已实现**：改了什么
- **已验证**：实际跑过的命令与结果
- **未验证**：没跑的部分及原因
- **风险**：回归范围、需要的后续授权

"测试通过"不等于"学习有效"，也不等于"可以上线"。请保持这三者分开。

## 安全问题

请勿开公开 issue，见 [SECURITY.md](SECURITY.md)。
