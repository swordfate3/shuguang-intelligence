# 验证记录

## Pi薄接口模型与thinking选择（2026-10-21）

- 新增同一adapter实例的安全模型状态、显式GET `/models`、模型/档位选择；接通protocol、独立CLI/client、两类服务FIFO及Pi确认/选择器。独立 `selectionRevision` CAS与主体revision分离；控制不读取/修改主体，不预占生成，不重建adapter或重置次数。off仅省略参数。
- 目录限制1MiB上游正文、128条、256字符ID、48KiB序列化ID列表、8秒；协议仍64KiB、控制请求10秒含排队。测试包含声明/流式超量、非法UTF8/schema/Unicode控制符/超条目/Unicode目录wire超量、重定向拒绝、超时/取消/错误脱敏、缓存失败保留。构造/配置/远程目录统一ID策略，原向导允许格式符的测试已改为拒绝并安全重问，不放宽生产规则。
- adapter测试验证显式GET鉴权且不生成/不收费、共享生成次数、失败不退款、CAS/同值no-op、未知ID与busy拒绝、off省略、当前model捕获及原始上游model不受信。
- 临时v2主体+真实loopback控制/模型适配器/SQLite测试：状态与预算在发现/选择后逐项不变；阻塞生成后选择FIFO等待，旧请求仍用旧模型，后续请求使用新模型；排队期间取消目录/档位后无GET/变更，队列仍可用。legacy、无控制模型、非法请求和活动取消路径同样覆盖。
- Pi选择器15项合成测试覆盖明确刷新确认、缓存、含空格ID映射、thinking/off、取消、CONFLICT不重试、shutdown拒迟到写入、无UI fail closed、旧status/reply通知兼容与目录失败不降级。仅mock Pi UI，不是真实Pi TUI验证。
- 额外完整链路回归：mock Pi UI → 真实DawnClient/HTTP → SubjectService → SQLite → OpenAICompatibleModel → loopback假上游。先交流一次，外侧选择模型及high，再交流一次；同一主体历史接续、仅交流增加revision/完成次数，同adapter calls从1→2不重置，真实请求body携带对应model/thinking。最后off/status不生成。
- 最终 `npm test` **279/279通过**；`npm run verify:acceptance`（交流+24项学习）及 `npm run verify:learning:offline`通过。借用既有宿主TS5.9.3/Node/Pi声明的根配置 `--noEmit`通过；标准 `npm run check`仍127（tsc未找到），没有安装依赖，不声称干净安装或最低Node认证。
- 独立有限快照静态审查未发现未关闭的可证实P1/P2；原测试契约矛盾已关闭并全量复验，另按建议补排队取消组合测试。审查不是动态认证；新增完整链路测试在审查后补充。
- 本轮未读取真实模型配置/密钥、调用真实目录/生成/学习、重启现有服务、修改正式数据或安装/提交/push。代码选择仅进程内；现有旧服务须用户手动重启，Pi须重载扩展；不自动保存默认值或管理提供商。临时日志 `/tmp/dawn-selection-{focused,full-final,service-final,integrated,acceptance,offline,tsc-final,standard-check}.log`仅诊断，不是持久交付物。

## 用户授权本机启动（2026-10-21）

- 用户随后要求从接口获取可用模型：用私有凭据对显式入口执行一次GET /v1/models（15秒deadline、1MiB响应上限、拒重定向、仅输出模型ID，不返回原始错误/凭据），返回deepseek-flash、deepseek-v4-pro、glm-5-turbo、glm-5.3、glm-5.3-flash。历史gpt-6.1-sol未列出；已私有备份旧模型配置并改为deepseek-v4-pro，重启后status awake/revision1、budget计数全0。模型列表仅为该凭据可见目录，非reasoning_effort/JSON/实际生成可用性证明；未发生成请求，未将密钥写入源码或Git。此操作为一次运维发现，未修改向导实现成自动联网。

- 后续用户明确提供入口和临时凭据授权代配置；仅将其保存到持久私有目录model.json/model.env（0600），未写源码/Git/操作说明或回复。使用此前验证过的模型gpt-6.1-sol/low、30秒、实例maxCalls4，不把加载配置等同供应商可用性。停旧无模型服务后启动已加载模型配置的服务，本机ready `modelConnected:true`，鉴权status仍awake/revision1、budget全部计数0；**未发起任何真实生成或学习**。dawn-stop扩展为严格匹配这两种已知启动argv，不自动停止其他进程。

- 用户要求启动曙光，模型token自行配置。检查无既有主体目录/7341服务及同名启动脚本后，在实测pi-runtime持久卷创建私有目录，learning-init显式新建v3主体dawn/曙光，总额度20、学习子额度4、仅既有合成示例pack；token-init生成0600本机服务凭据，未输出其值。
- 以现有Node启动127.0.0.1:7341 **无模型**服务，鉴权request status及wake成功；后续独立查询awake/revision1、经历/记忆0、永久budget reserved/completed/failed/pending均0。没有say或learning-run、真实模型探测、模型配置/密钥读取。当前是本机会话脱离的运行进程，不是服务管理器或容器开机自启。
- 持久包装入口dawn/dawn-serve/dawn-model-config/pi-dawn，shell语法检查通过；另有dawn-stop，仅在PID的完整argv仍为本次无模型服务时发送SIGTERM，实测停止后重新启动、主体awake/revision1与预算全0保留。该辅助脚本不是跨进程租约，前台模型进程仍用Ctrl+C。model.env仅有注释，model.json尚不存在；dawn-serve正常模式需用户先配置，绝不自动回退；当前使用显式--without-model。Node --env-file读取私有凭据配置，不source或执行shell。真实配置需用户填好后停止旧服务并前台启动，不并行启动同库runner。
- pi-dawn --offline --no-session --help退出0，仅为启动包装与扩展选项冒烟，不把help当真实TUI命令注册/交流端到端证据。详细运行文件/当前PID与用户操作说明在私有目录START-HERE.md；未改Pi全局配置、安装依赖或自动提交推送这些状态更新。本轮未改源码，未重跑全量测试。

