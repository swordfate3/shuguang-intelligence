# 曙光智慧 0.1.0（Shuguang Intelligence）

一个以 **self / cognition / affect / memory / agency / growth 六核心** 为中心的独立数字伙伴原型。主体、模型调用和记忆不依赖 Pi；Pi 只是可选的薄交流窗口。

**0.1.0 必需范围：有界、单所有者、本机运行的交流、记忆与自主学习闭环。** 自主学习不是可选的后续功能。现已接通并离线验证一次授权后的自主选题、学习、独立测验与持久接续；此前仅交流版的完成结论已撤回，以包含学习的新版验收为准。不是意识、无限记忆或模型权重训练。[版本范围与验收](docs/release-0.1.0.md)列出范围和验证状态。

## 这一版能做什么

- 一次交流经过六核心上下文与确定性规则，模型只返回待校验的结构化候选。
- 保存带来源的用户经历、助手生成记录、记忆、认识候选和工程情感。
- 单个 SQLite 库统一提交主体状态、事件、问答与调用台账；重启回放核对完整状态。
- 有限相关记忆召回、最近完整问答接续；失败调用不退款、不自动重试。
- 显式唤醒/休眠、前台启动/关闭；独立命令行客户端或可选 Pi 插件。
- 一次授权本地资料后自主选择目标、学习/练习、独立测验与连续推进；共享总预算、持久进度和同主体学习记忆。

**不包含：**任意搜索/工具执行、模型自行确认成长、自动遗忘/压缩、旧库迁移、多人隔离或后台自动拉起。自主学习只在显式授权的本地资料与永久预算内运行。记忆是本地规则检索，不是向量数据库。

## 模型配置向导

```bash
# 在交互终端运行，输出父目录须已存在；不会覆盖旧文件。
npm start -- model-config --output /absolute/private/model.json
```

参考Pi的配置分层体验，依次选择交流/学习用途、OpenAI或自定义兼容入口、准确模型ID、凭据环境变量**名称**、推理档位、超时和实例次数，再预览确认。生成的配置直接用于下方 `--model-config`；不读取Pi配置/密钥、不联网探测、不自动调用或启动主体。当前仅支持Chat Completions，不支持Pi全部协议或OAuth。详见[模型配置向导](docs/model-configuration.md)。

## 自主学习（0.1.0必需项）

见[完整操作与故障语义](docs/autonomous-learning.md)。一次授权后runner自行选择目标，连续读资料、记笔记/练习、接受本地独立评分、保存进度并继续；没有逐轮人工提示。使用v3学习新库，不自动改造已有v2主体。新库可用同一 `serve --subject-db` 继续普通交流并召回学习记忆。

```bash
# 先手动准备私有目录和模型配置；示例pack只有合成规则。
npm start -- learning-init --db /absolute/private/learning.sqlite --id dawn --name 曙光 \
  --limit 100 --learning-limit 4 --pack /absolute/project/config/learning-pack.example.json
npm start -- subject-wake --db /absolute/private/learning.sqlite --revision 0
npm start -- learning-run --db /absolute/private/learning.sqlite --model-config /absolute/private/model.json
npm start -- learning-status --db /absolute/private/learning.sqlite
npm start -- learning-stop --db /absolute/private/learning.sqlite
```

每目标study/assessment各计一次；两目标配置实例 `maxCalls` 至少4。测验答案不交模型，模型自评分数不被接受；通过测试不等于通用掌握或人格成长。停止授权不可恢复；Ctrl+C取消run但保留已提交进度。崩溃pending需先停止所有旧runner再显式 `learning-recover`，不退款不重发。

## 环境

- Node.js **>=24.0.0**，使用内建 `node:sqlite` 与原生 TypeScript stripping。
- npm；直接运行不需要第三方运行时依赖或编译产物。
- 模型交流需要用户自己的 OpenAI 兼容 API 配置与凭据环境变量。
- TypeScript 开发检查另需声明的开发依赖；Pi 类型检查需宿主 peer 类型。当前工作环境未做干净安装，离线借用现有工具的验证见[验证记录](docs/verification.md)。

## 快速开始：六核心新模式

以下命令**只有手动执行时才创建数据**。先选择私有目录；不要覆盖需要保留的旧主体。

```bash
cd /path/to/shuguang-intelligence
node --version
npm start -- --version
npm run check:capabilities

DATA="$HOME/.local/share/shuguang-intelligence"
mkdir -p -m 700 "$DATA"  # 已有目录需自行确认权限
DB="$DATA/subject.sqlite"
TOKEN="$DATA/service.token"

npm start -- subject-init --db "$DB" --id dawn --name 曙光 --limit 100
npm start -- token-init --token-file "$TOKEN"
npm start -- subject-status --db "$DB"
```

主体初始休眠；固定调用次数须在初始化时明确提供，范围1..10000，失败和崩溃中的请求也占次数。不会自动续期或重置。

### 配置并启动模型服务

参考 [`config/model.example.json`](config/model.example.json)，在私有位置准备模型配置：

```json
{
  "baseUrl": "https://your-provider.example/v1",
  "model": "your-model",
  "credentialEnv": "DAWN_MODEL_API_KEY",
  "maxCalls": 3,
  "reasoningEffort": "low",
  "timeoutMs": 30000
}
```

URL、模型和推理档位须与供应商兼容。`credentialEnv` 仅引用现有环境变量；**不把真实 key 填进 JSON、源码或聊天**。通过自己的私有包装脚本/运行环境注入变量，程序不会自动发现 Pi 凭据。`maxCalls` 是单服务实例上限，主体库的固定次数上限另行永久计数，重启不能重置后者。

```bash
# MODEL 是你手动准备的绝对路径，示例域名不能直接调用
MODEL="/absolute/private/model.json"
npm start -- serve --subject-db "$DB" --token-file "$TOKEN" \
  --port 7341 --model-config "$MODEL"
```

