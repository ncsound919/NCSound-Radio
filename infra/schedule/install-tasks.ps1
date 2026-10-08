# Register the station's Scheduled Tasks (roadmap E3 backup, E4 health check).
#
#   pwsh -File infra/schedule/install-tasks.ps1
#
# Uses Register-ScheduledTask, not `schtasks /TR`: schtasks strips the quotes
# around a path containing spaces, so the task then fails with 0x80070002
# ("file not found") because it split "Radio and DJ" on the space.
#
# Re-runnable (-Force overwrites). Remove with:
#   Unregister-ScheduledTask -TaskName "NCSound Backup","NCSound Health" -Confirm:$false
#
# Both run as the current user, only while that user is logged on — the station
# PC is an interactive machine. Logs land in %LOCALAPPDATA%\ncsound\.

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$backup = Join-Path $here "backup.cmd"
$health = Join-Path $here "health.cmd"

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName "NCSound Backup" `
  -Action (New-ScheduledTaskAction -Execute $backup) `
  -Trigger (New-ScheduledTaskTrigger -Daily -At 4:00AM) `
  -Settings $settings `
  -Description "NCSound station-state backup (roadmap E3): SQLite snapshot + session/audit files." `
  -Force | Out-Null

Register-ScheduledTask -TaskName "NCSound Health" `
  -Action (New-ScheduledTaskAction -Execute $health) `
  -Trigger (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 5) `
    -RepetitionDuration (New-TimeSpan -Days 3650)) `
  -Settings $settings `
  -Description "NCSound station health check (roadmap E4): polls ingest /status, logs JSON." `
  -Force | Out-Null

Write-Output "--- registered ---"
Get-ScheduledTask -TaskName "NCSound Backup", "NCSound Health" |
  Select-Object TaskName, State |
  Format-Table -AutoSize | Out-String
