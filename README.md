# 曙光智慧（Shuguang Intelligence）

独立数字伙伴原型：同一主体的六核心、交流、持久记忆和有界自主学习。本分支 `feat/mcp` 移除旧 Pi 聊天薄层，以 MCP 接入现有 AI 客户端；另提供可选 Pi 资源包统一管理 MCP 连接和 skills，曙光不依赖某个客户端存活。

**许可证：[MIT](LICENSE)** · 作者 **swordfate3**。允许商用、修改和分发，分发副本或实质性部分须保留版权及完整许可文本；不强制界面署名。第三方依赖遵循各自许可证。

## 1. 启动独立服务（WSL / Linux）

需要 Git、可用的 Docker 引擎和 Compose v2；镜像提供 Node，不安装 Pi 或其他交互客户端。使用 Docker Desktop 时先开启对应 WSL 集成。

```bash
docker info >/dev/null
docker compose version
```

首次取得项目后进入目录。MCP 开发尚未合入 `main`；**当前开发工作树未提交/推送，远程分支不一定包含下列接口**。应取得包含 `packages/mcp` 的版本，不要将旧 HTTP 接口当作 MCP 地址。

```bash
cd /你的绝对路径/shuguang-intelligence
bash start.sh
```

首次需要联网构建镜像，然后统一设置：

| 项目 | 含义 |
|---|---|
| 主体名称 | 默认“曙光” |
| 共享调用上限 | 默认20，聊天与学习合计永久次数；非金额，重启不补回 |
| API地址 | OpenAI Chat Completions 兼容根地址，通常以 `/v1` 结尾 |
| 模型ID | 供应商支持的准确ID，不会猜测或自动查询 |
| 思考档位 | 默认 `off`，仅省略参数，不保证上游关闭思考 |
| 最终确认 | 预览后输入 `yes` 才创建缺项 |
| API key | 隐藏输入，不放聊天或命令参数 |

默认附带两目标示例学习包，学习子额度4计入总额度；模型服务进程内上限4、超时30秒，与永久额度分别约束。失败、超时或取消预占后也可能扣次。设置不调用模型、不自动唤醒或学习。

启动就绪后返回终端，服务独立运行。已有完整配置仅预检，不覆盖；部分初始化错误保留证据，不删库重试。

## 2. 连接你现有的 Pi 或其他客户端

**跨机器／跨容器使用 HTTPS Streamable HTTP MCP**：客户端只需 URL 与独立接入凭据，不需要 Docker、仓库路径或数据卷。原有本地 stdio 作为兼容入口保留。内部 `/v1/request` 不是 MCP，不应直接公开。

### HTTPS 服务端：在曙光所在服务器显式启用一次

已有主体、模型和数据卷保持不变，不重新初始化数据库。新增网关只转发到原 Dawn 服务；普通 MCP 不开放来源导入／研究 owner 私有接口。以下是部署步骤说明，**源码实现不表示已替你部署或配置域名**。

1. 用已有 Compose 项目创建**独立远程接入 token**（不打印、不覆盖已有文件，不使用模型 key／service token／owner token）。必须沿用启动曙光时的 Docker context 和 Compose 项目名；如果使用过 `--context`／`--project-name`，以下命令也带相同参数。

   ```bash
   cd /你的绝对路径/shuguang-intelligence
   # 现有镜像必须先包含本轮 HTTP 网关代码；构建不会自动替换运行中的主体。
   docker compose build dawn
   docker compose run --rm --no-deps dawn mcp-token-init
   ```

   token 位于原私有数据卷 `/data/mcp-access.token`，仅经你自己的安全凭据渠道交付给可信客户端；不要贴到聊天、URL、源码或日志。服务端必须妥善保护数据卷：网关读取其中的 service token，因而宿主／卷管理员属于可信边界。服务端启动时拒绝远程 token 与 service token 相同。

2. 创建一个私有的 Compose 环境文件，例如 `/你的私有目录/shuguang-mcp.env`，**这里没有秘密**：

   ```dotenv
   SHUGUANG_MCP_PUBLIC_URL=https://dawn.example.com/mcp
   SHUGUANG_MCP_PORT=7342
   SHUGUANG_MCP_ALLOW_WRITE=true
   ```

   `true` 允许聊天、唤醒／休眠和模型控制；默认 `false` 只允许查状态。它不是细粒度、多用户 ACL；持有该凭据的客户端代表同一个 owner，不公开分享 token。

   ```bash
   docker compose --env-file /你的私有目录/shuguang-mcp.env \
     -f compose.yaml -f compose.mcp.yaml up -d --build mcp-http
   ```

   这是**显式部署操作**：overlay 为现有 dawn 增加宿主 `127.0.0.1:7342` 映射，首次应用可能重建 dawn 容器并短暂中断服务，先停止同库活动任务／安排维护窗口。卷不删除，网关不打开主体库、不另起 Dawn。不要用 `down -v`。