这是前台进程。Ctrl+C/SIGTERM 停止服务，不删除数据、不隐式休眠。未配置模型也能启动控制服务，但 `say` 明确返回 NOT_IMPLEMENTED。

### 在另一个终端交流（不需要 Pi）

重新设置上述 `DB/TOKEN` 路径变量，或直接填写绝对路径：

```bash
npm start -- request --endpoint http://127.0.0.1:7341 --token-file "$TOKEN" -- status
# 读取刚刚返回的 revision，初始新库为0；不要在后续操作中一直使用0
npm start -- request --endpoint http://127.0.0.1:7341 --token-file "$TOKEN" -- wake 0
npm start -- request --endpoint http://127.0.0.1:7341 --token-file "$TOKEN" -- say "你好，今天一起探索一个问题。"
npm start -- request --endpoint http://127.0.0.1:7341 --token-file "$TOKEN" -- status
npm start -- subject-budget --db "$DB"
```

`say` 消息须作为一个引号包裹的参数。一次成功交流增加两个revision；休眠应先查询最新版本，再执行 `request … -- sleep <最新revision>`。应用错误和连接失败都返回非零退出码；取消或响应丢失不证明未保存，先查状态，不自动重发。

服务仅绑定 `127.0.0.1`，不提供公网入口。一枚服务token拥有该主体的控制权限，不适合多人共享。模型供应商会收到有限自我/情感/相关记忆与对话，详见[数据披露与事务边界](docs/subject-runtime.md)。

## 数据与恢复

- 一个显式 `--subject-db` 文件保存一个主体；仅 `subject-init` 排他新建，其他命令不创建缺失库。
- 新格式为DSW2 / SQLite user_version=2；领域schemaVersion=2、协议v1、应用0.1.0是不同版本。
- 记忆和经历保存在完整JSON快照中，另有typed事件、初始快照与调用台账；不是独立记忆SQL表。
- 完整快照最大2MiB，经历/常规集合最多1000项；到限明确失败，不静默遗忘。长期容量尚未解决。
- 未加密，没有内置删除/遗忘接口。失败输入也会留在调用台账，但不进入成功问答历史。
- **备份：先停止所有写入进程并关闭数据库，再复制完整SQLite文件至私有位置。** 不在活动写入期间只复制单个DB文件。恢复到新私有位置，用 `subject-status --db /absolute/restored.sqlite` 验证回放后再决定启动；恢复备份会回退其后的经历和次数，不是防篡改计费。

原 `init/status/wake/sleep/events/chat-*` 与 `serve --db/--chat-db` 仅保留legacy兼容。新旧不自动迁移，不应以新建库冒充旧主体无损延续。[旧格式说明](docs/persistence.md)。

## 可选 Pi 窗口

Pi 包入口：`packages/pi-extension/`。未自动安装或启用。显式配置 `DAWN_ENDPOINT`、`DAWN_TOKEN_FILE` 后，`/dawn status | wake <版本> | sleep <版本> | say <消息>` 转发到同一个本机服务。

Pi 不代答、不发送自己的会话历史、不持有另一份人格；关闭 Pi 仅取消本客户端未完成请求，不关闭曙光服务。部署/安装应独立授权，见[本机服务说明](docs/local-service.md)。

## 验证

```bash
npm test                    # 全部自动化测试，包含临时loopback服务
npm run verify:acceptance    # 0.1.0合成端到端验收，不访问真实API
npm run verify:learning:offline # 两目标/四次loopback假模型学习验收，非真实效果
npm run check:capabilities   # 只报告能力，不开库、不启动服务
npm run check               # 开发类型检查，需要开发依赖/宿主类型
```

真实API已有首轮严格JSON交流、持久提交与冷重启验证；非空情感/认识候选和跨重启第二轮真实生成尚无同等实测证据。模拟测试不证明内容正确、意识或长期成长。

下一阶段按[可复现检查方案](docs/reproducibility.md)核对本体/宿主类型与干净环境门槛；[真实学习验收方案](docs/learning-evaluation.md)明确两目标最多4次生成、资料披露、费用与停止边界。真实学习尚未运行，执行前另行确认；专用模板见 `config/learning-model.example.json`，不会自动读取或发现凭据。

## 持续开发与交接

开发前先读 [AGENTS.md](AGENTS.md)（规则）、[STATUS.md](STATUS.md)（当前进度/阻塞/下一步）与 [ROADMAP.md](ROADMAP.md)（版本范围/验收条件）。每次结束更新状态与实际验证证据，不依赖会话历史，也不将路线图当作安装、真实API、部署或发布授权。

建议从本项目目录启动开发会话；若从上级工作区启动，请明确要求先读取上述文件。这些文档用于跨会话接续，不会启动无人值守开发。

## 项目布局与文档

```text
packages/dawn/src/
  core/       六核心与无I/O主体循环
  runtime/    交流编排、CLI、独立控制客户端
  adapters/   模型、SQLite、HTTP client/server
  legacy/     旧格式兼容
packages/pi-extension/  可选薄窗口
scripts/               可复验离线验收
```

[完整架构图 HTML](docs/architecture.html) · [开发规则](AGENTS.md) · [当前状态](STATUS.md) · [路线图](ROADMAP.md) · [0.1.0范围](docs/release-0.1.0.md) · [更新记录](CHANGELOG.md) · [架构](ARCHITECTURE.md) · [决策](DECISIONS.md) · [六核心](docs/six-core.md) · [运行与持久化](docs/subject-runtime.md) · [模型配置](docs/model-api.md) · [协议](docs/protocol.md) · [验证记录](docs/verification.md) · [文档索引](docs/README.md)
