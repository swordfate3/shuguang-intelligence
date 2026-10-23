# 架构决策记录

## D-024：通用 SearchPort 与独立授权搜索任务，Tavily 首个适配器

- **用户授权：**推进搜索能力；选择任务内自主搜索、独立API、Tavily，随后明确“应该做通用的search接口”。因此SearchPort/SearchResult/来源与错误契约供应商无关，可信注册表选择Tavily首实现，不动态import模型指定代码/endpoint、不借用DSH模型/搜索凭据；不以本次开发授权自动调用真实API、部署、提交或发布。
- **范围与披露：**新search-init/run/status/results/stop前台任务，目标、精确可披露查询集合、主题、provider、有效期和1–10次上限由用户给定；主体已有兴趣/关注的chooseIntention规则选择查询顺序，不让模型自由生成带私有内容的query，也不发主体投影/聊天/教材/测验数据。该版仅搜集资料，暂不接入聊天/学习测验，不改“无工具”模型系统提示，不宣称搜索即学会。网页数据不参与追加权限/查询或代码执行。
- **持久性：**独立DSR1/version1搜索SQLite，绑定subjectId/scopeId/不可变grant；不改主体DB v2/v3、领域schema2或协议v1，不隐式迁移。事务永久预占后才IO，每词一次、单pending、失败不退款/重试、pending不自动恢复；停止持久撤权拒迟到。结果保存provider/检索时间/URL/标题/摘要/可选发布日期，不写成可信记忆/学习成绩。新任务重新授权，单账本不等于全账户总消费限制。
- **边界：**读取主体以检查awake/identity/scope/revision，执行前后复核；使用前停止全部同库服务/旧runner，不承诺跨两个SQLite原子事务/全局租约或恰好一次。Ctrl+C取消当前请求，另进程stop阻止提交/后续派发，不承诺撤回供应商已处理/收费请求。默认180s任务期限，单次Tavily<=15s。没有后台联网/网页抓取/任意URL工具，也不开放控制HTTP搜索方法。
- **适配器与隐私：**固定Tavily官方HTTPS Search basic/general/最多3摘要，不自动提价参数/answer/raw/images，不重定向/重试；响应256KiB与字段/UTF8/来源URL语法上限。URL验证只作来源展示过滤，不是DNS/重绑定安全fetch许可。provider变更必须匹配新grant，凭据只显式DAWN_SEARCH_*_API_KEY。Docker独立search.env隐藏TTY创建，运行前校验精确单变量/私有模式，防止env-file额外NODE_OPTIONS；不读取model.env。
- **验收与限制：**合成fetch/本机fake HTTP、真实临时SQLite与关闭重开/预扣/取消/停止/过期/来源不可信有专项。Windows只在测试临时目录模拟POSIX stat权限验证事务；生产不放宽owner/0600，Linux权限/真实TTY/供应商/DSH按钮仍须独立实装验收。根README集中使用教程。此项仅扩展“授权前台搜索”，不把D-015学习改成联网测验或后台学习。

## D-023：Windows PowerShell 直接启动 Desktop 服务，与插件共享显式目标