3. 在**服务端宿主**现有受信任 TLS 反代中只代理 `/mcp`。例如 Caddy（域名／证书／443 可达需自行配置；不是本轮自动安装项）：

   ```caddyfile
   dawn.example.com {
       @mcp path /mcp
       handle @mcp {
           reverse_proxy 127.0.0.1:7342 {
               header_up Host dawn.example.com
           }
       }
       handle {
           respond 404
       }
   }
   ```

   反代到网关的链路必须私有可信；示例仅发布宿主 loopback，不把明文 7342 开放公网。同一 Compose 网络上的容器仍可能访问网关，该网络中的服务也必须可信／由网络策略限制，不把端口映射当作容器间防火墙。外部地址必须 HTTPS，Host 必须与 `SHUGUANG_MCP_PUBLIC_URL` 精确匹配（非默认端口需含端口），Origin 若存在只能等于该 URL 的 origin；不信任 X-Forwarded-*，不提供跨域浏览器 CORS。不要把 `/v1/request` 或 `/host/v1/request` 代理出去。网关不内置证书管理／OAuth／多用户账户。

协议为 tools-only Streamable HTTP，POST 返回单 JSON，GET 返回 405（不提供 SSE／事件重放）；session 有界、需持续 Bearer 鉴权，DELETE 只结束接入，不休眠或停止主体。无自动重试；HTTP 断线本身不是取消，也不能证明已提交操作回滚。取消用 MCP notification，未知写结果先查 status，不能自动重发。关闭网关只执行带相同 overlay／env 的 `docker compose ... stop mcp-http`，不等于关闭曙光。

### Pi：用一个安装包管理 MCP 和 skills（推荐）

包提供 `/shuguang-mcp` 连接管理、实验性 `/shuguang-share` 片段分享和 `shuguang` skill，不恢复旧 `/dawn` 聊天代理。**先完成上面的服务启动，再在原来运行 Pi 的环境安装本地资源包**，不用重新安装 Pi：

```bash
pi install /你的绝对路径/shuguang-intelligence/packages/pi-package
```

上述为通用安装说明；本次会话已按用户授权把该本地子包注册到当前容器个人Pi配置，其他环境仍需各自安装。当前未发布 npm 包，远程Git尚无本轮提交；不要安装不存在的版本。源码根也声明了相同Pi资源，选择根目录或子包其一，不要重复安装。现有会话执行 `/reload`，检查 `shuguang` skill 和命令是否出现；资源由 Pi 的包配置管理，其他 skills/服务不被覆盖。随后可通过 `/skill:shuguang` 显式加载操作规则；**它是给宿主的skill，不是把知识自动写入曙光**。

**远程连接**：在 Pi 所在环境手动创建 `/你的私有目录/shuguang-pi.json`，不放实际 token：

```json
{
  "version": 1,
  "url": "https://dawn.example.com/mcp",
  "credentialEnv": "SHUGUANG_MCP_TOKEN",
  "allowWrite": true
}
```

由 Pi 启动器／已有秘密注入机制提供 `SHUGUANG_MCP_TOKEN` 环境变量，值为服务端专用 MCP token；不要使用曙光模型 key，不放在命令行、URL 或聊天。包只登记环境变量引用，确认预览不读／展示 token。Pi 启动后才改变父 shell 环境不会传入现有进程，需要从正确注入的启动器重开 Pi。

客户端 `allowWrite` 是本会话工具暴露限制，不能升级服务器权限；服务器也必须显式启用写工具才能聊天。远程连接目前只支持普通 MCP 交流／状态／控制，`/shuguang-share` 与 `/shuguang-research` 的私有 owner 桥**尚未远程化**，在远程模式明确拒绝，不回退本地 Docker 或共享秘密。

**仅限本地兼容模式**：Pi 本来就能调用同一个 Docker 引擎时，可改用下列配置（与 URL 配置二选一，不能混用字段）：

```json
{
  "version": 1,
  "projectDirectory": "/你的绝对路径/shuguang-intelligence",
  "allowWrite": false
}
```

