# 六核心真实交流与统一持久化

0.1.0自主学习另见[自主学习](autonomous-learning.md)：v3学习新库由本服务访问同一个主体，与v2交流库的差异是新增授权pack/学习attempt和专用学习事件，不自动迁移已有库。v3学习事件内含多次连续core cycle，以最终revision占一条事件行；回放核验每段完整跨度，不能以事件行数当revision。当前v3每次完整回放，不用v2精确前缀缓存。

## 已接通什么

新模式把同一个用户的显式 `say` 接到六核心。模型仍只调用一次，返回候选而非直接修改主体。本节交流链路本身不调度学习；独立的显式learning-run路径承担授权范围内的自主学习，不增加任意搜索、学习工具、后台服务或自动人格成长。

```text
显式 say
  → read + 相关记忆召回、认知workspace
  → self/affect/agency最小投影 + 有界完整问答历史
  → T1：当前awake/revision检查、requestId去重、永久次数预占提交
  → 事务外模型请求（最多1024输出token，无重试）
  → 严格JSON候选解析 + 六核心预演
  → T2：最新attempt + awake/revision CAS复查
       用户经历cycle + 助手经历cycle
       主体snapshot + typed events + 对话pair + usage同事务提交
  → 提交后才回复
```

独立request CLI通过`runtime/request-cli.ts`、`control-client.ts`和`adapters/transport/http-client.ts`连接这个服务；Pi只复用同一实现，没有本体反向依赖。完整操作示例见项目README。

`runtime/subject-service.ts` 拥有一次交流的编排；`runtime/deliberation.ts` 拥有模型输入投影与候选解析；`adapters/storage/sqlite-subject.ts` 是统一事务所有者。core不访问模型或数据库。Pi仍只是薄客户端，无需拥有或复制六核心状态。

## 显式新建与兼容

新增独立文件格式，application ID `0x44535732`（DSW2）、`PRAGMA user_version=2`；与legacy主体库和chat sidecar都不兼容。此处的2是新SQLite格式版本，领域state.schemaVersion也为2，但二者是不同契约。

**不自动发现数据库格式、不迁移、不覆盖旧库、不组合两个主体同时运行。** 原 `init/status/wake/sleep/events/chat-init/chat-budget`、`serve --db ... --chat-db ...` 保留legacy行为。新模式明确选择 `subject-*` 与 `serve --subject-db`，拒绝同时提供 `--db/--chat-db`。

以下是用户未来可手动运行的示例，本次开发没有替用户执行正式初始化：

```bash
# 父目录须已存在且由用户控制。不要以新库替换需要保留的旧主体。
npm start -- subject-init --db /private/subject.sqlite --id dawn --name 曙光 --limit 100
npm start -- subject-status --db /private/subject.sqlite
npm start -- subject-wake --db /private/subject.sqlite --revision 0
npm start -- subject-budget --db /private/subject.sqlite

# token-init仍是原来的显式私有token创建；不会输出token。
npm start -- token-init --token-file /private/service.token
npm start -- serve --subject-db /private/subject.sqlite \
  --token-file /private/service.token --port 7341 --model-config /private/model.json
```

模型配置沿用现有显式baseUrl/model/credentialEnv/maxCalls/reasoningEffort，不发现Pi配置，不复制key。模型供应商会收到最小投影、有限历史与本次消息；新模式的上下文披露比legacy仅问答更多，须在用户选择该模式时知悉这一点。

`subject-init` 可信bootstrap提供两个明示关切：understanding（学习/理解/探索）、connection（交流/信任/陪伴），及领域默认性格/values；兴趣为空。它们是初始化设定，不是学来的性格或用户关系。没有模型修改身份、values、关系边界或权限的入口。

status只返回身份、版本、生命周期、计数和bootstrap关切ID，不输出记忆、私密关系或完整状态。清醒不是进程存活证明，Pi不自动拉起服务。

## 模型输入与候选

固定system提示不插入用户、主体或模型文本。独立user-role JSON包含不可信上下文投影：

- 身份/性格/有限values和兴趣；排除关系、承诺、私人自我认识。
- 按显式当前时间衰减的情感轴，不发送完整情绪episode。
- 与本次文本匹配的已知关切/兴趣主题；主题匹配只是确定性字符串启发式，不是语义理解模型。
- 最多6条相关可用记忆、8000字符内；最多8条相关认识，保留origin/status/confidence标记。
- 当前预演的工程动机、待回复意图、仅已暴露条目的不确定性ID；不是工具授权或内部思维链。
- 证据ID与origin白名单，只能引用本轮输入或已暴露来源。