- **最新要求：**用户原部署从WSL启动，希望新增Windows Docker启动配置；新增Windows入口，不通过wsl.exe/WSL shell，也不把原生WSL引擎暴露成TCP或自动迁移其卷。Windows Desktop仍可能以WSL2作为内部后端，这不意味着必须从WSL终端操作。
- **同一部署：**复用唯一compose.yaml与原dawn-data，不另建Windows Compose override，避免插件固定`-f compose.yaml`与启动配置不一致。config/docker-windows.json仅显式dockerContext（desktop-linux）/projectName（shuguang-intelligence），仓库目录来自start.ps1位置，不受当前目录/COMPOSE_PROJECT_NAME推断影响；运行前检查原引擎/项目，首次setup仍明确确认身份及预算。同名项目在不同引擎上不共享卷，不能当主体迁移。
- **生命周期：**start.ps1支持start/status/stop/build/help。非help命令检查可信context为本机Windows named-pipe且OSType=linux；不自动启动/安装Desktop、切换全局context或fallback其他引擎。setup前需交互终端、原镜像存在则复用，失败不up；运行中不build/setup，5次status就绪后返回DSH；stop不down/rm/delete/recover/wake/学习。插件仍只exec，不取得生命周期权限。
- **PS5边界：**ASCII脚本兼容Windows PowerShell5.1，捕获命令检查原生exit code，交互build/setup通过无shell的ProcessStartInfo继承stdin/out/err并按Windows规则引用argv，保留隐藏key输入。捕获路径不披露原始Docker错误，wrapper固定脱敏失败提示；不更改全局执行策略。JSON严格拒绝未知/重复/转义字段、非法字符与超限。Docker可执行文件、context和Compose源仍属高信任本机输入，不提供恶意配置沙箱。
- **DSH同步：**启动前后打印可信目录/context/project供用户照抄到插件。插件不自动读取JSON，不自动安装/改profile；其空context默认default与Windows配置desktop-linux不同，必须显式填相同值。保留Linux旧入口但它不读取新JSON，教程Windows优先。
- **验收：**PS合成fixture注入Fake Docker/TTY/Pause跑真实调度函数，单独npm入口，不依赖外部Pester或Node子进程管道。CLI help/PS5解析/JSON与引号有专项；不把假Docker当实际镜像/终端/信号/DSH实装。本轮只配置/源码/离线验证，不commit/push、部署、真实资料/模型或主体初始化。

## D-022：当前交互改为 DSH 插件，移除默认 Pi 运行路径

- **用户纠正：**此前将DSH作为Pi之外的可选窗口不符合最新要求。当前交互正式改为DSH插件，不使用Pi；Docker仍只承载独立主体服务，不把DSH当主体/数据库所有者。不把此要求扩张为自动读取DSH模型/历史/凭据或后台活动授权。
- **取代范围：**D-018/D-019的镜像安装Pi、三卷和start后进入Pi，D-020/D-021的“Pi原运行路径保留/可选DSH”描述均由本项取代；其他身份、数据、确认、网络、预算与学习边界保留。旧决策与验证作为历史，不直接改写成当前事实。
- **运行：**Dockerfile不安装Pi/额外apt或npm依赖、不复制Pi扩展，只保留Node基础与Dawn/scripts/sample/MIT。Compose仅挂原dawn-data，旧Pi卷不删除、不挂载/迁移。entrypoint去pi命令；start.sh在setup/up/status就绪后输出DSH说明并返回，无交互客户端exec；运行中不自动升级，显式stop/build/start切换旧镜像。
- **插件：**新安装Schema与bundle patch默认docker（需用户显式填repo/context/原project），旧HTTP配置不自动迁移；Bridge省略connection的旧调用保留HTTP兼容，不改变已有测试/客户端。消息在DSH曙光面板，不截获DSH主Agent输入；Docker stdio/owner门禁/无token导出保持D-021。
- **源码兼容：**暂保留packages/pi-extension及原回归，避免为交互切换无谓删除兼容资产；不在默认镜像、启动、教程或实际使用路径。此保留不是继续让用户用Pi；未来删除workspace需单独范围，不删除用户旧卷或会话数据。
- **验证与文档：**README整体改为DSH使用路径，历史HTML架构图仍未跟进，不当当前部署依据。相关静态/流协议验证与shell执行结果分别记录，不用mock冒充Docker/DSH实装。不部署/安装/正式数据/模型/commit/push。

## D-021：Docker 模式走显式 exec stdio，不开放控制端口或导出 token

