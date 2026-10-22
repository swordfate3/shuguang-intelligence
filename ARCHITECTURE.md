# 架构与能力边界

可视化总览见[完整架构图 HTML](docs/architecture.html)，可离线直接打开；展示当前0.1.0源码结构与限制，不是部署拓扑或实时健康页面。

## 六核心主线与兼容运行边界

当前设计已敲定六核心：self / cognition / affect / memory / agency / growth。`packages/dawn/src/core/` 为无I/O、可独立测试的领域内核；每个模块有类型、规则与校验，`experience.ts`统一来源，`cycle.ts`提供全有或全无的主体状态候选循环。具体契约见[六核心说明](docs/six-core.md)。

旧版状态/类型/校验已移入 `packages/dawn/src/legacy/`；旧 `--db/--chat-db` 保持旧库格式与行为。新增显式 `--subject-db` 路径接通六核心与统一SQLite格式v2（DSW2），不自动迁移、重建或初始化正式主体。domain schemaVersion=2与SQLite user_version=2是各自的格式契约，不能混为一个版本。

依赖方向：入口/适配器 → runtime → core；storage adapter实现runtime接口并调用core typed transitions。legacy模式的runtime仍只引用legacy。新core不依赖runtime、legacy或适配器。六核心不是六Agent，不增加微服务；新模式每轮仅一次模型调用。

## 六核心运行路径（显式新格式）

`subject-service`负责FIFO交流编排；`deliberation`组装有限自我/情感/相关记忆/认知不确定性/动机投影，并解析严格JSON候选；`sqlite-subject`统一事务管理六核心snapshot、bootstrap、typed事件、问答与预算。T1先预占调用、事务外IO、T2在锁内重新runSubjectCycle并原子提交两条经历/问答/usage。外部生命周期和revision变化会阻止旧结果提交。

旧侧库不参与新模式事务。新模式不接受模型提供activities、权限或可信评估，成长只能candidate。详见[主体运行契约](docs/subject-runtime.md)。

## 有界自主学习（0.1.0必需范围，已接通与离线验证）

显式learning-init新建v3学习主体库与不可变本地pack/学习子预算；与普通交流复用同一SubjectState、总budget和事件回放，不把学习当user chat。learning-run前台自主选目标→study→独立assessment→提交学习经历/笔记/本地评分→下一目标。私有答案键不进模型或memory；模型笔记为inference，评分仅为本次表现。pending不自动恢复/重发，显式stop持久撤权拒迟到，Ctrl+C取消当前run。无工具/后台daemon/模型自批成长；详情见docs/autonomous-learning.md。

## 已有运行链路（legacy，尚未切换六核心）

原legacy链路由 Node.js >= 24、TypeScript 的两个 workspace 构成（当前项目另有下述可选DSH workspace）：`packages/dawn` 保存独立于 Pi 的主体核心、生命周期操作和本地 SQLite 持久化适配；`packages/pi-extension` 是可选的薄直连客户端。这条运行链路仍保留旧五模块快照格式，不应与新六核心的已实现领域规则混为一谈。

`packages/dawn` 使用 Node 内建 `node:sqlite`。当前 SQLite schema v1 每个数据库保存一个完整主体快照、不可变 bootstrap 快照，以及受支持的生命周期事件。`wake` / `sleep` 以 `BEGIN IMMEDIATE`、revision CAS 和同事务事件追加变更状态；打开数据库时会校验 identity/schema/revision，并从 bootstrap 回放事件、与快照比对。受支持的写入只有生命周期变更，并没有任意主体字段更新能力。初始 snapshot 可以包含非空的合法状态，但新库 revision 必须为 0；lifecycle 写入只改变 lifecycle、revision、updatedAt，不会重置其余字段。

CLI `init`、`status`、`wake`、`sleep`、`events` 都需要绝对 `--db` 路径。仅 `init` 创建数据库，且须给出 `--id`、`--name`；父目录必须事先存在。`--check` 仅表明 SQLite adapter 可用，不打开数据库，也不证明某个库有效。推荐数据路径 `~/.local/share/shuguang-intelligence/dawn.sqlite` 不是默认值，程序不会自动创建库或父目录。

已实现显式前台本机 HTTP 控制服务，显式模型配置和对话库可启用带最近历史的 API 交流，成功问答与固定次数调用台账持久化；尚无自主执行循环、长期知识提炼或通用记忆条目仓库。主体 snapshot 中的 `memoryIds` 只保存引用 ID，不是记忆正文。关闭 Pi 不隐式改变主体状态；SQLite 中的 `awake` 仅为持久状态标记，不是运行进程或活跃性的心跳。

## Docker部署封装