历史仅取已完成的最近8对、24000字符完整连续后缀；所有messages文本合计小于40000字符。整体超限先丢旧pair或裁剪可选投影，绝不退回发送整个主体或Pi历史。候选替换目标也只能是实际投影的记录。投影裁剪不等于磁盘遗忘。

模型必须返回严格JSON：

```json
{"reply":"你好。","appraisal":null,"candidates":[]}
```

- appraisal须有已暴露关切及合法证据，数值/相关性/根来源去重由core校验。
- candidates最多4条，只允许world_belief、memory_correction、growth_candidate的完整领域结构。system提示中提供具体字段。
- world belief只允许tentative，memory correction只允许candidate；候选记忆修正不会撤回原有可用依据，尚无模型自行晋升candidate为usable的通道。不能把用户发言说成observation/document，不能把候选或文字自评说成已验证成长。
- 来源ID、替换ID、主体/scope、时间、新ID、数值和未知字段均校验；模型不能提供权限、活动、可信评估或任意patch。
- malformed JSON、截断、错误字段或无效领域候选：整轮不提交，无自由文本回退、静默跳过、自动修复或自动重试。已预占调用不退款。

模型依然可能说错话或提出错误认识。可验证的是输入/权限/来源和事务规则，不是内容真实性、稳定人格或提示注入被彻底消除。confidence不是校准概率。

## 统一事务与恢复

同一个SQLite连接协调bootstrap、snapshot、typed events、attempt ledger和问答；各仓库没有独立提交。

- **T1** `BEGIN IMMEDIATE`：确认awake与expectedRevision，原子预占attempt。requestId永久去重，失败/取消/崩溃pending都不退款、不自动重发。
- **T2** `BEGIN IMMEDIATE`：确认attempt仍pending且为最新sequence、主体仍awake且revision未变；在锁内重新运行typed cycles，再原子写snapshot/events/问答/usage。不是相信模型带来的快照。
- 每次成功交流是两个revision：用户conversation/user_statement与助手conversation/inference，助手sourceIds引用本轮用户经历。助手内容被保存为生成内容，不是独立外部证据。每条经历各生成episode记忆。
- 模型候选与情感评价随用户cycle应用；助手cycle只记录生成经历。成长可提案但本轮模型路径不给可信评估，因此不自动改变性格/兴趣。
- open/read从完整bootstrap回放typed lifecycle/cycle events，与完整snapshot比对；损坏、漏事件、不匹配或未来格式明确拒绝，不清空、不重建。问答台账也与对应cycle内容关联校验。
- 外部连接在模型请求期间sleep/wake或提交其他轮次，会使旧结果CAS失败。两连接均预占时，最新sequence可完成，旧请求收费但不能晚到覆盖。

副作用不能跨网络实现恰好一次交付：T2成功后响应丢失或取消，数据仍可能已保存；相同requestId重试被拒绝，不提供结果重放。查询状态/预算后再决定下一步。

## 限制与安全

- 单主体、单可信owner，不用于多人隔离；一个token持有完整控制权限。
- 固定次数额度1..10000，不是token/货币结算；恢复备份或另建库不构成防篡改账单。
- 领域最大2MiB、经历和cycle列表各1000项，成功交流需两条；达到容量明确失败，没有自动遗忘/压缩。打开新连接仍需完整回放；同连接复用已经验证且bootstrap/逐条事件JSON完全不变的私有前缀检查点，只计算新后缀。旧前缀变化或删除会全量重验；每次仍核对snapshot、台账和completed-cycle来源关系，不以revision相同代替内容校验。长期容量、压缩与冷启动性能尚未完成。
- 台账保留失败输入；只保留成功问答于模型历史。没有删除、加密、自动遗忘接口。
- 无跨进程独占租约；CAS保证不覆盖旧状态，不保证只有一个进程发请求。停止/休眠命令在本服务FIFO内不抢占已经排队的生成；进程shutdown/调用取消可通过AbortSignal停止可取消的网络操作。
- SQLite同步调用不能即时取消；busy_timeout=1000、synchronous=FULL、DELETE journal。仅可信私有父目录；最终symlink拒绝不是抗同UID竞态或篡改保证。备份须停写关闭后完整复制文件。
- 新模式路径已有本地模拟与一次真实API首轮/冷重启验证：严格JSON回复、经历/记忆/问答提交通过；实际appraisal=null/candidates=[]，不证明非空候选稳定性或真实情感成长。尚未初始化正式用户主体，详见验证记录。
- 模型timeoutMs可选1..30000、缺省8000；完整合法say服务累计35秒、客户端40秒，控制和上传仍10秒。期限含排队，用户/shutdown仍可提前取消，SQLite同步调用不能即时取消。
