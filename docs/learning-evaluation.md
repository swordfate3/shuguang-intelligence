# 0.1.0 真实学习链路验收方案

状态：**已准备离线验收；真实调用尚未执行，须确认下方授权单。** 本轮不读取真实模型配置/密钥、不初始化正式主体。本方案首轮只回答“真实模型能否完成现有学习链路”，不证明学习收益、泛化、意识或长期成长。

配套：[可复现检查](reproducibility.md)、[学习运行契约](autonomous-learning.md)、[验证记录](verification.md)。

## 1. 问题、观测与结论等级

| 等级 | 问题 | 本轮准备 / 下一步 |
|---|---|---|
| 离线工程正控制 | 既定答案的假上游能否走完整adapter/runner/store路径？ | `npm run verify:learning:offline`，临时库、loopback假上游 |
| 真实链路试验 | 真实模型能否输出合法JSON、留下笔记、独立作答并持久化？ | 经授权最多4次生成；本方案 |
| 学习收益比较 | 笔记使表现优于无资料/无笔记吗？ | 本次4次预算不含对照，不做收益结论 |
| 泛化与长期效果 | 新题、不同资料、延迟重测是否仍有效？ | 需新方案、新样本和额外授权 |

替代解释包括：题目过于简单、预训练已有相似知识、教材中答案直接可见、一次偶然正确。两目标本地exact分数不能排除这些解释；更不能把fake模型依据fixture产生答案称为真实学习。

## 2. 首轮冻结输入

- 使用已有 `config/learning-pack.example.json`，只含两组合成灯号/标签规则，无私人资料、URL或工具指令。**不为了过测试临时改教材/答案。**
- 目标 `signal`：study练习 `practice-blue`，assessment `test-orange`；目标 `label`：`practice-lumi` 与 `test-vela`。内容/本地标准答案以pack文件为准，不在执行后重写评分键。
- 开始前记录pack与相关源码/配置的SHA-256、Node/npm、OS、应用版本与执行时间。源码当前整体未跟踪，不能只记git HEAD冒称它能复原本轮源码；需保存脱敏的源码清单/快照摘要。
- 固定模型、endpoint、reasoningEffort、timeoutMs和输出契约。配置可从 `config/learning-model.example.json` 在私有目录准备：maxCalls=4、timeoutMs=30000、reasoningEffort=low。示例域名 `.invalid` 不能实际调用，须先批准供应商/模型与兼容档位；不得在聊天或文件中粘贴真实key。
- 学习模型实际收到：study的教材/练习题干，assessment的测验题干/已提交笔记；两阶段均没有私有评分字段，study没有held-out题干。教材本身可含相关知识答案，这是学习输入，不是密钥隔离失效。

本地pack只限制输入来源，不表示本地推理。若端点在远端，以上投影会发送给供应商；后续普通交流还可能召回学习材料/笔记。本轮不追加真实聊天调用。

## 3. 明确的四次调用边界

- 独立临时测试主体，新建v3；不是正式曙光，也不升级、覆盖或迁移已有库。
- 主体永久总limit=4，学习limit=4，模型实例maxCalls=4；同一主体不运行聊天服务或第二runner。
- 一个目标study/assessment各最多一次。两个目标成功正好4次；初始sleeping/revision0，wake后1，四个阶段成功再增10，通常最终revision11。
- study预检两次余额/五条cycle空间，**不是一次锁住两个调用**；T1每阶段只预占一次。pending、failed、completed均占永久次数；模型/传输失败也不退。
- 无自动重试、模型fallback、换端点、重置/换库续费。遇到坏JSON、超时、提交异常，本次run停止，记录结果后交回，不自行再次运行去“凑满四次”。
- 本地model单次timeout最大30秒，runner总deadline10分钟。供应商未必及时停止已发请求，四次上限是应用派发/本地预占约束，不保证供应商端取消或货币结算行为。
- 每次maxOutputTokens=1024，但这不是输入+推理+输出的总token上限。需用户另确认可接受的费用上限/供应商侧限额；系统当前不能强制执行货币钱包。

## 4. 真实执行前授权单（未确认）

| 项目 | 必须明确 |
|---|---|
| endpoint / model / reasoningEffort | 指定具体值及供应商兼容性，不沿用历史授权 |
| 资料披露 | 仅上述两目标合成pack的阶段投影，可发给该供应商 |
| 额度与费用 | 最多4次生成，无自动重试；1024输出上限；接受费用或供应商侧限额 |
| 凭据 | 用户现有私有运行环境以credentialEnv注入，不索取/输出key，不发现Pi配置 |
| 数据位置 | 已存在私有测试父目录；唯一新DB路径，不覆盖旧库；无并行runner |
| 留存/删除 | 保留脱敏结果；含pack/笔记/原始答案的SQLite仅私有保存，确认后删除 |
| 环境操作 | 无安装默认；依赖/Node安装若需要，另按可复现方案批准 |

确认后才执行下一节；路线图和本文件命令不是操作授权。

