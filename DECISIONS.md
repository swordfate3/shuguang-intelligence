# 架构决策记录

## D-023：可信来源与宿主桥设计收敛（仅设计，未实现）

- 按flow-design继续既有host-capabilities主文档，第11—18节选择普通MCP八工具＋私有typed宿主桥；owner UI管理与executor权限分离，不让现有service token/role字段冒充可信身份。原MCP不增加grant创建或暴露claim秘密，不缓存tool ctx伪造后台搜索权限。
- 会话先采用当前活动分支选定text块、准确预览后一次性批次授权，不监听全部历史；来源台账定位/hash去重，user_statement与Pi inference分离，不经say、不增本主体chat history；无模型生成的本地原子消费与接纳分离。
- 自主query先由owner批准公开seed/术语/模板生成，任意新文本候选等准确输入批准；provider固定适配在实际请求端实施预算/SSRF/无登录态/重试限制，无法保证就不登记。开放网络无独立测验只标verification_pending，不自批growth。
- 选择DSW2 SQLite v4候选保存同库来源/grant/run/task/receipt/新模型attempt，保持domain2和原wire v1；旧v2/v3不自动迁移，正式迁移需停写、验证副本及独立批准。现有pack及永久总额度不降级/重置。
- disconnect/卸载/退出仅关闭Pi接入与bridge/binding，不stop/sleep/delete曙光Docker、镜像、卷或记忆；有效grant不等于在线执行许可，未知外呼不自动重派。来源快照与假检索切片可先验证，真实pirun/provider/迁移另确认。
- 本轮只设计及静态文档检查，不新增运行接口、代码、数据库、安装部署或真实调用。详见docs/host-capabilities.md；拟验收不冒充已通过。

## D-022：Pi资源包统一分发MCP连接管理和skills

- **范围：**用户后续要求以Pi扩展安装包管理MCP并附带skills。新增`packages/pi-package`与根Pi资源清单；这不是恢复已删除的`packages/pi-extension`或`/dawn`聊天窗口，不让Dawn依赖Pi，不把Pi装回镜像。
- **职责：**扩展只注册`/shuguang-mcp connect|disconnect|status`，固定Docker exec stdio入口；connect显式绝对配置路径（或启动器提供环境引用）、有UI确认后注册本会话MCP，默认只读，不自动重连/启动/安装/修改mcp.json。配置不含token/API key；取消/断开/关机拒绝迟到确认。
- **分发：**Pi package声明extensions与skills，未来增加skills沿用同一资源包；当前附带shuguang操作skill，不写入主体记忆或自动执行学习。本地安装或Git整仓均由Pi包管理，不伪称已npm发布。
- **边界：**`status`是注册元数据不是健康；文件同名条目优先，替代内置MCP的适配器需支持动态注册。访问Docker本身是强权限，allowWrite仍非细粒度ACL或逐次批准，可信项目/context/PATH由owner负责。无源历史/搜索桥/新grant或数据库修改，不替代D-021执行桥。
- **验证：**Node合成配置/生命周期与竞态测试、宿主Pi离线加载检查，真实Docker/用户pirun和TUI交互仍须另验。不自动安装到用户Pi或commit/push。

## D-021：宿主检索能力窄契约与持久任务交接（设计，尚未执行）

- 按用户后续要求，曙光自主学习可提出Web检索问题，由Pi可信桥调用固定web_search/fetch_content适配，MCP负责list/claim/submit/status，不经sampling或万能execute继承全部工具。接口详见docs/host-capabilities.md，未注册新工具/改运行代码或DB。
- 可信控制面grant与执行方登记分离；模型不能创建授权/伪造身份。默认公开无登录态搜索与文本读取；对话供给单独授权和可信来源，不走owner say。若执行端无法限制真实网络请求/内部调用数，则不得声称满足策略。
- claim先持久预占/CAS后最小披露，任务/执行绑定/run fence/期限各有职责；claim ACK核对不等于再次外呼，崩溃不自动重派。结果接收去重与主体消费独立，不以ACK声称学会，不让网页/摘要自批growth；sleep/stop/revoke/EOF分别定义。
- 本轮仅契约设计和文档检查，沿用既有本地pack闭环，不增加真实联网/费用/模型调用、安装/部署、迁移或commit/push授权。

