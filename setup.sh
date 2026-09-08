#!/usr/bin/env bash
# Shared installer for Linux and Git for Windows. Never source .env as shell code.
set +x
set -Eeuo pipefail
umask 077

usage() {
  cat <<'HELP'
Usage: bash setup.sh [install|start|stop|status|logs] [options]
  install（默认）     首次安装或代码更新：配置、构建、下载校验、预处理并启动
  start              日常启动已有镜像，等待健康检查；不构建、不下载、不重建索引
  stop               停止当前项目服务，保留容器和数据卷
  status             查看当前项目的容器状态
  logs               查看应用和模型服务最近 100 行日志
安装选项（重复安装复用配置、数据卷、下载文件和索引进度）：
  --gpu / --cpu       选择并保存本地 embedding 设备，GPU 不可用时明确失败
  --env-file PATH     使用指定配置文件（默认仓库根目录 .env）
  --non-interactive   缺少配置时失败，不等待输入
  --check             仅检查 Docker 和已有配置，不修改文件或启动服务
  --no-build          复用已有应用/模型镜像，适合重复安装检查
HELP
}

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd -- "$root"
env_file="$root/.env"
non_interactive=false check_only=false build=true device='' action=''
while (($#)); do
  case "$1" in
    install|start|stop|status|logs)
      [[ -z $action ]] || { printf '%s\n' '一次只能执行一个操作。' >&2; exit 2; }
      action=$1 ;;
    --gpu) device=gpu ;;
    --cpu) device=cpu ;;
    --env-file) (($# >= 2)) || { usage >&2; exit 2; }; env_file=$2; shift ;;
    --non-interactive) non_interactive=true ;;
    --check) check_only=true; non_interactive=true ;;
    --no-build) build=false ;;
    --help|-h) usage; exit 0 ;;
    *) printf '未知选项：%s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done
action=${action:-install}
if [[ $action != install ]] && { [[ -n $device ]] || $check_only || ! $build; }; then
  printf '%s\n' '日常操作只接受 --env-file 和 --non-interactive；安装选项请配合 install 使用。' >&2; exit 2
fi
if $check_only && [[ -n $device ]]; then
  printf '%s\n' '--check 不修改设备配置，请单独运行 --gpu 或 --cpu。' >&2; exit 2
fi

stage='环境检查'
failed() {
  local code=$?
  trap - ERR
  printf '\n未完成：%s（退出码 %s）。已保留数据卷和下载进度；修复错误后重新运行同一入口。\n' "$stage" "$code" >&2
  exit "$code"
}
trap failed ERR
die() { printf '%s\n' "$1" >&2; return 1; }
command -v docker >/dev/null || die '未找到 Docker。请先安装并启动 Docker Desktop 或 Docker Engine。'
version=$(docker compose version --short) || die '需要 Docker Compose v2.20 或更新版本。'
if [[ ! $version =~ ^v?([0-9]+)\.([0-9]+) ]] || ((BASH_REMATCH[1] < 2 || (BASH_REMATCH[1] == 2 && BASH_REMATCH[2] < 20))); then
  die '需要 Docker Compose v2.20 或更新版本。'
fi
engine=$(docker info --format '{{.OSType}}') || die '无法连接 Docker。请启动 Docker Desktop 或检查 Docker Engine 的访问权限。'
[[ $engine == linux ]] || die '请将 Docker Desktop 切换为 Linux 容器。'

created=false
if [[ ! -f $env_file ]]; then
  [[ $action == install ]] || die '尚无配置文件。首次使用请运行 setup.cmd 或 bash setup.sh 完成安装。'
  $check_only && die '配置文件不存在。先运行安装向导，或复制 .env.example 并填写模型配置。'
  cp -- "$root/.env.example" "$env_file"
  created=true
  printf '已创建配置：%s\n' "$env_file"
fi
env_file=$(cd -- "$(dirname -- "$env_file")" && printf '%s/%s' "$PWD" "$(basename -- "$env_file")")
compose() { docker compose --env-file "$env_file" "$@"; }

# Compose parses interpolation/quoting itself. Keep resolved credentials off stdout.
load_config() {
  resolved=$(compose config --environment 2>/dev/null) || die 'Compose 配置解析失败。请在本地检查 .env 和 COMPOSE_FILE；为避免泄露密钥，此处不打印配置内容。'
}
value_of() {
  local key value
  while IFS='=' read -r key value; do
    if [[ $key == "$1" ]]; then printf '%s' "$value"; return; fi
  done <<< "$resolved"
}
save_value() {
  local key=$1 value=$2 line temporary
  [[ $value != *$'\n'* && $value != *$'\r'* ]] || die '配置项必须是单行文本。'
  temporary=$(mktemp "${env_file}.setup.XXXXXX")
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line =~ ^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*[:=] ]] && continue
    printf '%s\n' "$line"
  done < "$env_file" > "$temporary"
  # Docker dotenv double quotes: escape backslashes/quotes and preserve literal $.
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//\$/\$\$}
  printf '%s="%s"\n' "$key" "$value" >> "$temporary"
  mv -- "$temporary" "$env_file"
}
ask_value() {
  local key=$1 label=$2 secret=${3:-false} value
  value=$(value_of "$key")
  [[ -z $value ]] || return 0
  $non_interactive && die "缺少配置：$key。请填写配置文件后重试。"
  while [[ -z $value ]]; do
    printf '%s：' "$label" >&2
    if $secret; then
      IFS= read -r -s value || die '未收到输入；自动化运行请使用 --non-interactive 和已填写的 .env。'
      printf '\n' >&2
    else
      IFS= read -r value || die '未收到输入；自动化运行请使用 --non-interactive 和已填写的 .env。'
    fi
    value=${value%$'\r'}
  done
  save_value "$key" "$value"
  load_config
  [[ -n $(value_of "$key") ]] || die "配置 $key 被宿主环境中的空值覆盖，请取消该环境变量后重试。"
}

