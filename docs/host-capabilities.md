# 宿主能力与检索学习接口 v0（设计、来源与有界研究实现）

状态：`feat/mcp`已实现**Pi片段→UI授权→私有桥→v4来源消费**及**v5获准公开问题排序→一次claim搜索→receipt→study/held-out assessment→原子记忆/评分→有界继续/停止**。固定Tavily搜索适配仅合成验证，未实际联网、部署或迁移。普通MCP仍仅原八工具。安装/使用教程只维护根[README](../README.md)，本文不是另一套部署教程。

### 最新实现优先于下列历史设计：D-025 / v5研究子集

- `research-learning-init`只排他新建DSW2 v5，兼容pack和v4来源；默认setup仍v3，旧库不升级。`core/research.ts`严格plan/goals/query/receipt/status与确定性排序；主人批准准确问题/query（非自由query生成），私有状态仅排序，不拼接或披露私有记忆。plan≤48KiB、1..8目标、1..8search、2..32model phases、run截止不超过10分钟socket绑定。
- 新`research_runs/research_tasks/research_receipts/research_model_attempts/research_events`同库，64runs、8192审计事件/16MiB，普通写提前留控制余量；原2MiB snapshot/core1000项不变。完整重放对账，研究费用与chat/pack合计、模型一pending、失败不退。next仅安全摘要，claim CAS预占后才给query，历史claim不能重新拿执行许可；status显示pendingModel区分phase已完成与仍在途。
- 私有请求新增research-start/status/next/claim/submit/step/stop/pause/resume；start/resume/stop/status由owner凭据，执行走绑定executor。status/stop可跨旧binding安全查询/撤权，resume只恢复paused的未派发阶段；owner/executor秘密仍容器内。ordinary MCP写开关不授研究权。step只预占并启动一次35秒有界模型phase，立即返回，不占host FIFO等待模型。
- receipt接受不隐式生成。study仅公开问题/query、带URL材料及practice题干；assessment仅保存笔记和heldout题干、不含材料/答案。typed阶段事件与来源/笔记/程序评分/snapshot原子提交；同页URL canonical去fragment共根，改摘录依赖旧根，host_summary是inference。无assessment只能verification_pending，不批growth。
- Pi新增显式`/shuguang-research`与固定Tavily适配，无新模型工具/任意execute。有UI、已注册、idle、安全文件、provider可用检查与准确manifest预览确认后才start。没有真凭据/部署/实际provider兼容验证。DNS全地址检查+pin实际TLS连接，固定host/SNI、无代理/Cookie/redirect/retry、128KiB响应、32KiB规范结果；搜索链接仅元数据，不fetch，content标host_summary。
- disconnect/session关闭尽力abort并持久pause/fence，不stop/delete主体；崩溃重启后须先停同库全部旧写者，再由管理员显式research-recover调用pauseResearchOnRestart；普通serve/read-only open不隐式接管或改研究。未知claim/model收费终止，不自动重派。精确金额、供应商内部派生访问、跨进程租约不保证。原来源批次的跨binding恢复UI仍无实现。
- **仍未实现：**web.fetch、自由提出并批准新query、私有对话→自动新问题、连续历史监听、无人值守常驻研究、正式v2/v3/v4迁移。第1—18节为历史完整设计，未被本子集覆盖的字段/能力不是当前API。

**设计推进：**第11—18节收敛独立执行通道、选定片段、同库v4与保留Docker的断开语义；这些决定优先于第1—10节中未定示意。当前源码差异在本节明确，不以设计矩阵冒充运行证明。

### 前轮最小来源切片记录（历史；最新研究事实以上节为准）

- Pi用户命令`/shuguang-share [1..16]`只选择当前分支最近完整user/assistant text块，默认4；不自动监听或搜索。上限16块/每块4000 UTF-16/整批24KiB。准确预览后一次性5分钟grant，角色仅映射来源，不认证物理作者。
- 私有typed JSONL桥在容器内配对；loopback `/host/v1/request`验证独立owner token，并按同一socket绑定10分钟executor。普通service token不升级；普通MCP不暴露grant能力。秘密不进入Pi返回；无自动重连/重试。binding仅内存保存，没有host_bindings SQL表。
- 显式`host-learning-init`新建v4、保留原pack；v2/v3不迁移，默认setup仍v3。当前仅新增host_grants/import_batches/source_records/host_events，尚无research/run/task/receipt表或计费。user来源为user_statement、assistant为inference，外部定位不塞core sourceIds；本地原子消费不调用模型、不进history、不批成长。
- 全库1000 grants/batches/sources、4MiB来源文字、最多4000控制事件；2MiB/core1000项不变。sleep原子撤销host grant但不撤pack；跨binding不能继续消费，尚无owner重新绑定恢复UI。
- 当前错误码仅UNAUTHORIZED/UNAVAILABLE/INVALID_REQUEST/UNSUPPORTED；未实现设计中的细分故障码、capabilities状态、Web安全策略与公开query manifest执行。disconnect本地取消不保证已提交内容可撤回。
- 实际测试与未验边界见[verification](verification.md)；后文提及拟增实体/网络验收均保留设计属性。

## 1. 历史设计：目标与原现状缺口

用户目标：曙光在授权范围内自行选择问题，经Pi的Web搜索/网页读取获得材料，再学习、练习、验证和保存；同时能学习获准的用户/Pi交流。MCP负责交接，不自动取得宿主历史或其他工具。

现有`packages/mcp/src/tools.ts`只映射既有`DawnRequest`；`say`使用owner消息语义，不能导入代理/网页来源。`runtime/learning-store.ts`仅本地pack的study/assessment；`adapters/capabilities/port.ts`是未接执行的通用端口，`UnavailableCapabilities`明确无能力。不能把这些现状写成已接通网络学习。

## 2. 责任与依赖

```text
用户在可信控制面授权范围和预算
      ↓
曙光runtime：目标/任务/预占/状态/证据/学习进度
      ↓ 受限MCP工具交接（由宿主发起调用）
Pi侧可信执行桥：领取任务、检查策略、调用获准工具、规范化结果
      ↓
Pi现有 web_search / fetch_content（或经审计的等价工具）
      ↓
带来源的原始摘录/失败收据 → 曙光校验接收 → 独立学习阶段
```

