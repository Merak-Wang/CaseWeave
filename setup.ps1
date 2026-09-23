# Windows 原生入口：直接调用 Docker Compose，不需要 Git Bash、Node 或 Python。
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$SetupArguments)
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$script:exitCode = 1
$stage = '环境检查'
$envFile = Join-Path $PSScriptRoot '.env'
$action = ''; $device = ''; $nonInteractive = $false; $checkOnly = $false; $build = $true

function Show-Usage {
    Write-Host @'
用法：start.cmd [选项] 或 setup.cmd [install|start|stop|status|logs] [选项]
  不带参数 / start   自动构建更新并启动；首次使用自动初始化
  install           完整准备模型、数据及索引，已有文件和进度继续复用
  stop/status/logs  停止（保留数据卷）、查看状态或最近日志
  --gpu / --cpu     保存设备选择并执行完整准备
  --env-file PATH   指定配置文件（默认仓库根目录 .env）
  --non-interactive 缺少配置时失败，不等待输入
  --check           只检查 Docker 与已有配置，不修改或启动
  --no-build        显式跳过构建，复用已有镜像
'@
}
function Invoke-Docker {
    & docker @args
    if ($LASTEXITCODE -ne 0) { $script:exitCode = $LASTEXITCODE; throw 'Docker 命令未完成。' }
}
function Invoke-Compose { Invoke-Docker compose --env-file $envFile @args }
. (Join-Path $PSScriptRoot 'scripts/docker-windows.ps1')
function Read-Config {
    # Compose 负责 dotenv 展开；只在内存读取结果，密钥不进入控制台。
    $ErrorActionPreference = 'Continue'
    $resolved = & docker compose --env-file $envFile config --environment 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'Compose 配置解析失败，请检查本地 .env 和 COMPOSE_FILE。' }
    $script:config = @{}
    foreach ($line in $resolved) {
        $pair = $line -split '=', 2
        if ($pair.Count -eq 2) { $script:config[$pair[0]] = $pair[1] }
    }
}
function Test-ComposeConfig {
    $ErrorActionPreference = 'Continue'
    & docker compose --env-file $envFile config --quiet 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'Compose 配置校验失败，请检查本地配置。' }
}
function Save-Value([string]$key, [string]$value) {
    $lines = [IO.File]::ReadAllLines($envFile) | Where-Object { $_ -notmatch ('^\s*(export\s+)?' + $key + '\s*[:=]') }
    $quoted = $value.Replace('\', '\\').Replace('"', '\"').Replace('$', '$$')
    [IO.File]::WriteAllText($envFile, (($lines + ($key + '="' + $quoted + '"')) -join "`n") + "`n", [Text.UTF8Encoding]::new($false))
}
function Read-Input([string]$label, [bool]$secret = $false) {
    if ([Console]::IsInputRedirected) {
        Write-Host ($label + '：') -NoNewline
        $value = [Console]::ReadLine()
        if ($null -eq $value) { throw '未收到输入；自动运行请使用 --non-interactive 和已填写的 .env。' }
        return $value
    }
    if (-not $secret) { return Read-Host $label }
    $secure = Read-Host $label -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}
function Ask-Value([string]$key, [string]$label, [bool]$secret = $false) {
    if ($script:config[$key]) { return }
    if ($nonInteractive) { throw "缺少配置：$key。请填写配置文件后重试。" }
    do { $value = Read-Input $label $secret } while (-not $value)
    Save-Value $key $value
    Read-Config
    if (-not $script:config[$key]) { throw "配置 $key 被宿主空环境变量覆盖，请取消该环境变量后重试。" }
}
function Step([string]$label, [string[]]$command) {
    $script:stage = $label
    Write-Host "`n$label"
    Invoke-Compose @command
}

Push-Location $PSScriptRoot
try {
    for ($i = 0; $i -lt $SetupArguments.Count; $i++) {
        $item = $SetupArguments[$i]
        switch ($item) {
            { $_ -in 'install', 'start', 'stop', 'status', 'logs' } {
                if ($action) { throw '一次只能执行一个操作。' }; $action = $item
            }
            '--gpu' { $device = 'gpu' }
            '--cpu' { $device = 'cpu' }
            '--env-file' { $i++; if ($i -ge $SetupArguments.Count) { throw '--env-file 缺少路径。' }; $envFile = $SetupArguments[$i] }
            '--non-interactive' { $nonInteractive = $true }
            '--check' { $checkOnly = $true; $nonInteractive = $true }
            '--no-build' { $build = $false }
            { $_ -in '--help', '-h' } { Show-Usage; exit 0 }
            default { throw "未知选项：$item" }
        }
    }
    if (-not $action) { if ($device -or $checkOnly -or -not $build) { $action = 'install' } else { $action = 'start' } }
    if ($checkOnly -and $device) { throw '--check 不修改设备配置，请单独运行 --gpu 或 --cpu。' }
    if ($action -in 'stop', 'status', 'logs' -and ($device -or $checkOnly -or -not $build)) { throw '日常管理操作只接受 --env-file 和 --non-interactive。' }
    if ($action -eq 'start' -and ($device -or $checkOnly)) { $action = 'install' }
    Initialize-Docker ($action -in 'start', 'install' -and -not $checkOnly) (Join-Path $PSScriptRoot '.cache/setup')
    if (-not [IO.Path]::IsPathRooted($envFile)) { $envFile = Join-Path $PSScriptRoot $envFile }
    $envFile = [IO.Path]::GetFullPath($envFile)
    # 缺配置或从未创建应用时进入首次准备；直接复用 Compose 状态，不另建完成标记。
    if ($action -eq 'start') {
        if (-not (Test-Path -LiteralPath $envFile)) { $action = 'install' }
        elseif (@(Invoke-Compose ps --all --services) -notcontains 'app') { $action = 'install' }
    }
    if ($action -eq 'install') {
        $version = Invoke-Docker compose version --short
        if ($version -notmatch '^v?(\d+)\.(\d+)' -or [int]$Matches[1] -lt 2 -or ([int]$Matches[1] -eq 2 -and [int]$Matches[2] -lt 20)) { throw '需要 Docker Compose v2.20 或更新版本。' }
    }
    $created = -not (Test-Path -LiteralPath $envFile)
    if ($created) {
        if ($checkOnly -or $action -ne 'install') { throw '配置文件不存在，请运行 start.cmd 完成首次初始化。' }
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot '.env.example') -Destination $envFile
        Write-Host "已创建配置：$envFile"
    }
    $stage = '读取配置'; Read-Config
    $port = $script:config.RETRIEVAL_AGENT_WEB_PORT; if (-not $port) { $port = '3080' }
    if ($action -ne 'install') {
        Test-ComposeConfig
        switch ($action) {
            'start' {
                if ($build) { Step '构建应用、算子和模型服务更新（复用 Docker 缓存）' @('build', 'app', 'semantic-operators', 'model-service') }
                Step '启动更新后的服务，等待健康检查' @('up', '-d', '--wait', '--no-build', '--pull', 'never', 'app')
                Write-Host "`n工作台已启动：http://127.0.0.1:$port/retrieval"
            }
            'stop' { Step '停止当前项目服务' @('stop', '--timeout', '60'); Write-Host '服务已停止，容器和数据卷保留。下次运行 start.cmd。' }
            'status' { Invoke-Compose ps --all }
            'logs' { Invoke-Compose logs --tail 100 app model-service semantic-operators }
        }
        exit 0
    }
    if ($created -and -not $nonInteractive -and -not $device) {
        $device = Read-Input '本地 embedding 设备 [cpu/gpu，默认 cpu]'
        if (-not $device) { $device = 'cpu' }
        if ($device -notin 'cpu', 'gpu') { throw '设备只能填写 cpu 或 gpu。' }
    }
    if ($device) {
        if ($script:config.COMPOSE_PATH_SEPARATOR -ne ';') { throw '设备选择需要 COMPOSE_PATH_SEPARATOR=;。' }
        $gpuFile = 'config/model-service/compose.gpu.yml'
        $files = @($script:config.COMPOSE_FILE -split ';' | Where-Object { $_ -ne $gpuFile })
        if ($device -eq 'gpu') { $files += $gpuFile }
        Save-Value 'COMPOSE_FILE' ($files -join ';')
        $env:COMPOSE_FILE = $files -join ';'; Read-Config
    }
    $stage = '模型服务配置'
    Ask-Value 'RETRIEVAL_AGENT_BROWSER_LLM_PROVIDER' '模型服务的 DSH Provider 标识'
    Ask-Value 'RETRIEVAL_AGENT_BROWSER_LLM_MODEL' '模型名称'
    Ask-Value 'RETRIEVAL_AGENT_BROWSER_LLM_BASE_URL' '模型 API 地址（http:// 或 https://）'
    if (-not $script:config.RETRIEVAL_AGENT_BROWSER_LLM_API_KEY_ENV -and -not $checkOnly) {
        Save-Value 'RETRIEVAL_AGENT_BROWSER_LLM_API_KEY_ENV' 'RETRIEVAL_AGENT_MAIN_MODEL_API_KEY'; Read-Config
    }
    if ($script:config.RETRIEVAL_AGENT_BROWSER_LLM_API_KEY_ENV -ne 'RETRIEVAL_AGENT_MAIN_MODEL_API_KEY') { throw 'API_KEY_ENV 必须为 RETRIEVAL_AGENT_MAIN_MODEL_API_KEY。' }
    Ask-Value 'RETRIEVAL_AGENT_MAIN_MODEL_API_KEY' 'API 密钥（输入不回显，仅写入本地配置）' $true
    if ($script:config.RETRIEVAL_AGENT_BROWSER_LLM_BASE_URL -notmatch '^https?://\S+$') { throw '模型 API 地址必须是完整的 http:// 或 https:// 地址。' }
    Test-ComposeConfig
    if ($checkOnly) { Write-Host '仅完成 Docker/配置检查；未下载、构建、启动或验证主模型 API。'; exit 0 }
    if ($build) { Step '[1/8] 构建应用、算子和模型服务镜像' @('build', 'app', 'semantic-operators', 'model-service') }
    else { Write-Host '[1/8] 使用已有镜像' }
    Step '[2/8] 下载并校验模型（首次下载可能较慢）' @('run', '--rm', '--no-deps', 'model-prepare', 'prepare', '--download')
    Step '[3/8] 启动数据库、算子与模型服务，等待健康检查' @('up', '-d', '--wait', '--no-build', 'mysql', 'milvus', 'model-service', 'semantic-operators')
    Step '[4/8] 下载数据、清洗脱敏并校验' @('run', '--rm', '--no-deps', 'app-prepare')
    Step '[5/8] 导入工单并建立向量索引（支持续跑）' @('run', '--rm', '--no-deps', 'app-prepare', 'node', 'scripts/database.mjs', 'prepare')
    Step '[6/8] 准备关键词索引' @('run', '--rm', '--no-deps', 'app-prepare', 'node', 'scripts/database.mjs', 'grams')
    Step '[7/8] 验证数据与检索索引' @('run', '--rm', '--no-deps', 'app-prepare', 'node', 'scripts/database.mjs', 'verify')
    Step '[8/8] 启动工作台，等待健康检查' @('up', '-d', '--wait', '--no-build', 'app')
    Write-Host "`n部署完成：http://127.0.0.1:$port/retrieval"
    exit 0
} catch {
    [Console]::Error.WriteLine("未完成：$stage（退出码 $script:exitCode）。$($_.Exception.Message) 已保留数据卷和下载进度；修复后重试同一入口。")
    exit $script:exitCode
} finally { Pop-Location }
