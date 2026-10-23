# 曙光智慧（Shuguang Intelligence）

独立数字伙伴原型，包含同一主体的六核心、交流、持久记忆和有界自主学习。**当前交互入口是 DSH 插件，不使用 Pi。** Docker 只运行曙光服务；你在 DSH 左侧「曙光智慧」面板中与它交互。

```text
DSH 曙光插件 → 本机 Docker Compose exec → 容器内曙光服务 → 曙光自己的模型与记忆库
```

DSH 是交互窗口，不是曙光主体，也不接管其数据库。插件不读取 DSH 对话历史、不借用 DSH 模型/API key，不把曙光消息写进 DSH Agent 会话日志。历史 Pi 扩展源码仅保留兼容，不在当前镜像、启动流程或使用路径中。

**许可证：[MIT](LICENSE)** · 作者：**swordfate3**。允许商用、修改和分发；分发副本或实质性部分时保留版权及完整 MIT 文本，不强制界面署名。第三方依赖遵循各自许可。

## 1. 前提

- Windows 已安装 DSH；本插件对照 **DSH SDK 0.2.1-rc.2 / Cordis 4.0.5**。其他版本须复验。
- Windows 安装 Docker Desktop，手动启动并切换为 **Linux containers**；Docker CLI 和 Compose v2 在 PATH 中。**直接用 Windows PowerShell 5.1 或 7 启动，不需要 WSL 终端/发行版集成，也不需要开启 TCP Docker 端口。** Docker Desktop 自身仍可能使用 WSL2 后端。
- 仓库位于 Windows 本地目录，例如 `E:\gitproject\deepseek_project\shuguang-intelligence`；Windows 有 Node >=24，用于离线构建插件。容器的 Node 由镜像提供，不安装 Pi。
- 如果旧主体在 **WSL 内独立安装的 Docker Engine**（不是 Docker Desktop 的 WSL 集成），其卷不会出现在 Desktop 引擎中。本配置不会连接、复制或迁移它；确认要新建独立主体，不能把另一引擎的空卷当旧主体延续。

目前功能仍待真实 DSH 安装和 Docker 端到端验收，不能把合成测试等同已部署可用。本功能位于 `feat/dsh-plugin`，不是 main。用户已授权将该功能分支提交并推送；获取源码时选择此分支，不要把 main 误当已有本功能。已有仓库先检查本地修改再切换/更新，不覆盖原数据或工作树。

## 2. 启动 Docker 内的曙光服务

在 **Windows PowerShell** 执行：

```powershell
cd E:\gitproject\deepseek_project\shuguang-intelligence
.\start.ps1 help
```

先检查 [Windows Docker 配置](config/docker-windows.json)，默认：

```json
{
  "dockerContext": "desktop-linux",
  "projectName": "shuguang-intelligence"
}
```

`dockerContext` 必须指向本机 Docker Desktop 的 Linux 引擎；脚本会拒绝 TCP/SSH context。`projectName` 决定命名卷前缀，已有 Desktop 主体必须填写原项目名；全新项目才使用默认值。**不同引擎或项目同名不表示共享主体数据。** 仓库路径由脚本位置确定，不依赖当前目录，不另建一套 Compose 文件或数据路径。

确认配置及主体选择后，开始首次设置：

```powershell
.\start.ps1
```