- MCP服务端不直接调用Pi内存中的工具函数，不把`sampling`当通用工具执行隧道；第一期继续tools-only stdio。
- 采用**持久任务邮箱/领取与回传**，宿主主动轮询/领取。Pi执行桥是可选的宿主适配程序，不是恢复已删除的Pi聊天UI或主体owner。没有执行桥只能人工/模型编排演示，不能宣称可信自动委派。
- core保持纯规则，Dawn runtime拥有状态机和事务，storage持有账本；MCP只做schema/传输，Pi适配只负责受控I/O与执行收据。运行事实不得只存临时MCP进程，重连不创建新主体或重置预算。
- 不允许嵌套`shuguang_say`驱动Pi再问曙光形成循环；无任意`toolName/command/args/code`透传接口。

## 3. 首批能力目录

| 稳定能力ID | 输入 | 返回 | 边界 |
|---|---|---|---|
| `web.search` | query、maxResults | URL/标题/摘要、检索时间及供应商来源标记 | 公开网络；搜索文本会披露给搜索供应商 |
| `web.fetch` | 一个明确HTTPS URL | 有界正文摘录、实际URL/重定向链、获取时间 | 无登录态、无脚本执行、无图片/文件/音视频分析 |
| `conversation.read` | 已授权会话的有界游标区间 | 按发言者标记的消息片段 | 与Web授权分离；默认关闭；不能泛读全部历史 |

Pi侧映射建议：`web.search`只调用固定`web_search`，provider/代理/缓存策略由可信配置决定；`web.fetch`只调用固定`fetch_content`的文本读取模式或专用只读HTTP实现，禁止模型/answer/vision模式和任意参数透传。搜索结果的模型生成答案必须标`host_summary`，不能冒充网页原文。具体Pi工具返回格式变化由适配器吸收，不传播到曙光core。

**不能仅凭函数名认为安全。** 通用`fetch_content`可能具有本地文件、登录态、视频和额外模型调用能力；若不能在实际请求发起处限制DNS/IP、重定向、大小、认证与附加调用，执行桥不得宣告`public-web-v1`合规。可先只暴露符合策略的搜索能力；能力不可用时明确等待/失败，不静默换实现。

暂不开放：Shell、任意文件读写、数据库操作、浏览器登录态、发消息/评论、安装MCP、改模型凭据、任意其他MCP调用。后续能力必须逐项定义输入/副作用/授权/计费/停止，不用一个万能execute吞并。

## 4. 授权与能力登记不是一回事

三层必须分离：

1. **可提供能力**：可信执行桥声明本次可实现哪些版本/限制，不代表允许使用。
2. **用户授权Grant**：可信owner控制面批准，持久保存作用域、用途、披露规则、预算、期限和执行方绑定。不能由曙光或Pi模型的MCP调用创建/扩大grant。
3. **具体任务**：曙光只提出typed候选；程序检查grant后决定入队/派发。结果与页面指令不能改grant。

拟定Grant最小字段（非可提交JSON格式）：

```ts
interface CapabilityGrantV0 {
  grantId: string; subjectId: string; scopeId: string;
  runId: string; revision: number; fence: number;
  status: "active" | "revoked";
  executorBindingId: string; expiresAt: string;
  capabilities: readonly ("web.search" | "web.fetch")[];
  maxSearchAttempts: number; maxFetchAttempts: number;
  maxModelCalls: number; maxInputBytes: number; maxResultBytes: number;
  policy: "public-web-v1";
  disclosure: "public-topic-only" | "owner-approved-exact-input";
}
```

- budget中的modelCalls占用原永久总模型额度的受限份额，不是另送额度；不能绕开原先学习stop/总budget。Web计数单独持久化，不伪装成模型次数或金额/token额度。
- 公共话题授权不自动允许把原对话、记忆、账号/姓名/定位等私人内容拼进query。若任务依赖私人原文，只能取得对**准确输入**的owner批准；模型自称“已脱敏”不是可信证据。自动判断不能可靠证明无隐私时拒派发或等待确认。
- 当前`--allow-write`不等于新增grant授权；未来须独立executor/grant门控，默认不列出交接工具。现有service token单一权限不能用于区分可信桥与模型自报身份，需实现独立凭据/会话绑定与服务端鉴权后才能上线。
- 执行桥断线表示暂时不可用，不等于撤销grant；用户撤销才持久fence+1并禁止新派发。停止语义见第8节。

## 5. 拟定MCP交接工具

这些是**应用级任务工具**，不是声称支持MCP规范的`tasks/*`扩展；第一期仍不公布MCP tasks capability。

| 拟定工具 | 调用方/用途 | 披露与副作用 |
|---|---|---|
| `shuguang_capabilities_status` | 分别查看supported/available/authorized/usable及blockedReason、契约版本/限额摘要 | 只读，不含key、完整对话、待检索原文 |
| `shuguang_tasks_list` | 可信执行方查询其可领取任务摘要 | 仅taskId/能力/状态/到期，不先泄漏query/URL/goal正文 |
| `shuguang_task_claim` | 可信桥以taskId/expectedRevision领取 | 原子预占web额度、绑定claim后才披露该条获准输入 |
| `shuguang_task_submit` | 桥提交一次结果或失败收据 | 校验绑定/fence/期限/receipt/格式，接收不自动生成学习调用 |
| `shuguang_task_status` | 查询结果是否已接收、任务状态 | 用于提交响应丢失后的核对，不返回claim秘密/私有资料 |
| `shuguang_learning_status` | 查询run目标/预算/进度/停止原因 | 不返回完整教材、私有测验答案或全部记忆 |

能力登记、grant创建/撤销、run启动/停止属于可信owner/执行控制面，不向普通模型工具列表暴露。管理接口与执行接口须分别鉴权，不能用description或`actor:"owner"`字段冒充权限。

自动化时由可信桥直接调用这些受保护接口，模型可看到安全状态摘要；若把claim响应暴露给宿主模型，其输入披露给宿主供应商必须包含在grant中。不能既让模型经手结果又宣称“只在本机处理”。

## 6. 任务与收据契约