## 模型配置向导（2026-10-21）

- 用户要求参考Pi模型配置新增引导；只参考安装版 `models.md` / `providers.md` / `configuration.md` / `settings.md` 与安全说明，没有读取真实Pi配置或密钥。输出复用曙光单模型格式，保持本体独立与 `--model-config` 显式启用。
- 配置校验拆成无环境读取/无网络的 `parseModelConfig`，创建使用明确绝对路径、排他0600/最终symlink拒绝与fsync；旧配置可缺timeout，loadModel仍仅解析显式credentialEnv。模型ID新增256字符和控制字符限制，其他协议/预算/超时不扩展。
- 配置专项5/5（旧配置/超时、新离线解析、排他文件/权限/取消、生成→加载→adapter的mocked-fetch roundtrip）；向导专项9/9（默认/自定义、重问、确认/取消、输出/符号链接、预览转义、非TTY、EOF/abort）；加CLI/main回归共20/20通过。main实际子进程检查nonTTY/非法参数退出1、不读管道输入、不创建配置或泄漏参数。
- 真实PTY合成烟测6/6：交流默认保存、学习自定义入口保存、no取消、EOF、Ctrl+C、SIGTERM。前两项仅写临时配置，退出0/0600/字段正确；取消拒存，三个中断退出1/不留输出文件。六项均比较PTY前后termios一致，终端模式恢复。父程序使用Python stdlib PTY和15秒总限，逐prompt驱动main真实入口，没有安装、网络、真实变量值或供应商调用；不等于所有终端平台验证。
- 最终 `npm test` **247/247通过**；原交流+24项学习组合、新离线四次学习验收退出0。当前Node24.21.0/npm11.19.0；没有验证最低24.0.0。
- 标准 `npm run check` 本轮仍退出127：本地tsc不存在，未安装或生成锁。借用已有TS5.9.3+Node/Pi声明、extends根配置的离线 `--noEmit` 已通过，覆盖新增文件与双workspace/scripts；不冒充标准依赖解析或干净安装。
- 配置/CLI/文档及TTY/向导两次有限快照独立静态审查均未发现可证实P1/P2；主代理补齐真实PTY及完整入口验证，不把静态结论当动态证据。额外同输入流循环20次成功/abort/幂等close后监听数量稳定、keypress监听为0；Node readline首次keypress初始化会留一个data onData监听，因此不宣称回到初始化前零监听，未见逐次增长。临时日志 `/tmp/dawn-model-wizard-{focused,full,tsc,acceptance-final,offline-final}.log`，PTY驱动 `/tmp/dawn-model-config-pty.py` 均仅诊断，不是持久交付物。

## P0：可复现检查与真实学习离线准备（2026-10-21）

- 新增 `docs/reproducibility.md`：明确本体运行无Pi依赖、完整root类型检查仍需宿主声明；完整本体测试需完整项目树。无锁时先批准解析、显式选宿主精确版本、再第二空副本ci；最低Node24.0.0/精确npm/真实Pi加载均未复验。
- 新增 `docs/learning-evaluation.md` 与 `config/learning-model.example.json`：仅两组合成资料、临时v3主体、共享永久limit4/学习limit4/实例maxCalls4、无自动重试，明确阶段披露、费用非钱包、停止和pending门槛。真实试验需重新确认endpoint/model/凭据引用/资料/费用/留存，不沿用历史授权。四次试验只检验工程链路，不声称学习收益或泛化。
- 本机环境实际核对 Node v24.21.0、npm11.19.0；本地node_modules和根锁文件不存在。`npm run check`实际退出127（tsc未找到），未安装、未生成锁、未用npx下载。
- 本轮重新执行原 `npm run verify:acceptance` 退出0：交流合成脚本通过，原学习专项24/24通过；另执行core/CLI针对性9/9通过。能力元数据仍报告未开库/未连模型/未启动服务。合成pack两目标与新的四次占位模型配置通过本地解析/字段检查。
- 新增 `scripts/learning-acceptance.ts` 及独立命令 `npm run verify:learning:offline`。实跑退出0：真实OpenAI兼容adapter → loopback假上游 → runner → v3 SQLite，两目标四次，assessment使用已提交笔记；本地分数均1/1。仅检查数据投影无私有字段，允许教材/笔记中的合法解题事实；公共事件/状态不含私有评分字段或原始答案数组。
- 同一脚本断言：wake后revision1，学习再增10至11，10条经历/记忆；总预算4/4 completed、无pending/failed；关闭所有store连接后重开state/status/budget逐项深比较一致；完成后再次run零新调用；stop后重开仍stopped、state/budget/history不变。通过摘要只在owned临时库/服务清理后输出，不含教材/笔记/答案/token/路径。这里的冷重开是本进程新连接完整回放，不是OS重启。
- 新增回归3/3：CLI成功与安全摘要、假上游失败/内部取消清理、IPC屏障就绪后父进程延迟500ms再SIGTERM仍退出1/无迟到成功/无fixture残留。父deadline35秒+5秒强杀宽限，外层55秒；脚本30秒deadline。没有注入实际30秒deadline耗尽或清理失败，不把静态路径当动态通过。
- 独立静态审查指出1项P2：仅readiness没有屏障可能先完成再收到SIGTERM。已改成先注册abort/release监听再发IPC、等待继续或取消，并由原deadline兜底；不靠固定等待阻止完成。延迟测试及全量已重跑，独立静态窄复核确认原P2关闭、未发现修复引入的可证实问题。IPC continue正常释放与父无响应deadline路径未直接专项执行；静态审查不认证动态结果。
- 修复后本轮最终 `npm test` **234/234**、原 `npm run verify:acceptance`（交流脚本+24项学习）与新独立offline命令均退出0。能力检查通过，未发现本轮合成服务/脚本残留进程。
- 本轮替代 `tsc --noEmit`通过：借用已有TS5.9.3，以 `/tmp/shuguang-p0-typecheck.json` extends项目root配置，typeRoots/paths显式指向已有宿主Node/Pi声明，覆盖双包src/tests及scripts。没有安装或跳过源文件，不是标准项目解析、锁定依赖或最低Node证明；标准check失败127仍保留。
- 本轮范围始终限本机合成临时数据。没有真实API、正式主体、安装、旧库迁移、部署或Git提交/发布。日志仅临时诊断：`/tmp/shuguang-p0-full-final.log`、`/tmp/shuguang-p0-new-tests-final.log`、`/tmp/shuguang-p0-offline-final.log`、`/tmp/shuguang-p0-acceptance-final.log`；它们非持久交付物。

