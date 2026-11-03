# 更新记录

## 未发布 — feat/mcp

- 新增HTTPS Streamable HTTP MCP `/mcp`网关，远程客户端只需URL与独立接入凭据，不需要Docker／仓库路径；标准JSON响应、独立鉴权／Host-Origin／session／并发及超时边界，原stdio保留本地兼容。不公开内部Dawn／owner私有接口，不重建主体或迁移DB。
- Pi资源包新增HTTPS URL＋credentialEnv配置和远程确认／工具暴露限制；客户端不能升级服务端写权限。远程share/research私有桥尚不支持，明确失败关闭，不自动fallback Docker／读历史。
- 新增显式`compose.mcp.yaml`、`mcp-token-init`与`mcp-http`入口，默认Compose仍不发布端口；网关经可信TLS反代接入，只读原卷且不打开DB。断开只关闭接入，不stop/sleep/delete主体；实际域名／证书／Docker部署未执行。

- 新增v5有界公开研究：owner批准准确问题/query与预算，主体排序、私有task/claim/receipt、固定Tavily搜索适配、曙光独立模型study/heldout测验、原子来源/笔记/程序评分、继续/停止。`/shuguang-research`仅用户命令，不读Pi历史/借Pi主模型，不暴露通用执行工具。
- 显式`research-learning-init`只新建v5、兼容pack/来源和共享永久预算；默认setup仍v3，无正式迁移。断线/期限/stop/sleep持久fence，崩溃后须停全部旧服务再显式`research-recover`，未知请求收费不重派，普通serve不隐式接管。真实provider/模型/部署仍未认证。

- 新增实验性Pi `/shuguang-share`：选定完整文本块、准确预览授权、容器内私有桥/独立owner与socket绑定executor；不自动监听、不暴露模型授权工具或秘密、不停止Docker。
- 显式`host-learning-init`新建DSW2 v4来源库，保留pack学习和预算；接收/消费分开、整批原子记忆、定位去重/内容冲突/冷回放、sleep撤host权。不调用模型/联网、不等于已学会；默认setup仍v3，无正式迁移或真实部署。

- 后续新增可选Pi资源包：同一安装源分发MCP连接管理扩展与shuguang skill，仅在显式UI确认后注册当前会话，默认只读；不恢复旧/dawn、不代启服务、不改mcp.json/凭据或自动采集对话。资源包不打入独立Docker镜像；后续已按用户明确要求注册当前容器个人Pi配置，尚未发布。

- 从main b446014分出MCP开发，不合入DSH分支；删除Pi专用薄扩展workspace及其测试，dawn集成直接引用本体客户端。
- 新增无运行依赖的tools-only MCP stdio桥接：握手、工具schema、默认只读/显式写操作、取消、UTF8/帧/并发/输出队列限制及脱敏错误；不自动采集对话、检索或学习，不变更core/协议v1/SQLite格式。
- Docker不再安装Pi，只保留原dawn-data卷；新增mcp子命令，不加载model.env、不发布端口、不自动删除旧Pi卷。start就绪后返回终端；根README为唯一部署使用教程。
- 最小会话来源和有界公开检索任务均由独立私有桥承接；自由query和web.fetch仍为后续目标，不能用现有owner say冒充对话学习或继承Pi全部MCP工具。当前UNAVAILABLE细分仍未实现，真实Docker部署与长期学习未认证。

下文为main历史功能记录，Pi扩展/三卷/进入Pi等描述已被本分支新入口替代。

## 0.1.0 — 首版源码（含有界自主学习）

有界、单可信所有者、本机独立数字伙伴原型。版本号表示源码范围，不表示已经部署、发布包或创建正式主体。

### 核心

- self / cognition / affect / memory / agency / growth 六核心领域规则和纯函数主体循环。
- 统一经历与证据来源链、认识论标记、情感评价与衰减、相关记忆召回、proposed意图与有验证要求的成长候选。
- 候选严格校验；不支持任意patch、权限变更或模型自评即成长。待核验记忆纠正不会提前撤回原可用依据。