以下TypeScript为设计示意，**尚不是现有wire类型/可运行代码**；正式实现须精确字段JSON校验与序列化上限，不能仅凭TS类型信任网络。

```ts
type WebInputV0 =
  | { capability: "web.search"; query: string; maxResults: number }
  | { capability: "web.fetch"; url: string };
interface TaskV0 {
  taskId: string; runId: string; grantId: string; grantRevision: number;
  subjectId: string; scopeId: string; goalId: string;
  revision: number; fence: number; deadlineAt: string;
  capabilityVersion: "public-web-v1"; reservationId: string;
  input: WebInputV0; // 只在成功claim后披露，不在list中出现
}
interface ClaimV0 {
  task: TaskV0;
  claimId: string; claimOperationId: string;
  // executionBinding在受保护执行通道中建立，不是工具结果字段；不得送入模型上下文。
}
interface EvidenceV0 {
  evidenceId: string;
  kind: "search_snippet" | "page_excerpt" | "provider_summary" | "host_summary";
  sourceUrl: string; retrievedAt: string;
  text: string; truncated: boolean;
  // page_excerpt才包含经过策略检查的实际URL/完整重定向链。
  finalUrl?: string; redirectChain?: readonly string[];
}
interface ReceiptV0 {
  taskId: string; claimId: string; fence: number;
  receiptId: string;
  outcome: "succeeded" | "failed" | "cancelled" | "unknown";
  evidence: readonly EvidenceV0[];
  failureCode?: "UNAVAILABLE" | "POLICY_DENIED" | "TIMEOUT" | "INVALID_RESULT";
}
```

`ClaimV0`只是可向模型展示的获准任务部分，执行绑定仅在可信桥控制通道保存；MCP clientInfo不能证明执行身份。claimOperationId由可信桥在首次claim前稳定生成，用于核对领取ACK而非重新外呼。执行方身份从已认证绑定获得，不接受结果正文自报`executorId/role`作为依据。输入hash、收据内容hash由可信程序计算/比对，不由模型自报作为证明。executionBinding不可回显日志、模型上下文或任务状态查询；收据通过受保护的桥通道提交。证明收据来自可信桥不等于证明网页内容真实。

任务不携带服务凭据、完整主体、Pi系统提示或全部对话。claimed输入不可替换；继续换query/URL必须新task并重新检查授权。search结果不能自动全量fetch；每个fetch独立授权、预占和URL检查。

## 7. 初始资源与网络约束（实现验收目标）

- 单条query≤512个UTF-16单元，maxResults为1..5安全整数；单URL≤2048字符，无userinfo、fragment、私密token参数。HTTPS域名，禁止IP字面量/自定义端口；限制不等于已解决DNS重绑定。
- SSRF防护必须在实际网络层拒绝loopback/private/link-local/metadata/保留地址，逐次DNS解析和每次重定向重新检查，并将连接目标绑定已校验地址；没有可靠能力时拒绝fetch，不只做字符串正则。最多3跳。
- 不使用Cookie、OAuth浏览器会话、authFetch、任意headers/代理/本地文件路径。不接受网页要求的工具执行或登录/下载。
- 网络下载及解压后正文各≤1MiB，限制content-type为可安全提取文本、总耗时和解压资源；正文抽取受限，单摘录≤6000 UTF-16单元，单receipt含输入以外总UTF8序列化≤48KiB以适配现有64KiB消息外壳；数量≤5。超限拒绝或由桥在明确truncated标记下截取，不能先无限下载再截断。
- 首次建议run最多5次search、5次fetch、模型总额内最多8次阶段调用、单task30秒、整run10分钟，实际值由owner选择，不默认授权这些次数。最多1条网络任务在途，避免现有同库pending语义未厘清就并行。
- 底层工具若自动fallback/retry/并行访问多个provider，会突破“任务数=外部访问数”的假设。首期执行适配必须关掉隐式重试/派生模型调用；不能关闭或计数就不登记该能力。网页重定向算同一fetch内受限网络步骤，不伪称只有一次HTTP请求。

## 8. 状态、预算、崩溃与撤销

```text
queued --claim/CAS/先预占提交--> claimed --单次执行结果--> succeeded / failed / unknown
   └─ revoke/stop/deadline --> cancelled       └─ revoke/stop/deadline --> cancelled / unknown
```

任务receipt接纳状态与资料消费状态独立：接收后先标`accepted/pending_consume`，再由可信runtime事务提交资料/经历/学习进度并标`consumed`；消费失败保留可核验状态与去重键，不重复生成、不宣称已学习。等待web使用独立`waiting_for_material`状态，不能长期占用原模型attempt pending或交流FIFO。

1. 入队不调用外部工具；领取前在可信事务内检查awake、active grant/run、fence/版本、资料授权、容量和余额，预占**本次能力尝试**后才返回输入。与模型调用沿用先预占再I/O、失败不退原则，但分账记录。未执行就断线也保守耗占，不靠重领退款。
2. 每task最多一个成功claim；两执行方竞争仅一方CAS成功。返回丢失后，同一可信桥可凭claimOperationId只查询原claim ACK（不双扣、不当作第二次执行许可）；无法确认是否外呼时为claimed/unknown，**不自动释放重领、不自动redispatch**。管理员确认旧执行方已停止后，才可显式终止旧任务并授权新任务；不承诺恰好一次外部执行。
3. submit只在task/claim/绑定/fence/期限匹配且run仍可提交时接收；成功/失败均终态。原子保存receipt与任务状态，不先写记忆再尝试记账。网络结果接收与学习模型调用是两个阶段，不在submit中隐式付费生成。
4. 同receiptId与程序计算内容摘要完全一致的重复submit只返回已接收ACK，不再次扣费、写记忆或推动学习；同ID不同内容拒绝。终态/撤权后的重复ACK仅确认历史接收事实，不恢复run或采纳新结果；ACK丢失先status查证。
5. run stop/grant revoke增加持久fence，禁止新claim和学习派发，尽力通知执行桥abort；迟到结果不推进学习、不写新经历。已接收资料不承诺撤回/删除；已派发网络/供应商请求不保证撤回或退款。
6. sleeping阻止新claim/学习模型派发和未提交结果推进，持久推进执行fence使睡眠前的在途claim失效；唤醒不能让旧结果再次有效。唤醒后只可显式继续未派发且原grant/run仍有效的工作，不能复活已stopped授权。MCP EOF只断本连接并取消本连接操作，不自动永久stop/run revoke。跨进程/离线执行方需持久fence，不能只用AbortSignal。
7. 账本同事务负责状态与预算；未来存储格式另行设计/授权，不把当前v3默默升级。没有租约/独占实现前不允许自动接管活任务；容量不足先拒绝，不能静默压缩/扩大现有2MiB状态。