## 架构图视觉重排与文字碰撞复验（2026-10-21）

- 用户指出首版字体/标签重叠、不美观。首版只验证SVG文字未出viewBox，不能证明图中文字不重叠；该视觉结论不足，首版布局已整体撤换，下方原记录只保留为历史。
- 完整重写 `docs/architecture.html`：浅色白皮书样式、保留深色切换；大图拆为交流入口、学习入口、共享主体/模型边界等独立视角。使用HTML/CSS自适应节点与独立箭头，不再把文字压在SVG固定坐标/交叉连线上；长说明移到图外。桌面短流程横排、窄屏纵排，细节索引可折叠；非固定页头/移动导航避免覆盖正文。
- 增大标题行高，修正中英文换行后的文字边界；保留9个章节与151个本地链接/锚点。事实仍以当前实现为准，包括学习3+2 cycles、预占先于模型调用、答案隔离/远端披露、stop/recover及v2/v3回放，不通过美化删除限制。
- 使用独立浏览器context，展开完整源码索引，通过Range.getClientRects测量正文实际文字片段的两两交叠（>3px）、节点scrollWidth/clientWidth和页面宽度。1440/1024/768/390/320px普通字体，以及1440/390/320px下根字体200%共8组：文字交叠0、节点内容溢出0、页面横溢出0。截图复核交流、全景和手机六核心；检查期间无页面脚本错误或外部请求。
- 深浅主题、有效章节锚点、320px禁用JavaScript（9章节/31流程节点仍可读）通过；打印事件展开折叠索引、afterprint恢复状态、打印媒体9章节可见且无页面横溢出通过。仅验证现有浏览器与媒体模拟，不宣称覆盖所有字体/浏览器、真正打印分页或所有缩放设置。
- HTML唯一ID/资源/本地链接和内联脚本 `node --check` 检查通过；本轮文档空白/Markdown链接检查通过。未运行项目测试/TypeScript，未修改运行代码、调用真实模型、操作主体数据或安装依赖。临时loopback文档预览用后关闭；未部署本体。

## 历史：首版详细架构图 HTML（视觉布局已被替换，2026-10-21）

- 新增 `docs/architecture.html`：离线单文件、内联 SVG/CSS/脚本，覆盖全景拓扑、同主体六核心、交流 T1/T2、自主学习、SQLite/回放、权限与披露边界、版本兼容、源码/命令索引和未实现候选。README、ARCHITECTURE 与 docs 索引增加入口，STATUS 记录本轮交付。
- 依据当前源码核对模型投影、revision/cycle 数、预占/失败语义、stop/recover、v2/v3 表与回放、真实依赖和超时。只读代理核查与主代理复核不是重新执行运行测试；历史 231/24 基线与真实交流样本在页面中显式标为历史证据，不冒充真实学习验证。
- 静态检查覆盖 HTML 唯一 ID、章节锚点、本地源码/文档链接、内联脚本 `node --check` 与无外部样式/字体/脚本资源。通过独立临时浏览器 context 验证桌面 1440px 与移动 390px：页面无水平溢出、宽图在容器内滚动、主题按钮切换生效、章节锚点有效、全部图形文字均在 SVG viewBox 内；打印媒体保留图与章节。未发现页面脚本异常或外部网络请求。最终页面含6张 SVG、9个内容章节及151个链接/锚点，另检查关键流程截图的可读性。浏览器通过临时 loopback 预览加载；远端浏览器不能直接访问容器的 `file://` 路径，因此未冒称验证了该浏览器直接打开容器文件。
- 本轮仅展示文档，不改运行代码；未重跑 `npm test`、组合验收或 TypeScript，未读取真实凭据、调用模型、打开主体数据库、安装依赖或部署。仅为浏览器检查启动临时 loopback 静态文档预览，检查后关闭并清理临时脚本；不启动曙光本体。浏览器结果不等于所有浏览器或实际打印机兼容性认证。