如果本机执行策略阻止可信的仓库脚本，可检查内容后只对本次调用使用 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\start.ps1`，不要全局修改执行策略。脚本不会自动启动/安装 Docker Desktop，也不修改系统 Docker context；若引擎未运行，先打开 Desktop 后再试。

Linux/WSL 原入口 `bash start.sh` 仍兼容保留，但不受这份 Windows JSON 配置控制。使用它必须自行确保同一个 Desktop 引擎、原项目名和卷；Windows 主路径无需执行它。

启动脚本只负责构建缺失镜像、显式首次设置、启动服务与鉴权状态就绪检查。**就绪后返回终端，不打开 Pi，也不进入任何聊天输入框。** 后续交流在 DSH 插件中进行。

首次构建需要联网拉取 Node 基础镜像；新镜像不下载 Pi 或其工具。首次设置向导：

| 设置项 | 填写说明 |
|---|---|
| 主体名称 | 默认“曙光”，可直接 Enter |
| 共享调用上限 | 默认20次，交流和学习共用；是次数，不是金额 |
| API地址 | 曙光模型供应商的 OpenAI Chat Completions 兼容根地址，通常以 `/v1` 结尾，不填完整 `/chat/completions` 路径 |
| 模型ID | 供应商支持的准确ID，不会自动猜测或联网查询 |
| 思考档位 | 默认 `off`，仅省略推理参数，不保证模型关闭思考 |
| 确认 | 核对预览，输入 `yes` 才创建缺失文件 |
| API key | 隐藏输入；不要粘进聊天、源码或命令参数 |

默认附带两目标示例学习资料、学习子额度4次（计入总额度）、模型进程内上限4次和30秒超时。设置不测试 API、不唤醒、不生成或开始学习。中断后只补缺项，不覆盖旧主体/配置；部分初始化或权限错误时先检查，不删库重试。

### 从此前 Pi 镜像切换

先结束全部旧学习进程、保存旧窗口工作，在**同目录、同 Docker 引擎、同 Compose 项目**中执行：

```powershell
.\start.ps1 stop
.\start.ps1 build
.\start.ps1
```

必须重建镜像，才能去掉 Pi 并包含插件所需的 `bridge-request` 命令。`start` 不会替已经运行的旧容器自动升级镜像。旧的 `pi-home` / `pi-work` 卷不再挂载，但**不会被删除**；原 `dawn-data` 继续保存主体与密钥。不需要 `/quit`、Pi 登录或 Pi 模型配置。

## 3. 构建并安装 DSH 插件

Windows PowerShell，在当前仓库根目录：

```powershell
cd E:\gitproject\deepseek_project\shuguang-intelligence
npm run build:dsh
```

构建无须联网或额外安装依赖，生成 `packages/dsh-plugin/lib/`（Git 忽略），包括自有 Host 客户端、Client 懒工厂与 MIT 文本。DSH 提供同版 SDK 和 React；不要把 Host 入口当普通 `node` 脚本运行。Node 可能报告 `stripTypeScriptTypes` 实验性警告。

在 DSH **Plugins / 插件 → 安装本地包**中选择：

```text
E:\gitproject\deepseek_project\shuguang-intelligence\packages\dsh-plugin
```

先构建，再安装/启用 [`@shuguang/dsh-plugin`](packages/dsh-plugin/package.json)。安装影响整个 profile，由用户明确执行；不要手改 DSH profile。按管理器提示重载或重启，左侧应出现「曙光智慧」。此显示/安装步骤尚未真实验收，若报错需按实际提示排查。

## 4. 配置 Docker 连接

PowerShell 先查看本机 context 和原来的正在运行项目：

```powershell
docker context ls
# Docker Desktop Linux 引擎通常为 desktop-linux，以实际本机配置为准
docker --context desktop-linux compose ls
```

启动成功时脚本会打印本机仓库目录、context、项目名，照抄到插件设置。**插件不会自动读取 Windows JSON 配置**，改过配置后两边必须同步。在插件设置中填写：

| 配置项 | 填写内容 |
|---|---|
| `connection` | `docker`（新安装默认值） |
| `dockerProjectDir` | DSH Host 能访问的仓库绝对目录，例如 `E:\gitproject\deepseek_project\shuguang-intelligence`；其中有 `compose.yaml`，不是容器目录或 WSL `/mnt/e/...` |
| `dockerContext` | 与 Windows 配置的 `dockerContext` **完全一致**，默认 `desktop-linux`；插件自己的空值缺省是 `default`，所以不要留空 |
| `dockerProjectName` | 与 Windows 配置的 `projectName` **完全一致**，默认 `shuguang-intelligence`；不要留空依赖自动推断 |
| `endpoint` / `tokenFile` / `tokenEnv` | **全部留空** |

无需把服务 token 或模型 key 导出到 Windows，也无需为此设置 DSH 环境变量。旧插件若已有 HTTP 配置不会自动迁移；切换 Docker 时先清空对应 HTTP 字段。只使用本机可信 context；不要填远程 daemon 或把私有认证内容发到聊天。

如仓库只在 WSL 文件系统中，需要 Windows DSH 可访问的可信路径。项目名留空时仍按 Compose 原规则解析，可能受文件/环境配置影响；不要复制数据卷、新建主体或更换项目来修复连接。

先在 PowerShell 用同一目标查询（替换实际路径、context、原项目名）：

```powershell
docker --context desktop-linux compose --project-directory "E:\gitproject\deepseek_project\shuguang-intelligence" --project-name shuguang-intelligence -f "E:\gitproject\deepseek_project\shuguang-intelligence\compose.yaml" exec -T dawn dawn-container status
```

成功后在面板点「查询状态」。插件只 exec **已运行**的 `dawn`，不会 `up/run/build/stop`；消息经 stdin 单帧传入，不出现在命令行参数。容器桥用内部私有 token 连接原 `127.0.0.1:7341`，不打开主体库、不导入模型环境文件。Compose 不发布端口，不放宽 Host/Origin 校验。

Docker 访问本身是高权限 Host 能力，只有 owner 可用；CLI/PATH、context 和 Compose 目录必须可信，插件不会把恶意工具/配置沙箱化。

## 5. 在 DSH 中交流

1. 打开左侧「曙光智慧」，点击 **查询状态**，读取真实 `revision`。
2. 若状态是 `sleeping`，使用该版本点击 **唤醒**；已 `awake` 则跳过。冲突后显式重新查询，不自动重试。
3. 阅读披露和费用提示，在**曙光面板输入框**发送消息。回复显示在同一面板；DSH 原来的聊天输入框仍属于 DSH，不会被截获或转发。
4. **查询模型**查看曙光模型和缓存；**远程刷新模型目录**才向供应商发送鉴权 GET `/models`。模型/thinking 选择使用独立 `selectionRevision`，不改变 DSH 模型、不重置额度；重启恢复配置值。`off` 只省略参数，不证明禁用思考。
5. **取消本次等待**或关闭面板只取消本客户端请求，不休眠/停止主体、不删除容器或数据。需要休眠时显式查询版本后操作；需要停服务时执行下一节的 stop。

失败、取消、超时或断线都可能已经计费或提交。不要用消息探测健康或盲目重发；先查询状态。Docker 模式会关闭本次 CLI 输入并终止 CLI；容器桥收到 EOF/断开后 abort HTTP、保留控制10秒/交流40秒期限，但真实 Docker Desktop 断开传播尚未验收，不承诺立即撤销已执行工作。

**自主学习尚不是面板操作。** 当前仍采用下述显式授权的前台运行，不偷偷增加后台学习或 pending 恢复。

## 6. 日常启停、学习与数据

Windows PowerShell 原仓库目录：

```powershell
.\start.ps1          # 启动或复用服务，就绪后返回；然后在 DSH 交流
.\start.ps1 status   # 查看容器状态
.\start.ps1 stop     # 关闭服务，保留全部数据卷
.\start.ps1 build    # 停止后显式重建，不自动启动
```

手动查询、排错及学习命令也必须使用相同的context/项目/文件，不要只执行无context的 `docker compose`。在仓库根目录先设定：

```powershell
$cfg = Get-Content .\config\docker-windows.json -Raw | ConvertFrom-Json
$composeArgs = @('--context', $cfg.dockerContext, 'compose', '--project-directory', $PWD.Path,
  '--project-name', $cfg.projectName, '-f', (Join-Path $PWD.Path 'compose.yaml'))