两种模式的配置路径都必须是绝对路径、普通文件，Linux 下由当前用户拥有且不能组/其他用户可写，建议 `chmod 600`；内容上限8KiB。**只有本地模式**使用 `projectDirectory`、可选 `dockerContext`／`composeProject`，必须与原引擎／项目一致；HTTPS 模式完全不需要这些信息。

在 **Pi 命令输入框** 输入，不是 Bash 命令：

```text
/shuguang-mcp connect /你的私有目录/shuguang-pi.json
/shuguang-mcp status
/mcp
```

`connect` 后的余串整体作为路径（支持空格，无Shell引号语义）；也可由启动器设置 `SHUGUANG_PI_CONFIG` 后省略路径。每次新会话/重载需再次显式连接，不自动保存或重连。只有交互UI确认后才注册；无UI模式拒绝。`status`只报告本包是否注册和读写范围，**不是服务健康结果**；以 `/mcp` 和真实状态工具核对。

- 默认只读。明确需要交流/控制时把 `allowWrite` 改为 `true`，先 `disconnect` 再 `connect` 并确认范围。这开放全部六个写/联网工具，不是逐次批准；客户端仍应配置工具确认策略。
- `/shuguang-mcp disconnect` 只移除本包本会话的注册，不停服务或sleep。文件 `mcp.json` 中同名条目优先，可能在断开本包后仍有效；不要并列维护两套 `shuguang` 配置。
- 已用 Pi **1.4.0** 的原生扩展/MCP注册接口核对；较旧Pi需支持 `registerMcpServer`/`unregisterMcpServer`。替代内置 `/mcp` 的适配器必须消费扩展注册及动态变更事件，否则不会连接；历史核对 `pi-mcp-adapter 6.0.0`，本轮现有安装为 `7.0.0`，已核对其配置转换／工具过滤；仍未完成用户环境动态联调。本包不偷偷写适配器配置。
- HTTPS 模式仅要求客户端能访问 URL 并获得独立接入凭据，**不需要 Docker、socket 或宿主项目目录**。只有本地 stdio 兼容模式才需要 Docker 访问；不应为聊天给 Pi 盲挂宿主 socket。
- 连接预览只确认本次注册，不代表服务健康或模型 API 可用。只连接可信 HTTPS 服务；本地模式的 Docker 权限属于强权限，不是只读沙箱。

### 断开或卸载：只移除接入，不删除曙光

- **临时断开**：在 Pi 输入 `/shuguang-mcp disconnect`，仅注销本包当前会话的 MCP 连接。
- **卸载 Pi 资源包**：在运行 Pi 的环境执行下面命令，使用当初安装的同一来源；若安装时用了 `--local`，卸载也加 `--local`。

```bash
pi remove /你的绝对路径/shuguang-intelligence/packages/pi-package
```

卸载后在已有 Pi 会话执行 `/reload`（或退出后重新打开），让旧扩展和连接退出。包附带的命令与 skills 随包移除；手动配置的同名 MCP 条目不由本包删除，需另外处理。

**上述操作都不会停止、休眠或删除曙光本体，不会删除 Docker 容器、镜像、数据卷、主体记忆或预算记录。** 被关闭的只是 MCP 桥接进程，不是独立服务。连接配置文件也不由本包清理；之后重新安装、连接即可继续访问原主体。停止曙光是独立操作，须显式执行第4节的 `bash start.sh stop`，它同样不删除数据卷。本包不提供 Docker 卸载或数据清除功能。

### 其他客户端／手动配置（与Pi资源包二选一）

将下面 HTTPS 条目**合并**到客户端 MCP 配置，不覆盖现有服务。认证字段的环境变量引用写法取决于客户端，下面为 Pi 格式；其他客户端使用其秘密存储机制，不把 token 写进 URL。

```json
{
  "mcpServers": {
    "shuguang": {
      "url": "https://dawn.example.com/mcp",
      "headers": { "Authorization": "Bearer ${SHUGUANG_MCP_TOKEN}" },
      "timeout": 45
    }
  }
}
```

普通对话可以直接使用任意兼容 MCP 客户端，**不必安装 Pi 资源包**。手动条目没有本包 `allowWrite` 字段，写范围由服务器与客户端自己的工具权限共同限制。

下面是仅限本地 Docker 的旧 stdio 配置；与 HTTPS 配置二选一。替换绝对路径，并使用原 Docker context/Compose 项目名。

