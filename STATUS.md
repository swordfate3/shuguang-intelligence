# 当前开发状态

当前分支`feat/mcp`，从main `b446014`创建；`feat/dsh-plugin`保留不混入。MCP、Pi包、来源和研究均为本地未提交工作树，未commit/push或部署。用户已另授权把本地Pi资源包注册进当前容器的个人Pi配置；这不等于Dawn／网关已部署。证据见[verification](docs/verification.md)，教程只维护根README。

## 最新：HTTPS远程MCP接入（D-026）

- 用户明确纠正远程客户端不应依赖Docker／宿主目录并授权优化。新增 `packages/mcp/src/http-{server,config,main}.ts`，标准Streamable HTTP `/mcp` JSON-only，GET405、独立接入Bearer／随机session／准确Host-Origin／并发与超时限额。复用现有八工具及DawnTransport，不开DB、不初始化／唤醒主体、不开放owner私有桥。原stdio保留兼容。
- Pi配置支持 `{version:1,url,credentialEnv,allowWrite}`，仅HTTPS／环境引用；远程确认不读凭据、无Docker要求，客户端工具暴露不能升级服务端权限。远程share/research在读历史／计划／创建私有child前失败关闭，未远程化能力不伪称可用。
- 新 `compose.mcp.yaml` 为显式opt-in，sidecar共享Dawn网络／只读原卷，宿主loopback发布7342给可信TLS反代；不把内部Dawn／owner接口公开，不挂Docker socket。新增独立MCP token排他创建入口，不重建DB。整个私有卷可读／同Compose网络可信是部署边界；首应用overlay可能重建Dawn容器，需维护窗口。
- 真实loopback完整对话已验证：网关→Dawn HTTP→临时六核心SQLite／假模型，显式wake／say、budget1、revision3、断开后仍awake／冷开一致。借已有MCP SDK 1.32.1完成initialize/list/ping/DELETE，另经过实际本地HTTPS反代、临时证书显式CA校验验证，未关闭TLS验证、无公网访问／模型调用。
- 主最终全量 **512/512**、MCP **52/52**、Pi **124/124**、容器入口组合 **8/8**；原交流／pack验收与离线学习通过。独立静态审查两项P2（Caddy路由遮蔽、header截断漏Origin）修复／补回归／复核关闭，非生产认证。详情见verification最新节。开源收尾已提交锁文件并 `npm ci` 干净安装，标准 `npm run check` 与全量 `npm test` 均真实通过（本机 Node 24，非 CI 实跑）；新增 CI／贡献指南／安全策略／CODEOWNERS／PR与issue模板，`feat/mcp` 已推送 origin。**尚未开 PR／合 main／配置仓库设置或邀请协作者**；尚未正式部署域名／证书／Docker overlay，用户现有运行容器不会自动变成HTTPS服务。不修改正式库／真实key。

## 前轮：关键后半段的有界公开研究

用户明确要求“把关键后半段进行实现”。已落盘：**主体排序获准公开问题 → 宿主claim一次搜索 → 收据接受 → 曙光自己的模型学习/练习 → 隔离held-out测验或待验证 → 同主体原子保存 → 有界继续/停止**。