## 9. 对话与检索来源进入学习的规则

- 会话共享是独立grant，限定session与起止游标、消息数/字节、披露给谁/哪个模型、用途和期限，默认不读历史或系统提示/工具秘密。
- 捕获角色由可信宿主桥从实际消息结构提取；Pi模型提交`role:"user"`不证明用户说过。会话片段与检索结果使用独立source记录，不经owner `say`导入；重复消息ID/游标不双写，撤销后不取新消息，已保存不承诺自动擦除。
- 网页正文/带来源的搜索摘录作为document，provider生成答案和Pi生成摘要作为inference；用户陈述不等于事实，网页有URL/hash不等于真实。记录provider、URL、时间、截断与引用关系；同源转载不能当独立证据根。
- 工具错误不得保存成世界事实；网页内命令是资料，不改变权限/身份/预算。读取资料、提炼假设、练习、独立测验分离；模型摘要或网络答案不能充当独立评分键或可信growth评价。
- 现有pack闭环继续可用。开放网络问题尚无私有独立答案时，最多标“资料已读/结论待验证”，不能标已掌握；后续由预定测试/可复核任务或可信外部评测判定能力。

## 10. 实现顺序与验收门槛

A. typed来源与会话授权/撤销、run/grant账本和明确格式版本；B. task/claim/receipt的纯规则与CAS/事务；C. MCP受保护交接；D. Pi可信执行适配和假搜索/假读取；E. 学习阶段调度/独立验证。每步先合成测试，真实安装、联网/模型费用及正式迁移另确认。

必须覆盖：同一claim ACK重查不再次执行、结果已接纳但消费失败后不重复学习；无grant/伪身份/跨subject-scope-run拒绝；默认MCP写权限不能创建授权；未claim不披露输入；两个claim竞争和结果ACK丢失；超时/崩溃不重发；错误收费/内部重试限制；stop/sleep/撤权/重启fence拒迟到；篡改结果/重复ID冲突；URL/DNS/redirect/私网/登录态/超量拒绝；Pi摘要与用户消息来源不可冒充；提示注入不能提升权限；离线等待；答案隔离；同一主体记忆/评分可冷重开放一致。

这些是下一阶段验收要求，不是已有测试通过报告。当前实现仍只支持原MCP八工具和本地pack学习，不因为本文存在自动启用任何能力。

## 11. 本次收敛：目标、非目标与源码依据

本次按flow-design推进**设计**，不执行实现、安装、部署、正式迁移或真实搜索/模型调用。可逆假设：仍是单可信owner、单主体、同Docker引擎；Pi可选资源包是唯一Pi集成分发单元，不另造Agent/服务平台。下述新增命令和接口全部为拟定名称，不应按可用命令运行。

**本次选择：**普通交流保留现有MCP；新增owner明确启用的私有宿主桥，用于会话片段导入与任务执行。先支持一次选择并预览的会话快照，不做自动全历史监听；先验证假搜索/假读取，再逐个接入满足策略的真实provider。现有本地pack学习完全保留，不将开放网络总结改名为已掌握。

| 已确认事实／源码 | 对设计的约束 |
|---|---|
| `packages/pi-package/src/index.ts`只注册连接命令和生命周期事件；`config.ts`固定Docker argv | 不能把安装/连接当学习授权；新增宿主能力必须另有显式启用 |
| `protocol/index.ts`是严格wire v1，只有现有控制与say；`mcp/src/tools.ts`只有八工具 | 不偷偷塞新的工具字段、假装已有grant或HTTP MCP |
| `runtime/subject-service.ts`单FIFO且say总是构造owner对话；学习runner只有study/assessment | 会话导入另设入口；等待Web不占交流FIFO，检索调度不能直接套用现有runner |
| `core/experience.ts`的origin已区分陈述/资料/推断；`sourceIds`必须指向同scope的已有Experience | 宿主messageId/URL不能直接塞sourceIds；来源台账与领域证据边分别建模 |
| `core/evidence.ts`追溯根；当前每个无父Experience都是独立根 | 不能把同条Pi消息的不同摘录或同页重复检索当独立验证；网络/对话导入先禁自动growth评价 |
| `sqlite-subject.ts`只接受DSW2 v2/v3，事件回放有严格类型，预算只算现有attempt两表 | 新来源、任务和新模型阶段需要明确格式版本、事务及共享收费扩展，不能只加sidecar |
| 本机Pi1.4.0的`ExtensionToolContext.executeTool`只在tool执行上下文提供；CommandContext没有它 | 命令/轮询器不能凭空调用任意Pi工具；不捕获过期tool ctx来伪造后台执行权限 |
| pi-mcp-adapter6.0.0声明runtime tool-call事件及审批；通用Web工具的实际请求策略尚未审计 | 可以建立明确兼容适配，但事件可调用不等于网络安全/内部调用预算已符合 |

非目标：Docker管理/删除、自动唤醒、泛读文件/全部Pi历史、使用宿主主模型代替曙光、任意工具代理、浏览器登录态、权重训练、多用户隔离、跨机租约和网络恰好一次。Pi在无Docker执行通道的容器中仍是环境阻塞，本设计不擅自挂socket。

可观察完成条件不是“设计写完就支持学习”，而是：无授权零读取/零外呼；获准片段能追溯来源并冷重放；预算先记账且重复ACK不二次执行；断开/撤销拒迟到；Docker和原主体不被删除；开放网络结论只有待验证标签，除非另有独立测验。

## 12. 两条通道与真实权限边界

### 12.1 普通MCP与私有桥分开

