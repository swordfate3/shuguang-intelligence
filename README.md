# 曙光智慧（Shuguang Intelligence）

独立数字伙伴原型，包含同一主体的六核心、交流、持久记忆和有界自主学习。**当前交互入口是 DSH 插件，不使用 Pi。** Docker 只运行曙光服务；你在 DSH 左侧「曙光智慧」面板中与它交互。

```text
DSH 曙光插件 → 本机 Docker Compose exec → 容器内曙光服务 → 曙光自己的模型与记忆库
```

DSH 是交互窗口，不是曙光主体，也不接管其数据库。插件不读取 DSH 对话历史、不借用 DSH 模型/API key，不把曙光消息写进 DSH Agent 会话日志。历史 Pi 扩展源码仅保留兼容，不在当前镜像、启动流程或使用路径中。

**许可证：[MIT](LICENSE)** · 作者：**swordfate3**。允许商用、修改和分发；分发副本或实质性部分时保留版权及完整 MIT 文本，不强制界面署名。第三方依赖遵循各自许可。

## 1. 前提

- Windows 已安装 DSH；本插件对照 **DSH SDK 0.2.1-rc.2 / Cordis 4.0.5**。其他版本须复验。
- Docker Desktop 的 Linux 引擎已启动，并启用所用 WSL 发行版集成；Windows DSH 与 WSL 必须连接**同一个本机 Docker 引擎**。
- WSL/Linux 中有 Git、Docker CLI 和 Compose v2，用于配置和启动容器；Windows 的 `docker`/Compose 在 DSH Host 的 PATH 中。
- Windows 有 Node >=24，用于离线构建插件。容器的 Node 由镜像提供，不需要在 WSL 安装 Node、Pi 或 DSH。

目前功能仍待真实 DSH 安装和 Docker 端到端验收，不能把合成测试等同已部署可用。本功能位于 `feat/dsh-plugin`，不是 main。用户已授权将该功能分支提交并推送；获取源码时选择此分支，不要把 main 误当已有本功能。已有仓库先检查本地修改再切换/更新，不覆盖原数据或工作树。

## 2. 启动 Docker 内的曙光服务

在**原来的 WSL/Linux 仓库目录**执行，先确认环境：

```bash
docker info >/dev/null
docker compose version
bash start.sh
```

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

```bash
bash start.sh stop
bash start.sh build
bash start.sh
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

在插件设置中填写：

| 配置项 | 填写内容 |
|---|---|
| `connection` | `docker`（新安装默认值） |
| `dockerProjectDir` | DSH Host 能访问的仓库绝对目录，例如 `E:\gitproject\deepseek_project\shuguang-intelligence`；其中有 `compose.yaml`，不是容器目录或 WSL `/mnt/e/...` |
| `dockerContext` | 刚确认的本机 context，例如 `desktop-linux`；缺省显式 `default`，不会跟随 `DOCKER_CONTEXT` / `DOCKER_HOST` |
| `dockerProjectName` | `compose ls` 中原项目名，例如 `shuguang-intelligence`；建议明确填，尤其 Windows/WSL 目录名不同时 |
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

WSL/Linux 原仓库目录：

```bash
bash start.sh          # 启动或复用服务，就绪后返回；然后在 DSH 交流
bash start.sh status   # 查看容器状态
bash start.sh stop     # 关闭服务，保留全部数据卷
```

安全查询与排错：

```bash
docker compose exec -T dawn dawn-container status
docker compose exec -T dawn dawn-container budget
docker compose ps -a
docker compose logs --tail 30 dawn
```

容器 `running` 不等于主体 `awake`；status 成功也不证明供应商 API 有效。连接失败先核对 Docker 引擎、context、项目、镜像是否更新及 DSH Host 的 Docker PATH，不自动删除卷重试。

### 运行一次学习（会调用模型）

先在 DSH 面板查询并按实际版本唤醒。确认示例资料向模型供应商披露及最多4次阶段调用费用后，停止全部同库服务和旧学习进程；停止面板请求，在 WSL 运行：

```bash
bash start.sh stop
docker compose run --rm --no-deps dawn learning-run
```

前台选题、练习、独立测验并保存结果。Ctrl+C 取消；`compose stop` 不会停止另一个一次性学习进程，须在它的终端取消并确认退出。结束后 `bash start.sh` 恢复服务，再回 DSH 交流。pending 不自动重发，不并行启动或盲目恢复；完成不等于全部通过，也不证明长期学习效果。

### 更新与保留数据

确认所有学习进程退出、停止面板请求，先 `bash start.sh stop`；检查 `git status --short` 并按实际分支更新代码，不用 reset 覆盖当前修改，也不要在本功能分支盲目拉取 main。之后 `bash start.sh build`、`bash start.sh`，Windows 重新 `npm run build:dsh`，按插件管理器提示重载。

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

DSH 专项61/61通过（原56项+DSH主入口部署静态5项），涵盖 Host/Client、取消/卸载/namespace、Docker两端stdio与真实loopback HTTP；Compose配置、两份脚本语法与帮助输出验证通过，但完整Unix启动/入口行为测试受本机工具/沙箱限制未通过；不等于真实SDK/浏览器或Docker exec已验收。本轮切换DSH主入口的实际结果见 [验证记录](docs/verification.md) 与 [当前状态](STATUS.md)。

Docker Linux引擎此前未运行；真实镜像构建/Windows与WSL同引擎/断开传播/DSH安装与UI、真实模型兼容性和学习质量均待验证。标准全量受Windows沙箱进程管道/Unix权限与shell差异影响，类型检查缺本地`tsc`；未发布预构建镜像或部署。源码分支的提交/推送不等于服务已部署或插件已安装。