- **授权与取舍：**用户确认Docker部署，并同意补Windows DSH连接源码与合成测试。比较独立HTTP relay后，选择更少权限面/运维项的Docker stdio：避免新增0.0.0.0监听、host ports、桥token配对、DPAPI启动器和sidecar生命周期。此项扩展D-020：HTTP模式仍要求同loopback，Docker模式通过已有本机Docker控制通道进入容器，不要求DSH与Dawn共享loopback。
- **固定路径：**owner配置`connection: docker`、Host绝对repo目录、显式Docker context（缺省固定default）和可选原Compose项目名；Host仅shell:false执行固定`docker --context … compose --project-directory … [--project-name …] -f …/compose.yaml exec -T dawn dawn-container bridge-request`。不运行up/run/build/stop、任意shell或命令，不激活探测。项目目录/context只在Host配置，不由Client RPC/模型传入；目录作为单独argv，不包含消息或token。
- **容器职责：**新bridge-request仅从stdin接收一帧有界strict DawnRequest，用私有目录中的service.token和既有HttpDawnTransport访问固定127.0.0.1:7341。stdout仅一帧compact DawnResponse，应用error仍是合法响应并exit0；transport/协议失败固定stderr+exit1。无model.env导入、不打开DB、不改协议/HTTP绑定/Host/Origin或Compose。镜像必须显式重建包含新命令，原Pi/服务启动流程不变。
- **期限与取消：**Host保持stdin打开，EOF/流断开使容器桥abort内部HTTP；Host控制10s/say40s包含启动/序列化开销，容器初始帧10s，解析后按命令总预算重新计时，Dawn原35s服务期限保持。双方拒迟到/关联错配/错误UTF8/多帧/超64KiB（响应含末尾LF），不重试。Host销毁流并只终止本次CLI，不停止服务。Docker真实断开如何传播尚需实装，不能把kill docker.exe等同已杀容器请求；失败可能已提交/计费。
- **信任边界：**Docker权限等价高权限本机能力，daemon/CLI/Compose/PATH/context必须可信，插件不沙箱化它们。显式context可避免环境变量意外选引擎，但其实际配置可能是remote，要求用户选择本地。项目名建议明确指定已运行实例；不启动新容器，不复制或迁移任何卷来修复连接。
- **验证边界：**合成fake子进程双向流+真实HTTP验证stdio两端契约，不启动Docker/正式数据；本机Desktop引擎未运行，实际镜像、Windows/WSL同引擎、exec/取消/端到端DSH仍未证明。学习前仍停所有同库服务与旧runner，插件不会从停止容器自动恢复或偷偷启动学习。教程仅根README第6节。

## D-020：DSH 作为独立薄窗口，不成为主体或模型所有者