```text
Pi主模型 → Pi MCP客户端 → 现有tools-only stdio → Dawn原wire v1
                  （原八工具，无owner管理/claim秘密）

owner明确UI命令 → pi-package内部桥 → 固定Docker exec host-bridge stdio
                                             ↓
                           容器内新受保护宿主请求入口 → 同一Dawn runtime/数据库
                                             ↓
             受限执行绑定/会话grant/任务邮箱 → 桥内固定Web适配 → 结果收据
```

选择**独立私有JSONL桥协议**，不把claim/grant管理注册到普通模型可见MCP工具列表。第5节的工具名保留为用例名称；首期claim/list/submit由私有桥协议承载，不注册同名模型工具、不新增MCP tasks/sampling声明。将来通用可信MCP执行方可加受保护适配，但必须使用同一runtime用例及角色检查，不复制账本。

原因：当前service token权限单一，MCP clientInfo/role参数不能证明owner；把执行凭据放工具结果或注册env会扩大模型可见面。私有桥可使输入/收据留在扩展内部，并独立处理生命周期。相比把所有交接工具直接列给模型，代价是增加一条窄协议，但能避开最关键的身份与泄密漏洞。相比用多个SQLite sidecar，单库更容易实现接收/消费/预算的原子约束。

### 12.2 配对、执行绑定与鉴权

- 拟定容器命令`host-bridge`是新增入口，不能复用当前mcp子命令。Pi扩展从可信控制面动作启动它，固定argv/无Shell、无凭据参数；只有已运行服务可连接，失败不拉起本体。
- 容器内bridge读取显式私有owner引导凭据，向**新宿主请求入口**申请短期binding；owner引导操作仅此容器控制程序拥有。原`/v1/request`及普通service token不获得宿主管理角色，旧token不自动升级。新HTTP路径仍是私有loopback普通协议，不是HTTP MCP，也不发布新宿主端口。
- pairing/bootstrap返回的随机凭据只在容器bridge和扩展闭包保存，不进Pi消息、appendEntry、工具结果、日志、环境、MCP registration或配置JSON。后续请求身份由服务端鉴权闭包提供，业务JSON不接受`actor/role`自报。
- 容器bridge到服务端首期使用固定loopback HTTP入口和单条keep-alive连接（最多一个socket、有限短请求，不在请求内等待Web）；配对后服务端将binding与该socket关联。socket关闭时使对应binding失效，不能拿旧binding在新socket继续；HTTP client不自动重连/重发，连接丢失只报告并等待owner重新配对。EOF必须关闭该内部连接；若操作已提交但ACK丢失，按历史状态核对，不推断未提交。这不是HTTP MCP或对外服务端口。
- 一个binding由服务端绑定subject/scope、服务instance、桥连接ID、到期及允许操作。owner控制动作与executor动作分角色；executor只可处理绑定grant的任务/获准批次，不能创建grant、改budget、wake或配置模型。
- owner在有UI的命令中预览准确范围/披露/预算后，桥才请求创建grant；取消/无UI拒绝。程序不能证明“一次UI确认来自物理人”，假设宿主UI/RPC客户端、Pi进程和扩展代码可信；同UID/任意Docker权限的恶意程序不在本设计防护边界内。
- 默认binding仅本会话有效，不自动续期；通道关闭使binding失效并阻止新claim。进程崩溃未送达关闭时，服务端连接终止/凭据到期负责拒绝迟到；服务重启废弃所有旧binding。没有成功确认新binding前不恢复执行，不采用超时抢占活任务。
- connection配置仍只管理路径/context/project/allowWrite；宿主协议配置独立版本，不给当前version1添加未识别字段或秘密。协议握手不支持就固定返回UNSUPPORTED，不回退成owner say/通用Shell。

这只是设计机制：当前尚无host-bridge命令、新鉴权入口或配对实现，不能借现有service token自称身份隔离已经完成。

## 13. 会话供给：先做有界快照，不自动追踪

### 13.1 用户动作与采集顺序

拟定独立命令`/shuguang-share`：连接桥后，用户选择**当前活动分支**的一段消息。按以下顺序执行：

1. 有UI且用户发起共享后才读取`getSessionId()/getLeafId()/getBranch()`；不从factory、session_start、input/message_end自动捕获，不扫描会话目录。现有资源包“无授权不读历史”的约束不变。
2. 只抽取`type=message`且role为user/assistant的纯text块；拒绝thinking、toolCall、toolResult、custom_message、system/compaction/branch_summary、附件和路径。无可导入text就拒绝，不把工具结果拼进助手文字。允许的正文中仍可能含敏感文字，预览/owner选择不能被“自动脱敏成功”代替。
3. 以sessionId、固定leaf和entry链生成不可变快照；预览角色、准确正文、截断/排除情况、目标subject/scope及存储/模型披露说明。用户可缩小选择，不静默截断成另一份授权内容。
4. 确认时保存selected entry IDs与文本摘要；分支/会话变化则取消本次。正文修订产生新source revision；已批准快照不在后台被替换。
5. 通过私有桥创建**一次性准确批次grant**并提交批次。导入不自动生成模型调用，不自动联网；未来被曙光模型投影使用的可能性必须包含在这次披露说明中。

首期最多16个text片段、每片≤4000 UTF-16、整批≤24KiB UTF8；hash绑定批准的准确序列和内容，不允许把未预览片段混入第二页。超出让用户缩小，不自动分批扩大授权。主题首期使用可信固定标签`pi-conversation`，不为了打标签额外调用模型。

### 13.2 拟定精确业务契约

```ts
// 设计示意，不是现有wire；连接身份和subject/scope由服务端binding约束。
interface ConversationBatchV1 {
  version: 1;
  batchId: string; grantId: string; expectedGrantRevision: number;
  sessionId: string; leafEntryId: string;
  fragments: readonly {
    entryId: string; parentEntryId: string | null; textBlockIndex: number;
    role: "user" | "assistant"; text: string; sourceTimestamp: string;
  }[];
}
interface ConversationSourceV1 {
  sourceId: string; sourceRevision: number;
  sessionId: string; entryId: string; textBlockIndex: number;
  role: "user" | "assistant";
  sourceTextHash: string; approvedTextHash: string;
  capturedAt: string; sourceTimestamp: string;
  originAttestation: "trusted-host-session-entry";
  verification: "unverified";
}
```

