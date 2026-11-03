# 独立本机控制服务契约

部署与使用只维护根[README](../README.md)。本文件描述底层服务边界，不是另一份源码部署教程。

## 进程与持久状态

- `serve`显式启动前台服务，打开已有SQLite，不创建、迁移、重建数据库或自动wake。
- 六核心模式使用显式`--subject-db`，交流v2/学习v3/实验性来源v4同主体库；legacy `--db/--chat-db`保留兼容行为，不与新模式混用。
- 持久awake字段不是存活心跳，也不是后台自主活动。关闭MCP客户端或桥接只取消其在途请求，不隐式sleep或停止本体。
- 原有有界本地pack学习仍由显式前台runner执行；同库运行/恢复的管理边界不因MCP接入放宽。

## 鉴权与传输

- 既有底层服务只监听`127.0.0.1`，处理`POST /v1/request`，不是HTTP MCP endpoint。
- 强制独立service token、精确Host、拒绝Origin、有界UTF8/JSON与字段校验。token不同于模型API key，不打印或自动发现。
- `HttpDawnTransport`和`DawnClient`由dawn拥有；MCP只依赖该客户端契约，core/runtime不依赖MCP宿主。
- 默认控制请求10秒、say客户端40秒/服务端35秒；模型独立≤30秒。取消/断线不证明未提交，不能自动重试写操作。
- 实验性`/host/v1/request`另需显式新v4及独立owner凭据，不由service token升级。私有host协议v1按socket配对短期executor，分开owner授权/撤销与executor接收/消费/查询；默认不启用，不自动升级旧库。不是HTTP MCP，细节见[宿主能力](host-capabilities.md)。
- 原`/v1/request`的service token是单一权限。MCP的只读/`--allow-write`是桥接暴露限制，不是服务端细粒度鉴权，也不保护恶意同UID进程或能运行任意Docker命令的宿主。

## MCP入口

本分支删除`packages/pi-extension`，改由`packages/mcp`提供stdio桥接。客户端通过子进程通信，容器场景以`docker compose exec -T`在现有服务容器运行桥接，不发布控制端口、不复制token、不注入model.env。

仅支持有界tools能力；无自动会话采集/检索委派/HTTP MCP/sampling。MCP握手与工具调用不意味着对话学习授权；`say`仍是旧owner消息语义，不能用于冒充来源分离的代理对话导入。

详细接口及版本边界见[MCP契约](mcp.md)与[底层协议v1](protocol.md)。

## 运行限制

没有跨进程独占租约、恰好一次交付、自动重试/恢复/迁移/加密保证；多个客户端共享同一主体和永久预算，CAS只防过期覆盖。备份/学习恢复前停止全部写入者，不能以MCP连接状态当数据库独占锁。UNAVAILABLE仍是多类错误的固定脱敏响应，尚未提供精细诊断。
