param(
  [string]$TaskName = "FeishuCodexBridge",
  [string]$WorkingDirectory = "C:\trae project\Economic",
  [string]$NodeExe = "node.exe"
)

$scriptPath = Join-Path $WorkingDirectory "dist\index.js"
$action = New-ScheduledTaskAction -Execute $NodeExe -Argument $scriptPath -WorkingDirectory $WorkingDirectory
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Description "Feishu Codex operator with approval-gated local execution" `
  -Force