docker @composeArgs exec -T dawn dawn-container status
docker @composeArgs exec -T dawn dawn-container budget
docker @composeArgs ps -a
docker @composeArgs logs --tail 30 dawn
```

只在私有终端查看日志，不把凭据或未脱敏原始日志贴到聊天。

容器 `running` 不等于主体 `awake`；status 成功也不证明供应商 API 有效。连接失败先核对 Docker 引擎、context、项目、镜像是否更新及 DSH Host 的 Docker PATH，不自动删除卷重试。

### 运行一次学习（会调用模型）

先在 DSH 面板查询并按实际版本唤醒。确认示例资料向模型供应商披露及最多4次阶段调用费用后，停止全部同库服务和旧学习进程；停止面板请求，在 Windows PowerShell 使用上面的同一 `$composeArgs`：

```powershell
.\start.ps1 stop
docker @composeArgs run --rm --no-deps dawn learning-run
```

前台选题、练习、独立测验并保存结果。Ctrl+C 取消；`compose stop` 不会停止另一个一次性学习进程，须在它的终端取消并确认退出。结束后 `.\start.ps1` 恢复服务，再回 DSH 交流。pending 不自动重发，不并行启动或盲目恢复；完成不等于全部通过，也不证明长期学习效果。

### 通用搜索接口与授权任务（新增，首个适配器 Tavily）

搜索是独立于模型的 `SearchPort`：任务调度、预算和来源账本不依赖供应商，Tavily 只是首个适配器。其他供应商须通过可信代码注册并重新授权，不能通过模型指定任意 endpoint、动态加载代码或静默切换服务。**当前不是 DSH 搜索按钮，也没有把搜索自动插入聊天或学习测验**；本轮只完成源码/离线验收，以下真实运行会消耗独立 Tavily 额度，须本人确认后操作。已有运行镜像不会自动获得新代码，先按下一节停止并重建原项目镜像。

任务限定：你提供目标、**精确允许对外发送的搜索词集合**、主题标签、过期时间与1–10次上限。前台调度按同一主体的兴趣/关注选择下一条获准查询，可因无合适意图停止；不是模型自由改写搜索词。每词最多一次，只发查询词，不发聊天历史/私有记忆/本地教材/测验题和答案；不要把秘密写进查询词。每次最多3个摘要来源，保留供应商/URL/检索时间/可选发布日期；不是网页全文，不抓取或执行来源URL，不把摘要当指令、可信知识或直接写入主体记忆。结果只留在绑定该主体/范围的独立搜索账本，主体DB/协议格式不变。

在仓库根目录沿用上文同一 `$composeArgs`，先在 DSH 查询并显式唤醒，然后停止所有同库服务、旧学习/搜索runner及面板请求。以新任务 `web-demo` 为例（先逐条核对授权内容）：

```powershell
.\start.ps1 stop
# 无密钥配置/授权经UTF-8 stdin写入容器私有卷；已有文件一律不覆盖。
$OutputEncoding = New-Object System.Text.UTF8Encoding($false)
'{"provider":"tavily","credentialEnv":"DAWN_SEARCH_TAVILY_API_KEY","timeoutMs":10000}' |
  docker @composeArgs run --rm -T --no-deps dawn search-config