## 开发交接文档补齐（2026-10-21）

- 新增根目录AGENTS.md、STATUS.md、ROADMAP.md，分别保存稳定开发约束、当前事实/阻塞/下一任务和版本验收路线；README增加接手流程与导航。
- 明确自主学习为0.1.0必需项、D-015覆盖旧排除决定；区分此前231项/24项合成基线、真实首轮交流样本与未验证的真实学习质量。不把任务列表当作真实API/安装/部署/发布授权。
- 本轮仅文档：检查4份接手文档的本地链接、代码围栏、空白、npm脚本名称及源码入口路径通过；git diff --check -- .通过。项目整体尚未跟踪，另用内容检查覆盖新文件，不能单靠git diff证明检查了新增文档。
- 未重跑npm test/类型检查；未调用真实API、安装依赖、操作数据库、启动服务或进行Git提交/发布。下方验证数字仍属于各实现阶段，不冒称本轮新执行。

## 自主学习范围更正及最终离线验收

用户明确0.1.0必须实现自主学习；此前仅交流版完成结论撤回。新增学习pack、v3同主体持久学习、runner与CLI已接通并完成本轮离线验收。`verify:dialogue`保留原合成脚本；`verify:learning`覆盖学习闭环；`verify:acceptance`组合二者。

- 最终`npm test` **231/231通过**；`npm run verify:acceptance`交流与学习组合通过；学习专项**24/24通过**（core6/store9/runner6/CLI3）。全项目含scripts离线TypeScript `--noEmit`通过，仍借用既有宿主编译器，不是干净安装证据。
- 自主证据：一次授权后runner无需逐轮用户输入，连续选择两个目标并完成study/assessment共4次假模型调用；study不见heldout题、两阶段投影均无private answer键；assessment不见教材，仅使用上次已保存笔记解答。不是脚本只“回一句学会了”。
- 持久证据：v3主体同库写入reading/document、reflection/inference和activity_result/observation，纯本地exact评分；公共snapshot/events无私有评分答案。冷重开state/status/budget一致，学习不进问答history；普通中文主题交流实际获得相关学习笔记（有界6条召回，不保证两目标所有笔记同时出现）。同库交流成功提交并重开校验通过。
- 故障证据：study提交后新runner直接测验；模拟崩溃pending不自动恢复/重发，显式recover保留费用并终止不确定目标；取消忽略abort的迟到生成不提交；跨连接stop、sleep拒迟到；坏JSON收费失败、失败测验继续其他目标但allGoalsPassed=false；trigger强制失败保持state/events/result回滚而预占保留。
- 边界证据：共享总额度/学习子预算、阶段一次性与pending互斥；995/996/997集合槽位边界，完整episode不足5条时零调用零计费且exhausted；study后交流占满时不再收费发测验。热读/冷开均拒缺事件、改结果、改snapshot和改已读pack。
- 独立只读审查发现两项P2：study只预检3条导致后续assessment无容量、readonly投影测试错误。已改完整5条/接续2条并将容量纳入status、修类型测试，动态回归及静态窄复核关闭。只读审查不是测试执行或无缺陷保证。
- 学习CLI另经真实OpenAI兼容适配器连接loopback假上游完成2阶段，配置/pack读取、strict候选、持久提交、隐私诊断通过。全程无真实模型API、无正式主体/旧库迁移/后台部署、无安装或Git发布。
- 限制：结果是本地学习记忆/笔记与规则测验，不是模型权重训练、通用学习能力或长期人格成长。真实API学习质量、多教材迁移、长期容量、最低Node版本和干净安装未验证。v3当前每次完整回放；学习账记录次数/阶段/结果，暂不保存逐call modelId/token用量。

## 此前仅交流版源码收尾与离线验收（完成结论已被更正）

