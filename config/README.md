# 配置示例

无需从零手写：在交互终端运行 `npm start -- model-config --output /absolute/private/model.json`，按[配置向导](../docs/model-configuration.md)选择用途、入口、模型、凭据环境变量名与运行限制，预览确认后新建0600配置。父目录须已存在、不覆盖旧文件、不自动读取Pi配置或密钥、不调用模型。生成结果兼容现有serve/learning-run的 `--model-config`。

`learning-model.example.json` 是两目标学习验收专用的配置模板，实例 `maxCalls:4`、超时30秒，只有不可访问的占位域名与环境变量引用，不自动加载。须经确认后在私有目录填写供应商/模型，并由用户运行环境注入凭据；模板不授予API调用权限。见[真实学习验收方案](../docs/learning-evaluation.md)。普通交流用的 `model.example.json` 仍保留原3次实例限制，不为学习修改其额度。

`learning-pack.example.json`是0.1.0本地自主学习的合成资料包示例，不自动加载。通过显式`learning-init --pack`授权后固化进新v3主体库，再由`learning-run`前台自主推进；私有答案键不进入模型。两目标需要4次生成，请为学习模型配置设置`maxCalls:4`或更大但不超过10。详见[自主学习](../docs/autonomous-learning.md)。下文dawn.example.json的autonomy:false仅指它不会自动启用daemon，不否定显式学习runner能力。

`dawn.example.json` 仅展示未来配置的安全形状，当前应用不会读取它，也不启用任何模型或 transport。当前 SQLite 持久化由 CLI 参数显式控制，不从该配置读取数据库路径。

`autonomy` 保持禁用。改配置文件不会启动服务或启用聊天、模型、自主能力。服务由显式 serve 参数启动，Pi 客户端由 DAWN_ENDPOINT 与 DAWN_TOKEN_FILE 配置，见[本机服务说明](../docs/local-service.md)。SQLite 也不会因为配置文件存在而自动创建：必须由用户手动执行 `init`，并提供绝对 `--db` 路径；父目录须已存在。推荐路径与命令见[持久化说明](../docs/persistence.md)。

示例不含密钥；模型凭据只通过 `credentialEnv` 指向环境变量名称，不在配置中放 key、token 或 secret。不要依赖 dawn.example.json 改变程序行为。

`model.example.json` 则是已实现的显式模型配置形状，通过 serve --model-config 读取，不自动加载；legacy启用时必须同时指定已初始化的 --chat-db；六核心新模式改为显式 --subject-db 统一库，见[对话记录与预算](../docs/dialogue-memory.md)。严格限制 credentialEnv 引用、推理档位和实例调用上限；timeoutMs可选1..30000、缺省8000，示例显式30000，见[模型 API](../docs/model-api.md)。用户授权的 config/dawn.local.json 是被 Git 忽略的本地测试配置，不含密钥，不应提交。