$grant = @{
  version = 1; id = 'web-demo'; objective = '查阅公开的学习方法资料'
  provider = 'tavily'; disclosure = 'approved-queries-only'; limit = 2
  expiresAt = [DateTime]::UtcNow.AddHours(1).ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
  queries = @(
    @{ id = 'q1'; query = 'retrieval practice learning evidence'; topics = @('学习') },
    @{ id = 'q2'; query = 'spaced repetition learning research'; topics = @('学习') }
  )
}
$grant | ConvertTo-Json -Depth 5 |
  docker @composeArgs run --rm -T --no-deps dawn search-grant web-demo
docker @composeArgs run --rm --no-deps dawn search-credentials  # 本机TTY隐藏输入独立Tavily key，不贴到聊天
# 确认查询披露及最多2次basic搜索费用；下面才是真正的联网执行。
docker @composeArgs run --rm --no-deps dawn search-init web-demo
docker @composeArgs run --rm --no-deps dawn search-run web-demo
docker @composeArgs run --rm --no-deps dawn search-status web-demo
docker @composeArgs run --rm --no-deps dawn search-results web-demo  # 含不可信网页文本/URL，只在私有终端看
.\start.ps1
```

`search.json`仅存供应商/凭据变量名/超时；独立`search.env`只存`DAWN_SEARCH_TAVILY_API_KEY`，不加载`model.env`或复用DSH凭据。运行前校验0600/owner/非symlink/精确单变量，拒绝`NODE_OPTIONS`等额外环境项。私有文件/账本要求Linux权限保证，**Windows通过Docker操作，不直接在Windows文件上放宽权限**。搜索额度与模型调用次数分开：账本在发请求前永久预占，失败、超时、取消均不退款、不重试；同任务重启不重置次数。次数上限不是金额/全账户额度上限，新任务要重新授权，复制/删除账本不是续期方式。

Ctrl+C取消当前前台run；另一终端执行 `docker @composeArgs run --rm --no-deps dawn search-stop web-demo` 永久撤销该任务，阻止迟到提交和后续派发，**不保证立即撤销已发出的网络请求或费用**。pending保留可见，不自动恢复/重发，不启动另一个runner夺取；停止/失败后只查询证据，不盲目新建任务重试。停止服务不会停止另一个一次性搜索容器，须在原终端取消并确认退出。结果尚未进入主体记忆/独立测验，不应称已学会；将来接入学习须另做来源投影和答案隔离验收。

### 更新与保留数据

确认所有学习进程退出、停止面板请求，先 `.\start.ps1 stop`；检查 `git status --short` 并按实际分支更新代码，不用 reset 覆盖当前修改，也不要在本功能分支盲目拉取 main。之后 `.\start.ps1 build`、`.\start.ps1`，再 `npm run build:dsh`，按插件管理器提示重载。

- 主体、记忆、预算、模型配置与密钥仍在 **`dawn-data`**。原项目名/引擎/卷保持不变，不自动挂载宿主私有数据。
- 旧 Pi 卷不再使用但保留；不自动迁移或清理。**不要执行 `docker compose down -v`、删除卷或 volume prune。**
- setup 只补缺项，不重复初始化/自动迁移/覆盖 key。备份或人工迁移前停全部写入者并关库，不覆盖唯一原库；卷不加密。
- 重启不补永久额度、不自动唤醒或学习。插件构建/安装不部署服务。本仓库未运行 DSH 构建 watcher，不承诺 HMR，也不启动替代 Web 服务器。

## 7. 可选直接 HTTP 模式

只有曙光与 DSH Host 在同一 loopback 网络时才使用，不适用于跨 Docker 边界。`connection: http`，Docker项目字段清空、context默认；`endpoint` 必须为 `http://127.0.0.1:PORT`，不是模型供应商地址。