## D-020：MCP优先分支与受限stdio接入

- **范围：**按用户要求从main b446014创建feat/mcp，删除Pi专用薄workspace/测试与镜像内Pi，专注MCP；保留main与独立DSH分支不修改。不改core、底层wire v1或数据库格式，不迁移正式数据。不因开发授权默认commit/push/安装/部署。
- **第一阶段：**新增无运行依赖的MCP tools-only stdio适配，桥接已有鉴权loopback服务。Docker客户端通过exec -T在同容器运行桥接，无新增端口、宿主socket挂载或token复制；本地Node模式显式endpoint/token-file。服务生命周期仍独立，不随MCP退出sleep/停止。
- **授权：**默认只读status/model_status，显式allow-write开放六个写/联网工具；annotations不是确认或授权，宿主需另设策略。底层token仍单一权限，此开关不保护恶意同UID或任意Docker执行方。输出可能进入宿主模型，不隐式提供完整记忆。
- **未来目标：**用户要求从获准的用户/Pi交流中学习并借检索自主探索。第一阶段仅接入骨架，不用say冒充该目标完成；下一阶段须来源区分、会话范围授权、可撤销能力、检索任务账本、预算和独立验证，不能默认继承所有MCP工具。现有本地pack闭环保留，不降级首版学习。
- **覆盖关系：**替代D-009/D-017中的Pi专用窗口、D-018/D-019中Pi镜像/三卷/启动后进入Pi部分；其事务、单主体、显式设置、失败不退款及部署授权约束继续生效。旧Pi卷不挂载也不删除，运行教程仍仅根README。

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

## D-026：HTTPS Streamable HTTP为远程接入，stdio只作本地兼容

- **状态：**用户纠正客户端不应依赖服务部署位置，并授权优化；本轮实现源码／隔离验证，不自动安装反代、配域名证书、公开服务、操作正式库或commit/push。
- **决策：**远程客户端只持HTTPS `/mcp` URL及独立接入Bearer；不需要Docker／宿主路径／数据卷。标准tools-only Streamable HTTP以POST单JSON响应、GET405、随机session／DELETE结束接入；不提供SSE／重放、OAuth或多用户ACL。内部Dawn HTTP仍loopback，不冒充公网MCP。
- **部署：**显式独立gateway adapter复用既有tools/DawnTransport，无新框架依赖、不另开主体或DB；TLS在可信反代终止，准确Host／Origin及独立鉴权，不信X-Forwarded头。独立access token不能等于service token，owner token不进远程接口。默认Compose不变，overlay显式共享服务网络与只读原卷、仅宿主loopback发布网关；反代部署及卷管理员可信，不声称文件级隔离。
- **客户端：**Pi配置精确区分URL＋credentialEnv／本地Docker两模式，注册前UI确认，不读发现／输出秘密；allowWrite仅收窄客户端工具暴露，不能升级服务端启动开关。普通MCP八工具及原状态／预算／同主体事务保持。share/research私有桥未远程化，远程模式明确拒绝，不误称全产品已远程可用。
- **失败语义：**HTTP断线不等于取消，不自动重发／退款；显式取消／会话结束不撤回已提交状态。保留原stdio及本地私有桥，不因换传输重建主体。网关退出只移除接入，不stop/sleep/delete独立服务。

## D-025：获准公开问题的v5有界研究，不冒充自由自主联网

