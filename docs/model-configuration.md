# 模型配置向导

通过独立CLI引导配置曙光使用的模型，不要求先安装或登录Pi。

```bash
# 在交互终端运行；父目录须已存在，目标文件须不存在。
npm start -- model-config --output /absolute/private/model.json
```

## 引导步骤

1. **用途**：交流或学习。仅影响实例次数建议值（交流3、学习4），不绑定主体或修改数据库额度。
2. **连接**：OpenAI（预填 `https://api.openai.com/v1`）或自定义OpenAI兼容入口。这里是填写起点，不是端点可用性认证。
3. **baseUrl / model**：确认入口、填写准确模型ID。模型名不自动推测，不联网拉取模型目录。
4. **credentialEnv**：填写运行时注入密钥的环境变量**名称**，例如 `OPENAI_API_KEY` 或 `DAWN_MODEL_API_KEY`，不是密钥正文。
5. **reasoningEffort / timeoutMs / maxCalls**：选择推理档位、完整单次请求期限和模型实例次数上限。
6. **预览并确认**：明确确认后排他新建0600配置文件；空确认或拒绝不保存。Ctrl+C、SIGTERM或输入结束中止；写入失败可能留新文件，先检查目标，不自动覆盖或删除。

当前配置输出与 `config/model.example.json` / `config/learning-model.example.json` 同形：

```json
{
  "baseUrl": "https://model.example.invalid/v1",
  "model": "your-model-id",
  "credentialEnv": "DAWN_MODEL_API_KEY",
  "maxCalls": 4,
  "reasoningEffort": "low",
  "timeoutMs": 30000
}
```

`.invalid` 仅为示例。向导进行本地字段校验，不检查变量是否存在、不读取其值、不证明模型或供应商支持所选档位。

## 参考Pi，但不复用其凭据与运行时

参考Pi模型配置的“提供商/入口 → 模型 → 凭据 → 推理档位”分层体验。Pi `models.json` 的 `providers`、`baseUrl`、`models[].id` 对应这里的连接选择、`baseUrl` 和 `model`；Pi `/thinking` 对应这里的 `reasoningEffort`，但可选值并不完全相同。

曙光不读取Pi的 `models.json`、`settings.json` 或 `auth.json`，不导入会话，不执行 `!command`，不插值密钥。生成的是曙光自己的单模型配置，**不是Pi models.json导入器，也不是多提供商目录**；不会直接把Pi的 `apiKey`、`api`、`headers`、兼容选项或模型元数据带入曙光。需要多个模型时，分别输出到不同的新文件，在运行命令中明确选择一个。

当前仅支持 **OpenAI Chat Completions**（`/chat/completions`，非流式、`max_tokens`、`reasoning_effort`）。不支持Anthropic/Google原生协议、OpenAI Responses、OAuth、凭据命令、自定义认证头、自动兼容转换或自动降档。供应商还须返回合规 `usage` 并支持所选推理档位及严格JSON任务；勾选兼容并不证明这些能力。

- URL只接受HTTPS根入口或 `/v1`；本机假上游允许HTTP `127.0.0.1`，不接受路径任意拼接、userinfo、查询参数或fragment。
- 推理档位：`off / low / medium / high / xhigh / max`；`off`仅省略 `reasoning_effort`，不保证供应商实际关闭思考。不支持 `minimal`，不自动映射为 `none`。
- timeout：1–30000ms，向导建议30000；旧手写配置缺省仍为8000。
- 实例次数：1–10，失败也计数、重启实例会重置；**不是持久预算或货币上限**。两目标完整学习通常需要4次，主体总预算与学习子预算仍须单独授权。
- 向导不收集、保存或验证密钥值。凭据应由私有运行环境/包装脚本注入，不要把真实key粘贴进向导、聊天或示例文件。

## 使用生成的配置

现有命令无需更改格式，仍显式指定文件：

```bash
# 已有六核心主体与服务token；不会自动创建或唤醒主体。
npm start -- serve --subject-db /absolute/private/subject.sqlite \
  --token-file /absolute/private/service.token --port 7341 \
  --model-config /absolute/private/model.json

# 已授权的本地学习主体；运行此命令才可能调用模型。
npm start -- learning-run --db /absolute/private/learning.sqlite \
  --model-config /absolute/private/model.json
```

保存配置不是授权发送资料或付费调用，也不启动服务、开库或生成请求。真实使用前仍确认资料披露、预算与费用；见[模型API](model-api.md)、[学习方案](learning-evaluation.md)和[自主学习](autonomous-learning.md)。

## 运行中从 Pi 薄接口选择模型与 thinking

服务使用 `--model-config` 启动后，Pi 只发控制命令，模型请求仍由曙光的同一个适配器实例执行：

```text
/dawn model-status         # 当前模型、thinking、选择版本与实例次数；不联网
/dawn model                # 确认是否远程刷新目录，再选择模型
/dawn models               # 明确从当前曙光入口 GET /models，只列目录、不生成
/dawn model deepseek-v4-pro # 从已发现的缓存目录切换；不隐式刷新
/dawn thinking             # 打开档位选择器
/dawn thinking high        # 明确选择档位
/dawn thinking off         # 省略 reasoning_effort，不代表服务商保证禁用思考
```

示例ID并非默认值，只有当前入口已发现的ID可切换；首次缓存只有配置中的模型。取消选择器不提交；目录失败保留旧缓存并停止本次流程，不偷偷用旧目录完成选择。目录最多128条，1MiB上游正文、48KiB序列化ID列表；8秒发现期限，仍受控制请求含排队10秒总期限限制。目录并非能力或价格认证：所列模型和档位是否兼容 `max_tokens`、严格JSON、`usage`，仍需另行授权真实验证。

选择受服务FIFO与独立 `selectionRevision` CAS保护；冲突不自动重试。进行中的生成先完成，不中途切换。同一实例的 `maxCalls`不因切模型或thinking重置，失败继续计数；主体身份、记忆、revision和永久预算不因控制操作变化。目录发现不消耗生成次数，但会发送该入口的显式模型凭据，不发送对话或主体投影。

**选择仅存服务进程内，所有连接此服务的客户端共享。** 不写回 `model.json`、SQLite或Pi设置；重启从文件恢复初值，若要长期默认值请单独修改私有配置。仅限原入口/凭据范围，不能从Pi切提供商、导入Pi模型/密钥，也不控制另起的 `learning-run` 进程。旧服务不支持新增命令时须由使用者手动重启到新代码；扩展不自动重启本体。

独立CLI可做相同操作，不依赖Pi：`request … -- model-status`、`request … -- models`、`request … -- model <selectionRevision> <ID>`、`request … -- thinking <selectionRevision> <level>`。先查询最新选择版本；这不是主体生命周期revision。取消或响应丢失后先重新查询，不自动重发。

## 安全与限制

- 仅交互TTY，不从管道批量读取回答；自动化可按示例手工生成配置后进行既有显式运行。
- 只新建明确的绝对路径；父目录需已存在且可信，拒已有文件和最终symlink，不自动创建父目录、改默认配置或覆盖本地模型配置。
- 0600是本机文件权限，不是加密或同UID沙箱；中间路径仍依赖可信父目录。
- 本地校验与创建可离线执行，不发网络请求、不读取Pi配置或真实环境值。
