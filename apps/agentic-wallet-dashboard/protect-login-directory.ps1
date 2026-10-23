$ErrorActionPreference = 'Stop'
$taskPrivate = Join-Path $PSScriptRoot '.private'
New-Item -ItemType Directory -Path $taskPrivate -Force | Out-Null
$taskOwnerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$taskAllowedSids = @($taskOwnerSid, 'S-1-5-18')
# Change only this application's DACL; do not request SACL/security-audit privileges.
& icacls.exe $taskPrivate /grant:r ('*' + $taskOwnerSid + ':(OI)(CI)F') '*S-1-5-18:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'LOGIN_DIRECTORY_PERMISSION_FAILED' }
& icacls.exe $taskPrivate /inheritance:r | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'LOGIN_DIRECTORY_PERMISSION_FAILED' }
$taskAccess = (Get-Acl -LiteralPath $taskPrivate).GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
foreach ($taskRuleSid in @($taskAccess.IdentityReference.Value | Select-Object -Unique)) {
  if ($taskRuleSid -notin $taskAllowedSids) {
    & icacls.exe $taskPrivate /remove ('*' + $taskRuleSid) | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'LOGIN_DIRECTORY_PERMISSION_FAILED' }
  }
}
& icacls.exe $taskPrivate /setowner ('*' + $taskOwnerSid) | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'LOGIN_DIRECTORY_OWNER_FAILED' }
$taskProtectedAcl = Get-Acl -LiteralPath $taskPrivate
$taskProtectedRules = @($taskProtectedAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
if (-not $taskProtectedAcl.AreAccessRulesProtected -or $taskProtectedRules.Count -ne 2) { throw 'LOGIN_DIRECTORY_VERIFICATION_FAILED' }
foreach ($taskRule in $taskProtectedRules) {
  if ($taskRule.IdentityReference.Value -notin $taskAllowedSids -or $taskRule.AccessControlType -ne 'Allow' -or $taskRule.FileSystemRights -ne 'FullControl') { throw 'LOGIN_DIRECTORY_VERIFICATION_FAILED' }
}