- **状态：**用户明确要求实现关键后半段；新增源码与合成验证，未真实联网/付费、安装、迁移、部署或提交。此决策取代D-024“全部研究仍未实现”的当前状态，不覆盖其来源授权规则。
- **范围：**主体从owner明确批准的1..8问题/query中按兴趣/关切/未覆盖主题排序；Pi可信私有执行桥只做固定search，一任务一次claim先预占，receipt接受后由曙光自己的模型分study/assessment。不是Pi主模型代答，不支持任意tools、web.fetch、自由query拼接、由私密历史自动生成公开检索或常驻后台。
- **版本：**显式research-learning-init新建DSW2 v5，原v2/v3/v4和默认Docker v3不升级。保留pack/来源，chat+pack+research共用永久模型额度及单pending；search独立计数，失败/取消/未知不退款。普通MCP仍八工具；private host v1加严格typed用例。
- **执行与恢复：**next不披露query，claim只成功一次；receipt hash幂等但历史ACK不是再执行许可。step T1预占后后台只跑一次35秒phase、立即ACK不占host FIFO；pendingModel明确区分正在执行与已完成phase。断线pause+fence；重启恢复必须停全部旧写者后显式research-recover，claimed/pending转unknown不能重派；owner status/stop可跨binding，resume仅未派发/accepted阶段。无跨进程租约，普通serve不自动恢复/接管，避免重复启动破坏活跃研究；显式恢复前必须停止同库旧服务/runner。
- **来源与评分：**网页/host摘要角色分离，Tavily content保守标inference；URL canonical去fragment共页根，变化摘录依赖旧根。材料/笔记/本地评分/typed事件/snapshot同事务。答案键与heldout题只本地存储，study不见heldout，assessment只笔记/题干，未提供assessment最多verification_pending；不批准growth，不证明通用掌握。
- **请求边界：**固定api.tavily.com HTTPS POST、全DNS公网检查并pin连接、SNI/TLS验证、无代理/Cookie/redirect/retry/fetch，8秒/128KiB响应/3results/32KiB规范结果。合法字段反射key也失败关闭。仅合成兼容测试，不声称供应商内部计费/派生访问被控制。
- **容量：**64runs、8192研究审计事件/16MiB，普通写到8000/15MiB前止，fence/fail/必要terminal共享有界清理余量；快照2MiB/core1000保留。容量失败不静默遗忘或扩大披露。

## D-024：最小会话来源切片，显式v4且不等于学会

- **状态：**已获用户“推进实现/继续”授权，完成源码与合成验证；未正式启用或迁移。完整网络学习仍按D-021/D-023设计推进。
- **决策：**Pi用户命令`/shuguang-share`采集当前分支最近完整user/assistant text块；先UI/idle/服务状态，再准确预览主体、文字和未来模型披露；确认后核对快照、短期grant、accept、consume。禁止用say、普通MCP写开关或模型自报role授权。无UI/取消/分支变化/断开不继续派发。
- **信任边界：**容器内私有JSONL桥持独立owner token，经loopback同socket配对10分钟executor；owner只授权/撤销，executor只接收/消费/查询。秘密不进Pi stdout/日志，合法响应字段反射凭据同样拒绝；无自动重连或重发。该边界不防同UID/Docker管理员绕过。
- **存储：**显式`host-learning-init`新建DSW2 v4，原v2/v3与默认Docker setup不变、无迁移。v4保留pack及共享预算，新增精确来源/批次/grant/控制事件；来源唯一定位/hash冲突拒绝，user_statement与inference分开、不进聊天history、不调用模型或批成长。accept和consume分开，整批cycles/typed event/snapshot/消费标记同事务。sleep撤host权不撤pack；pending模型拒消费。
- **限制：**2MiB快照/1000 core项与全量回放保留；host台账1000 grants/batches/sources、4MiB来源正文、4000审计事件上限。binding只内存、重启失效；已保存不能撤回，ACK丢失结果未知不重发，跨重连恢复UI与正式迁移未实现。来源可靠记录不证明文本真实、理解、通用掌握或成长。
- **后续：**研究run/task/claim/receipt、公开query manifest执行、真实Web provider与独立测验尚未实现；不因最小来源通过就扩大到联网、费用、安装、部署或提交推送。