- 用户明确首版版本为0.1.0。应用与两个workspace保持该版本，新增runtime/version.ts、--version；--check改为bounded-companion能力描述，明确domain2/newstorage2/legacy1和未开库/未连接/未运行，不混同版本或假健康。
- 新增独立request CLI，显式endpoint/token-file -- status/wake/sleep/say；共享HTTP客户端与命令解析迁至dawn，Pi兼容re-export。dawn不反向依赖Pi，未增加新Pi API或自动启动功能。main对应用error退出1，并传播SIGINT/SIGTERM取消；子进程测试验证成功/应用失败退出码和取消不打印晚到reply。
- 新增scripts/acceptance.ts与npm run verify:acceptance：全部合成、临时库/token/loopback假上游，验证首轮带来源认识/情感/记忆、精确重开、第二轮上下文/回复、休眠、坏凭据、重启固定额度。不会读取真实模型配置、调用外网或初始化正式主体；finally关闭监听/存储和清理数据。release.test核对版本并执行该脚本，失败不报告通过。
- README以六核心subject-db新模式为默认指南，含完整新建/配置/前台服务/独立客户端/停止/备份恢复说明；旧格式仅兼容。0.1.0范围、验收和已知限制见release-0.1.0.md，不把自主持续学习或无限记忆写成首版已交付。
- 最终冻结回归：npm test **207/207通过**（在197基础上新增request-cli6、main子进程2、release gate/中断清理2）；全项目含scripts的离线TypeScript --noEmit通过（借用既有宿主工具，非干净安装）。npm run verify:acceptance独立执行通过，输出9类检查共32项断言计数；--version、check:capabilities与help通过。
- 独立只读审查发现两项发布验证P2：支持范围Node的SQLite ExperimentalWarning被stderr空断言误判、父测试9秒SIGKILL早于脚本30秒deadline绕过finally。已在测试子进程明确屏蔽ExperimentalWarning（其他stderr仍校验），协调35秒等待+5秒信号清理宽限+父级拥有tmpRoot兜底，脚本SIGINT/SIGTERM统一abort且cleanup完成后才输出passed。新增IPC就绪后SIGTERM验证子进程自己清空临时目录，不由父删除掩盖。审查窄复核关闭两项，无新可证实P1/P2；并未实际用Node24.0.0复验，不宣称覆盖所有支持版本。
- 最终JSON/Markdown链接、git diff --check和dawn无Pi运行依赖检查通过，项目无.sqlite/.token，验收临时目录清理；只读检查未操作用户其他目录。本轮未安装依赖、未生成锁文件、未真实API调用、未正式初始化/迁移/部署，也未commit/tag/push/npm发布。版本0.1.0表示当前源码交付范围，不表示生产上线。

## 此前实测：超时定位与真实首轮闭环成功

用户要求推进后，本轮限定最多两次生成请求，未自动重试或换端点：

1. **诊断请求一次**：现有8秒配置下再次返回UNAVAILABLE；脱敏观察到elapsed8003ms、AbortError、adapter signal已abort、尚无响应头，定位为本地8秒生成期限触发。不能据此断言所有历史失败原因相同。
2. **修复后一次**：同入口、模型gpt-6.1-sol与low档位，显式timeoutMs=30000，实际10522ms收到HTTP200，10523ms完整接收；finish_reason=stop，usage输入1220/输出176token。候选JSON恰好reply/appraisal/candidates，appraisal=null、candidates=[]；经过实际HttpDawnTransport → 鉴权HTTP → SubjectService → 模型适配器 → API → core → SQLite事务成功。

持久状态revision从wake后的1增到3；保存用户user_statement与助手inference各一条、两条episode记忆与完整问答；预算limit1/reserved1/completed1/failed0/pending0。关闭服务、全新SQLite连接完整回放要求状态完全相等，再启动产生新instanceId；实际status返回revision3；本地prepareTurn确认原学习偏好记忆和完成问答进入下一轮上下文。重启后的额度耗尽请求明确拒绝，观察器确认没有额外上游调用。

**验证范围**：真实首轮生成、核心/问答提交、冷重启回放和下一轮上下文准备通过；没有进行第二轮真实生成（本轮两次总额度已用尽），不能声称跨重启第二轮真实回答已经验证。模型未提出appraisal/认识候选，情感仍0、beliefs0、没有成长应用；该分支仍只有模拟fixture证据。回复内容未逐条事实核验；工程闭环成功不是知识正确性或学习成功证明。

**改动**：模型配置新增可选timeoutMs=1..30000、缺省8000、五必需字段兼容；完整合法say服务累计期限35秒、客户端40秒，控制/上传仍10秒，排队不重置期限。Pi命令原15秒独立取消遗漏已修复，transport管理deadline、session_shutdown继续独立取消。独立审查确认该P2关闭，无新增可证实P1/P2。

新增10.2秒真实client/server+假upstream测试与15.2秒注册Pi handler回归，另保留shutdown取消、槽位、预算和脱敏校验。聚焦23项通过；冻结后全套npm test **197/197通过**、离线全项目TypeScript --noEmit通过（沿用现有宿主工具，未安装依赖）。临时脚本/tmp/dawn-live-sixcore-single.mjs和脱敏结果/tmp/dawn-live-sixcore-30s-result.json不属于持久依赖；服务、库、token清理。没有正式主体初始化、迁移、部署、安装或Git提交。

## 此前实测：真实模型闭环尝试（未完成）

用户授权闭环测试后，使用已有显式模型配置（gpt-6.1-sol、low）、环境变量凭据引用与/tmp临时DSW2主体库，通过实际HttpDawnTransport → 鉴权HTTP → SubjectService → 模型API执行。最多两次调用，中间计划重启；只发送合成学习偏好，无Pi历史、用户真实资料或凭据打印。

- 实际仅发起 **1次生成请求**，上游fetch未返回可用响应，服务返回UNAVAILABLE；没有自动重试、TLS绕过或换端点。现有模型边界统一脱敏，测试观察器只记录transportFailed，**没有足够证据区分生成超时、连接中断等底层原因**，不能宣称已定位。
- 失败后主体revision仍为1（只有wake），experiences/memories/beliefs均0，情感无变化；预算reserved1/failed1/completed0/pending0。失败收费且核心不部分提交已观察到。第二轮、重启接续与真实候选提交均未执行，不算通过。
- 随后不带凭据HEAD探测baseUrl，HTTP200、127ms；只说明当时入口HTTP/TLS可达，不证明生成接口可用，也不能据此排除生成阶段网络问题。该探测不是生成调用。
- 重新执行subject-integration/service/recovery：**11/11通过**，上游均为本地合成fixture。模拟闭环通过与真实模型闭环失败分别记录，不能互相替代。
- 测试服务、临时token与主体库均finally清理；没有初始化正式主体或改动生产数据。脚本与脱敏结果为/tmp/dawn-live-sixcore.mjs、/tmp/dawn-live-sixcore-result.json，非持久项目依赖。继续生成诊断需新的明确动作，不自行追加调用。