当前Dockerfile/Compose只运行曙光服务，交互统一在Host的DSH插件；不安装Pi/Git/额外npm包，不复制Pi扩展，不创建或挂载Pi会话/工作卷。非root运行，保留原`dawn-data:/data`，旧pi-home/pi-work卷只是不再挂载，不删除/迁移。Linux/WSL的`start.sh`执行检查、首次构建、显式setup、up及鉴权status就绪后返回终端，绝不打开聊天客户端；随后在DSH面板中操作。容器setup确认/补缺/私有凭据与学习前停全部写入者等门控保持；不改core/数据库/协议，不发布控制端口，不自动wake/生成/学习。停止容器保留数据，关闭DSH面板不停止容器。镜像需显式重建，旧运行容器不会自动升级；当前未有Docker实际构建/运行证据，使用见根目录[README](README.md)，决策D-022取代D-018/D-019中的Pi默认路径。

## 当前 DSH 插件交互入口

当前交互使用第三 workspace `packages/dsh-plugin`（旧Pi源码仅历史兼容，不参与默认部署）：Client 懒工厂在 DSH main/sidebar slots 提供面板，通过独立严格 Typert RPC 到 Host `shuguang` 服务，再复用 DawnClient/HttpDawnTransport。依赖仅 DSH 插件 → dawn 客户端；core、runtime、Pi 原逻辑不变。Host 强制 owner；浏览器不持有服务 token，不直接访问会拒绝 Origin 的 Dawn HTTP。仅显式命令读取唯一配置凭据源（私有 tokenFile 或 SHUGUANG_*_TOKEN 环境变量），不导入 DSH Session/模型/API key；激活不建主体、不启动服务或探测。关闭/卸载/namespace 失效取消并拒迟到结果，不隐式 sleep。8请求上限、版本CAS/协议v1/超时和失败不退款沿用原边界。

构建将可达 Dawn 客户端源码类型擦除并复制进插件 lib，不把 SDK 或 React 打入产物；同版 optional Host peer 由 DSH 运行时解析，Client 依赖动态 Remote namespace 注入。不新增后台学习或学习HTTP命令。新增显式Docker模式：Host固定shell:false执行docker compose exec -T进入已有dawn容器，以stdin单帧DawnRequest驱动容器bridge-request，再用容器私有token访问原loopback服务；stdout单帧有界响应，两端校验/关联/取消，无端口/token导出/模型env加载/直接DB访问。默认HTTP与Docker配置互斥，只有HTTP要求同loopback；Docker权限与可信context/Compose由用户明确选择，不自动up/build/停止。实际Docker exec及断开传播尚未验收。详细决策 D-020/D-021；使用与未验证项见[README](README.md#3-构建并安装-dsh-插件)。当前 HTML 架构图未补 DSH 入口，以本文及 D-020 为准。

## 依赖与边界

- 核心状态和生命周期不依赖 Pi。SQLite 由显式本地命令或 serve 进程打开，没有数据库路径推断或自动初始化。
- 独立request CLI与Pi窗口共用dawn内的HTTP客户端和命令解析；引用方向仅Pi→dawn，本体不依赖Pi运行时。Pi只适配显式命令，不复制主体状态、不调用宿主模型、不自动拉起进程。未配置endpoint/token或服务不可用时明确失败。
- DawnService 串行处理请求并保留取消/关闭边界；HTTP adapter 只绑定 127.0.0.1，强制 token、Host/Origin 与正文/响应限制；协议进行运行时字段校验。当前控制 token 是单一权限，不用于多人共享。
- 独立实例元数据与持久身份分离；进程关闭不隐式 sleep。跨实例独占租约尚未实现，不能把实例 ID 当锁。
- 模型配置通过 --model-config 显式读取，与 --chat-db 成对启用；其余主体示例不自动读取。对话库独立于主体 schema v1，chat-init 显式初始化并绑定主体 ID，不自动迁移。
- SQLite 的安全假设、备份方法、格式兼容和失败语义见[持久化说明](docs/persistence.md)。它不提供加密或抗恶意同 UID 用户的安全边界。

## 兼容路径与明确边界

say交流路径与学习路径明确分离；0.1.0增加授权范围内的前台自主学习，不增加任意工具或外围服务。新格式和typed lifecycle/cycle事件回放已实现，旧库迁移器未实现。必须由用户明确选择新建独立主体库，不能把新库当作旧主体的无损延续；下文模型与独立chat库描述仍只适用于legacy模式。



模型处理固定能力边界提示、最近完整对话及本次消息；不直接写性格/情绪/知识，调用须清醒且受超时、实例次数与对话库永久次数限制。对话只在最新预占序号、输出校验和主体 revision 复查后提交；失败不退次数。详见[对话记录](docs/dialogue-memory.md)。后续可以分别评估记忆仓库、模型提案接口、Pi 显式自动拉起及跨进程运行租约，但每项都需要独立实现、错误语义、测试与安全审查。schema v1 不支持旧库或未来 schema 自动迁移。完成前，文档和用户界面必须持续区分“规划”“类型定义”和“已接通能力”。
