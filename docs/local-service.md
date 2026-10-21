# 独立本机控制服务

本阶段把本体持久状态接到独立前台进程，再由 Pi 作为薄客户端访问。带有界对话历史与持久调用额度的模型交流可显式启用，尚无自主活动。以下命令是使用说明，本次开发没有创建正式主体或安装服务。

> 下方示例是legacy `--db/--chat-db`。六核心采用 `serve --subject-db /absolute/subject.sqlite`，没有chat sidecar；显式新建与数据披露差异见[主体运行接线](subject-runtime.md)。endpoint/token/协议不变，现有Pi薄客户端可连接任一明确选择的服务。

## 不依赖Pi的独立客户端（0.1.0）

服务启动后，可在另一终端运行：

```bash
npm start -- request --endpoint http://127.0.0.1:7341 --token-file /absolute/private/service.token -- status
npm start -- request --endpoint http://127.0.0.1:7341 --token-file /absolute/private/service.token -- say "你好"
```

--后只允许status、wake/sleep加安全整数revision、say加单个完整消息参数。endpoint与token-file必须显式提供，不发现环境、不创建库或拉起服务。输出应用error时退出码1；成功response退出0。SIGINT/SIGTERM传播取消，响应丢失或取消后仍应查状态确认，不自动重试。HTTP client与命令解析由dawn拥有，Pi只复用实现。

## 显式准备与启动

在项目目录下，手动执行：

```bash
DATA="$HOME/.local/share/shuguang-intelligence"
mkdir -p -m 700 "$DATA"  # 已有目录需另外确认权限及所有者
npm start -- init --db "$DATA/dawn.sqlite" --id dawn-local --name 曙光
npm start -- token-init --token-file "$DATA/service.token"
npm start -- serve --db "$DATA/dawn.sqlite" --token-file "$DATA/service.token" --port 7341
```

- 如数据库或 token 已存在，不重复 init；创建操作拒绝覆盖。
- token 文件必须是当前用户拥有的私有普通文件，不接受最终路径 symlink。新文件权限 0600；父目录必须可信且私有。
- token 不出现在命令行参数或正常输出。服务就绪只输出 endpoint、实例 ID 与模型配置状态，不含密钥。
- `--port 0` 可让系统选择临时端口，主要用于测试；插件必须配置实际端口。
- Ctrl+C 或 SIGTERM 关闭服务与连接，等待运行请求清理并释放 SQLite。不隐式 sleep，也不删除数据。
- 进程启动不自动 wake；重启恢复上次持久生命周期字段。awake 不代表自主推理已启用。

## Pi 连接

插件使用显式 `DAWN_ENDPOINT` 和 `DAWN_TOKEN_FILE`，不猜测端口、不搜索凭据、不读取 Pi 模型配置。建议写在仅供本次启动的包装脚本或宿主进程配置中，不依赖交互 shell export：

```sh
#!/bin/sh
DAWN_ENDPOINT=http://127.0.0.1:7341 \
DAWN_TOKEN_FILE="$HOME/.local/share/shuguang-intelligence/service.token" \
exec pi -e /workspace/projects/shuguang-intelligence/packages/pi-extension/src/index.ts "$@"
```

包装脚本只是示例，本次没有写入用户安装目录或修改 Pi 配置。插件注册时不启动进程、监听网络或调用模型。

服务已单独启动且插件被用户显式加载后：

```text
/dawn status
/dawn wake 0
/dawn sleep 1
/dawn say 你好
```

先 status 获取当前 revision，示例数字不能盲目复用。未配模型时 say 返回 NOT_IMPLEMENTED；配模型后须先 wake，从已绑定对话库接续最近的完整问答，保存成功对话与调用台账。关闭 Pi 仅断开客户端，不休眠/终止独立服务。

## 限制

- 必须同时附加 `--model-config /absolute/path/model.json --chat-db /absolute/path/chat.sqlite` 才能启用模型；先通过 `chat-init --db ... --chat-db ... --limit N` 创建对话库。额度不会随重启重置，详见[对话记录与预算](dialogue-memory.md)、[模型接入说明](model-api.md)。
- 当前只连接已启动服务，Pi 尚不负责自动拉起服务进程。这是未来启动开关的剩余工作，不应把 wake 标记当成创建后台进程。
- 所有持有 token 的本机客户端都具有当前控制权限；暂未细分只读、控制或聊天权限，不适合多人或不可信插件共享。
- 服务不防御恶意同 UID 进程，不加密本机 HTTP，不提供系统服务安装或自动重启。
- 进程内请求串行化，SQLite CAS 跨连接防覆盖；未实现跨进程独占运行租约，不应同时为同一数据库启动多个自主运行器。
- 数据库同步操作无法即时抢占；客户端超时、取消和断线不证明变更未提交。参见[协议](protocol.md)。
