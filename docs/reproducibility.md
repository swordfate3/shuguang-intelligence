# 0.1.0 可复现检查方案

状态：**检查方案与本机离线基线，不是干净安装/最低版本已通过的证明。** 本轮不下载 Node、安装依赖、生成锁文件或修改宿主。真实调用另见[学习验收方案](learning-evaluation.md)。

## 1. 当前事实

- 生产本体使用 Node 内建模块，Node >=24.0.0 直接运行可擦除的 TypeScript；无需 tsx、ts-node 或先构建。
- 本次环境为 Node v24.21.0、npm 11.19.0；不是最低 Node 24.0.0。
- 根开发依赖为 TypeScript `~5.9.3`、`@types/node ^24.0.0`。当前工作树没有本地 node_modules、package-lock.json、固定 npm/packageManager。
- Pi 扩展使用可选 peer `@earendil-works/pi-coding-agent: "*"`，扩展源码和测试有显式 `import type { ExtensionAPI }`。Node 运行时会擦除此导入，tsc 仍须解析其声明；optional peer 不保证普通安装会补齐它。
- 全局已装宿主不等于项目 NodeNext 可以解析宿主类型。不能通过编造 any 声明、禁用检查或依赖绝对宿主路径宣布可复现。
- 不安装依赖时，npm 脚本中已有 node 命令仍可运行；`npm run check` 缺 tsc 会失败，不能用 npx 临时下载掩盖。

## 2. 检查入口与证据范围

在**完整项目树的根目录**执行：

| 命令 | 覆盖 | 仍不证明 |
|---|---|---|
| `npm test --workspace=@shuguang/dawn` | 本体及其集成/发布回归 | 独立复制 dawn 目录可测试、真实 Pi 加载 |
| `npm test --workspace=@shuguang/pi-extension` | 模拟 Pi API 的扩展测试 | 实际 TUI/RPC 宿主兼容 |
| `npm test` | 两 workspace 全部测试 | tsc、真实学习效果、干净安装 |
| `npm run verify:acceptance` | 交流脚本 + 原24项学习专项 | 真实模型调用 |
| `npm run verify:learning:offline` | 新的四次 loopback 假模型学习验收 | 真实模型遵守输出契约或知识提升 |
| `npm run check:capabilities` | 静态版本/能力元数据 | 服务/API 健康 |
| `npm run check --workspace=@shuguang/dawn` | 本体 src/tests 及传递导入文件 | Pi 入口与根 scripts 全覆盖 |
| `npm run check` | 两 workspace src/tests + 根 scripts | 最低 Node 运行兼容 |

本体完整测试会引用 sibling pi-extension 的 client/transport re-export，release 测试还读取三个 manifest 和根 scripts。因此“独立于 Pi 宿主”成立，但不等于“只复制 packages/dawn 就能运行完整测试”。`npm run check --workspaces` 是分别执行两个检查，不覆盖根 scripts，不能替代 root check。

所有运行检查需可写临时目录、子进程与 loopback 监听权限。网络边界是临时本机假上游，不读取真实模型配置。全量有15.2秒等真实计时回归，慢机器失败应保留原因，不通过删断言换通过。

## 3. 授权后执行的干净环境流程

**以下是待执行方案，不是本轮安装授权。** 使用隔离、持久化的验证副本，保留完整项目树，排除 .git、node_modules、真实本地配置、.env、凭据及运行数据库。不在唯一工作树内直接重装或覆盖数据。容器里的复用运行时/依赖环境按工作区约定放 ~/.local 持久卷；本轮不会建立它。

### A. 无安装运行基线

先固定记录 OS/架构、精确 Node/npm、源码内容摘要及条件，再运行第2节中的测试/验收/能力命令。此阶段不运行任何会安装的 npx/npm exec 指令。记录退出码、总耗时、失败项目、残留 fixture 和进程；对全套运行设置独立的宽裕总时限，超时先 TERM 后宽限清理，再必要时 KILL。总时限失败不是支持证明。