stage='模型服务配置'
load_config
if [[ $action != install ]]; then
  # Operational commands must also work when credentials need repair, so they
  # bypass the installation wizard and never edit .env or prepare data/models.
  compose config --quiet 2>/dev/null || die 'Compose 配置校验失败，请检查本地配置。'
  case "$action" in
    start)
      stage='启动已有服务（缺少镜像或初始化数据时请先运行安装入口）'
      printf '%s\n' "$stage"
      compose up -d --wait --no-build --pull never app
      port=$(value_of RETRIEVAL_AGENT_WEB_PORT); port=${port:-3080}
      printf '\n工作台已启动：http://127.0.0.1:%s/retrieval\n' "$port" ;;
    stop)
      stage='停止当前项目服务'
      compose stop --timeout 60
      printf '%s\n' '服务已停止，容器和数据卷保留。下次运行 setup.cmd start 或 bash setup.sh start。' ;;
    status)
      stage='读取服务状态'
      compose ps --all ;;
    logs)
      stage='读取最近日志'
      compose logs --tail 100 app model-service ;;
  esac
  exit 0
fi
if $created && ! $non_interactive && [[ -z $device ]]; then
  printf '本地 embedding 设备 [cpu/gpu，默认 cpu]：' >&2
  IFS= read -r device || die '未收到设备选择。'
  device=${device%$'\r'}; device=${device:-cpu}
  [[ $device == cpu || $device == gpu ]] || die '设备只能填写 cpu 或 gpu。'
fi
if [[ -n $device ]]; then
  files=$(value_of COMPOSE_FILE)
  separator=$(value_of COMPOSE_PATH_SEPARATOR)
  [[ $separator == ';' ]] || die '设备选择需要 COMPOSE_PATH_SEPARATOR=;，与 .env.example 保持一致。'
  gpu_file='config/model-service/compose.gpu.yml'
  IFS=';' read -r -a entries <<< "$files"
  files=''
  for entry in "${entries[@]}"; do
    [[ $entry == "$gpu_file" ]] && continue
    files="${files:+$files;}$entry"
  done
  [[ $device != gpu ]] || files="$files;$gpu_file"
  save_value COMPOSE_FILE "$files"
  export COMPOSE_FILE="$files"
  load_config
fi

ask_value RETRIEVAL_AGENT_BROWSER_LLM_PROVIDER '模型服务的 DSH Provider 标识'
ask_value RETRIEVAL_AGENT_BROWSER_LLM_MODEL '模型名称'
ask_value RETRIEVAL_AGENT_BROWSER_LLM_BASE_URL '模型 API 地址（http:// 或 https://）'
api_key_env=$(value_of RETRIEVAL_AGENT_BROWSER_LLM_API_KEY_ENV)
if [[ -z $api_key_env ]] && ! $check_only; then
  save_value RETRIEVAL_AGENT_BROWSER_LLM_API_KEY_ENV RETRIEVAL_AGENT_MAIN_MODEL_API_KEY
  load_config
  api_key_env=$(value_of RETRIEVAL_AGENT_BROWSER_LLM_API_KEY_ENV)
fi
[[ $api_key_env == RETRIEVAL_AGENT_MAIN_MODEL_API_KEY ]] || die '容器配置需要 RETRIEVAL_AGENT_BROWSER_LLM_API_KEY_ENV=RETRIEVAL_AGENT_MAIN_MODEL_API_KEY。'
ask_value RETRIEVAL_AGENT_MAIN_MODEL_API_KEY 'API 密钥（输入不回显，仅写入本地配置）' true
base_url=$(value_of RETRIEVAL_AGENT_BROWSER_LLM_BASE_URL)
[[ $base_url =~ ^https?://[^[:space:]]+$ ]] || die '模型 API 地址必须是完整的 http:// 或 https:// 地址。'
compose config --quiet 2>/dev/null || die 'Compose 配置校验失败，请检查本地配置。'
project=$(value_of COMPOSE_PROJECT_NAME)
port=$(value_of RETRIEVAL_AGENT_WEB_PORT); port=${port:-3080}
printf '配置检查通过，Compose 项目：%s，工作台端口：%s。\n' "$project" "$port"
if $check_only; then
  printf '%s\n' '仅完成 Docker/配置检查；未下载、构建、启动或验证主模型 API。'
  exit 0
fi

step() {
  stage=$1; shift
  printf '\n%s\n' "$stage"
  compose "$@"
}
if $build; then
  step '[1/8] 构建应用和模型服务镜像' build app model-service
else
  printf '\n[1/8] 使用已有镜像\n'
fi
step '[2/8] 下载并校验模型（首次下载可能较慢）' run --rm --no-deps model-prepare prepare --download
step '[3/8] 启动数据库与模型服务，等待健康检查' up -d --wait mysql milvus model-service
step '[4/8] 下载数据、清洗脱敏并校验' run --rm --no-deps app-prepare
step '[5/8] 导入工单并建立向量索引（按进度输出，支持续跑）' run --rm --no-deps app-prepare node scripts/database.mjs prepare
step '[6/8] 准备关键词索引' run --rm --no-deps app-prepare node scripts/database.mjs grams
step '[7/8] 验证数据与检索索引' run --rm --no-deps app-prepare node scripts/database.mjs verify
step '[8/8] 启动工作台，等待健康检查' up -d --wait app
printf '\n部署完成：http://127.0.0.1:%s/retrieval\n' "$port"
printf '%s\n' '请在工作台提交一次查询，确认主模型服务实际可用。关闭终端不会停止后台服务。'
