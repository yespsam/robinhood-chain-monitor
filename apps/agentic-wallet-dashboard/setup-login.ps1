# Local desktop password setup. The owner types the password; no password is supplied by an agent.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$taskOwnerPath = Join-Path $PSScriptRoot '.private\owner.json'
if (Test-Path -LiteralPath $taskOwnerPath) {
  [System.Windows.Forms.MessageBox]::Show('看板密码已配置，未作覆盖。请回到浏览器使用 owner 登录。', 'Agentic Wallet 看板') | Out-Null
  exit
}
$taskNode = (Get-Command node -ErrorAction Stop).Source
& (Join-Path $PSScriptRoot 'protect-login-directory.ps1')
[System.Windows.Forms.Application]::EnableVisualStyles()
$taskForm = New-Object System.Windows.Forms.Form
$taskForm.Text = '设置本地看板登录 · 真实交易仍禁用'
$taskForm.ClientSize = New-Object System.Drawing.Size(540, 350)
$taskForm.StartPosition = 'CenterScreen'
$taskForm.FormBorderStyle = 'FixedDialog'
$taskForm.MaximizeBox = $false
$taskForm.MinimizeBox = $false
$taskForm.TopMost = $true
$taskForm.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10)
$taskDescription = New-Object System.Windows.Forms.Label
$taskDescription.Location = New-Object System.Drawing.Point(24, 18)
$taskDescription.Size = New-Object System.Drawing.Size(492, 64)
$taskDescription.Text = "由你本人设置独立看板密码（16–256 字符）。`n不要使用 Binance 密码，也不要将密码发到聊天。`n这里只开启本地登录，不连接钱包或开启交易。"
$taskFirstLabel = New-Object System.Windows.Forms.Label
$taskFirstLabel.Text = '新看板密码'
$taskFirstLabel.Location = New-Object System.Drawing.Point(24, 98)
$taskFirstLabel.AutoSize = $true
$taskPasswordOne = New-Object System.Windows.Forms.TextBox
$taskPasswordOne.Location = New-Object System.Drawing.Point(24, 123)
$taskPasswordOne.Width = 492
$taskPasswordOne.MaxLength = 256
$taskPasswordOne.UseSystemPasswordChar = $true
$taskSecondLabel = New-Object System.Windows.Forms.Label
$taskSecondLabel.Text = '再次输入'
$taskSecondLabel.Location = New-Object System.Drawing.Point(24, 164)
$taskSecondLabel.AutoSize = $true
$taskPasswordTwo = New-Object System.Windows.Forms.TextBox
$taskPasswordTwo.Location = New-Object System.Drawing.Point(24, 189)
$taskPasswordTwo.Width = 492
$taskPasswordTwo.MaxLength = 256
$taskPasswordTwo.UseSystemPasswordChar = $true
$taskStatus = New-Object System.Windows.Forms.Label
$taskStatus.Location = New-Object System.Drawing.Point(24, 230)
$taskStatus.Size = New-Object System.Drawing.Size(492, 40)
$taskStatus.Text = '用户名固定为 owner。密码只用于此本地看板。'
$taskSubmit = New-Object System.Windows.Forms.Button
$taskSubmit.Text = '设置密码并开放本地登录'
$taskSubmit.Location = New-Object System.Drawing.Point(24, 282)
$taskSubmit.Size = New-Object System.Drawing.Size(330, 42)
$taskCancel = New-Object System.Windows.Forms.Button
$taskCancel.Text = '取消'
$taskCancel.Location = New-Object System.Drawing.Point(370, 282)
$taskCancel.Size = New-Object System.Drawing.Size(146, 42)
$taskCancel.Add_Click({ $taskForm.Close() })
$taskSubmit.Add_Click({
  if ($taskPasswordOne.Text.Length -lt 16 -or $taskPasswordOne.Text.Length -gt 256) { $taskStatus.Text = '密码须为 16–256 字符。'; return }
  if ($taskPasswordOne.Text -cne $taskPasswordTwo.Text) { $taskStatus.Text = '两次输入不一致。'; return }
  $taskSubmit.Enabled = $false
  $taskChild = $null
  $taskPayload = $null
  try {
    $taskStartInfo = New-Object System.Diagnostics.ProcessStartInfo
    $taskStartInfo.FileName = $taskNode
    $taskStartInfo.Arguments = '"' + (Join-Path $PSScriptRoot 'server\setup.mjs') + '"'
    $taskStartInfo.UseShellExecute = $false
    $taskStartInfo.CreateNoWindow = $true
    $taskStartInfo.RedirectStandardInput = $true
    $taskStartInfo.StandardInputEncoding = [System.Text.UTF8Encoding]::new($false)
    $taskStartInfo.RedirectStandardOutput = $true
    $taskStartInfo.RedirectStandardError = $true
    $taskChild = New-Object System.Diagnostics.Process
    $taskChild.StartInfo = $taskStartInfo
    $taskChild.Start() | Out-Null
    $taskPayload = @{password = $taskPasswordOne.Text} | ConvertTo-Json -Compress
    $taskPasswordOne.Clear(); $taskPasswordTwo.Clear()
    $taskChild.StandardInput.WriteLine($taskPayload)
    $taskChild.StandardInput.Close()
    $taskPayload = $null
    $taskChild.StandardOutput.ReadToEnd() | Out-Null
    $taskChild.StandardError.ReadToEnd() | Out-Null
    $taskChild.WaitForExit()
    if ($taskChild.ExitCode -ne 0) { throw 'SETUP_FAILED' }
    [System.Windows.Forms.MessageBox]::Show('独立看板密码已保存。请回到浏览器使用 owner 登录。钱包仍未连接，真实交易仍禁用。', '设置完成') | Out-Null
    $taskForm.Close()
  } catch {
    $taskStatus.Text = '设置未完成。若已有配置，不会覆盖。请查看项目说明。'
    $taskSubmit.Enabled = $true
  } finally {
    $taskPayload = $null
    $taskPasswordOne.Clear(); $taskPasswordTwo.Clear()
    if ($null -ne $taskChild) { $taskChild.Dispose() }
  }
})
$taskForm.Controls.AddRange(@($taskDescription, $taskFirstLabel, $taskPasswordOne, $taskSecondLabel, $taskPasswordTwo, $taskStatus, $taskSubmit, $taskCancel))
$taskForm.AcceptButton = $taskSubmit
$taskForm.CancelButton = $taskCancel
$taskForm.Add_Shown({
  $taskForm.Activate()
  $taskPasswordOne.Select()
  [Console]::WriteLine('PASSWORD_SETUP_WINDOW_READY')
})
try { $taskForm.ShowDialog() | Out-Null } finally { $taskPasswordOne.Clear(); $taskPasswordTwo.Clear(); $taskForm.Dispose() }
