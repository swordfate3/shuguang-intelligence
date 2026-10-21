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
- 推理档位：`low / medium / high / xhigh / max`；不含Pi的 `off / minimal`。
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

## 安全与限制

- 仅交互TTY，不从管道批量读取回答；自动化可按示例手工生成配置后进行既有显式运行。
- 只新建明确的绝对路径；父目录需已存在且可信，拒已有文件和最终symlink，不自动创建父目录、改默认配置或覆盖本地模型配置。
- 0600是本机文件权限，不是加密或同UID沙箱；中间路径仍依赖可信父目录。
- 本地校验与创建可离线执行，不发网络请求、不读取Pi配置或真实环境值。
