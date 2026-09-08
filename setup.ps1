# Windows launcher: use Git Bash, never the unrelated WSL bash.exe on PATH.
[CmdletBinding()]
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$SetupArguments)
$ErrorActionPreference = 'Stop'
try {
    $candidates = @()
    $gitCommand = Get-Command git.exe -ErrorAction SilentlyContinue
    if ($gitCommand) {
        $gitDirectory = Split-Path -Parent $gitCommand.Source
        $candidates += Join-Path $gitDirectory '../bin/bash.exe'
        $candidates += Join-Path $gitDirectory '../../bin/bash.exe'
    }
    foreach ($installRoot in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
        if ($installRoot) { $candidates += Join-Path $installRoot 'Git/bin/bash.exe' }
    }
    $gitBash = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if (-not $gitBash) { throw 'Git Bash was not found. Install Git for Windows, then run setup.cmd again.' }
    Push-Location $PSScriptRoot
    try {
        & $gitBash './setup.sh' @SetupArguments
        $setupExitCode = $LASTEXITCODE
    } finally { Pop-Location }
    exit $setupExitCode
} catch {
    Write-Error $_ -ErrorAction Continue
    exit 1
}