## 5. 执行流程（模板，尚未运行）

### A. 离线检查先行

```bash
npm run verify:acceptance
npm run verify:learning:offline
```

离线正控制失败则停止真实试验。不要把离线summary改成live标签。完整代码改动后还需全量测试和类型检查；标准check缺工具时照实记录，不临时下载。

### B. 显式初始化并唤醒

用户先批准已存在的私有父目录，DB必须不存在。以下路径均是占位符：

```bash
DB="/absolute/private/eval-run-unique/learning.sqlite"
PACK="/absolute/project/config/learning-pack.example.json"
MODEL="/absolute/private/eval-run-unique/model.json"

npm start -- learning-init --db "$DB" --id dawn-eval --name 合成验收主体 \
  --limit 4 --learning-limit 4 --pack "$PACK"
npm start -- subject-status --db "$DB"
npm start -- subject-budget --db "$DB"
npm start -- learning-status --db "$DB"
npm start -- subject-wake --db "$DB" --revision 0
```

准备模型配置不能调用模型做“随手连通性测试”，否则额外计费且不在4次试验内。参数校验/本地哈希检查不计API调用。不把完整环境或配置原文写进公共日志。

### C. 一次前台run

```bash
npm start -- learning-run --db "$DB" --model-config "$MODEL"
```

允许runner自己选择顺序并推进，不逐轮人工喂题、不编辑模型笔记。只有这条命令可能发起真实生成；控制/状态查询不调用模型。若学习评分不通过但响应合法，runner可在同run继续其他目标，这是既定语义，不是retry。

执行时记录开始/结束时间与退出码。CLI输出安全报告，不暴露笔记/私有答案；仅把固定应用错误码或人工归类写入结果，不保存原始上游错误/凭据。遇到问题不要自动执行recover或重跑。

### D. 冷进程状态复核（零额外生成）

runner正常退出已关闭DB后，在新进程执行：

```bash
npm start -- learning-status --db "$DB"
npm start -- subject-status --db "$DB"
npm start -- subject-budget --db "$DB"
```

核对阶段结果/分数、packId、reserved和revision；普通history不应混入学习。新进程打开会执行完整回放核验。真实CLI摘要一致不等于逐字snapshot比较；完整state/status/budget精确重开比较由离线脚本覆盖，不能混写证据等级。

观察完成后，用户确认结束此grant可执行 `learning-stop` 并再次冷查stopped；这是持久撤权，无resume。然后停止所有进程，确认备份/私有留存，再按授权清理测试目录。不动其他主体。

## 6. 故障与停止规则

| 观察 | 本次操作 | 禁止 |
|---|---|---|
| 合法答案但测验不通过 | 保留本地grade，允许当前run按既有规则结束 | 改答案/宽松评分/重新测同目标 |
| 坏JSON、模型错误或超时 | 当前run结束，查状态/预算，保留失败证据 | 自动重试/换模型/新建库重新收费 |
| Ctrl+C / SIGTERM | 取消本run，保留提交与费用；等进程结束再查 | 假设已撤回供应商请求或自动退款 |
| 持久stop | 拒迟到提交和下一预占；不保证即时中止在途 | 把stop解释为可resume或sleep |
| 崩溃pending | 停此库所有旧runner/交流服务，用户决定是否recover | 自动steal、退款或重发 |
| 本地fail更新也失败 | 可能仍pending，如实报告 | 声称异常必然清理成功 |

恢复命令仅在门槛满足后人工执行 `learning-recover --db ...`，会将该v3库学习和交流pending都标failed，不退款、不撤销stopped。首轮真实试验不为演示故障另加调用；取消、stop迟到、pending恢复由现有离线专项覆盖。

## 7. 结果记录与判定

每次记录：runId/时间、源码与pack摘要、精确环境、脱敏模型标识/档位/timeout、最大调用数4、CLI退出码、总耗时、每目标study/assessment状态与确定性grade、reserved、冷开revision和状态、停止/清理结果。未执行字段写 `not-run`，未知用量写 `unavailable`，不要填0伪装无成本。

当前学习表没有逐call modelId/token usage；四次额度来自本地attempt计数。不能据此编造逐阶段token/费用/耗时，若需这些数据需另加可信审计实现。供应商对账另获授权，不读取账户或原始敏感日志。

分别判定：

1. **工程链路完成**：4个阶段均合法完成、总reserved=4、10条学习经历/对应记忆、revision与冷开正确、无额外调用。评分可不通过，但必须如实显示。
2. **本次任务全部通过**：工程完成且每目标assessment全对，safe report `allGoalsPassed:true`。`completed`本身不足以满足。
3. **失败或不确定**：保留已收费/提交阶段和停止原因，缺证据不判通过；不为得到绿色报告更改协议。
4. **学习收益**：本试验不判定。后续需预先冻结新随机合成规则、无笔记对照、迁移/延迟题与独立预算，报告样本数量和不确定性，而非用单次成功推广。
