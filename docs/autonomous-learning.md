# 0.1.0 有界自主学习

自主学习是首版必需项，已接通纯规则/存储/runner/CLI并通过24项学习专项、231项全量离线回归。此前仅完成交流与记忆的207项是补齐前基线，以此轮学习验收为准。没有真实API学习或长期效果证据。

## 什么叫自主

用户一次授权本地资料包和永久预算后，前台 `learning-run` 根据主体兴趣/关切与完成进度选择目标，自动连续完成读资料、笔记/练习、独立测验、结果提交和下一目标选择。不需要人逐轮输入题目或按“下一步”。

范围由用户授权，选择与推进由程序执行。无隐藏后台定时器、网络搜索、任意工具、生成代码执行或权重训练。自主并不等于可以自行扩大权限/成本。

## 显式新建与运行

学习使用SQLite **v3新库**，领域模型仍为schema2。旧v2主体保持可用，不自动ALTER/迁移/替换。学习新库本身也能通过原来的 `serve --subject-db` 交流；不是另存一份人格。

```bash
# 先选择已存在的私有目录，绝对路径，不覆盖需要保留的主体。
DB="/absolute/private/learning.sqlite"
PACK="/absolute/path/config/learning-pack.example.json"
MODEL="/absolute/private/model.json"

npm start -- learning-init --db "$DB" --id dawn --name 曙光 \
  --limit 100 --learning-limit 4 --pack "$PACK"
npm start -- subject-wake --db "$DB" --revision 0
npm start -- learning-run --db "$DB" --model-config "$MODEL"
npm start -- learning-status --db "$DB"
```

- `--limit` 是主体交流与学习共享的永久次数，1..10000。
- `--learning-limit` 是其中学习可用的子上限，2..32，不能超过总上限。每目标study/assessment各预占一次，失败不退。开始study需有完整两次额度及5条core cycle的集合空间；接续assessment需2条，容量不足报告exhausted。学习台账目前只记录调用次数/阶段/结果，不记录逐次modelId或token用量，不等于货币预算。
- 模型配置仍使用[显式配置](model-api.md)，`maxCalls` 是该实例的更小上限（最大10），不会因学习而绕过。两目标一般需4次生成，示例应设至少4；仅修改示例数字不能续主体永久额度。
- 每个前台run总期限10分钟，模型调用按原timeoutMs截止；无自动重试、换模型或自由文本降级。
- 成功返回的运行报告只有packId、目标ID、阶段状态、确定性分数及`allGoalsPassed`，不打印教材、答案、笔记或凭据。`completed`表示所有目标已终止尝试（可能含失败），不是全部学会；只有`allGoalsPassed:true`表示此次每目标独立测验均通过，仍非通用能力证明。

## 资料包与答案隔离

结构参考 `config/learning-pack.example.json`：version1/id/title/goals。每目标含id/title/topics/material/practice/assessment；问题均为id/prompt/answer。

读取限制为64KB普通文件，拒绝最终路径symlink，不支持URL/include。当前pack文本还保守拒绝看起来像URL/文件引用的内容；它不适合含路径/网址的技术教材，这属于当前输入格式限制，不是安全沙箱。校验未知字段、重复ID和长度上限，最多16目标、每组8题。导入后pack固化在数据库，不再自动读取原路径；恢复不接受同路径文件悄悄换内容。

- study只见目标、教材和公开练习题干，不见assessment题干和两组评分答案。
- assessment只见题干和前一阶段已提交的笔记，不再提供教材或答案。
- 正确答案由本地精确匹配评分器管理。NFC/大小写/空白规范化后匹配，不使用模型自评分数或语义裁判。
- 教材可能本身包含知识点答案，这是学习需要；隔离的是私有答案键和未到测验阶段的题干，不声称训练数据去污染或密码学保密。
- 资料和模型输出仍是不可信数据。没有工具权限，不能借资料中的命令执行程序或修改授权。

## 数据如何进入同一个主体

学习按专用事件提交，不伪装成用户对话、不进入最近问答history：

1. reading/document：已读教材，作为有来源的资料，不等于客观真理。
2. reflection/inference：模型学习笔记，保留生成性质，不自动成为已验证知识。
3. activity_result/observation：本地评分器的正确数/总数，证明该次任务表现，不证明普遍掌握。

这些经历建立同一主体的记忆，可在后续相关普通交流中召回。私有答案键和测验回答不写入公共经历/记忆。分数不自动把整篇笔记变成可靠知识，不自动改变性格或兴趣，不以“学完”宣称长期成长。

## 停止、崩溃与接续

```bash
# 不可撤回的授权停止，不会因重启复活；拒绝在途迟到提交。
npm start -- learning-stop --db "$DB"

# 仅在确认此库所有旧learning-run与交流服务进程都已停止后执行：
npm start -- learning-recover --db "$DB"
```

Ctrl+C/SIGTERM取消当前run，保留已提交进度及预占费用；正常取消会标记本次失败。忽略AbortSignal的迟到模型输出不会提交。独立进程 `learning-stop` 撤销持久授权，不能保证立刻取消另一个进程供应商端的在途生成，但会拒绝其结果并阻止下一调用。

崩溃可能留下pending。新runner明确拒绝它，不自动夺取正在运行的任务；用户确认所有使用此库的旧学习runner和交流服务均停止后显式recover，把v3同库学习/交流pending标失败，保留费用且不重发。失败目标终止、不重复测验；其他未尝试目标可继续。study成功且assessment尚未预占时重启，可直接继续该assessment，不重做study。

协议status中的`runtime.autonomy:false`仍表示该HTTP服务实例不运行后台daemon；`--check.autonomousLearningAvailable:true`表示有显式前台学习能力，实时进度需`learning-status`查询。

没有跨进程独占租约；同库pending互斥与revision CAS保护提交，不能据此允许多runner长期并发。停止标记、费用与进度都保留在同一DB；复制/恢复旧库会回退它们，非防篡改计费。

## 评测边界

首版验收应覆盖一次授权至少两目标自动运行、答案隔离、笔记用于测验、冷重启、失败计费、pending恢复、取消/停止拒迟到、共享预算与普通交流实际记忆召回。合成评分只能证明工程闭环，不证明真实模型对任意教材的学习效果；真实API和长期迁移能力需另行授权评测。

可运行 `npm run verify:learning:offline` 执行两目标、四次loopback假模型的独立工程验收；不读取真实模型配置。真实两目标最多四次生成的资料/预算/费用/停止授权单与判定标准见[真实学习验收方案](learning-evaluation.md)，开发环境与最低Node门槛见[可复现检查](reproducibility.md)。