## 当前实现阶段：六核心交流接线与统一持久事务

- 新增 `runtime/subject-store.ts`、`subject-service.ts`、`deliberation.ts`、`deliberation-types.ts`、`subject-cli.ts` 与 `adapters/storage/sqlite-subject.ts`；入口/serve/CLI增加显式新模式，原legacy运行链保持兼容。没有新增端点、Pi能力、后台服务或工具。
- `subject-init/status/wake/sleep/budget` 与 `serve --subject-db` 使用新DSW2/schema2统一库；原 --db/--chat-db互斥保留，不猜测格式、不覆盖或迁移。新建主体有明示bootstrap关切，非学习结果。
- 从真实服务入口串通最小self/affect/memory/cognition/agency投影 → 一次模型请求 → 严格候选 → T2锁内typed六核心循环 → 同事务snapshot/events/pair/usage → 重启接续。这里“真实入口”指本地HTTP应用链路，不表示调用了真实模型供应商；所有上游为loopback合成fixture。
- 预算T1先预占不退款、requestId永久去重、最新sequence与awake/revision CAS、同事务回滚、用户陈述/助手推测分离；每次成功say两个revision。模型只能提案，不能提供可信成长评估或权限。
- 最终 `npm test` **194/194通过**：此前155项继续通过，新增39项（deliberation16、subject-store11、subject-service6、subject-integration4、subject-recovery1、core记忆修正1）。全项目离线TypeScript `--noEmit`通过（沿用宿主已有编译器/类型映射，不是干净安装验证）。
- 新增验证：最小上下文与隐藏数据不披露、总字符预算、候选schema/来源/替代目标/主体/时间白名单、错误输出不部分提交、重启持久情感/认识/经历/问答、额度不重置、跨连接sleep fence、trigger失败全事务回滚、取消和前台shutdown排空、独立进程持有写锁竞争最后额度以及pending崩溃恢复。竞态测试将额度拒绝与SQLITE_BUSY等未知错误区分，不能将错误冒充成功边界。
- 独立只读审查发现P2：candidate记忆修正提前撤回原usable，且候选不召回导致来源消失。已修正candidate只追加不生效；推进到第12轮、原问答离开8对history后仍能从memory召回原依据，candidate不晋升。审查代理复核关闭；新模式仍无可信记忆候选确认通道。
- 性能风险实测后处理：重复全量回放在20轮样本中read/history/reserve约395/390/407ms。增加bootstrap+逐条eventJSON完全相同才复用的私有前缀checkpoint，所有snapshot/台账/来源关联校验仍保留，前缀变化或缩短重验，新open完整回放。审查窄范围未发现可证实P1/P2；缓存别名、同revision改事件、bootstrap改写、删除事件与跨连接追加均有回归。
- 同合成脚本、Node v24.21.0 linux/x64对照：优化后20轮read67.651ms/history13.437ms/reserve20.484ms，累计reserve+complete1439.679ms（此前5086.163ms）；30轮read141.522ms/history26.660ms/reserve51.487ms。read样本含尚未缓存的最新后缀校验，其后history为热前缀；非生产benchmark、不代表冷启动或容量上限验证。脚本位于/tmp/dawn-subject-bench.mjs，临时库finally清理。
- `check:skeleton`、CLI help、JSON/Markdown链接、core依赖方向检查通过，项目中无.sqlite/.token文件；未新增安装、真实key读取、真实API调用、正式主体初始化、部署或Git提交。本轮没有改Pi插件注册/命令行为。
- 剩余：本阶段当时尚未完成真实API闭环；最新首轮与冷重启验证见上，但非空候选稳定性仍未验证成功；1024token与16000字符content限制会使复杂JSON截断并明确失败。没有自动迁移/自主调度/工具执行/可信成长验证/遗忘压缩/跨进程独占/恰好一次交付。同步校验与SQLite不能即时取消；本地小样本通过不证明长期人格或成长。

## 已完成阶段：六核心领域内核

- 用户明确要求核心优先、不扩外围。本轮落地self/cognition/affect/memory/agency/growth各模块types+logic，统一experience/evidence来源解析、完整validation和纯函数SubjectCycle。
- 旧schema v1状态、校验与类型移至`src/legacy/`，现有runtime/adapters及原测试显式改引用。旧CLI/HTTP/SQLite格式和行为保留；新core schemaVersion=2仅是内存领域格式，不是数据库迁移。
- 最终 `npm test` **155/155 通过**：原122项继续通过，新增核心33项（认知/记忆8、自我/成长8、情感/自主7、cycle6、证据与边界4）。完整离线TypeScript `--noEmit`检查通过；仍借用现有宿主类型/编译器，不等价于干净安装npm run check。
- 集成fixture覆盖：记录阅读经历→形成有来源认识→按自身关切评价情感→选择proposed意图；后续独立活动结果评估兴趣候选→小幅变化→影响下一次选择。候选不是自动接受；来源不是内容真理证明；活动不是实际工具执行。
- 独立只读审查发现6项P2边界：继承数组toJSON getter、topics getter、成长target大小写绕过、聚合证据32/1000容量不一致、派生源刷情绪、跨主体evaluateGrowth。均已修复并回归，审查代理定向复核关闭。主代理另补满长experience ID对应固定哈希memory ID和完整状态独立来源校验。
- 严格验证数据对象、schema未知字段、scope/subject、时间、证据链/循环引用、来源替换图、重复提交、每轮单目标成长限幅、停止和预算。cycle中任一步失败不改输入，返回深拷贝；这是内存纯函数原子性，不是持久事务或并发锁。
- 本轮没有读取真实key或调用模型API，没有安装依赖、修改Pi集成行为、创建数据库/凭据、部署服务或commit/push；测试仅临时fixture与原有loopback模拟。没有宣称真实人格、情感或长期成长已通过验证。
- 关键限制：旧say仍不使用新core；模型候选解析、统一持久事务/事件回放、显式迁移、真实工具和自主调度未在本轮实现。最多2MiB、1000经历的有界领域快照明确失败不静默遗忘。启发式权重/半衰期非论文复现。详见[六核心契约](six-core.md)。