```json
{
  "mcpServers": {
    "shuguang": {
      "command": "docker",
      "args": [
        "compose", "--project-directory", "/你的绝对路径/shuguang-intelligence",
        "-f", "/你的绝对路径/shuguang-intelligence/compose.yaml",
        "exec", "-T", "dawn", "dawn-container", "mcp"
      ]
    }
  }
}
```

- **默认只读**：只提供 `shuguang_status` 和 `shuguang_model_status`，不生成或改状态。
- 要允许聊天、唤醒/休眠及模型控制，明确在 `args` 最后加 `"--allow-write"`。这会向该客户端开放全部列出的写工具，不是仅聊天授权；客户端应再配置工具确认策略。启动参数是本地暴露限制，不是独立服务的细粒度ACL。
- 不加 `-t`，不让 Shell 输出欢迎语；stdout 专供 MCP 消息。
- 客户端必须能执行 Docker 命令并连接**同一 Docker 引擎和原 Compose 项目**。Pi 在另一个容器里但没有 Docker CLI/socket 时，此配置不能直接运行；不要为此盲目共享宿主 socket或凭据。
- 开启 Docker 访问的客户端本身就拥有强本机权限；MCP只读开关不能约束它绕开此入口直接运行其他Docker命令。仅用于可信客户端。

使用 Pi 内置 MCP 时，用户级配置为 `~/.pi/agent/mcp.json`，项目级为 `<工作目录>/.pi/mcp.json`（须信任项目）；`~` 属于 Pi 运行环境。若用替代内置 MCP 的适配器扩展，应使用它的配置，不混用。重新加载后检查 MCP 工具列表；连接成功不代表模型 API 已验证。

### 不经 Docker 的本地桥接

已有 Node >=24、独立服务和私有 token 时，客户端可配置 `command: "node"`，参数为以下命令中 `node` 后的各项（绝对路径）：

```bash
node /绝对路径/shuguang-intelligence/packages/mcp/src/main.ts \
  --endpoint http://127.0.0.1:7341 \
  --token-file /绝对私有路径/service.token
```

需要写工具才追加 `--allow-write`。桥接不启动服务、不打开数据库、不发现凭据；只允许显式本机 endpoint。不要用 `npm run` 包裹stdio进程，npm提示可能污染协议输出。此入口不是 HTTP MCP `/mcp` 服务。

## 3. 通过 MCP 交流

先让客户端调用 `shuguang_status`。初始主体为 `sleeping`；写权限已启用且你明确要求唤醒时，调用 `shuguang_wake`，传刚查询的 `expectedRevision`。已醒则不重复唤醒。

再由客户端调用 `shuguang_say`，参数为你明确选择发送的 `message`。它消耗曙光自己的模型与永久额度，回答进入客户端上下文，也可能发送给客户端模型供应商。成功一轮主体版本增加2；失败不自动重试。

| 工具 | 行为 |
|---|---|
| `shuguang_status` | 生命周期、主体版本与运行实例；不含完整记忆 |
| `shuguang_model_status` | 缓存模型、thinking、选择版本和进程调用计数 |
| `shuguang_say` | 发送明确文字并保存成功问答，需要主体awake |
| `shuguang_wake` / `shuguang_sleep` | 以主体 `expectedRevision` CAS 修改生命周期 |
| `shuguang_model_list` | 显式联网读取供应商模型目录，不生成 |
| `shuguang_model_select` | 以选择 `expectedRevision` 选择缓存内 `model` |
| `shuguang_thinking_select` | 以选择 `expectedRevision` 改 `thinking`，不改客户端模型 |

**不自动读取你和 Pi 的对话，也不能调用 Pi 的搜索工具。** 来源导入只通过下节独立的用户命令；`say` 仍按现有 owner 对话语义入账，不能拿它冒充代理来源、网页原文或批量对话学习接口。模型输出不是可信指令，不因接入MCP放开任意工具或后台循环。

### 实验性：预览后分享当前 Pi 片段

源码已实现最小来源保存链路，**默认首次设置仍创建 v3，不支持此功能**。仅显式新建的 DSW2 v4 库、独立 owner 凭据和已运行的支持版服务可用。旧 v2/v3 不能直接启用，当前没有迁移工具；不要删库、换卷或重新初始化正式主体来“升级”。本轮未部署到实际 Docker/Pi 环境。

已由管理员准备好独立 v4 测试环境后，在已通过本包连接的 Pi 会话手动输入：

