# 启动前只准备宿主 Docker；Node、pnpm、Python、uv 由各 Dockerfile 安装。
function Find-DockerCommand {
    if (Get-Command docker -ErrorAction SilentlyContinue) { return $true }
    foreach ($directory in @("$env:LOCALAPPDATA\Programs\DockerDesktop\resources\bin", "$env:ProgramFiles\Docker\Docker\resources\bin")) {
        if (Test-Path -LiteralPath (Join-Path $directory 'docker.exe')) {
            $env:PATH = "$directory;$env:PATH"
            return $true
        }
    }
    return $false
}
function Install-DockerDesktop([string]$cacheDirectory) {
    New-Item -ItemType Directory -Path $cacheDirectory -Force | Out-Null
    $architecture = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'amd64' }
    $installer = Join-Path $cacheDirectory 'Docker Desktop Installer.exe'
    Write-Host '正在从 Docker 官方下载并安装 Docker Desktop（包含 Compose）……'
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest -UseBasicParsing -Uri "https://desktop.docker.com/win/main/$architecture/Docker%20Desktop%20Installer.exe" -OutFile $installer
    $process = Start-Process -FilePath $installer -ArgumentList @('install', '--user', '--quiet', '--backend=wsl-2') -WindowStyle Hidden -Wait -PassThru
    if ($process.ExitCode -in 3010, 1641) { throw 'Docker 安装需要重启 Windows；重启后再次运行 start.cmd 即可继续。' }
    if ($process.ExitCode -ne 0) { throw "Docker 安装未完成（退出码 $($process.ExitCode)），请按安装提示处理后重试。" }
    Write-Host 'Docker 已安装。首次运行如出现许可、WSL 或管理员提示，请完成该系统步骤；需要重启时重启后再次运行 start.cmd。'
}
function Read-DockerEngine {
    $ErrorActionPreference = 'Continue'
    $engine = & docker info --format '{{.OSType}}' 2>$null
    if ($LASTEXITCODE -eq 0) { return $engine }
}
function Read-WSLVersion {
    if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) { return }
    $ErrorActionPreference = 'Continue'
    $versionText = (& wsl.exe --version 2>$null) -join "`n"
    if ($LASTEXITCODE -eq 0 -and $versionText.Replace("`0", '') -match '\d+\.\d+\.\d+(\.\d+)?') { return [version]$Matches[0] }
}
function Initialize-WSL {
    $version = Read-WSLVersion
    if ($version -and $version -ge [version]'2.1.5') { return }
    if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) { throw '当前 Windows 未提供 WSL 安装入口；请更新 Windows 后再次运行 start.cmd。' }
    [string[]]$wslArguments = if ($version) { @('--update') } else { @('--install', '--no-distribution') }
    Write-Host '正在准备 WSL 2，请允许 Windows 管理员授权；无需安装 Linux 发行版。'
    $process = Start-Process -FilePath 'wsl.exe' -ArgumentList $wslArguments -Verb RunAs -WindowStyle Hidden -Wait -PassThru
    if ($process.ExitCode -in 3010, 1641) { throw 'WSL 安装需要重启 Windows；重启后再次运行 start.cmd 即可继续。' }
    if ($process.ExitCode -ne 0) { throw "WSL 准备失败（退出码 $($process.ExitCode)）；请完成系统提示后重新运行 start.cmd。" }
    # 安装完成后重新读取版本；功能启用尚待重启时，不继续安装和启动 Docker。
    $version = Read-WSLVersion
    if (-not $version -or $version -lt [version]'2.1.5') { throw 'WSL 尚未就绪；请完成 Windows 更新或重启后再次运行 start.cmd。' }
}
function Initialize-Docker([bool]$allowChanges, [string]$cacheDirectory) {
    $installed = Find-DockerCommand
    if (-not $installed -and -not $allowChanges) { throw '未安装 Docker。运行 start.cmd 会自动下载安装；检查和管理命令不安装软件。' }
    $engine = if ($installed) { Read-DockerEngine } else { $null }
    if (-not $engine -and $allowChanges) {
        Initialize-WSL
        if (-not $installed) {
            Install-DockerDesktop $cacheDirectory
            if (-not (Find-DockerCommand)) { throw 'Docker 安装后尚未找到命令；请完成系统提示并重新运行 start.cmd。' }
        }
        Write-Host '正在启动 Docker Desktop，等待 Linux 引擎就绪……'
        Invoke-Docker desktop start --timeout 120
        $engine = Read-DockerEngine
    }
    if (-not $engine) { throw 'Docker 引擎尚未就绪；请完成 Docker Desktop 的首次设置或系统重启后，再运行 start.cmd。' }
    if ($engine -ne 'linux') { throw '请将 Docker Desktop 切换为 Linux 容器。' }
}
