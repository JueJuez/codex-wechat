param([ValidateSet('start', 'login', 'doctor', 'check', 'smoke', 'background', 'stop', 'status', 'send-test')][string]$Action = 'start')
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not $env:SystemRoot) { $env:SystemRoot = 'C:\Windows' }
if (-not $env:WINDIR) { $env:WINDIR = $env:SystemRoot }
if (-not $env:ComSpec) { $env:ComSpec = Join-Path $env:SystemRoot 'System32\cmd.exe' }
if (-not (Test-Path -LiteralPath 'node_modules/typescript/bin/tsc')) {
  & npm.cmd ci --ignore-scripts
  if ($LASTEXITCODE -ne 0) { throw '安装依赖失败' }
}
& node node_modules/typescript/bin/tsc -p vendor/wechat-core/tsconfig.build.json
if ($LASTEXITCODE -ne 0) { throw '构建失败' }
& node node_modules/typescript/bin/tsc -p tsconfig.integration.json
if ($LASTEXITCODE -ne 0) { throw '微信文件接口类型检查失败' }
if ($Action -eq 'check') { & node --test 'test/*.test.mjs' }
elseif ($Action -eq 'smoke') { & node scripts/smoke.mjs }
elseif ($Action -eq 'send-test') { & node scripts/send-test-file.mjs }
else { & node src/cli.mjs $Action }
exit $LASTEXITCODE
