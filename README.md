# 曙光智慧（Shuguang Intelligence）

独立数字伙伴原型，包含同一主体的六核心、交流、持久记忆和有界自主学习。Pi只是交流窗口，不是主体本身。

## 1. 部署并启动（WSL / Linux终端）

需要Git、可用的Docker引擎和Compose v2。**Node、Pi和曙光扩展由镜像提供，不用在WSL另装。** 使用Docker Desktop时，先启动它并启用对应WSL发行版集成。

先检查环境，两条命令都成功再继续：

```bash
docker info >/dev/null
docker compose version
```

首次获取项目并启动：

```bash
git clone https://github.com/swordfate3/shuguang-intelligence.git
cd shuguang-intelligence
bash start.sh
```

已有仓库直接进入原目录；使用旧版本时先检查本地修改并更新。仓库根目录应包含`start.sh`和`compose.yaml`。

首次运行会构建镜像（需要联网下载），然后打开设置向导：

| 设置项 | 填写说明 |
|---|---|
| 主体名称 | 默认“曙光”，可直接Enter |
| 共享调用上限 | 默认20次，交流和学习共用；是次数，不是金额 |
| API地址 | 供应商的OpenAI Chat Completions兼容根地址，通常以`/v1`结尾，不填完整`/chat/completions`路径 |
| 模型ID | 填供应商支持的准确ID，不会自动猜测或联网查询 |
| 思考档位 | 默认`off`，仅省略推理参数，不保证模型关闭思考 |
| 确认 | 核对预览，输入`yes`才创建缺失文件 |
| API key | 隐藏输入，Enter保存；不要粘进聊天或命令参数 |

默认附带两目标示例学习资料、学习子额度4次（计入总额度）、模型进程内上限4次和30秒超时。设置不测试API、不唤醒、不生成或开始学习。中断后再次启动只补缺项，不覆盖旧主体/配置；如果报部分初始化或权限错误，先检查，不删库重试。

## 2. 在容器里的Pi交流

启动成功后，当前终端会显示 **Docker容器内的Pi输入框**，不是WSL上或当前开发会话的Pi。连接和扩展已自动配置，不用执行`pi install`。

在**Pi输入框**先输入：

```text
/dawn status
```

通知区会显示状态和版本。新主体初始为`sleeping`；**仅当返回状态版本0时**，执行：

```text
/dawn wake 0
```

已有主体用刚查询的真实版本替换0，已`awake`则跳过。确认资料披露和费用后，才发送：

```text
/dawn say 你好，曙光。
```

回复目前在**通知区**。常用命令：

| Pi输入框命令 | 作用 |
|---|---|
| `/dawn status` | 查询曙光状态/版本，不调用模型 |
| `/dawn model-status` | 查看曙光模型、思考档位和进程次数 |
| `/dawn model` | 选择曙光模型；联网刷新目录前会确认 |
| `/dawn thinking` | 选择曙光思考档位 |
| `/quit` | 退出Pi回到WSL终端；曙光服务仍运行 |

**普通输入仍发给Pi，只有`/dawn say`发给曙光并消耗其额度。** `/model`改变Pi自己的模型，不等于`/dawn model`。Pi自己的认证不继承宿主，也不复用曙光key；使用Pi普通AI聊天需在容器Pi里单独配置（支持的供应商可用`/login`）。

## 3. 日常使用（WSL / Linux终端）

以下命令均在原仓库目录执行：

```bash
bash start.sh          # 启动或复用服务，进入容器Pi；不重新初始化
bash start.sh status   # 查看容器状态
bash start.sh stop     # 需要关闭服务时才执行，保留全部卷
```

若只想查询服务、不进入Pi：

```bash
docker compose exec dawn dawn-container status
docker compose exec dawn dawn-container budget
```

容器`running`不等于主体`awake`，status成功也不代表模型API有效。启动失败先查看：

```bash
docker compose ps -a
docker compose logs --tail 30 dawn
```

不要用say探测健康；失败或取消也可能消耗次数，不自动重发。Pi没有`/dawn`时，确认打开的是`bash start.sh`启动的容器Pi，并检查镜像是否已更新。

## 4. 运行一次学习（可选，会调用模型）

先在Pi里查询状态，必要时按真实版本wake，再`/quit`退出。确认示例资料发送给模型供应商及最多4次阶段调用费用后，**停止全部同库服务和旧学习进程**，在WSL终端执行：

```bash
bash start.sh stop
docker compose run --rm --no-deps dawn learning-run
```

学习在前台选题、练习、独立测验并保存结果。Ctrl+C取消；`compose stop`不会停止另一个一次性学习进程，须在其终端取消并确认退出。结束后`bash start.sh`恢复交流。崩溃pending不会自动重发，不要并行启动或盲目恢复；完成不等于全部通过，也不证明长期学习效果。

## 5. 更新与数据

确认学习进程等都退出、保存Pi工作后，在WSL终端执行：

```bash
bash start.sh stop
git status --short     # 有本地修改先处理，不用reset覆盖
git pull --ff-only origin main
bash start.sh build
bash start.sh
```

- 主体/记忆/预算/密钥在`dawn-data`卷，Pi配置/会话在`pi-home`卷，工作文件在`pi-work`卷；不自动挂载或迁移宿主数据。
- 停止和重建镜像不会清空卷。**不要执行`docker compose down -v`、删除卷或volume prune。** 保持仓库目录、Compose项目名和Docker引擎一致，避免连到另一组空卷。
- 不重复初始化、不自动迁移或覆盖key。setup只补缺项，不提供原地换key/一键备份；备份或人工迁移前停全部写入者并关库，不覆盖唯一原库。卷不加密。
- 模型选择重启后恢复配置值；重启不能补回永久调用额度，也不会自动运行学习。容器重启后需要再次`bash start.sh`。

**验证状态：**已有合成测试，当前开发环境没有Docker，尚未实际验证镜像构建、WSL/Compose运行或容器Pi，也没有发布预构建镜像。已收到Pi首次下载fd/ripgrep超时与曙光UNAVAILABLE的反馈，尚未修复/定位；本版不包含这两项修复。真实模型兼容性与学习效果需另行验证，不视为生产部署认证。