- 新`core/research.ts`、`runtime/research-store.ts/research-runner.ts`、`adapters/storage/sqlite-research.ts`；显式`research-learning-init`新DSW2 v5，保留pack与v4来源。默认Docker setup/learning-init仍v3，旧v2/v3/v4不升级，不重建正式主体。
- owner准确批准1..8问题/query、最多8搜索/32模型阶段/截止；私有状态只用于排序，不从记忆自由拼新query。模型不能改manifest/权限/费用/评分。开放问题无私有assessment最多verification_pending，completed不等于全通过或通用掌握。
- 同库run/task/receipt/model attempt/audit、claim CAS先预占、重复收据hash幂等、receipt不隐式生成。chat/pack/research模型共享永久预算和单pending；失败、取消、未知不退。来源/笔记/本地评分/typed事件/snapshot同事务，冷回放核对；不入chat history、不批growth。同网页canonical去fragment共根，变化摘录依赖旧根。
- 私有host v1新增研究请求，普通MCP仍八工具。owner start/status/stop/resume与executor next/claim/submit/step/pause分离，秘密容器内；后台仅一次35秒phase，不占host FIFO等待模型，pendingModel明示在途。
- Pi新增用户命令`/shuguang-research`，有UI/已注册/idle/显式安全plan/provider可用/准确公开输入预览确认后运行；不读取Pi历史、不借Pi主模型、不暴露任意工具。固定Tavily适配已写，全部测试假DNS/HTTP响应，不真实联网。
- 固定provider HTTPS主机、DNS全部公网检查与pin、SNI/TLS验证、无Cookie/代理/redirect/retry/fetch；8秒/128KiB响应/3项/32KiB规范材料。供应商content诚实标host_summary/inference，不冒充网页原文。合法字段反射key也拒绝，含JSON转义凭据回归覆盖。
- 断线/绑定到期主动abort并持久pause/fence，sleep/stop拒迟到，不stop/delete主体。崩溃须先停止全部同库旧服务/runner，再显式research-recover；普通serve和read-only open不隐式接管，重复启动不破坏活跃研究。unknown搜索/模型收费终止不重派，resume仅未派发或accepted未生成阶段。
- 64runs、最多8tasks/24材料每run、8192研究审计事件/16MiB，普通操作留fence/fail/terminal控制余量；2MiB快照/1000core集合保持，超限拒绝不遗忘。

## 验证与审查

主最终全量 **484/484**、Pi **118/118**、研究存储 **20/20**、研究集成 **10/10**通过，计数与日志见docs/verification；测试均临时目录/假模型/loopback，未读正式库、key或历史。主已跑真实Pi executor→stdio child→HTTP→临时v5两目标/四phase闭环、原pack验收及严格借用类型检查；真实Pi ResourceLoader根/子包3命令/1skill/无UI不读历史，子包dry-run精确9文件。

- 存储审查确认审计边界fail+terminal回滚与fragment假独立根两项P2；修复并补合法7999事件边界/共享slot释放/冷开、canonical URL/共同根回归。
- 运行/请求适配审查确认绑定过期不主动fence、普通serve隐式接管活跃研究、JSON转义key反射三项P2；已加主动期限取消、显式recover替代自动接管、解析字符串扫描和对应合成回归。审查是静态有限快照，不是生产认证。
- 既有交流、本地pack、来源分享、MCP与卸载不动Docker语义保留；前轮397/61/17/10及Pi ResourceLoader冒烟为历史基线，不能替代本轮复验。
- 标准npm run check因本地未安装tsc仍有限制；可借现有TS5.9.3/Pi声明严格检查，不代表干净安装或最低Node矩阵。

## 未实现／未验证

- **完整产品目标尚未全部实现：**自由提出新query并重新授权、私有会话自动生成研究问题、web.fetch、连续历史监听、无人值守常驻研究未提供。当前是在准确获准公开问题池中自主选择和推进，不是假称开放自主意识。
- 未真实调用Tavily/模型验证API兼容、搜索收费、搜索质量、独立测验效果或长期成长；供应商内部访问/费用不能由宿主HTTP次数证明。
- 无正式迁移、跨进程租约、跨binding来源批次恢复UI、多用户ACL、加密/安全删除、无限容量、网络恰好一次保证。同UID/Docker管理员可信边界保留。
- 环境无Docker CLI/socket，未构建镜像/Compose/真实exec/用户Pi TUI联调，不盲挂socket或安装空白Pi。
- 本地Pi包已按用户授权注册；未部署Dawn／HTTP网关、未正式库迁移或提交推送。普通远程聊天不要求v5迁移；来源／研究真实启用仍需另确认provider/key注入、费用和v5正式迁移方案，不能重建唯一主体绕过。
