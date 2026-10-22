# 显式模型 API 与测试

曙光通过自己的 `OpenAICompatibleModel` 调用 API，不调用 Pi 模型运行时。URL/model/credentialEnv 必须由用户显式配置，代码不探测 Pi 设置、不会执行凭据命令。

> 新 `--subject-db`模式使用同一个模型适配器，但每轮最多1024输出token，要求严格候选JSON而非自由文本；投影/白名单/提交规则见[主体运行接线](subject-runtime.md)。新模式已完成一次真实模型严格JSON交流、持久提交与冷重启上下文恢复，见[验证记录](verification.md)；实际返回appraisal=null/candidates=[]，不代表非空候选或情感成长已获真实验证。

## 配置

可先运行 `npm start -- model-config --output /absolute/private/model.json`，按[模型配置向导](model-configuration.md)选择入口/模型/凭据环境变量名并确认保存。仅本地生成，不读Pi凭据、不调用模型、不覆盖旧配置；与下述手写配置同形。

参考 `config/model.example.json`，严格字段为：

- `baseUrl`：HTTPS 入口，支持无路径或 `/v1`；本机模拟允许 HTTP 127.0.0.1。
- `model`：明确模型名，非空且无首尾空白、最多256字符，不含终端控制字符。
- `credentialEnv`：当前进程中已有的密钥环境变量名，不接受直接 key 或命令。
- `maxCalls`：1–10 的服务实例调用上限，失败同样扣除；重启会重置，不是持久日预算。
- `reasoningEffort`：off/low/medium/high/xhigh/max；off省略 `reasoning_effort`，其余显式发送，不自动回退。off不保证供应商关闭思考，档位列表不是模型能力认证。
- `timeoutMs`：可选整数1–30000，缺省8000；覆盖完整请求和正文读取，不是自动重试。示例显式设为30000以容纳结构化生成，旧五字段配置仍有效。

legacy以 `serve ... --model-config /absolute/path/model.json --chat-db /absolute/path/chat.sqlite` 启用；新模式以 `serve --subject-db ... --model-config ...` 启用，详见主体运行契约。对话库必须经 `chat-init` 显式创建，详见[对话记录与持久额度](dialogue-memory.md)；不再支持仅有 model-config 的无台账服务模式。密钥应由宿主进程配置或私有包装脚本提供，不写源码、普通示例或终端输出。

历史授权测试的 `config/dawn.local.json` 被Git忽略，保留了当时入口、模型与环境变量引用，不含密钥。它不是默认配置或新的调用授权；向导不会读取、修改或沿用它，迁移环境需重新显式准备配置与凭据。

## 服务运行中选择

Pi `/dawn model`、`/dawn thinking` 或独立request命令可控制同一个服务实例；显式 `/dawn models` 才鉴权GET原入口的 `/models`。不生成、不会披露历史；无自动探测、重试或凭据发现。选择不重建适配器、不重置实例或永久额度；仅服务进程内共享，不改配置/主体，也不影响独立学习runner。具体命令、目录限额和取消语义见[运行中选择](model-configuration.md#运行中从-pi-薄接口选择模型与-thinking)。

## 当前对话边界

- 清醒时才允许调用；未配置返回 NOT_IMPLEMENTED，休眠返回 UNAVAILABLE。
- 发送固定身份/能力边界提示、当前对话库中有界的已完成问答与本次消息，不发送 Pi 历史、文件、主体私人字段或整个主体状态。所有本机 token 持有者共享同一 owner 会话，不适合多人共用。
- legacy每次服务交流最多256输出token；六核心JSON新模式最多1024输出token。适配器默认8秒超时，可显式配置至30秒；say服务总期限35秒、客户端40秒（含排队，非每阶段重置），控制请求和正文上传仍为10秒。响应正文最多128KiB；模型content仍最多16000字符（新模式包含JSON本身），因此不是所有16000字符reply都能装进候选信封，超限明确失败。
- 不重试、不换端点、不跟随重定向。上游非成功、缺失用量、空白、截断或非法响应拒绝，不伪造回复。
- 成功问答与完成调用用量持久保存，失败/中断预占也收费，重启同一对话库不重置额度。legacy不写模型提案或情感、回复不改变主体revision；subject-db新模式则提交受限候选与情感，并增加两个revision，仍无工具、自主活动或模型自批成长。
- 台账限制调用次数，不是精确 token 或货币费用核算；失败调用实际费用可能未知。

## 最新六核心真实验证

本地8003ms主动abort定位后，将测试配置明确改为timeoutMs=30000，并同步say服务35秒、客户端40秒和Pi命令入口期限。真实生成10523ms完整返回HTTP200/stop，严格reply/appraisal/candidates JSON通过；持久保存两条经历与记忆，冷重启完整回放及下一轮记忆上下文通过。模型返回appraisal=null/candidates=[]，没有情感变化或认识候选应用。本轮总计两次生成（一次8秒失败、一次修复后成功），未再次重试；第二轮真实生成未执行，详见验证记录。未绕过TLS或切换模型。

## 上一阶段真实验证（单轮接入）

用户授权后，从当前 Pi 配置只识别活跃入口及密钥变量引用，没有在输出中显示密钥，也未复制密钥。

初始请求使用 reasoning_effort=none，被当前模型以 HTTP 400 拒绝。通过有界诊断确认允许 low 等档位后，改为显式配置 low。总计四次实际生成请求：前三次均因该参数被拒绝，修正后一次通过独立服务与实际直连客户端成功返回：

> 我是曙光，一个正在开发的独立数字伙伴，目前尚未具备自主学习能力或持久聊天记忆。

此外只有一次无凭据 HEAD 连通性探测；没有隐式重试、备用模型、Pi 会话正文发送或 TLS 校验绕过。

测试使用临时 SQLite、临时控制 token 与 loopback 端口，结束后清理并停止。未启用正式服务或安装插件。真实返回只证明该入口当时可用与单轮链路成立，不证明人格、记忆、学习能力已完成。
