#!/usr/bin/env bash
# Linux/WSL launcher. It only orchestrates Docker; configuration stays inside the container.
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd "$ROOT"
command=${1:-start}
if (( $# > 1 )); then printf '%s\n' '用法：bash start.sh [start|status|stop|build|help]' >&2; exit 1; fi
case "$command" in
  help|-h|--help)
    cat <<'HELP'
曙光智慧 — WSL/Linux + Docker
  bash start.sh          首次配置后启动并进入 Pi；已有服务直接连接
  bash start.sh status   查看容器状态
  bash start.sh stop     正常停止，不删除任何卷
  bash start.sh build    停止服务后显式构建/更新镜像，下次启动生效
首次构建需要联网下载基础镜像和依赖；不会在 WSL 安装 Node/Pi。
退出 Pi 后服务继续运行；不自动唤醒、生成、学习或恢复 pending。
HELP
    exit 0 ;;
  start|status|stop|build) ;;
  *) printf '%s\n' '未知命令；请运行 bash start.sh help。' >&2; exit 1 ;;
esac
if ! command -v docker >/dev/null 2>&1; then
  printf '%s\n' '未找到 Docker。请先在此 WSL/Linux 终端启用可用的 Docker。' >&2; exit 1
fi
if ! docker compose version >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  printf '%s\n' 'Docker 引擎或 Compose v2 不可用。请检查 WSL 集成/当前用户权限；脚本不会自动使用 sudo 或安装。' >&2; exit 1
fi
compose() { docker compose --project-directory "$ROOT" -f "$ROOT/compose.yaml" "$@"; }
case "$command" in
  status) compose ps -a; exit ;;
  stop) compose stop dawn; exit ;;
esac
running=$(compose ps --status running -q dawn)
if [[ "$command" == build ]]; then
  if [[ -n "$running" ]]; then
    printf '%s\n' '服务正在运行。请先 bash start.sh stop；这也会关闭容器中的 Pi，请先保存工作。' >&2; exit 1
  fi
  compose build dawn
  printf '%s\n' '镜像已构建。运行 bash start.sh 启动；现有主体与配置不会重建。'
  exit 0
fi
if [[ ! -t 0 || ! -t 1 ]]; then
  printf '%s\n' '启动/首次配置需要交互终端（TTY），不要通过管道执行。' >&2; exit 1
fi
if [[ -z "$running" ]]; then
  image=$(compose config --images)
  if [[ -z "$image" || "$image" == *$'\n'* ]]; then
    printf '%s\n' '无法确定唯一服务镜像，请检查 compose.yaml。' >&2; exit 1
  fi
  if ! docker image inspect "$image" >/dev/null 2>&1; then
    printf '%s\n' '首次使用：正在构建容器镜像（需要联网下载，可能耗时几分钟）……'
    compose build dawn
  fi
  # setup validates existing files or prompts only for missing steps. Failure never starts serve.
  compose run --rm --no-deps dawn setup
  compose up -d --no-build dawn
else
  printf '%s\n' '检测到已运行的服务，直接连接；不重新配置或重建。'
fi
ready=false
# Each status call is bounded by the existing control-client timeout. No model request is made.
for (( attempt=0; attempt<5; attempt++ )); do
  if compose exec -T dawn dawn-container status >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  printf '%s\n' '服务未在就绪检查内响应。未打开 Pi、未自动重试生成。请查看 docker compose logs --tail 30 dawn。' >&2; exit 1
fi
printf '%s\n' '曙光服务已就绪。即将进入 Pi；退出 Pi 不会停止服务。' \
  'Pi 输入框用 /dawn status 查询；休眠时用 /dawn wake <当前版本>。' \
  '只有 /dawn say … 发给曙光，普通输入仍发给 Pi。'
compose exec dawn dawn-container pi