```text
/shuguang-share 4
```

默认选择当前活动分支最近4个非空 user/assistant **完整 text 块**，可选1..16；单块最多4000 UTF-16字符，整个批次24KiB，超限拒绝而非截断。不包含 thinking、tool/system、压缩摘要和附件。确认框展示主体/scope及准确文字；取消、分支变化或断开不继续派发。user 保存为 `user_statement`、assistant 保存为 `inference`，不证明文本真实或物理用户身份。

确认只批准这一批内容，5分钟内有效；不等于允许搜索、连续监听、模型调用或新增费用。接收与消费分开，整批本地消费原子保存经历/记忆；重叠来源不重复。不会加入聊天 history、调用模型、消耗模型额度或自批成长。**已保存来源不等于理解或学会**；未来正常交流的有界记忆投影可能披露这些内容给曙光自己的模型供应商。

分享走独立私有 JSONL 桥，不是新 MCP 工具。普通 service token / `allowWrite` 不提供导入权限，配对秘密留在容器中。断开、退出和卸载关闭桥但不停止 Docker；已经提交的记忆不能通过取消撤回。若响应丢失，结果可能未知，不自动重试；本轮尚无跨重连的批次恢复 UI。

#### 开发者：仅新建隔离 v4 测试库

下面只说明源码入口，**不是正式库升级或部署指令**。已有 Node >=24 时，在新的、已存在的私有目录显式创建：

```bash
npm start -- host-learning-init --db /全新私有目录/subject.sqlite \
  --id synthetic-dawn --name 测试曙光 --limit 20 --learning-limit 4 \
  --pack /绝对仓库/config/learning-pack.example.json
npm start -- token-init --token-file /全新私有目录/service.token
npm start -- token-init --token-file /全新私有目录/host-owner.token
npm start -- serve --subject-db /全新私有目录/subject.sqlite \
  --token-file /全新私有目录/service.token --port 7341 \
  --host-token-file /全新私有目录/host-owner.token
```

原 `learning-init` 仍建 v3；新命令排他建 v4、不覆盖文件。服务可不加载模型，但导入前需用户另行明确唤醒。私有桥入口为 `node packages/dawn/src/host-bridge-main.ts --endpoint http://127.0.0.1:7341 --owner-token-file /全新私有目录/host-owner.token`，不能经 `npm run` 包装 stdout。它不是供模型直接调用的通用工具。Pi 包当前仍固定走 Docker `compose exec -T dawn dawn-container host-bridge`；本地 Node 服务的手动测试不证明 Pi/Docker 已连通。

容器入口仅在 `/data/host-owner.token` 已显式存在时给 serve 追加 owner 通道；它不创建凭据或升级库，在 v3 上启用会失败。`host-bridge` 不加载 `model.env`，不自动启动/唤醒主体。新测试卷/正式迁移与实际启用须另行确认；不能把上面的新路径替换为唯一正式库。

### 实验性：获准公开问题的有界检索学习

本分支新增源码链路：**主体排序获准问题 → 宿主一次领取搜索 → 材料收据 → 曙光自己的模型学习/练习 → 隔离测验 → 同主体保存 → 继续或停止**。它不是全天后台Agent，也不会从私有记忆自由拼接新query。尚未在用户实际Docker/Pi或真实搜索供应商运行。

仅新建隔离环境可用 `research-learning-init` 建 DSW2 **v5**（参数与上面的 `host-learning-init` 相同）；保留pack和来源分享，仍需独立owner token及显式加载曙光模型。默认Docker setup仍创建v3，v2/v3/v4均不自动升级。**不要重建正式主体来启用研究。** v5测试环境/镜像/卷的实际准备与部署需另行确认。

Pi连接配置可另外声明一个固定搜索适配：

```json
{
  "version": 1,
  "projectDirectory": "/绝对路径/shuguang-intelligence",
  "allowWrite": false,
  "search": { "provider": "tavily", "credentialEnv": "SHUGUANG_TAVILY_API_KEY" }
}
```

key只由Pi宿主的**显式环境引用**读取，不放此JSON/plan/聊天，不发现Pi凭据；按你现有启动器的私有配置注入，不执行本文不存在的自动安装。未配置、key不可用或策略检查失败时拒绝，不切换其他工具。适配固定HTTPS Tavily `/search`，一次HTTP、最多3项、不重定向/重试/自动fetch，不使用浏览器登录态。其content诚实记为`host_summary`推断；不证明网页原文或真实性。未验证实际API兼容和供应商内部计费，只计宿主派发次数。

