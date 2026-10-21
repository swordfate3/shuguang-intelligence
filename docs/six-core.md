# 六核心：职责、规则与最小主体循环

## 定案与代码落点

曙光以持续自我为锚点，采用 self / cognition / affect / memory / agency / growth 六核心。它们是一套主体的六种职责，不是六个独立人格、六个服务或六次模型调用。

```text
packages/dawn/src/
  core/
    self/          types.ts + logic.ts
    cognition/     types.ts + logic.ts
    affect/        types.ts + logic.ts
    memory/        types.ts + logic.ts
    agency/        types.ts + logic.ts
    growth/        types.ts + logic.ts
    experience.ts  统一经历和证据解析
    evidence.ts    根来源追溯，防派生包装重复影响
    guards.ts      有界、仅数据的输入边界
    state.ts       六核心领域状态（schemaVersion=2）
    validation.ts  模块间引用、主体/作用域与时序校验
    cycle.ts       纯函数主体循环与显式生命周期变更
  legacy/          旧schema v1状态、类型和校验，供现有服务使用
  runtime/         subject-service/deliberation新模式 + legacy兼容服务
  adapters/        模型、SQLite统一主体库/legacy库、HTTP适配器
```

`legacy` 是运行兼容隔离，不是一套新启动的主体。旧代码路径已经改为显式引用 legacy；新 core 不依赖它，也不依赖 runtime、数据库、Pi 或模型服务。没有包级依赖循环或新增依赖。

## 六核心实际规则

### self：持续身份与关切

身份、性格、values、concerns、自我认识、兴趣、关系边界和承诺均有明确结构。world beliefs 不放在 self，而归 cognition。

- `assertSelf` 校验结构和范围。
- `selfRelevance` 根据主题与兴趣/关切计算相关性。
- `projectSelf` 只投影身份、性格、values、兴趣，排除关系、承诺与私人自我认识；并不意味着可以默认把投影发给任何模型。
- 初始值明确是工程bootstrap，不伪称经历积累出的性格。关切和初始背景需由可信初始化提供；本轮不开放模型修改身份、values和关系边界。

### cognition：认识与当前工作空间

- `reviseBelief` 接受有来源、时间和认识论状态的世界认识候选，支持旧认识被替代、撤回，不覆盖历史来源。
- 用户陈述、推测和想象不能仅凭模型自信直接升级为已支持世界事实；document/observation 也仅表示来源类型，不等于自动证实其内容。
- `buildWorkspace` 从当前经历、有界相关记忆及认识构成瞬时工作空间，含相关ID与尚未确定的认识。不持久保存内部思维链。

### affect：事件意义，而非任意调数

- `appraiseAffect` 从明确关切、相关主题与经历证据接受评价：期望符合度、利弊、可控制性和强度。
- 无关关切或不存在证据被拒绝；按来源链根ID去重，同一事件被改写成reflection也不能反复刷同一关切的情绪。
- 无新评价也可以随显式传入的时间衰减，时间不能倒退；不读取系统时钟启动后台循环。
- 数值有界，小步变化。具体权重与时间常数是工程启发式，不是EMA复现，也不是主观感受证明。

### memory：经历证据与可纠正记忆

- `rememberExperience` 把经历保存为有scope、subject、origin和sourceIds的episode。usable episode只表示可作为“发生过/说过”的对话依据，不意味文本已证实。
- `recallMemories` 采用确定性的相关性、时间与重要性排序，仅当前主体/作用域内的可用非未来条目可被召回，无关内容不强塞上下文。
- `correctMemory` 有来源地追加替代条目；candidate阶段不撤回原可用记录，只有生效替代才将旧记录retracted，不悄悄改写。推测/想象不能被自动改成usable知识。
- 核心规则本身无I/O；显式subject-db模式已将条目持久化到统一SQLite，详见[运行接线](subject-runtime.md)。legacy的memoryIds依旧不是正文仓库；没有自动磁盘删除。

### agency：偏好成为选择，意图不成为权限

