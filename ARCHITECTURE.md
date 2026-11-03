# 架构与能力边界

本分支`feat/mcp`从main `b446014`创建，不继承`feat/dsh-plugin`。删除旧Pi聊天薄层，不绑定Pi/DSH宿主；后续按用户要求提供可选Pi资源包，不改变MCP主线。部署使用只见根[README](README.md)。

## 模块与依赖方向

```text
可选 packages/pi-package：Pi扩展注册MCP连接＋分发skills（不接管主体）
  ↓ Pi原生MCP注册，显式UI确认，无自动启动
MCP客户端（Pi等）
  ↓ HTTPS Streamable HTTP /mcp（远程）或 stdio JSON-RPC（本地兼容）
packages/mcp：独立接入鉴权、握手、工具白名单、参数校验、取消、有界会话
  ↓ DawnTransport
packages/dawn/adapters/transport/http-client.ts
  ↓ 鉴权本机HTTP /v1/request（不是HTTP MCP）
runtime/subject-service.ts：FIFO交流、T1预占、T2提交
  ↓
core六核心纯规则 ＋ adapters/storage/sqlite-subject.ts持久化
```

MCP只提供另一种入口，不持有另一份人格或模型。主体状态、模型配置/调用计数、SQLite与预算仍属于独立Dawn服务。core不依赖MCP、Pi、外部I/O；runtime不反向依赖接入包。

## 六核心与事务

self/cognition/affect/memory/agency/growth是同一主体。`runSubjectCycle`确定性校验与转换；世界认识、记忆修正和成长只是受限模型候选，不可任意patch或改变身份/权限。交流最小投影不包含完整状态/所有记忆。

新模式`serve --subject-db`使用统一DSW2库；成功一轮交流两cycles、revision+2。T1先预占收费→事务外模型IO→T2重新校验CAS/纯cycle/原子提交，失败不退款、不重试。legacy库保留兼容，不自动迁移或重建。

## 有界自主学习

0.1.0必需范围保留：学习v3显式授权本地pack与子预算，同主体、同总预算。runner前台选题→教材/练习与笔记→独立assessment→本地评分→记忆/结果→继续或停止。私有评分键不入模型/公共记忆；合法教材中的知识不等于泄漏。completed不等于全通过或通用掌握。stop持久撤权、迟到拒交；pending不自动重发，recover前停所有同库进程。

## 私有有界研究（v5，合成验证未部署）

`core/research.ts`只排序已批准的公开问题/query；`sqlite-research.ts`同库任务、收据、模型attempt、控制事件重放，由`SqliteSubjectStore`唯一事务拥有者提交。显式新v5保留pack/来源，旧库不升级。T1 claim预占搜索→Pi固定Tavily适配一次IO→receipt；T1 model预占→`ResearchRunner`一次有界phase→T2来源/笔记/程序评分/状态原子提交。不占host FIFO等待模型，pendingModel表示真实在途；chat/pack/research共享总额和单pending。

owner UI→Pi私有JSONL→同socket owner/executor认证→研究用例。普通MCP仍八工具；Pi主模型既不持owner token也不代答。search仅公开manifest，host_summary为inference；同页摘录共同根，heldout答案不进模型。无独立测验只能待验证，不批growth。stop/sleep/断开/重启持久fence，未知外呼不重派，owner可查/停，resume只明确恢复安全阶段。不支持自由新query、web.fetch、全历史监听或永久后台循环。

## MCP第一阶段

- `packages/mcp/src/server.ts`实现受限stdio协议和请求生命周期；`tools.ts`把精确工具参数映射到既有DawnRequest；`config.ts/main.ts`验证显式连接与私有token后运行。
- 默认只有状态/缓存模型查询；`--allow-write`显式暴露交流、生命周期、目录发现与模型选择。工具注解不是安全授权，启用写权限的客户端还需自己的确认策略。
- 新增HTTP MCP（D-026）：受信TLS反代→单 `/mcp` 网关→内部DawnTransport，POST单JSON、GET405、不提供SSE／重放。独立远程Bearer、准确Host／Origin、随机session及容量／超时边界；没有resources/prompts/sampling或私有owner接口。显式取消与HTTP断线不同，断线不保证撤回上游或已提交事务。
- `say`仍按owner消息处理，不提供来源分离；不得用作自动导入Pi对话的接口。来源导入另走私有桥，接入不会自动共享历史或调用客户端搜索。

## 可选Pi资源包

