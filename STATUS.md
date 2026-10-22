# 当前开发状态

最后交接：2026-10-22。本文记录当前 Windows 检出事实，不把此前 Linux/私有部署的记录当成本机现状或新授权。历史证据见 [验证记录](docs/verification.md)。

## 当前任务与工作树

- 用户要求「新建一个分支，这次新增为 dsh 插件」。已从 `b446014` 创建并切换 `feat/dsh-plugin`；原工作树干净；开发阶段未commit/push。用户随后明确要求“直接更新远程分支”，本次交付授权提交并推送至origin/feat/dsh-plugin（非main、不force、不tag/包发布）；实际推送状态以Git远程ref和操作回执为准。
- 新增第三 workspace `@shuguang/dsh-plugin`。用户最新纠正当前只用DSH交互、不用Pi；默认镜像/启动去Pi，旧Pi源码仅历史兼容保留，不纳入当前部署。保留独立 Dawn；六核心、协议v1、core schema2、DB v1/v2/v3 均未改。应用仍0.1.0，自主学习仍为首版必需项，不降级为仅聊天。
- 用户随后确认Docker部署并同意补连接支持；已采用免端口/免token复制的显式Docker stdio方案，不是原先讨论的HTTP relay。只授权源码与合成验证，未授权正式部署或真实API。
- 本轮完成源码与离线验证；**未安装真实 DSH 插件、未修改 profile、未部署、未初始化正式主体、未读真实凭据、未调用真实模型或学习**。新路径不再安装/启动Pi，因此不再需要其fd/ripgrep下载，但旧Pi问题本身不宣称修复；曙光UNAVAILABLE反馈仍未定位。

## 本轮已实现

- `packages/dsh-plugin/src/bridge.ts`：显式本机连接、复用 DawnClient/HttpDawnTransport、构造无I/O、命令先校验、最多8请求、固定脱敏错误、取消与 dispose 拒迟到，不自动启动/retry/sleep。
- Host `shuguang/command` RPC：官方 TypertRemoteService，显式严格同版 descriptor，强制 owner；不走 DSH Agent command/Session log，不借用宿主模型或历史。
- DSH main/sidebar 面板：状态、带revision的wake/sleep、独立输入消息、模型/thinking选择CAS、显式远程目录、取消；无自动探测，输出是文本。Client 动态注入 `remote.shuguang`，namespace撤销取消并拒迟到，恢复不自动重发。
- 凭据仅Host侧：`endpoint` + `tokenFile`/`tokenEnv`恰一非空；Windows可用显式`SHUGUANG_*_TOKEN`变量名。原 tokenFile POSIX校验不放宽，不向浏览器传token，不发现任何 DSH/Pi/API key。
- Node24内建类型擦除与可达模块复制构建；Client使用DSH React、Host使用同版optional SDK peers，不安装构建依赖。lib为忽略的生成物，构建复制MIT正文。
- Docker模式：Host配置显式context/repo/原project，固定shell:false exec已运行dawn；消息stdin、单帧响应、两端schema/64KiB/期限/取消拒迟到。容器新`bridge-request`读取内部token走原HTTP，不导入model.env/开库/启动服务/发布端口，HTTP与Docker字段互斥。真实断开传播待实装。
- DSH主入口切换：Docker无Pi安装/扩展/PATH/工作卷，Compose只挂原dawn-data，旧Pi卷不删除；entrypoint移除pi命令；start就绪后返回终端、只提示DSH，无client exec，新安装Schema/patch默认Docker。旧HTTP配置不自动迁移。
- README整体重写为DSH主教程，不再要求进入/退出Pi；决策 D-022取代D-018～D-021中的Pi默认路径，架构/路线图/Changelog/AGENTS同步。HTML架构图尚未补DSH入口，不能冒称已展示。

## 本轮验证（Windows / Node24.17.0）