### B. 首次解析开发依赖

当前没有锁文件，不能从 `npm ci` 开始。在批准的副本、选定的 npm 版本中核对参数行为后：

```bash
npm install --include=dev --ignore-scripts
npm run check --workspace=@shuguang/dawn
```

这会解析版本范围并生成根 workspace 锁；不是精确可复现已经完成。`--ignore-scripts` 是保守安装边界，不默许以后执行宿主/传递依赖的安装脚本。

### C. 明确宿主类型版本，再做完整检查

完整 root check 需要真实、可解析的 Pi 声明。建议**只在验证副本中先选一个经批准的精确 Pi 开发版本**，例如命令模板：

```bash
# 把占位符换成已批准版本，不能照抄占位符执行。
npm install --save-dev --save-exact --ignore-scripts \
  @earendil-works/pi-coding-agent@<APPROVED_EXACT_VERSION>
npm run check
```

该步骤会改验证副本的 manifest/根锁文件，不自动修改项目正式依赖策略。当前宿主1.3.0曾用于借用类型检查，仅是历史证据，不代表默认批准锁定该版本。确认宿主及传递依赖支持所选 Node。

不建议以 `--no-save` 临时安装宿主后宣称全依赖已锁定；下次 ci 不会凭空重建未入 manifest/lock 的树。也不要把 `--include=optional` 当作补装缺失 optional peer 的保证。

### D. 第二个空副本复验

冻结准备好的 manifest 与**根** package-lock.json；记录 SHA-256、精确 npm、安装参数、是否允许安装脚本。在第二个空副本：

```bash
npm ci --include=dev --ignore-scripts
npm run check
npm test
npm run verify:acceptance
npm run verify:learning:offline
npm run check:capabilities
```

两个 workspace 不各自生成独立锁。通过第二空环境后，再决定把哪部分依赖/锁文件变更合入项目；不得把验证副本的修改静默带回正式工作树。

## 4. 最低版本与宿主矩阵

| 维度 | 候选检查条件 | 当前证据 |
|---|---|---|
| 最低 Node | 精确24.0.0 + 明确兼容的精确 npm | 未运行，需准备环境授权 |
| 本机维护版本 | 24.21.0 / npm11.19.0 | 本轮离线执行结果见 verification |
| 同一锁定依赖树 | 最低与维护版本均运行ci/check/test/两种验收 | 未生成锁，未运行 |
| 本体无宿主 | 完整项目树、无 Pi 安装，测试及本体 check | 测试可运行；标准类型工具尚缺 |
| 完整类型 | 已批准精确 Pi peer/dev 类型可解析 | 历史宿主映射通过，非标准安装 |
| 实际 Pi | 选定宿主 TUI/RPC 加载、命令、shutdown | 未验证，独立授权 |

重点核验原生 TS stripping、`.ts --check`、`node:sqlite`、信号、HTTP和子进程。`@types/node ^24.0.0` 可能暴露后续24.x新增API，类型通过不等于24.0.0能运行。

release/main 子进程对 stderr 严格断言时按 warning 名称屏蔽 ExperimentalWarning，而不是全局禁用 warning；这也不能代替最低版本实测。部分旧 child tests 仍没有一致的硬超时兜底，复验时需外层总时限和残留检查；遇到挂起应先定位，不盲目加大超时。

## 5. 通过标准与下一步

只有同时拥有“精确环境 + 冻结输入/锁 + 第二空副本 ci + 标准 root check + 测试/验收结果”，才报告该环境可复现。真实 Pi/学习、正式部署分别报告，不能被此结论覆盖。

下一授权项：确认验证环境位置、Node/npm与Pi精确版本、是否允许联网安装及安装脚本策略。批准前只使用已有环境做离线检查，不生成假锁或修改版本范围。