- **范围：**按用户最新要求创建 `feat/dsh-plugin`，新增第三个 workspace `@shuguang/dsh-plugin`。Pi 原入口保留；DSH → Dawn，core/runtime 不反向依赖 DSH。应用/协议/schema/数据库版本均不变，不新增学习 HTTP 或后台活动。
- **接入：**当前安装版 DSH 0.2.1-rc.2 使用 Cordis Host 插件与 Client 懒工厂。采用独立 `shuguang/command` Typert RPC 和 main/sidebar 面板；不使用 DSH Agent slash command（该路径会记 Session log），不调用 DSH 模型、不导入会话或凭据。Host 用官方 TypertRemoteService；严格 descriptor 是显式维护的同版契约，不冒称生成物。Client 挂载后单独注入 `remote.shuguang`，依赖撤销取消并拒迟到结果。
- **网络与凭据：**浏览器不直接 fetch Dawn，保留 Dawn 对 Origin 的拒绝；Host 复用既有 HttpDawnTransport 的精确 loopback/Host、鉴权、有界响应、关联 ID、超时、拒重定向和取消。RPC 强制 owner，不能给任意浏览器调用方选 endpoint/token。只命令时读取配置的私有 tokenFile 或 `SHUGUANG_*_TOKEN` 环境变量（唯一来源）；Windows 用显式 tokenEnv 不放宽 POSIX 文件校验。配置和进程环境由用户注入，插件不发现秘密或自动安装/启动。
- **行为：**面板挂载不探测服务；生成与远程模型目录操作都有可见披露。主体 revision 和选择 selectionRevision 分离；不自动重试、退款、重置预算或迁移。关闭面板/卸载只取消本客户端，不 sleep/关闭独立主体。最多8个并行请求，错误固定脱敏。学习仍在原授权本地 pack 的前台入口。
- **分发：**Node24 内建类型擦除构建，无新增运行依赖；复制可达 Dawn 客户端模块到插件 lib，浏览器使用 DSH 的 React，Host SDK 用同版 optional peer 与 DSH runtime resolution。JS 适配层显式独立于 TypeScript Bridge，根 allowJs 允许测试导入 JS，但 checkJs=false 不等于适配层已严格类型验证。安装/更新交给插件管理器，不手写 profile，不宣称当前 GUI HMR 生效。
- **部署限制：**DSH Host 与 Dawn 必须同 loopback 命名空间。现有 Compose 无宿主端口，不能直接供宿主插件连接；不为此开放0.0.0.0、改 Origin 或搬运容器数据。安装 SDK 实证、浏览器/实际配置与正式数据部署需单独授权验证，本轮仅源码与合成离线测试。该项扩展 D-019 的单教程内容：仍只 README 维护用户教程，但按最新要求新增可选 DSH 安装节，不恢复已删除手册。

## D-019：WSL/Linux 单入口启动与显式首次设置

- **动机：**用户实际在WSL Linux终端用Docker；把进入Bash、init、model-config、credentials、up、exec拆开仍过于繁琐。以`bash start.sh`作为正常入口，不新增Web后台或重构主体。
- **宿主职责：**只检查Docker/Compose、首次缺镜像时构建、服务停止时调用容器setup、up、鉴权status就绪后进入Pi；已有服务复用，不重建/改配置。status/stop/build为同入口子命令，build要求服务已停。无自动安装/sudo/git pull、删除卷、key传参或宿主Node/Pi要求。
- **设置职责：**容器setup整合普通字段与隐藏key，首次写入前明确确认身份/本地示例pack/总额度20可调与学习子4；模型入口/ID由用户填，thinking默认off且仅省略参数，实例上限4/30秒。已有完整文件仅预检；缺配置补项不覆盖，DB/token只有一项时拒绝自动修复。取消或失败保留已成功文件，不以删除库完成重试。模型/学习权限、原子事务和DB格式不变。
- **不隐式授权：**首次保存不联网探测、不唤醒或付费生成/学习，不传曙光key给Pi；新主体保持sleep，Pi仍由用户按当前revision显式wake。学习仍先停全部同库使用者，脚本不提供跨进程独占保证。持久卷位置与旧主体迁移保持D-018。
- **文档与验证（按用户最新要求修订）：**仅根目录README维护一份简约完整的部署/使用教程，不保留单独Docker教程或旧源码部署教程，也不并列两套部署路径。假Docker/临时合成库/TTY回归不等于真实build/Compose/Pi TUI已验证；真实部署、迁移、发布、commit/push仍需另行授权。

## D-018：单容器部署封装，不改变独立主体与模型边界

