$ErrorActionPreference = 'Stop'
$taskNode = (Get-Command node -ErrorAction Stop).Source
$taskPrivate = Join-Path $PSScriptRoot '.private'
if (Test-Path -LiteralPath (Join-Path $taskPrivate 'owner.json')) { throw '登录已配置；未覆盖。请按 README 重置。' }
& (Join-Path $PSScriptRoot 'protect-login-directory.ps1')
Write-Host '设置独立看板密码（16–256 字符）。请勿使用 Binance 密码。不会设置或请求 Binance 授权。'
$taskFirst = Read-Host '新看板密码' -AsSecureString
$taskSecond = Read-Host '再次输入' -AsSecureString
$taskPtrOne = [IntPtr]::Zero
$taskPtrTwo = [IntPtr]::Zero
try {
  $taskPtrOne = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($taskFirst)
  $taskPtrTwo = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($taskSecond)
  $taskTextOne = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskPtrOne)
  $taskTextTwo = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskPtrTwo)
  if ($taskTextOne -cne $taskTextTwo) { throw '两次输入不一致。' }
  @{ password = $taskTextOne } | ConvertTo-Json -Compress | & $taskNode (Join-Path $PSScriptRoot 'server\setup.mjs')
  if ($LASTEXITCODE -ne 0) { throw '未完成设置。' }
} finally {
  if ($taskPtrOne -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskPtrOne) }
  if ($taskPtrTwo -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskPtrTwo) }
  $taskTextOne = $null; $taskTextTwo = $null
  $taskFirst.Dispose(); $taskSecond.Dispose()
}
