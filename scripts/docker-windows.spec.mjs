import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url)), parent = join(root, '.tmp/setup-dependency-tests')
mkdirSync(parent, { recursive: true })
// 在函数边界替换下载、安装和引擎命令；测试不修改宿主软件或 Docker 服务。
for (const mode of ['ready', 'cold', 'missing', 'check', 'download-failure', 'reboot', 'windows']) {
  test(`Windows dependency preparation: ${mode}`, { skip: process.platform !== 'win32' }, () => {
    const dir = mkdtempSync(join(parent, 'run-')), script = join(dir, 'test.ps1')
    writeFileSync(script, `\uFEFF
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
. '${join(root, 'scripts/docker-windows.ps1').replaceAll("'", "''")}'
$mode='${mode}'; $calls=[Collections.Generic.List[object]]::new()
$installed=$mode -in 'ready','cold','windows'
$engine=if($mode -eq 'ready'){'linux'}elseif($mode -eq 'windows'){'windows'}else{''}
function Find-DockerCommand { return $script:installed }
function Read-DockerEngine { return $script:engine }
function Initialize-WSL { $script:calls.Add(@{kind='wsl'}) }
function Invoke-WebRequest($Uri,$OutFile,[switch]$UseBasicParsing) {
  $script:calls.Add(@{kind='download';uri=$Uri})
  if($mode -eq 'download-failure'){throw 'download failed'}
}
function Start-Process($FilePath,$ArgumentList,$WindowStyle,[switch]$Wait,[switch]$PassThru) {
  $script:calls.Add(@{kind='install';flags=$ArgumentList;hidden=($WindowStyle -eq 'Hidden')})
  $script:installed=$true
  return @{ExitCode=$(if($mode -eq 'reboot'){3010}else{0})}
}
function Invoke-Docker {
  $script:calls.Add(@{kind='start';arguments=$args}); $script:engine='linux'
}
$errorText=$null
try { Initialize-Docker ($mode -ne 'check') '${dir.replaceAll("'", "''")}' } catch { $errorText=$_.Exception.Message }
@{calls=@($calls.ToArray());error=$errorText}|ConvertTo-Json -Depth 5 -Compress
`, 'utf8')
    const run = spawnSync('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-File',script], { encoding:'utf8',timeout:20_000 })
    assert.ifError(run.error); assert.equal(run.status, 0, run.stderr)
    const result = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1))
    const kinds = result.calls.map(c => c.kind)
    if (mode === 'ready') { assert.deepEqual(kinds, []); assert.equal(result.error, null) }
    if (mode === 'cold') { assert.deepEqual(kinds, ['wsl','start']); assert.equal(result.error, null) }
    if (mode === 'missing') {
      assert.deepEqual(kinds, ['wsl','download','install','start']); assert.equal(result.error, null)
      assert.match(result.calls[1].uri, /^https:\/\/desktop\.docker\.com\/win\/main\/(amd64|arm64)\//)
      assert.ok(result.calls[2].hidden)
      assert.ok(result.calls[2].flags.includes('--user'))
      assert.ok(!result.calls[2].flags.includes('--accept-license'))
    }
    if (mode === 'check') { assert.deepEqual(kinds, []); assert.match(result.error, /未安装 Docker/u) }
    if (mode === 'download-failure') { assert.deepEqual(kinds, ['wsl','download']); assert.equal(result.error, 'download failed') }
    if (mode === 'reboot') { assert.deepEqual(kinds, ['wsl','download','install']); assert.match(result.error, /重启 Windows/u) }
    if (mode === 'windows') { assert.deepEqual(kinds, []); assert.match(result.error, /Linux 容器/u) }
  })
}

for (const mode of ['ready', 'missing', 'old', 'reboot', 'failure', 'not-ready']) {
  test(`WSL dependency preparation: ${mode}`, { skip: process.platform !== 'win32' }, () => {
    const dir = mkdtempSync(join(parent, 'run-')), script = join(dir, 'test.ps1')
    writeFileSync(script, `\uFEFF
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
. '${join(root, 'scripts/docker-windows.ps1').replaceAll("'", "''")}'
$mode='${mode}'; $calls=[Collections.Generic.List[object]]::new()
$version=if($mode -eq 'ready'){'2.1.5'}elseif($mode -eq 'old'){'1.2.5'}else{$null}
function Read-WSLVersion { if($script:version){return [version]$script:version} }
function wsl.exe { throw 'test must not invoke WSL' }
function Start-Process($FilePath,$ArgumentList,$Verb,$WindowStyle,[switch]$Wait,[switch]$PassThru) {
  $script:calls.Add(@{program=$FilePath;flags=$ArgumentList;verb=$Verb;hidden=($WindowStyle -eq 'Hidden')})
  if($mode -ne 'not-ready'){$script:version='2.6.1'}
  return @{ExitCode=$(if($mode -eq 'reboot'){3010}elseif($mode -eq 'failure'){1}else{0})}
}
$errorText=$null
try { Initialize-WSL } catch { $errorText=$_.Exception.Message }
@{calls=@($calls.ToArray());error=$errorText}|ConvertTo-Json -Depth 5 -Compress
`, 'utf8')
    const run = spawnSync('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-File',script], { encoding:'utf8',timeout:20_000 })
    assert.ifError(run.error); assert.equal(run.status, 0, run.stderr)
    const result = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1))
    if (mode === 'ready') { assert.deepEqual(result.calls, []); assert.equal(result.error, null); return }
    assert.equal(result.calls.length, 1)
    const call = result.calls[0]
    assert.equal(call.program, 'wsl.exe'); assert.equal(call.verb, 'RunAs'); assert.ok(call.hidden)
    assert.deepEqual(call.flags, mode === 'old' ? ['--update'] : ['--install','--no-distribution'])
    if (['missing','old'].includes(mode)) assert.equal(result.error, null)
    if (mode === 'reboot') assert.match(result.error, /重启 Windows/u)
    if (mode === 'failure') assert.match(result.error, /WSL 准备失败/u)
    if (mode === 'not-ready') assert.match(result.error, /WSL 尚未就绪/u)
  })
}