- **决策：**提供Node24+固定Pi版本的镜像与Compose，容器内管理入口包装既有CLI、私有凭据录入和Pi连接。Windows用户仅运行Docker命令，无需在WSL单独安装运行时或配置环境。Docker引擎可仍依赖WSL2，不声称完全去除WSL。
- **进程与网络：**同一容器中的曙光服务与exec Pi为独立进程，共用loopback，不开放宿主端口；不为跨容器方便而放宽HTTP绑定/鉴权。退出Pi不关闭主体服务，容器停止会终止其中进程。
- **持久化：**主体/配置/密钥、Pi设置/会话、工作目录分为三个命名卷；镜像只含允许列表源码和示例pack，无真实配置或秘密。非root uid1000，已有权限错误不自动chown、覆盖或迁移。卷不是加密vault，Docker管理员可读取。
- **操作授权：**init/model-config/credentials单独显式执行；启动缺配置失败，不自动初始化、wake、学习或生成。学习前停同库交流服务；recover仍需确认全部旧runner停止。运行入口不转交曙光模型key给Pi、不复制宿主配置。停止/更新不删除卷。
- **验证边界：**当前环境无Docker CLI/socket，不执行镜像构建/系统包/Pi下载；入口、合成文件/终端与回归验证不代表Compose/Windows/Pi镜像内已验证。Node标签/apt/传递依赖未完整固定，不冒称位级可复现或正式部署。

## D-017：同一服务模型实例的显式运行中选择

- **决策：**Pi薄窗口提供模型与thinking选择器，并复用曙光自有protocol/client向既有服务发控制请求。本体持有入口与凭据、执行显式GET目录和真实生成；Pi不调用自己的模型或导入会话/密钥。
- **预算与一致性：**不以重建adapter实现切换；模型、thinking、调用计数和上限在同一实例，失败不退款，无重试/自动降档。控制纳入既有FIFO；独立selectionRevision做CAS，冲突显式报错。主体revision、持久身份和记忆不因选择变化。适配器拒忙时直接切换，生成捕获本次model/thinking。
- **目录与隐私：**只有显式models或选择器确认刷新才向原入口GET /models，固定认证、拒重定向、有界字节/条目/时间、严格ID校验；不发主体或Pi历史。失败不替换缓存。只发现ID，不能认证兼容性、价格或推理能力。
- **thinking：**off仅省略reasoning_effort，其余档位原样发送，不自动转换成none或改API协议。允许提交的档位不是每模型能力元数据。
- **范围：**仅服务进程内、所有客户端共享；不写配置或SQLite，不影响独立learning-run，不增加provider管理/工具/后台活动或新DB格式。重启还原配置和选择版本，选择版本不是跨实例租约。D-016的离线向导不变，其“不支持模型发现/切换”仅指向导自身；运行中控制由本决策补充。

## D-016：独立、本地离线的模型配置引导

- **决策：**新增 `model-config --output /absolute/new.json` 交互向导，参考Pi提供商/入口、模型、凭据与推理选项分层，但生成既有曙光单模型配置，不引入Pi运行时依赖或另一套默认选择规则。多个模型可分别保存为不同文件，由现有 `--model-config` 显式选择。
- **实现边界：**runtime处理向导与输入校验流程，terminal adapter负责TTY；配置adapter复用现有字段/URL策略并排他新建0600文件。用途只推荐实例次数，不绑定主体、改变永久预算或创建数据库。只有后续显式运行命令可能调用模型。
- **不支持：**自动读取Pi models/auth/settings、OAuth、执行凭据命令、保存密钥值、联网模型发现/探测、自动兼容转换或模型切换。仅现有Chat Completions适配，不因界面选项冒称支持Pi全部协议。
- **文件与取消：**绝对输出路径、父目录预先存在且可信、禁止覆盖和最终symlink；取消确认不保存，写入失败可能留下新文件证据，不自动删除/重试。

## D-014：0.1.0有界首版与共享独立客户端

- **状态：**源码收尾与验收，不表示部署或发布。
- **决策：**首版定位单所有者、本机独立伙伴的六核心交流/记忆/恢复闭环；自主持续学习、工具、无限记忆和模型自批成长不计入首版。应用/workspace统一0.1.0，与协议/DB/domain版本分离。
- **入口：**HTTP客户端和命令解析由dawn拥有，Pi仅兼容re-export并提供UI；独立request CLI连接同一个已有服务，不发现凭据、不拉起进程、不重试。避免本体为了独立交互而反向依赖Pi包。
- **验证：**新增可重复离线验收，使用临时主体和假上游；明确分开工程测试、真实API样本与长期人格/成长效果。标准依赖干净安装、正式主体/部署/发布不借版本号隐式宣称完成。
- **运维：**前台启停、显式新建、私有凭据、停写后备份；旧格式兼容保留，不默认迁移或重建。详见docs/release-0.1.0.md。