## 已完成阶段：持久对话与调用额度

- 主体 schema v1 不变；新增独立主体绑定对话库。CLI 提供显式 chat-init/chat-budget；模型服务强制 model-config 与 chat-db 成对提供，不静默退回无台账模式。
- 持久预占收费、请求 ID 去重、失败/崩溃不退款、最新预占序号屏障；仅完整成功问答进入最近8对/24000字符历史。对话证据不写为性格、情绪或知识事实。
- 最终 `npm test` **122/122 通过**：在原92项上新增存储13项、交流语义12项、完整本地集成3项、跨进程恢复/锁竞争2项；另补CLI非法选项断言。完整离线 TypeScript --noEmit 通过，仍不是干净安装标准npm run check验证。
- 集成覆盖：临时配置→鉴权HTTP→本地假上游，重启接续问答、额度不重置、超限不请求、SIGTERM等价abort取消进行中请求、已有台账不重建和缺失不创建。
- 并发恢复覆盖：独立进程持有 BEGIN IMMEDIATE 锁时另一进程尝试预占，释放后仅一个获取最后额度；重开后所有状态请求ID仍去重；跨连接更晚预占失败也阻止旧回复提交。
- 本轮未调用外部真实模型API，未读取真实key，未安装依赖或启用Pi插件，未创建正式主体/对话库，也未commit/push。所有测试采用临时合成数据和loopback服务。
- 独立静态审查在覆盖范围内无必须修复缺陷；建议的锁竞争与跨重启/连接组合测试已补。主代理发现存储层空白助手文本未拒绝与额外64KiB成对限制后修正，增加近上限中文问答回归。最终冻结后全套122项通过。
- 明确限制：固定次数非货币预算；单owner共享；无自动遗忘/删除；失败用户输入仍在台账但不进模型历史。主体/对话双库非联合事务，跨进程sleep非即时抢占，崩溃pending保持收费不自动补发。参见[对话记录与预算](dialogue-memory.md)。

## 已完成阶段：显式模型 API

- `npm test` 最终 **92 项通过**，新增适配器 13 项、模型配置 1 项、单轮交流 2 项；离线 TypeScript 5.9.3 完整检查通过。
- 本地模拟覆盖鉴权请求、reasoning effort、输入/输出校验、响应128KiB边界、重定向拒绝、错误脱敏、取消/超时和调用上限。
- 用户显式授权复用当前 Pi URL/key 后，识别了已有密钥环境变量引用，未打印或复制密钥。实际四次生成请求：前三次均被上游拒绝不支持的 reasoning_effort=none；修正为显式 low 后，一次完整的独立服务→实际客户端→上游模型测试成功。没有隐式重试或回退，过程见[模型 API](model-api.md)。
- 测试临时状态库、控制 token 与服务均已清理。仅保留被 Git 忽略的本地模型配置，包含入口、模型、环境变量名、low档位与3次实例调用上限，不含密钥。
- 独立静态审查无必须修复项；指出仍可补本地假上游的完整配置集成/进行中关闭测试、更强的多轮无泄露断言。没有真实 Pi TUI/RPC 加载验证，不将单轮API证明为持续记忆或自主学习。
- 当前 sleep 不跨进程抢占已发出模型请求；调用上限随实例重启重置，尚无持久费用台账。正式长期使用前仍需补这些边界。

## 已完成阶段：独立本机控制服务

开发按运行内核、HTTP 适配、Pi 客户端分文件并行分工；前两项由子代理交付，客户端任务未产出后由主代理接手，主代理同时负责协议、CLI、凭据文件、集成与文档，另有只读审查代理。开发协作不是曙光运行时多 Agent 能力。