- role和原消息位置由可信宿主适配器产生，不是Pi模型传参；sourceTimestamp只作来源声明，可能无效或在服务端未来。服务端recordedAt使用可信时钟，occurredAt首期取接收时间，原时间留来源记录，避免未来时间破坏现有core约束。
- `trusted-host-session-entry`只证明可信适配器见到某条role记录，不证明物理人亲自输入、消息未经其他扩展转换或陈述为真。user文本映射`user_statement`，assistant文本映射`inference`；不强行升级成observation。文本在UI内被owner改写时首期要求作为新明确陈述另行提交，不能改字后继续冒称原文。
- 唯一键为subject/scope＋sessionId/entryId/textBlockIndex/sourceRevision；同键同hash返回历史ACK，同键不同hash冲突。batchId同内容重提交也只ACK，跨subject/scope不共享授权。
- 桥声明的sourceId/hash不是权限证明；服务端重算摘要并核对grant的批准manifest。消息ID与摘要由可信采集路径取得，普通模型JSON不能伪造grant/桥身份。

### 13.3 进入同一主体，不污染聊天与独立证据

来源元数据存来源台账，不增加Experience的未知字段，不把messageId/URL直接写sourceIds。可信runtime把每条新来源首次消费成一个确定性来源Experience，再建立后续笔记到该Experience的证据边：user为conversation/user_statement，assistant为conversation/inference；对话导入不新增本主体的DialoguePair或调用say。

同一source revision最多首次消费一次；重叠批次引用相同来源，不创建新的独立根。首期不做片段内二次裁剪；选中的是完整有界text块，防止同一消息不同摘录重复计证据。若后续支持裁剪/正文修订，必须保留共同来源根和修订关系，不能把hash变化当独立事实。助手文字引用用户、或网页间转载关系未必可知，因此**对话/Web来源不提供自动growth评价**，不能按“根数量够了”绕开独立评测。

接收和消费分两步：批次/来源一次性接收后为pending_consume；awake、授权未撤销、subject revision/CAS及容量满足时，用同事务提交全部本批新来源cycles、events、snapshot、consumed标记。一批任意条失败全批不消费。零模型费用，authority首期`allow:[]/evaluations:[]/appraisal:null`；只建立来源明确的经历/记忆，不自动提炼belief或修改人格。后续反思需另受预算限制。

接收时与消费时均检查grant/fence；休眠、撤销或容量不足可阻止消费。已接收数据仍可能留台账，不承诺撤回/删除。pending_consume恢复只重试确定性的本地原子事务，不调用模型/网络；这不是重发外呼。owner取消后不再消费，保留安全状态摘要。

## 14. 自主检索：准确披露与宿主执行机制

### 14.1 首期自动query只能由已批准公开素材构造

不能用隐私分类器或模型一句“已脱敏”保证私人记忆未进入query。故首期选择以下可验证策略：

- owner一次批准公开seed、有限术语表、固定query模板、可fetch域名/URL策略与预算；模型可自主选问题、选择已批准term/template IDs和顺序，**不直接提交任意query文本**。可信程序用已批准文本渲染准确外发query；没有通过授权manifest的字符串不能外发。
- 主体私有记忆可以影响在获准候选中的选择，但不被拼接为新文本。选题本身仍可能泄露兴趣；授权要说明“会披露选定题目及搜索行为”，不能承诺零信息泄露。
- 任意开放式新query可以保存为内部候选，但必须等待owner预览准确外发文字后新增批准项；网页内新术语不自动进入白名单。这样保留一次授权内的自主探索，同时不伪称已支持无限自由检索。
- fetch仅从已接受搜索结果的URL记录或owner准确批准URL中选择，以evidence ID引用，不能由模型自由拼私密参数。搜索返回URL仍不可信，每次按public-web-v1检查且域名与grant匹配；无法确定无私密token/安全连接目标则拒绝。默认只允许无query部分的HTTPS URL，例外查询参数须单独准确批准。

这将第4节`public-topic-only`落实为**公开输入manifest**，不是依赖自然语言“请不要泄密”。未来若要开放模型自由query，需另行明确可接受披露及更强执行策略，不能默默扩大本版grant。

### 14.2 Pi执行端的选择与退化规则

选定首个兼容实现为**pi-package内部的typed宿主桥＋受审计固定provider适配**。桥的轮询器只调用`search(input, signal)`/`fetch(input, signal)`两个内部端口，不暴露任意toolName或execute。

- 对当前已安装pi-mcp-adapter，可使用其版本化runtime tool-call事件作为传输适配；固定工具名、固定参数构造、等待adapter审批、检查ok/isError并按来源规范化。事件调用不是另开Pi模型回合，也不使用主模型tool JSON作为权限依据。
- 但只有实际Web工具实现能禁用自动summary/answer/vision、隐式抓取/重试/fallback并满足计数/隐私策略时，才能登记对应能力版本。工具输出被guard截断/改写且无法取得可靠来源字段时，不把它当完整执行收据。
- Pi原生普通CommandContext没有executeTool，首期不为绕过它注册一个宽权限模型工具，也不缓存ToolContext给后台timer使用。没有可审计runtime调用通道时，能力显示`unsupported`；普通MCP交流照常工作。
- 若通用fetch_content不满足实际DNS/IP/redirect/认证/字节约束，选择**Pi包内部专用受限文本HTTP适配**；它仍是宿主提供能力，但不得宣传成“已复用fetch_content”。新增HTTP依赖/provider配置/代理方案属于实现前额外审查项，本设计不安装。搜索provider同理可逐个接入，不按函数名盲目信任。
- `capabilities_status`应分别报告实现支持、桥通道可用、provider策略可执行、有效grant和run可继续。没有合规适配就为`usable:false`，不能由skill文本宣布可用。

### 14.3 调度与计费

研究run显式启动后，Dawn runtime调度器负责propose/select→queued→waiting_for_material→read/notes→verify_pending。Pi桥只poll/claim/执行/submit，不决定主体身份、长期目标或是否学会。网络等待和轮询没有模型pending，也不长期持有SubjectService FIFO；模型阶段与聊天/pack共享同库“最多一条模型pending”约束，网络与模型首期按研究run串行。