## D-013：显式六核心运行模式与统一事务所有者

- **状态：**实现并本地模拟验证，未正式初始化/部署或真实候选API验证。
- **决策：**新增subject-init/status/wake/sleep/budget与serve --subject-db，单库DSW2/schema2保存六核心snapshot/bootstrap/typed events/attempts；旧--db/--chat-db继续legacy，不自动识别、迁移或覆盖。
- **交流：**最小self/affect/相关memory/cognition/agency投影与有限成功问答→一次模型调用→严格reply/appraisal/candidates JSON。生成候选不能改变权限、身份、values、关系边界或提供可信评估；belief仅tentative、memory correction仅candidate、growth不自批。
- **事务：**T1预占次数并去重requestId；模型IO在事务外；T2锁内复查最新attempt、awake和revision，重新运行用户及助手两cycle，同事务保存snapshot/events/pair/usage。用户陈述和助手inference分离。open/read从bootstrap完整回放校验，不删除一致性检查。
- **兼容与限制：**新建主体不是旧库无损延续；容量有界，全量回放未做压缩；失败调用收费、不重试、崩溃pending不重发；提交后网络丢失不能承诺恰好一次交付。没有自主调度、学习工具、即时sleep抢占或跨进程独占。详见docs/subject-runtime.md。

## D-012：六核心纯领域内核优先，旧运行链路显式隔离

- **状态：**领域层已实现；后续显式运行接线见D-013（无正式部署）
- **决策：**采用self/cognition/affect/memory/agency/growth六核心，每个模块落地可执行规则，而不是六个模型或服务。core/experience统一经历；core/cycle协调有类型候选、证据解析、情感评价、意图选择和成长验证。
- **边界：**domain schemaVersion=2不等于SQLite v2；原schema v1类型/状态/校验移入legacy，原服务和数据库格式不变，不做自动迁移。新core不依赖legacy/runtime/adapters。
- **输入与变化：**拒绝任意patch，模型只能提供未信任领域候选，可信调用者另提供allow/budget/stop/评估；每步校验scope、来源、时间、去重和幅度，任何失败不修改传入状态。评估只能用于先前cycle候选，文字自评不当作客观结果。
- **限制：**纯函数原子返回不等于持久事务或实际跨进程CAS；当时新核心未控制live说话或工具；后续说话接线见D-013，工具仍未接入。权重与半衰期为显式工程启发式，非论文复现或意识证据；完整契约见docs/six-core.md。统一持久存储与模型接线后续单独验证，不借本轮增加外围。

## D-001：主体核心独立于 Pi

- **状态：**已采纳
- **决策：**核心是独立的 `packages/dawn` workspace；Pi 插件属于可选薄适配层。
- **理由：**主体生命周期和状态不应由某个宿主的启停或 API 定义。
- **约束：**关闭 Pi 不隐式改变主体状态；核心也不假设 Pi 存在。

## D-002：持久主体状态与显式本地 SQLite（替代旧内存存储决策）

- **状态：**已由 D-008 替代（旧决策仅保留历史记录）
- **原决策：**只承诺内存中的状态；状态不跨进程重启。
- **当前约束：**持久 SQLite schema v1 已实现。运行能力、CAS、事件、安全限制与迁移边界以 D-008 为准；不得再把“状态不跨重启持久化”当作当前实现。

## D-003：模型输出只能是待审提案

- **状态：**已采纳（作为未来接入约束）
- **决策：**任何未来模型输出都只能作为提案；在校验结构、权限、状态版本和策略之前，不得直接提交状态变更或触发行动。
- **理由：**模型不是事务执行器或授权来源。当前模型可依据有界对话记录交流，不直接提交主体变化。