- 测试使用临时数据库、随机测试凭据和 loopback 临时端口，无外网模型请求，不操作正式主体。
- 已实现 DawnService 串行队列、运行实例元数据、关闭排空与取消检查；say 明确 NOT_IMPLEMENTED。
- 已实现 HTTP Bearer 鉴权、Host/Origin 约束、严格协议/大小校验、并发与超时限制、断线取消及连接清理。
- 已实现私有 token 文件显式创建/读取，不覆盖、不打印凭据；CLI 显式 serve，SIGINT/SIGTERM 清理而不隐式 sleep。
- `npm test` 最终 **76 项通过**，包含真实子进程 serve + 实际 HTTP 客户端的唤醒、冲突、未实现聊天、错误凭据、停止和重启恢复，以及模拟 Pi 命令与实际服务连通、插件关闭不 sleep 的测试。
- 客户端额外覆盖 loopback 目标限制、重定向不跟随/凭据不转发、错误 schema/requestId/响应类型、非法 UTF-8、大小上限和取消。HTTP 端覆盖 10 秒超时后忽略 abort 的 handler 不释放并发名额。
- 完整离线 TypeScript 5.9.3 `--noEmit` 检查通过，仍借用既有本机类型环境，不等价于干净安装后的标准 npm run check。
- `npm run check:skeleton`、`npm start -- --help` 通过，报告 transportAvailable=true 但 serverStarted=false，不会隐式启动服务。
- 独立静态审查发现默认 HTTP 80 端口 Host 构造兼容性问题，已显式固定规范 Host，并补 80/7341 的纯构造回归；审查代理复核关闭。没有为测试绑定特权端口。
- 局部测试曾因并行文件尚未落盘失败、持久化测试曾超时；最终冻结文件全套通过。没有将中间态结果冒充最终验证。模拟宿主测试不替代真实 Pi TUI/RPC 加载验证。

### 剩余边界

本阶段当时不含模型 API；当前显式单轮接入见上节，仍无聊天记忆、自主学习或情绪演化；Pi 不自动拉起服务；没有跨进程独占租约或持久请求去重。客户端取消不证明服务端未提交，必须重新查询状态。未安装依赖、未启用 Pi 插件、未部署后台服务。


## 已完成阶段：SQLite 持久化与恢复

环境：Node.js 24.21.0、npm 11.19.0；使用 Node 内建 `node:sqlite`（SQLite 3.53.4），没有安装新依赖。

### 已执行

- `npm test`：**35 项通过**。覆盖既有骨架功能及下列新边界：
  - 完整主体 bootstrap、身份、兴趣和记忆引用在关闭/重开后保留；
  - 新文件权限 0600、显式初始化不覆盖、open 不创建缺失库并拒绝最终路径 symlink；
  - 两连接 CAS、两个独立 CLI 进程竞争仅一个成功、过期版本不覆盖；
  - 状态与事件原子提交：注入事件写入失败时两者一起回滚；
  - 子进程带未提交事务退出后，重开恢复旧状态并能够继续写入；
  - 取消、时钟倒退、非规范时间戳、非法参数和分页；
  - 未知/未来数据库版本、外来数据库标记、缺失或损坏快照、事件链及 bootstrap 拒绝，不自动重建；
  - 完整主体 schema 的运行时校验；
  - JSON 不可无损序列化的输入（包括不可枚举必需字段、负零）和超大 bootstrap 在建文件前拒绝；
  - 快照恰好 2 MiB 时，后续版本增长造成超限的提交被拒绝，旧状态、事件和重开仍正常；
  - 真实独立 CLI 进程间 init、wake、status、sleep、events 的恢复流程。
- `npm run check:skeleton`：适配器可用，明确报告 `databaseOpened: false`，模型、transport、自主运行仍为 false。检查不会创建主体数据库。
- `npm start -- --help`：展示本地状态命令，明确 wake 只修改生命周期标记，不证明常驻运行。
- 借用本机已有 TypeScript 5.9.3、Node 类型与 Pi 1.3.0 声明，以 `/tmp` 临时 tsconfig 的 typeRoots/paths 映射执行完整 `--noEmit` 检查：通过。没有修改项目解析规则、没有安装依赖；不等价于干净安装后的标准 `npm run check`。
- 独立只读审查发现两项序列化边界问题，均已修复并加入回归：每次持久化统一执行大小、schema 与无损 JSON 校验；必需对象字段拒绝不可枚举属性。审查不是无缺陷保证。

所有数据库测试使用 `/tmp` 合成 fixture 并清理，没有初始化用户真实主体，也没有操作用户已有数据库。

### 限制

- SQLite 同步调用期间无法即时响应 AbortSignal；只在同步操作边界及提交前检查。锁等待上限设置为 1000ms，不承诺实时抢占。
- v1 每次读取回放完整生命周期链核对快照，成本随事件数增长；未做大规模性能测试。没有模型、记忆正文写入或通用成长提案提交。
- 崩溃测试模拟未提交事务的进程退出，不等于断电、磁盘损坏或所有文件系统耐久性测试。
- 数据库目录必须由可信用户私有管理；文件检查不构成对恶意同 UID 进程、目录替换竞态或直接改库的防御。数据库不加密、不提供抗篡改证明。
- 本阶段当时未涉及真实 Pi TUI/RPC、网络 transport、服务鉴权或模型；后续服务阶段验证另记。模型 API、自主学习和情绪演变尚未实现。
- 未安装依赖、未生成 package-lock.json、未安装/启用插件、未提交 Git。标准安装与 `npm run check` 仍需准备环境后复验。

## 历史：初始骨架

初始骨架 15 项测试通过，内存版生命周期、模型和能力显式未配置、Pi 命令及协议边界已验证。`architect_review` 的 generic 模板报告根目录 src/include/tests/tools/third_party 缺失；项目有意采用 packages/*/src 和 packages/*/tests，不创建无实际职责的根目录占位。架构文档与构建忽略规则通过检查。

## 下一步

本机服务、Pi 直连及显式单轮模型 API 已实现。下一步可做记忆、显式启动托管和持久预算；主体变更提案需要继续经过统一事务、取消、预算与校验边界。