### 运行与数据

- 单SQLite主体库统一保存快照、初始状态、typed事件、经历/记忆、成功问答与固定次数台账。
- T1预占调用 → 事务外模型IO → T2版本/最新attempt复查与原子提交；失败不退款、不自动重试。
- 完整事件回放与快照核对；同连接仅在bootstrap/逐条历史事件完全不变时复用私有前缀检查点。
- 显式主体初始化/唤醒/休眠/预算、前台服务、loopback token鉴权与有界请求。
- 模型timeoutMs可选、默认8秒最高30秒；say服务累计35秒、客户端40秒，保留用户取消与关闭传播。

### 使用与验证

- 采用MIT许可证，作者swordfate3：允许商用/修改/分发，分发副本或实质性部分须保留版权和许可声明；根与两个workspace标注MIT，Docker镜像携带LICENSE。GitHub公开可见性是独立设置，不由许可证自动改变。

- 新增Dockerfile/Compose与容器管理入口：镜像包含Node/Pi及薄扩展；三个命名卷持久化、非root运行、仅loopback、不挂宿主密钥或发布端口。新增Linux/WSL `bash start.sh`统一首次构建/配置/启动/进入Pi，容器setup合并显式身份预算确认、模型字段与隐藏凭据；已有数据不重复初始化、配置不覆盖、不自动wake/生成/学习。README改为最短路径，源码手动教程单独保留；当前环境无Docker，实际镜像构建/Compose/Pi镜像内复验未完成。

- 新增Pi薄接口 `/dawn model` 和 `/dawn thinking` 选择器、直接参数选择、`models`显式远程目录与`model-status`安全状态；独立request客户端同样可用。服务FIFO/选择CAS，不改Pi模型或主体，不重置实例/永久额度，选择只存服务进程。目录有界且拒重定向/脱敏错误；新增off仅省略reasoning_effort，不承诺禁用思考或所有模型档位兼容。

- 新增离线交互模型配置向导 `model-config --output`，参考Pi的连接/模型/凭据/推理配置体验，生成现有单模型配置；排他0600新建、不发现Pi凭据、不保存key或自动调用。交流/学习用途仅推荐实例次数，不改变主体预算。配置读写复用离线校验，模型ID限制为最多256字符且无控制字符；旧配置可继续省略timeoutMs。

- 增加独立的两目标四次loopback假模型学习验收入口 `verify:learning:offline`，覆盖真实适配器、阶段投影、持久进度/冷重开与清理；不自动接入真实供应商。
- 增加可复现检查与真实学习验收方案，以及四次实例上限的学习模型占位模板；干净安装、最低Node及真实学习质量仍待授权验证。

- 不需要Pi的独立request命令行客户端；Pi薄窗口复用同一客户端实现。
- --version和无副作用能力报告；应用/workspace版本0.1.0，与协议/数据库/domain版本分离。
- 一键合成离线端到端验收与自动化回归；README以六核心新模式为主要操作路径。
- 显式v3学习新库：同主体、总额度与学习子预算；自主目标选择、study/assessment、本地exact评分、记忆入库与重启接续。私有答案键不进模型，学习不冒充聊天。
- 停止持久撤权、取消拒迟到、pending显式恢复失败且不重发；整轮容量预检。本轮24项原学习专项、234项全量及独立离线学习验收通过；新增3项回归覆盖成功/失败/取消清理，非真实模型学习效果证明。
- 真实API已验证一次严格JSON交流、持久提交和冷重启上下文恢复；未把空候选样本当作情感/成长有效性证明。

### 已知限制

自主学习为首版必需项，已实现一次授权后的本地资料学习/测验/进度闭环；不包含权重训练或无限开放学习。无任意工具执行、后台自动调度、自动压缩/遗忘、旧库迁移或多人权限。快照2MiB/常规集合1000项有界；数据未加密，无内置删除。没有恰好一次交付、独占运行租约或Pi真实宿主部署验证。详见[0.1.0版本范围](docs/release-0.1.0.md)。
