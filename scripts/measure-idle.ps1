# Measures ROG's CPU and memory over a window while it sits idle.
# Usage: powershell -File scripts/measure-idle.ps1 [-Seconds 30]
param([int]$Seconds = 30)

function Get-RogProcesses {
  Get-CimInstance Win32_Process | Where-Object {
    ($_.Name -eq 'electron.exe' -and $_.CommandLine -like '*Rog My assistant*') -or
    ($_.Name -eq 'powershell.exe' -and $_.CommandLine -like '*speech-host.ps1*') -or
    ($_.Name -eq 'ROG.exe')
  }
}

$start = @{}
foreach ($p in Get-RogProcesses) { $start[$p.ProcessId] = (Get-Process -Id $p.ProcessId).TotalProcessorTime.TotalMilliseconds }
Start-Sleep -Seconds $Seconds

$rows = foreach ($p in Get-RogProcesses) {
  $gp = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
  if (-not $gp -or -not $start.ContainsKey($p.ProcessId)) { continue }
  $type = if ($p.CommandLine -match '--type=([\w-]+)') { $matches[1] } elseif ($p.Name -eq 'powershell.exe') { 'speech-host' } else { 'main' }
  [pscustomobject]@{
    Type           = $type
    Id             = $p.ProcessId
    'CPU% (1 core)' = [math]::Round((($gp.TotalProcessorTime.TotalMilliseconds - $start[$p.ProcessId]) / ($Seconds * 1000)) * 100, 2)
    PrivateMB      = [int]($gp.PrivateMemorySize64 / 1MB)
    WorkingSetMB   = [int]($gp.WorkingSet64 / 1MB)
  }
}
$rows | Sort-Object Type | Format-Table -AutoSize
'TOTAL CPU: {0}% of one core ({1} logical cores)' -f [math]::Round(($rows | Measure-Object 'CPU% (1 core)' -Sum).Sum, 2), [Environment]::ProcessorCount
'TOTAL private: {0} MB, working set: {1} MB' -f ($rows | Measure-Object PrivateMB -Sum).Sum, ($rows | Measure-Object WorkingSetMB -Sum).Sum