## D-004：隐私隔离与认识论标记

- **状态：**已采纳（作为设计约束）
- **决策：**未来记录应隔离私人信息，并区分事实、推测与想象；不得将推测或生成内容无标记地作为事实保存。
- **理由：**记忆和主体状态需要可理解的来源与可信度边界。当前尚无记忆条目仓库。

## D-005：情感表达不代表意识，不用于胁迫

- **状态：**已采纳
- **决策：**情感状态或情感表达不构成意识存在的证据；不得以情感表达制造负罪、依赖或胁迫用户的压力。
- **理由：**避免把 affect 概念误述为意识声明或操纵手段。

## D-006：CLI 与插件不宣称虚构能力

- **状态：**已更新
- **决策：**CLI 提供 `--help`、`--check` 以及显式 `init`、`status`、`wake`、`sleep`、`events` SQLite 操作。每个数据库命令都需要绝对 `--db`；仅 `init` 可创建库，必须带 `--id`、`--name`，且绝不覆盖。wake/sleep 需要 revision。`--check` 只报告 adapter 可用性，不打开库或启动监听。token-init 仅显式创建本机服务凭据，serve 显式启动前台控制服务，不自动 wake。Pi 插件显式配置后可通过鉴权本机服务执行 status/wake/sleep；say 未配置模型时返回未实现，显式配置且清醒时支持有界历史交流，仅保存对话证据，不自动提炼长期知识。未配置/未连通必须报告不可用。服务需要手动 serve，插件不自动启动进程。
- **理由：**明确的本地持久化功能不应与尚未存在的服务、模型和自主能力混淆。

## D-007：协议与传输分离

- **状态：**已更新，本机服务见 D-009
- **决策：**协议独立提供消息类型及运行时校验；HTTP 与 Pi 分别适配，服务强制鉴权、资源边界和请求关联。status 增加运行实例元数据，当前本机客户端/服务端需一起更新。
- **理由：**类型不替代网络数据校验或身份验证；传输实现不能侵入主体核心。

## D-008：SQLite schema v1 的显式持久化边界

- **状态：**已采纳并实现
- **决策：**使用 Node 内建 `node:sqlite`，一个数据库一个主体。仅显式 `init` 创建新库；要求绝对路径、已存在父目录、`--id` 与 `--name`，使用排他新建、不覆盖现有文件；`open` 不创建缺失库且拒绝 symlink。应用 ID 与 `user_version=1` 必须匹配，不自动迁移旧版或未来版。初始化失败留下的文件不自动删除、替换或重试。
- **事务：**schema v1 仅支持 lifecycle 写入。事务以 `BEGIN IMMEDIATE` 串行化写入，CAS 比较预期 revision；revision、状态快照和 lifecycle 事件原子提交。no-op 不增事件。bootstrap 在创建时保存完整 snapshot（可包含非空主体字段，但 revision 必须为 0）；后续打开时从 bootstrap 回放事件并要求等于当前快照，以校验支持范围内的状态一致性。此校验不是防篡改证明。
- **边界：**完整 snapshot 最大 2 MiB；事件是有限诊断历史，不是长期记忆。`memoryIds` 只是 ID，记忆正文仓库尚未实现。SQLite 操作同步阻塞；AbortSignal 只在同步调用边界检查，不能保证中途即时中断；busy timeout 为 1000 ms。
- **安全与运维：**仅适用于可信、私有的数据库父目录，不防恶意同 UID 用户，也不消除检查/打开竞态；不加密、不防篡改。默认 DELETE journal，不是 WAL。备份必须在停止写入/关闭数据库后做完整复制；不支持活动期间直接复制单个 DB 文件作为一致性备份。推荐位置 `~/.local/share/shuguang-intelligence/dawn.sqlite` 仅是建议，不自动创建。
- **生命周期：**关闭 Pi 不自动 sleep；持久化 `awake` 是状态字段，不是存活心跳。详情见 `docs/persistence.md`。

