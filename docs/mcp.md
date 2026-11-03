# MCP传输契约：HTTPS与本地stdio（开发分支）

本文件是协议与安全设计，不是第二份安装教程；客户端配置和部署统一见根[README](../README.md)。无依赖受限实现，不宣称完整MCP认证。

## Pi资源包与服务的边界

可选`packages/pi-package`用Pi资源清单分发连接管理扩展和shuguang skill。MCP连接管理调用原生`registerMcpServer`/`unregisterMcpServer`：在显式配置、有交互UI并确认后注册HTTPS URL与环境凭据引用，或本地兼容Docker exec入口，默认只读，安装/加载不连接。配置与确认不包含服务token/model key，不启动主体、不恢复旧/dawn、不注册对话代理工具。

这是宿主MCP注册入口，不是新的Dawn wire或可信检索执行桥；不会继承其他工具或自动读Pi历史。实验性`/shuguang-share`用户命令另走独立私有桥，只在准确预览授权后读取当前分支有限text；不注册为MCP工具，需显式新v4/独立owner凭据，默认v3不支持。注册成功不等于网络连接成功；文件mcp.json同名配置优先，第三方适配器是否消费动态注册需核对。详细使用只在根README。

## 生命周期与能力

- UTF-8、按换行分帧的JSON-RPC2.0，stdout只用于协议，固定脱敏诊断到stderr。
- `initialize`协商版本并返回`serverInfo`与`capabilities:{tools:{}}`；`notifications/initialized`之后可列举/调用工具。支持ping；未知request方法返回协议错误，notification不回包。
- 只有tools；不支持resources/prompts/logging/sampling/elicitation/tasks。新增HTTP MCP网关单独提供 `/mcp`，内部Dawn `/v1/request` 仍不是MCP。
- 无参数工具接受省略arguments或空对象；精确schema、额外工具字段拒绝、安全整数与文本上限都在可信程序检查，不只依赖模型遵循schema。
- 当前工具列表不动态变化，不公布listChanged。注解只是提示，不能代替授权或逐次确认。

## HTTPS Streamable HTTP边界（D-026）

- HTTP网关是独立adapter，经可信TLS反代提供HTTPS。POST接收单JSON-RPC消息并返回单JSON；notification成功202空正文，GET405，不提供SSE／事件重放。initialize返回随机session，后续持续鉴权并校验session／版本，DELETE仅删除接入会话。
- 独立远程Bearer与内部service token不同；固定Host与public URL对应，Origin若存在只能准确匹配配置origin，不信任转发头。默认监听127.0.0.1，只有可信反代部署才显式0.0.0.0；明文网关不得公网发布。不提供OAuth／多用户ACL，持token的可信客户端代表同一owner。
- 输入64KiB／fatal UTF8、响应256KiB、有限session／并发／超时，固定脱敏错误。HTTP断开不是协议取消，不自动重复派发；显式cancel、DELETE或期限不能撤回已提交状态或退款。重连后未知写入先查状态，session不是持久幂等键。
- `--allow-write`由服务端决定；Pi客户端可以再收窄工具暴露，不能升级服务端权限。客户端HTTPS模式不需要Docker／宿主路径。私有来源与研究owner桥不在远程普通MCP内，远程share/research失败关闭，不会fallback本地Docker。
- 容器默认不发布端口；可选overlay显式部署网关，经只读原卷取凭据、共享Dawn网络而不打开DB。卷管理员可信，不声称对同UID或部署管理员防秘密读取。具体配置仅在根README。

## stdio资源与取消边界

输入单帧≤64KiB、最多8个in-flight；取消但transport未结束仍占槽，不因取消释放后无限替换请求。输出单帧≤256KiB、队列≤16帧/1MiB，有背压，溢出结束会话并取消在途任务。这些数值是项目约束，不是MCP统一标准。

`notifications/cancelled`按原ID取消非initialize请求。EOF、流关闭、SIGINT/SIGTERM/root abort停止桥接；未完整最后一行丢弃，不再接纳迟到回复。取消不保证上游立即停工、数据库未提交、供应商撤回或额度退款。不自动重试或恢复pending。

## 暴露与数据

- 默认只有status/model_status；启动时显式`--allow-write`才列举并允许另外六个工具。此开关是可信stdio宿主的本地暴露策略，**不是底层service token的细粒度ACL**；同UID/任意Docker执行权限可绕开，不将其当安全沙箱。
- MCP启动仅读显式endpoint/token，不导入model.env、不读取模型或Pi认证、不打开SQLite、不自动启动本体/wake/学习。
- 写工具可能持久改状态、消耗不可退款额度、向模型供应商发消息或联网取目录。启用写权限不是用户对任意消息的授权，宿主应设置适当确认/资料范围和次数。
- 返回的文字进入客户端上下文，可能发往其供应商；不输出完整主体、私密记忆、配置或原始上游异常。合法模型回复仍是不可信文本，不作为宿主指令。
- `shuguang_say`参数`message`映射既有`DawnRequest.text`，当前owner经历语义不变。**不得自动批量导入Pi/user/web消息或冒充可信来源分离**。来源导入及v5有界研究任务账本走独立typed私有桥；普通远程MCP不自动获得该授权。

## 工具与原协议

| MCP名称 | DawnRequest.type | 权限 |
|---|---|---|
| shuguang_status | status | 只读 |
| shuguang_model_status | model-status | 只读缓存 |
| shuguang_say | say | 写/生成 |
| shuguang_wake / shuguang_sleep | wake / sleep | 写/主体revision |
| shuguang_model_list | model-list | 写/联网刷新 |
| shuguang_model_select | model-select | 写/选择revision |
| shuguang_thinking_select | thinking-select | 写/选择revision |

每个工具派发生成独立随机requestId；MCP请求ID不是持久恰好一次键。活动重复ID不重新派发。主体与模型选择revision不同，不能混用；模型选择只在服务进程内，服务重启归配置值，不重置DB永久预算。工具执行错误返回固定脱敏isError；协议错误与上游业务错误分别处理。

## 私有桥与未交付范围

能力接口设计及最新实现见[宿主能力与检索学习契约v0](host-capabilities.md)：v4来源及v5公开manifest/search有界闭环已做合成验证；不等于真实供应商验证、完整web.fetch或远程owner桥已提供。HTTPS普通对话不要求迁移旧数据库；来源／研究的显式v4／v5与正式迁移限制仍保持。

用户目标是曙光从获准的用户/Pi交流学习，并经Pi执行公开检索。MCP本身不能自动读取会话或继承其他MCP的工具，需要Pi侧/通用宿主执行桥。应先实现明确来源/授权/撤销、任务唯一ID与预算/超时/停止、检索原文与模型总结分离，再考虑客户端离线执行方；不直接开放全部工具或shell。既有pack学习闭环保留，不用简单总结冒充独立验证。

参考：[官方生命周期](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)、[传输](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)、[工具](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)、[取消](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation)。