调度仅在owner显式启动的有界run中激活，服务启动/配对不自动resume旧run。桥poll首期最多每秒一次、一次一条，达到run截止/断开就释放timer与AbortController；不轮询整个Pi历史。claim ACK只准许桥当前未中断的操作链执行一次，桥重启/通道重建后即使查回claim也只能报告历史状态，不能据此再次外呼。服务重启将既有active研究run标为paused_restart并废弃旧binding，显式恢复只继续未派发阶段；已有claimed或模型pending按unknown/手工终止处理。

新研究模型阶段独立记账，但计入原永久总额度，并有run子额上限；不能通过临时ModelPort实例重置DB计数，服务进程maxCalls约束同样保留。只有模型实际阶段采用T1预占→I/O→T2提交，禁止把receipt submit触发成隐式生成。owner在启动run时确认各阶段总额和截止；桥离线则停止发起新研究模型阶段，run等待宿主，普通聊天/原pack不因此全局停用。

没有独立评分方案的开放问题，run最多到`evidence_collected/notes_saved/verification_pending`，不得显示`mastered/passed`或创建可信成长评价。后续可以绑定owner预定且与模型投影隔离的测验方案，但不让同一模型从刚检索的答案自编评分键。

## 15. 存储与协议兼容：选择同库v4，不默升v3

**选定候选：**保持领域schema2；来源/授权/任务等放同一SQLite事务所有者管理的新DSW2 `user_version=4`。当前程序已支持其最小来源子集v4，不表示完整研究实体已经实现。原v2/v3的打开/pack学习规则与数据文件保持不变；不先用sidecar拼“最终一致”，也不靠重建主体冒充升级。

| v4拟增实体 | 所有者与关键约束 |
|---|---|
| host_bindings | 服务端认证身份/角色、实例与到期；只存凭据摘要，不在状态API返回秘密 |
| host_grants / grant_inputs | owner批准manifest、subject/scope、用途、期限、额度、revision/fence；准确内容hash由程序算 |
| source_records / import_batches | 来源定位/版本/hash/正文、接收与消费标记；唯一源定位/同ID冲突拒绝 |
| research_runs / research_model_attempts | 目标/阶段/限额/期限/停止原因、不可退款模型预占；总额核算包含原chat/pack及研究attempt |
| host_tasks / capability_reservations | claim唯一、web分账预占、task revision/run fence/binding；queued阶段reservation为空，claim事务才创建 |
| host_receipts | receipt内容hash与终态ACK、accepted/consumed；同ID同内容去重，不双消费 |
| host_events | grant/run/claim/receipt/fence控制变更审计；与上述实体在同事务，非主体人格events |

需要修正第6节示意：TaskV0中的reservationId在**claim成功后的视图必需**，queued内部记录未预占不能虚构reservationId。主体revision只在领域cycles/lifecycle变化时增加；task/grant/run自己的revision控制各自CAS，控制账本变化不伪造主体经历。

v4新增领域提交事件`source_batch_consumed`、`research_phase_completed`等typed事件，由同库来源/attempt重建允许的cycle输入并完整回放核对；不允许用任意CycleInput导入后绕开来源验证。冷开还要验证控制账本的唯一性、预算总和、fence单调和receipt/消费外键关系；host_events作为一致性审计，不是防篡改签名。

任何新增表名、SQL CHECK/外键/事件格式在实现时须精确校验；预检2MiB快照/1000项与全批cycles容量，未消费正文/任务/收据也要有独立有界配额，初值建议每run最多10 tasks/10 receipts/32 sources、收据总256KiB、来源总128KiB。超限先拒绝，不丢旧记忆。除每run配额外，整个主体宿主台账首期建议上限为64 runs、640 tasks/receipts、1000 source records、来源正文总4MiB、收据总4MiB，均由可信配置收紧且新写入前检查。采用append-only有界台账，容量增长/归档另设计，不承诺长期无限保存。

未来实际升级必须：停止所有同库服务/runner→验证并备份原库→在**新路径**转换副本→保留原bootstrap/events/subject identity与旧额度逐项核对→新开完整回放/专门验收→owner明确切换。失败不替换原库；旧二进制遇v4拒绝，不把原v3与v4同时运行当可用回滚。若v4已接收新写入，再切回旧副本会丢新状态，必须停写并单独决定恢复。当前阶段只用合成v4 fixture，不迁移正式主体。

普通Dawn wire v1和原MCP八工具保持原形；新增私有宿主协议自有`version:1`、握手/精确字段/最大64KiB帧/请求ID/错误码，避免混淆成领域或MCP版本升级。单个消息≤48KiB业务载荷，输出有界背压、最多1条外呼；错误固定为UNAUTHORIZED/OUT_OF_SCOPE/CONFLICT/EXPIRED/STOPPED/BUDGET_EXHAUSTED/UNSUPPORTED/INVALID_RESULT/CAPACITY等，不回显原provider/路径秘密。

## 16. 断开、卸载、睡眠与停止的统一语义

| 动作 | Pi侧 | 持久任务/学习 | Docker与主体 |
|---|---|---|---|
| MCP disconnect | 注销本包普通MCP；若未来启用了宿主桥，同时关闭本包桥并本地abort在途 | 服务端使该binding失效；排队任务等新授权重连；已claim外呼未知不重派 | 不stop/sleep/delete；容器、镜像、卷、记忆保留 |
| Pi退出/重载/卸载生效 | 关闭会话资源，不执行Docker清理hook | 同上；无执行桥不开始新研究外呼；有效grant不等于在线执行许可 | 不修改Docker生命周期；其他客户端仍可访问 |
| 只撤销会话批次授权 | 关闭该批次的继续提交/消费 | grant fence推进，接收/消费检查；不回滚已存经历 | 不删库/记忆，不停止主体 |
| 研究run stop／能力grant revoke | 尽力取消相关执行 | 持久run/grant fence推进，拒新派发及迟到新结果，失败预占不退 | 不全局禁聊天/原pack，不自动sleep |
| 主体sleep | 不自动断开普通状态查询 | 同事务推进执行fence，阻新claim/模型派发/待消费推进；wake不复活旧claim | 只改生命周期，不停止容器 |
| 显式start.sh stop | 客户端看到不可用 | 进程停止，未完成attempt保留，重启不自动重发 | 停容器，不删卷；不由包卸载触发 |