## D-009：独立前台控制服务与 Pi 薄直连

- **状态：**已实现，未安装/启用
- **决策：**显式 serve 打开已有 SQLite，实例内串行执行控制请求，独立 HTTP adapter 仅监听 127.0.0.1。强制私有 token、Host/Origin 校验、消息与连接限额。token-init 显式创建 0600 凭据，不打印 token。
- **宿主：**Pi 只转发显式命令，不发送会话历史、不调用宿主模型、不维护另一套主体状态。关闭 Pi 仅取消本客户端请求，不 sleep 或关闭独立服务。
- **剩余工作：**Pi 自动拉起尚未实现；自主活动、控制请求的持久去重、跨进程独占运行租约仍未实现；对话记录与 say 的请求 ID 去重见 D-011。实例 ID 是连接状态信息，不是锁或持久身份。
- **取消：**响应丢失或客户端取消不证明服务端未提交。重新查询 revision，不能自动重试带副作用请求。

## D-010：显式模型 API 与最小单轮交流

- **状态：**已实现并通过授权的真实入口测试
- **决策：**OpenAI 兼容适配器由 --model-config 显式启用，仅 credentialEnv 引用，不自动读取 Pi 配置。当前用户授权复用 Pi 入口时只保留 URL、模型和已有环境引用，密钥不复制。
- **边界：**清醒检查、8 秒超时、每次 256 输出 token、实例调用次数上限、重定向拒绝、响应大小/schema/用量校验。无自动重试或切换端点。对话与持久额度后续由 D-011 接入。
- **后续：**经验证的主体变更提案与长期知识仍需实现；API 交流不等于学习成长。

## D-015：用户更正首版必须自主学习

- **状态：**范围已更正并实现，24项学习专项与231项全量离线回归通过；覆盖此前将自主学习排除0.1.0的决定。仅交流版完成结论不再成立。
- **必需闭环：**一次显式授权本地有界pack与永久学习子预算后，由主体状态/进度规则自主选题，连续读资料、生成笔记与练习、独立测验、保存结果并选下一目标；无逐轮人工提示。
- **实现：**SQLite v3显式新建学习主体库，不迁移已有v2；同库同主体和总额度，独立typed学习事件与学习attempt，不伪装用户聊天。core schema2不变；v2交流原行为保持。
- **验证与边界：**本地exact评分，私有答案键永不投影给模型，study不见heldout题；模型笔记仍inference、分数只证明该次任务。进度/费用/停止持久化，失败目标终止不重试，pending仅明确停止旧进程后手工recover。无任意工具/后台服务/权重训练/模型自批人格。

## D-011：主体绑定对话库与不可退款的持久次数额度

- **状态：**已实现，尚未正式初始化或启用
- **决策：**独立 SQLite sidecar 保存单一可信 owner 会话，不改主体 schema v1；chat-init 显式新建、绑定 subjectId 与固定次数上限，serve model-config/chat-db 必须成对提供，缺失不自动创建或回退。
- **上下文：**只回放已完成问答的最近完整连续后缀（8 对/24000字符），本次输入加历史最多40000字符；不发送 Pi 历史或私有主体字段，用户/助手 role 标记保留，不作为已验证事实。
- **事务：**生成前原子预占收费并去重 requestId，错误/取消/崩溃不退次数；回复及 usage 在最新预占序号检查后原子提交，提交成功才回复。未完成请求不进历史；失败用户输入仍存在台账，明确文档告知。超限后需另行明确管理，不自动重置或续期。
- **限制：**次数额度非货币/token预算；同ID复制/恢复/替换新库可改变历史，非防篡改计费。跨库生命周期检查非联合事务，不保证其他进程 sleep 与对话完成强原子或即时抢占。多人会话、遗忘/删除、摘要提炼、跨进程独占与持久费用结算仍未实现。