| 命令/范围 | 实际结果 | 限制 |
|---|---|---|
| `node --test --test-isolation=none packages/dsh-plugin/tests/*.test.ts` | **61/61通过** | 原56项+DSH-only部署静态5项；不是实际Docker/浏览器 |
| `node packages/dsh-plugin/build.mjs`、Client/容器桥 `node --check` | 通过，10个自有Host模块 | 无真实DSH激活/加载证明 |
| 既有core/协议/model/Pi client/learning-core选集（关闭进程隔离） | **92/92通过** | 不包含受平台权限影响的Pi model-picker；前轮加该文件15项均mode0666失败 |
| `check:capabilities` | 通过 | 无数据库打开/模型连接/服务启动 |
| 容器packaging静态选集 / `docker compose config --quiet` | **1/1通过** / 通过 | 无引擎构建/部署，测试按名称仅选静态项 |
| Git Bash `-n` 两脚本 / start help | 获准原命令沙箱外重试通过 | 原沙箱signal pipe Win32 error5；只语法/help，无Docker操作 |
| launcher完整8项 / entrypoint完整专项 | 未通过 | spawnSync bash/script/sh受限制/工具缺失，不能用静态5项替代行为通过 |
| `npm test` | 未通过：54个文件均在runner spawn EPERM | Windows沙箱子进程管道限制，不是54个业务断言失败 |
| 改动前既有全量（获准沙箱外） | 多项失败并挂起，已终止 | 原POSIX文件权限、Unix shell、信号平台差异；不能借旧308项报本轮全绿 |
| `npm run verify:acceptance` | 未通过：Acceptance failed (details omitted) | 交流阶段失败，`&&`后的学习未执行；未改脚本放宽检查 |
| `npm run check` | 未通过：tsc未安装 | 未安装依赖、未借用编译器；不能宣称严格TS通过 |
| `npm pack --dry-run --ignore-scripts --json` | 被沙箱拒绝写宿主npm缓存 | 未生成tarball，实际pack文件列表未验证 |
| 真实Cordis/DSH服务测试 | 未执行成功 | 读取提取SDK遇EPERM，额外审批取消，不重试/绕过 |

独立静态审查发现Client动态namespace注入遗漏，已修复；补回归时发现namespace撤销后迟到结果仍可采纳，已修复，新增Dawn HTTP业务服务集成后31项最终通过。Docker扩展独立审查范围内无确定P1/P2，独立复跑新增25项通过。本轮DSH主入口窄审无确定P1/P2，审查者独立部署静态5项/packaging1项通过。审查与模拟测试不替代真实安装。

## 运行边界与仍未验证项

- DSH SDK当前对照0.2.1-rc.2/Cordis4.0.5，手写strict descriptor随版本维护，SDK真实service绑定与RPC/metadata/图标/浏览器行为待授权实装。无浏览器控制或plugin_manager工具，不凭当前GUI地址宣称已安装。
- 直接HTTP才须Host/Dawn同loopback。Docker模式经exec到容器再访问内部127.0.0.1；Compose仍不发布端口、HTTP Origin/Host不放宽，不搬运卷数据。必须更新原项目镜像包含新命令，DSH需能运行本机Docker/Compose。
- Windows普通token文件mode0666会被既有安全校验拒绝；tokenEnv解决插件凭据读取，不代表旧Dawn正式服务初始化/文件路径已Windows端到端认证。
- 本轮检查Compose v2.24.6-desktop.1可用，`docker --context desktop-linux info --format '{{.OSType}}'`报找不到dockerDesktopLinuxEngine管道，引擎未运行；真实exec/镜像和stdin断开传播未验证，不自动启动Docker；WSL版本可读、发行版列表E_ACCESS_DENIED，未重试提权。历史「开发环境无Docker」「已有正式主体/私有wrapper」不直接适用本机。
- 真实模型兼容性与学习效果、干净依赖/最低Node/Docker/DSH实装复验、长期部署均未验证。旧308项和借用宿主TS5.9.3属于历史基线，不是本轮通过。
- 自主学习仅授权本地pack的有界前台运行；无联网学习、任意工具、后台常驻或模型自批成长。pending recover前必须确认全部旧runner/同库服务停下。
- 2MiB快照/常规集合1000项、全量回放、失败不退款、无独占租约/恰好一次/自动迁移；数据未加密、无内置删除，长期容量性能未验证。

## 下一项可执行任务

经用户明确授权后，在同版DSH测试profile由插件管理器安装已构建目录，以合成独立Dawn服务验证Host/Client注册、owner、RPC、取消/卸载和中英文显示；Docker先由用户启动Desktop并明确授权测试镜像/合成项目，在同本机engine、context、原项目路径下核验exec/EOF取消与服务仍存活，不能拿mock当已接通。运行环境/私有凭据来源/资料范围必须先确认；真实API、正式主体/迁移、联网安装、部署、commit/push均不能沿用旧授权。标准全量/类型检查需在合适环境重新跑，不靠弱化安全断言通过。
