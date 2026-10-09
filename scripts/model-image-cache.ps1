# 模型镜像仅随自身构建输入更新，工作台源码和文案不进入这个指纹。
function Get-ModelBuildFingerprint([string]$root, [string]$uvImage) {
    $inputs = @('config/model-service/Dockerfile', 'config/model-service/Dockerfile.dockerignore',
        'pyproject.toml', 'uv.lock', 'python/evals/pyproject.toml',
        'python/model-service/pyproject.toml', 'python/model-service/README.md',
        'python/semantic-operators/pyproject.toml', 'architecture/model-manifest.json',
        'config/query-domain-lexicon.json')
    $source = Join-Path $root 'python/model-service/src'
    foreach ($file in Get-ChildItem -LiteralPath $source -Recurse -File) {
        if ($file.FullName -notmatch '[\\/]__pycache__[\\/]') {
            $inputs += $file.FullName.Substring($root.TrimEnd('\', '/').Length + 1).Replace('\', '/')
        }
    }
    $content = "UV_IMAGE=$uvImage`n"
    $sha = [Security.Cryptography.SHA256]::Create()
    foreach ($path in ($inputs | Sort-Object)) {
        $hash = ([BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes((Join-Path $root $path))))).Replace('-', '')
        $content += "$path=$hash`n"
    }
    try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($content)))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}
function Test-ModelImageCurrent([string]$image, [string]$fingerprint) {
    $ErrorActionPreference = 'Continue'
    $recorded = & docker image inspect --format '{{json .Config.Labels}}' $image 2>$null
    if ($LASTEXITCODE -ne 0) { return $false }
    $labels = ([string]$recorded) | ConvertFrom-Json
    return $labels.'org.caseweave.model-inputs' -eq $fingerprint
}