准备**私有且owner所有**的计划文件，模板见 `config/research-plan.example.json`。模板故意用无效远期截止，必须复制到私有位置、把 `expiresAt` 设置为当前时间之后且不超过10分钟，检查准确公开query、问题、独立评分键与2次搜索/4次模型预算后再授权。示例未执行，不将答案写进Pi模型上下文；测验键仅保存在本地主体未加密库，不发送给学习模型。已有key注入环境必须重开/重连以加载新配置。

```text
/shuguang-research start /绝对路径/私有研究计划.json
/shuguang-research status public-web-basics-1
/shuguang-research resume public-web-basics-1
/shuguang-research stop public-web-basics-1
```

start/resume/stop由UI明确确认；start精确预览公开问题/query、披露和预算，不读取Pi历史，不使用Pi主模型。研究期需保持Pi命令/桥连接；最多8个目标、8次搜索、32次模型阶段，受原永久额度、进程模型额度、10分钟绑定/截止及容量共同限制。若模型上限仍4，两个目标最多4次；不自动补额或退款。

只有预定私有held-out题被程序评分通过才标`passed`，无assessment最多`verification_pending`，不是通用掌握或长期成长。搜索接受本身不调用模型；练习和测验分开，测验只见已保存笔记和题干。stop/sleep/断开阻断迟到提交；崩溃恢复须先停止全部同库旧服务/runner，再显式 `npm start -- research-recover --db /绝对路径/v5.sqlite` 后启动原服务；普通serve不会隐式接管活跃研究。未知外呼和pending模型不重发，resume仅继续尚未派发或已接收尚未生成的阶段。响应丢失先status，不能自动重发start/claim/step。断开/卸载仍不停止或删除Docker及既有记忆。

## 4. 日常管理和学习

均在 WSL/Linux 的原仓库目录执行：

```bash
bash start.sh          # 启动或复用，不自动wake/生成/学习
bash start.sh status
bash start.sh stop     # 不删除卷；先结束客户端在途请求
```

诊断不使用 `say`：

```bash
docker compose exec dawn dawn-container status
docker compose exec dawn dawn-container request model-status
docker compose exec dawn dawn-container budget
docker compose logs --tail 30 dawn
```

`running` 不等于 `awake`；`UNAVAILABLE` 仍可能覆盖休眠、额度、模型超时/格式等多种错误，目前尚未细分。不要反复发送，重启不补永久预算。MCP取消/断线不证明数据库未提交，先查状态，不自动重发。

原有本地学习包闭环保留，不由MCP自动启动。确认最多4次示例阶段调用、资料披露与费用后，显式唤醒主体并**停止全部同库服务和旧runner**：

```bash
bash start.sh stop
docker compose run --rm --no-deps dawn learning-run
```

选题→练习/笔记→独立测验→本地评分→保存→继续/停止。Ctrl+C取消并确认退出；`compose stop`不停止另一个一次性runner。完成不等于全通过或长期掌握。崩溃pending不自动重发，recover前必须停止全部同库进程。结束后 `bash start.sh` 恢复服务，客户端按自身机制重连。

## 5. 更新和数据

保存客户端工作，结束全部在途请求及学习进程，检查本地修改后更新本开发分支；不要在未提交工作树里盲目pull：

```bash
bash start.sh stop
git status --short
# 确认来源分支已发布、有新提交且本地修改已处理后，再 git pull --ff-only
bash start.sh build
bash start.sh
```

- 原 `dawn-data` 卷保留主体、记忆、预算和凭据，不迁移或重新初始化。
- 旧 `pi-home` / `pi-work` 卷不再挂载，也不自动删除；镜像不含 Pi 或其登录/模型配置，可选Pi资源包只在你现有客户端环境安装。
- **不要执行 `docker compose down -v`、删除卷或 volume prune。** 保持原仓库目录、Compose项目名与引擎，避免连到另一组空卷。
- 数据不加密；备份前停全部写入者并关库，不覆盖唯一原库。没有自动迁移、换key、删除或无限容量保证。

**验证范围：**MCP是无新增运行依赖的受限stdio实现，不是完整协议认证；仅公布tools能力，不实现HTTP MCP、资源、模板、sampling或自动检索。合成测试不能代替真实客户端互操作、Docker构建、部署或真实学习效果，最新证据见[验证记录](docs/verification.md)。