- `chooseIntention` 从兴趣、性格、当前情感及明确活动候选计算有界动机和稳定排序。
- 娱乐有自身选择价值，不必伪装成学习；rest代表活动调节，不假装生理痛苦。
- 不可用或超过当前预算的候选不入选；停止请求不产生新意图，没有候选时不虚构活动。
- 返回的意图始终 `proposed`。该函数不发网络请求、不执行工具、不消费真实额度，也不授权任何副作用。候选availability须由可信调用者核实，不能让模型自行标注就算获权。

### growth：有证据的小步变化

- `proposeGrowth` 保存有多次经历依据的兴趣或性格小幅变化候选，不自动应用。
- `evaluateGrowth` 接受可信观察/测试侧的独立活动结果，pass才应用受限变化，fail只拒绝候选；模型写“测试通过”不能充当可信评估。
- 每次delta最多0.05，兴趣/性格仍限制0..1；cycle同一目标每轮最多处理一次评估，目标按与实际应用相同的大小写归一规则去重，不能靠堆候选放大。
- 身份、values、关系边界与执行权限不属于可变更目标。一个候选不能重复接受。
- 核验结构、来源与结果只证明规则成立，不证明真实长期人格或能力进步；尚无真实成长实验。

## 最小循环

`runSubjectCycle(state, input, authority)` 是纯函数，不负责模型、存储和工具I/O：

1. 严格校验完整状态、revision、输入时间、主体scope、cycle/experience去重和停止条件。
2. 在分离副本中追加有来源经历、记录episode。
3. 只应用authority.allow中的有类型候选：world_belief / memory_correction / growth_candidate。没有任意JSON patch。
4. 处理可信评估，只允许评估先前循环已有的成长候选，不能同轮自提自批。
5. 根据关切评价更新情感；根据兴趣/情感/预算选出 proposed 意图。
6. 整体校验引用、范围和时间，形成新的revision及cycle_completed结果；提供临时workspace给后续调用者。

任何一步失败都抛出，不修改传入状态，不返回半完成主体。返回state/event/workspace均与输入隔离。这个“原子性”是纯函数候选的一次性成功返回，不是数据库事务或跨进程CAS；真实持久化时仍需事务协调者。

`CycleAuthority` 是可信应用策略，不允许由模型候选JSON决定；其中allow只允许提交特定领域变更，不是工具权限。evaluations来自可信观察/测试，不是直接相信模型。input.experience的来源类型也必须由上层实际来源分配，结构校验无法鉴定外部文本真伪。

## 数据与容量边界

- 只有普通、可枚举、无getter的数据对象；拒绝未知字段、稀疏数组、循环引用、NaN/Infinity、超深/超大数据。
- 核心快照最大2MiB，常规集合最多1000项，经历文本最多16000字符。达到上限明确失败，不静默删经历或自动压缩。
- ID采用受限字符串；经历、记忆、候选、评估和cycle各有自己的语义，不把revision当经历ID。派生episode记忆ID使用固定SHA256，满长经历ID也不导致超限。
- 单次提案/评价证据上限32，兴趣等聚合引用上限1000，统一来源解析支持聚合容量，不静默丢失历史依据。
- 时间为四位年份规范UTC ISO串；证据不可来自未来，派生经历的来源需存在、先于派生项并在同一subject/scope。
- 事件与状态仍可被拥有写权限的调用者伪造；这些规则不是安全沙箱、密码学证据或意识测试。

## 运行接线与仍未实现的部分

六核心规则最初以纯领域实现交付；后续已新增显式subject-db模式，把say接入上下文投影、严格模型候选解析及统一事务持久化，见[完整契约](subject-runtime.md)。原--db路径仍使用legacy，不自动迁移旧库。

没有新增Pi功能、API端点、服务托管、网络工具或后台任务，没有真实候选API调用或正式主体初始化。交流新模式只接受成长候选，不提供模型自批；0.1.0新增独立授权的前台自主学习路径，见[自主学习](autonomous-learning.md)，仍须区分“工程规则和模拟运行通过”与“真实长期人格/成长有效”。