`packages/pi-package`为宿主侧独立分发资源，无Dawn/MCP运行代码依赖；根manifest也声明同一扩展与skills，支持整个Git源作为Pi包。扩展注册`/shuguang-mcp connect|disconnect|status`与用户专用`/shuguang-share`；前者通过`registerMcpServer`管理当前会话`shuguang`，后者只在UI预览批准后分享当前分支有限text块。不恢复旧`/dawn`、不直接转发聊天、不注册LLM工具或自动截取会话。

显式配置二选一：HTTPS URL＋credentialEnv＋allowWrite，或本地仓库路径＋可选Docker context/Compose项目名＋allowWrite，不混用。扩展factory不做IO或连接（Pi安装本身仍由包管理器写资源/设置），connect在有UI且确认后注册远程URL／环境凭据引用或固定Docker exec argv，不拉服务/安装/写mcp.json。远程普通MCP不暴露owner桥，share/research远程模式明确拒绝，不读取历史或回退Docker。无UI失败关闭；并发/断开/关机会使迟到确认失效。注册不等于已连接，文件同名优先，替代MCP适配器需实际支持动态注册。Docker权限本身强大，路径/env/上下文不是沙箱；只连接可信项目。skill仅约束宿主操作，不自动教给曙光或授予联网学习。

## 容器边界

Docker仅打包Node、dawn、mcp和显式管理脚本，无Pi安装/薄扩展。默认compose仍只运行原Dawn，不发布端口。显式 `compose.mcp.yaml` overlay新增只读网关sidecar，共享dawn网络命名空间及只读data卷，只发布服务端宿主127.0.0.1:7342给可信TLS反代；不挂Docker socket／Pi home，网关不打开DB或装模型key。整个卷对网关可读是已知可信部署边界，不冒称文件级秘密隔离。

HTTPS客户端不需要Docker／仓库路径，只有URL和远程接入凭据；断开／删除session不stop/sleep/delete主体。原stdio仅本地兼容，本机直接模式桥接和Dawn须同loopback。访问Docker引擎本身属于强权限，不应用于解决远程客户端普通对话。

## 最小来源导入：已实现，未部署

用户专用`/shuguang-share`经独立Docker exec私有JSONL桥，容器内部以独立owner token配对、生成10分钟socket绑定executor；秘密不进Pi响应或普通MCP工具。准确批次授权最多5分钟；服务分离owner的authorize/revoke与executor的accept/consume/status，普通service token不升级。没有自动重连或重发。

显式`host-learning-init`新建DSW2 v4；v2/v3打开规则不变、host方法拒绝。v4保留原pack和共享预算，新增host_grants/import_batches/source_records/host_events。来源定位含主体/scope/session/entry/block/revision1，内容hash冲突拒绝；user→user_statement、assistant→inference。accept存来源，consume在唯一SQLite事务中运行确定性cycles并提交snapshot/typed event/消费标记；不入DialoguePair、不调用模型、不批成长。pending模型未结算时拒绝消费；sleep同事务撤销全部host grants，wake不复活。

冷开验证精确SQL表约束、来源/授权/控制审计、领域事件与快照；不是管理员抗篡改证明。台账上限1000 grants/batches/sources、4MiB来源正文、4000 host events；现有2MiB快照/1000 core集合不变，超限整批拒绝。binding只在内存，重启失效；跨重连恢复UI未实现。默认setup仍v3，未提供正式旧库迁移。

## 下一阶段：检索学习

这是用户确认的产品方向，网络部分尚未实现。已形成[宿主能力接口v0设计](docs/host-capabilities.md)：先以web.search/web.fetch窄能力及持久任务邮箱连接Pi可信执行桥，不透传任意工具；grant来自可信控制面，领取预占/CAS与执行绑定、结果接纳/消费分阶段、持久fence及崩溃不自动重派分别约束。设计文档不意味着新接口已注册或自动联网已启用。需要显式会话范围/授权、来源区别、任务账本、独立预算/停止、工具执行方和检索证据返回机制；不能单靠MCP工具列表或提示词实现。优先公开检索/有界网页只读，不自动开放Shell、登录态浏览器、发消息或所有MCP；Pi离线时任务等待而非假成功。

旧[HTML架构导览](docs/architecture.html)保留六核心/存储说明，已标注Pi交互图过时，尚未重新做全图排版认证。应用0.1.0、普通/私有协议各v1、领域schema2、SQLite v1/v2/v3/v4、MCP协商版本各自独立，不自动升级。