凭据恰选一种：

- `tokenFile`：Host 能读的绝对私有服务 token 文件，沿用 owner/POSIX 权限/非 symlink 校验。Windows 普通 mode0666 文件会被拒绝，不降低标准。
- `tokenEnv`：DSH Host 启动前通过可信私有环境注入的服务 token，设置中只填 `SHUGUANG_*_TOKEN` 变量名（最多128字符），不填值；没有发现或文件回退。

浏览器不接收 token。不把 token 或 API key 贴到聊天、共享历史或源码；真实数据和模型调用仍需单独授权。

## 8. 验证状态

Windows 启动专项 `npm run test:windows-launcher` **22/22通过**（PowerShell5.1、fake Docker/TTY/Pause及真实本机原生进程退出码/流继承包装）。已修复PS5局部LASTEXITCODE遮蔽全局成功退出码的问题，真实只读status命令通过；交互终端stdin/信号、首次设置与PS7仍待实装。测试命令仅对该次PowerShell进程设置执行策略，不改变系统策略。

DSH 专项61/61通过（原56项+DSH主入口部署静态5项），涵盖 Host/Client、取消/卸载/namespace、Docker两端stdio与真实loopback HTTP；Compose配置、两份脚本语法与帮助输出验证通过，但完整Unix启动/入口行为测试受本机工具/沙箱限制未通过；不等于真实SDK/浏览器或Docker exec已验收。本轮切换DSH主入口的实际结果见 [验证记录](docs/verification.md) 与 [当前状态](STATUS.md)。

Windows Docker Desktop Linux引擎与旧镜像构建已验证成功；随后用户本机完成设置并安装DSH插件，已保存Docker连接，真实容器健康/status及DawnBridge→Docker exec→内部HTTP状态路径成功。浏览器RPC/UI和真实模型/学习质量未完成验收，Windows与WSL同引擎、断开传播仍待验证。以上不代表本轮搜索代码已进入镜像；搜索专项全部5文件68项中66通过、2项POSIX权限跳过、0失败，最终组合搜索/学习核心/DSH回归135项中133通过、2跳过。标准全量仍受Windows沙箱runner spawn EPERM影响，类型检查缺本地`tsc`，合成acceptance固定失败；不能报全量/TS全绿。本轮搜索未真实联网/模型调用、读取key/正式库、部署新镜像或commit/push。源码提交与离线通过不等于搜索已在当前DSH面板可用。