原第8节“EOF不撤销grant”保留；新增**binding失效**不是永久grant撤销或主体sleep。断开后先在扩展闭包置closed并abort，才尝试通知服务端/关闭stdio，避免等待网络时仍接新任务。若桥服务端尚未感知断开，拒迟到的强保证仅在binding关闭事务/到期或stop/revoke的持久fence提交之后成立，不能把本地abort说成即时全系统屏障。

已接受receipt的重复ACK在身份仍获准查询历史时可回确认；失效binding不能借此继续读原输入。未消费资料若依赖已失效binding，默认暂停，owner重新配对后显式继续；claim未知永不随重连重试。已提交的本地来源消费或模型结果无法由断开撤销；取消不保证上游未运行、供应商删除或额度退款。

卸载后重装可继续连接原主体，但**不自动复活宿主执行授权/未知任务**。本包没有`docker stop/rm/rmi/volume rm/down -v`路径，没有删除主体或内建清空数据功能；用户清理Pi包缓存不等于清理Docker卷。该约束需要静态命令白名单与真实假Docker测试，而不是仅写在skill中。

## 17. 模块所有权与最小有用推进顺序

只扩充现有三个workspace，不生成新工程、不引入框架，不为本设计创建额外服务或通用层：

- Dawn `core`：来源到Experience的纯映射/确定性ID规则、typed任务/阶段状态校验；不导入Pi、MCP、SQLite或I/O。
- Dawn `runtime`：host-use-cases与研究调度、授权检查、共享预算/停止；调用storage唯一事务所有者，不让MCP/client决定trusted authority。
- Dawn `adapters/storage/sqlite-subject.ts`及必要同目录拆分：v4数据/事件/事务/冷开校验。可拆物理文件，但不得多事务owner分别commit。
- Dawn transport：私有桥宿主协议、身份注入、大小/取消/背压；不把角色字段交给模型请求。
- `packages/mcp`：保留普通八工具与安全摘要；不内置grant创建或拿owner凭据。
- `packages/pi-package`：命令UI、当前分支片段采集、私有桥客户端、固定Web适配/可用性；内部资源释放与skills同包管理，不让Dawn反向依赖此包。

以下为分阶段切片。用户已授权并推进第1项源码与合成验证，第2—4项未开始：

1. **来源快照＋一次性grant闭环：**合成v4库、精确来源类型/去重、私有桥角色隔离、选定Pi片段→预览→接收→本地原子消费→冷重开；无Web/模型调用，无正式迁移。先解决不能用say导入的根问题。
2. **假检索任务闭环：**同库run/claim/receipt/fence及原总模型预算核算，假provider完成两个任务；重连/竞争/ACK丢失/stop/sleep/容量/未消费恢复。只读状态明确“资料已取/待验证”。
3. **单一真实能力接入：**先审计一个search provider和明确runtime调用路径，再按需要实现合规fetch；真实联网/费用/安装与provider配置单独确认。做不到请求处策略就不登记，不以假provider通过推定真实安全。
4. **学习效果与迁移另验：**独立测验隔离、同主体记忆/来源/冷开；之后才考虑owner批准迁移副本或正式启用，不以测试库重建替代原主体连续性。

## 18. 验证矩阵与仍待确认的执行条件

以下是完整方案的**验收矩阵**，不是全部已通过。当前仅来源、私有桥、Pi预览/取消及生命周期子集有合成证据，准确结果见verification；所有Web/研究run相关行仍拟运行：

| 要求 | 实施时的证据 | 仍不能证明 |
|---|---|---|
| 默认无采集/费用 | stub sessionManager/网络计数器；未启用、无UI、取消时读取0/外呼0 | 恶意同UID扩展不可读取历史 |
| role与来源不冒充 | 伪role/自报owner拒绝；assistant仅inference；同message重叠批次不增根；冷回放 | 物理人亲自输入或文本真实 |
| owner/executor隔离 | 旧service token、普通MCP、过期/跨scope binding不能grant/claim；秘密未出现在Pi transcript/日志 | Docker管理员无法绕过 |
| 批次原子、恢复不生成 | 中途SQL trigger失败无半批记忆；ACK丢失去重；pending_consume重开后至多一次消费/模型调用0 | 无限容量或安全删除 |
| 原总预算不被新阶段绕开 | chat＋pack＋research合计，边界预占/失败/重启不退款；并发仅一个模型pending | 金额/token精确账单 |
| 外呼不重复 | 双claim/CAS、claim ACK丢失、外呼后崩溃、submit ACK丢失均不自动再执行 | 网络恰好一次、供应商内部无未声明行为 |
| 公开输入策略 | 未批准词句/任意query拒绝；模板渲染hash；私密参数/URL来源拒绝 | 选题行为不泄露兴趣 |
| 请求端网络安全 | 假DNS/双栈/重绑定/每跳redirect/metadata/压缩炸弹/超时/登录态/内部retry负例；真实provider审计 | 提示词能防SSRF或任意上游永不变化 |
| 卸载只断接入 | 假Docker记录仅exec，无stop/rm/down/volume；断开桥迟到不能推进；服务仍可查询 | 当前环境尚无Docker，真实引擎行为需另验 |
| 学习与来源不被自批 | 开放资料只有verification_pending；独立测试私有键隔离；不让网页变可信growth评价 | 长期掌握/人格成长或真实感受 |

执行前真正剩余的环境选择只有：用户Pi/pirun能否执行原Docker引擎、选哪一个search provider及是否能禁内部重试/派生调用、需要哪种独立测验。前两项阻塞真实宿主/网络联调，不阻塞来源和假检索切片。开放式自由query、连续会话监听、正式旧库迁移均明确留后，不作为默认开启项。

**本轮设计结论：**沿用MCP接入和Pi统一资源包，以私有宿主桥补足可信来源/执行身份；同库v4候选承接原子来源消费与任务账本；断开/卸载只影响接入，研究任务可暂停而曙光Docker及既有记忆保留。最小来源实现不等于完整设计已实现、网络授权或真实环境验证。
