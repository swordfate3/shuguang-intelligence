# 0.1.0 可复现检查方案

状态：本分支的离线检查方案，不是干净安装/最低Node版本或真实客户端兼容认证。部署/使用只维护根[README](../README.md)。

## 当前依赖边界

- Node >=24，原生可擦除TypeScript与内建node:sqlite；dawn/mcp/pi-package三个workspace，Dawn/MCP没有运行时外部依赖。
- 旧Pi聊天workspace已删除，可选pi-package管理MCP注册/skills与显式UI片段分享；源码type-only引用宿主Pi，运行由Pi提供API，不导入Dawn代码。MCP采用受限tools-only stdio实现，不内置SDK。
- 根开发依赖TypeScript ~5.9.3、@types/node ^24.0.0和Pi ~1.4.0用于扩展类型；新增manifest依赖未在本轮安装。没有本地node_modules、根锁文件或固定npm版本，不能直接声称npm ci可运行。
- 不安装时可运行Node测试；标准npm run check缺tsc会失败。借用宿主编译器/Node声明只提供离线类型证据，不是干净安装。

## 检查入口

| 命令 | 范围 | 不能证明 |
|---|---|---|
| `npm test` | dawn、mcp与pi-package全部合成测试 | 真模型、真实Docker或完整MCP认证 |
| `npm run test:mcp` | MCP协议/工具/CLI及stdio→HTTP→临时SQLite | 所有客户端互操作 |
| `npm run verify:acceptance` | 原交流验收及学习专项 | 实际供应商支持严格输出 |
| `npm run verify:learning:offline` | 四次本机假模型、两目标学习与清理 | 通用掌握或长期学习 |
| `npm run test:pi-package` | 连接/片段预览授权/私有子进程与取消、分发清单/skill | 用户pirun/TUI/Docker兼容 |
| `npm run check` | 三包src/tests与scripts的严格TS | 最低Node支持或运行安全 |
| `npm run check:capabilities` | 静态能力元数据 | 实时健康 |

完整发布回归读取根/dawn/mcp/pi-package四个manifest及根scripts，因此单独复制dawn目录不保证完整测试可运行。临时fixture需要文件、子进程、loopback权限；shell/权限/信号测试有POSIX假设。失败不通过删除断言掩盖。

## 待授权的干净环境复验

1. 明确隔离副本位置、精确Node/npm与安装脚本策略，不在唯一工作树直接重装。副本排除真实配置、数据库、凭据、.git、node_modules和附件。
2. 在副本以批准版本执行`npm install --include=dev --ignore-scripts`，生成根workspace锁；先检查依赖解析和Node兼容，再跑标准check/test/两验收。三个workspace不分别维护锁。
3. 冻结manifest/根锁、记录摘要和精确工具版本，第二个空副本执行`npm ci --include=dev --ignore-scripts`后复跑；不能把初次解析当作可复现已证。
4. 最低精确Node24.0.0与当前维护版本分别检查原生TS、sqlite、HTTP、信号、子进程；@types/node后续24.x API不保证最低版本存在。
5. Docker构建、私有卷权限、真实客户端握手/列工具/取消/EOF、实际模型学习分别验收。没有SDK依赖不等于无需互操作测试。

上述步骤需要另行安装/联网授权，当前不会执行或创建假锁。容器内长期复用工具安装按工作区持久路径约定。真实学习需额外确认材料披露、次数/费用、失败收费与清理，不自动沿用旧授权。
