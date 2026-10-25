# Rana service menu and shared service watchdog.
#   (no args)                 interactive menu
#   --all --no-pause          start every missing service
#   --all --no-pause --skip-gateway  start missing services except the official gateway task
#   --dry-run                 show status and start nothing
#   --watchdog                one hidden watchdog cycle (scheduled every five minutes)

$ErrorActionPreference = 'Continue'
$argsLower = @($args | ForEach-Object { "$($_)".Trim().ToLowerInvariant() })
$AutoAll = ($argsLower -contains '--all') -or ($argsLower -contains '--no-pause')
$NoPause = $argsLower -contains '--no-pause'
$DryRun = $argsLower -contains '--dry-run'
$Watchdog = $argsLower -contains '--watchdog'
$SkipGateway = $argsLower -contains '--skip-gateway'
$HiddenLaunch = $Watchdog -or $AutoAll

$ROOT = 'C:\Users\Administrator\.openclaw'
$MUSIC = Join-Path $ROOT 'workspace\services\music_core'
$OLLAMA_EXE = 'C:\Users\Administrator\AppData\Local\Programs\Ollama\ollama.exe'
$EMBEDDING_DIR = Join-Path $ROOT '_review\embeddinggemma2\llama-b11630'
$EMBEDDING_EXE = Join-Path $EMBEDDING_DIR 'llama-server.exe'
$EMBEDDING_MODEL = Join-Path $ROOT '_review\embeddinggemma2\model\embeddinggemma-2-Q8_0.gguf'
$LAVALINK_JAVA = 'C:\Program Files\Microsoft\jdk-21.0.10.7-hotspot\bin\java.exe'
if (-not (Test-Path -LiteralPath $LAVALINK_JAVA)) { $LAVALINK_JAVA = 'java' }
$LIVE_PYTHON = 'D:\Users\Administrator\miniconda3\python.exe'
$WATCHDOG_DIR = Join-Path $ROOT 'logs\watchdog'
$WATCHDOG_LOG = Join-Path $WATCHDOG_DIR ('watchdog_' + (Get-Date -Format 'yyyyMMdd') + '.log')
$WATCHDOG_STATE = Join-Path $WATCHDOG_DIR 'restart-state.json'
$NOTIFICATION_STATE = Join-Path $WATCHDOG_DIR 'notification-state.json'
$PAUSE_ALL = Join-Path $ROOT 'watchdog.pause'
$RESTART_API = 'D:\_Project\LoLCoachBench\lolcoach\scripts\restart_api.ps1'
$PATCH_PENDING = 'D:\_Project\LoLCoachBench\lolcoach\data\patch_pending.json'

$env:RANA_VISION_BASE_URL = 'http://192.168.50.3:6970'
$env:RANA_VISION_FALLBACK_BASE_URL = 'http://100.99.83.84:6970'
if (-not $env:RANA_VISION_DEBUG) { $env:RANA_VISION_DEBUG = '0' }

function Test-Port([int]$Port) {
  $client = New-Object System.Net.Sockets.TcpClient
  try { $task = $client.ConnectAsync('127.0.0.1', $Port); return ($task.Wait(1000) -and $client.Connected) }
  catch { return $false } finally { $client.Close() }
}

function Test-Http([string]$Url) {
  try { $null = Invoke-RestMethod -Uri $Url -TimeoutSec 2; return $true } catch { return $false }
}

function Test-Live {
  try { $h = Invoke-RestMethod -Uri 'http://127.0.0.1:8080/health' -TimeoutSec 2; return ($h.service -eq 'online') } catch { return $false }
}

function Test-Lolcoach { return (Test-Http 'http://127.0.0.1:8790/health') }

function Test-Swarm {
  return [bool](Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'swarm_master\.py' })
}

function Get-ServiceLogDir([string]$Key) {
  $dir = Join-Path $ROOT ("logs\" + $Key)
  if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  return $dir
}

function Start-HiddenServiceProcess([string]$Key, [string]$FilePath, [string[]]$ArgumentList, [string]$WorkingDirectory, [switch]$Wait) {
  $dir = Get-ServiceLogDir $Key
  $stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
  $base = Join-Path $dir $stamp
  $params = @{
    FilePath = $FilePath
    ArgumentList = $ArgumentList
    WindowStyle = 'Hidden'
    RedirectStandardOutput = ($base + '.out.log')
    RedirectStandardError = ($base + '.err.log')
    PassThru = $true
    ErrorAction = 'Stop'
  }
  if ($WorkingDirectory) { $params.WorkingDirectory = $WorkingDirectory }
  $process = Start-Process @params
  if ($Wait) { $process.WaitForExit() }
  return $process
}

function Start-Embedding {
  $logDir = Join-Path $ROOT 'logs\embedding'
  if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
  Write-Host "    logs: $logDir\6971_<time>.out/.err/.exit.log"
  $watcher = @"
`$t = Get-Date -Format yyyyMMdd_HHmmss
`$b = '$logDir\6971_' + `$t
Add-Content -LiteralPath (`$b + '.exit.log') -Value ('started ' + (Get-Date -Format o))
`$p = Start-Process -FilePath '$EMBEDDING_EXE' -ArgumentList '-m','$EMBEDDING_MODEL','--host','127.0.0.1','--port','6971','--embedding','--pooling','mean','--no-mmproj','-c','4096','--log-timestamps' -WorkingDirectory '$EMBEDDING_DIR' -WindowStyle Hidden -RedirectStandardOutput (`$b + '.out.log') -RedirectStandardError (`$b + '.err.log') -PassThru
`$null = `$p.Handle
`$p.WaitForExit()
Add-Content -LiteralPath (`$b + '.exit.log') -Value ('exited ' + (Get-Date -Format o) + ' code=' + `$p.ExitCode)
"@
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($watcher))
  Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile', '-WindowStyle', 'Hidden', '-EncodedCommand', $encoded -WindowStyle Hidden
}

# Single service definition shared by status, --all, and --watchdog.
$services = @(
  @{ Key = 'llama'; MenuKey = '1'; Name = 'OOGG llama.cpp'; Port = '6969'; Wait = 60; Owner = 'rana_services.ps1'; Check = { Test-Port 6969 }; Start = { if ($HiddenLaunch) { Start-HiddenServiceProcess -Key 'llama' -FilePath 'cmd.exe' -ArgumentList @('/c', (Join-Path $ROOT 'start_rana_hidden.cmd')) -WorkingDirectory 'F:\llama-cpp' } else { Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', '"F:\llama-cpp\start_rana.bat"' } } },
  @{ Key = 'embedding'; MenuKey = '2'; Name = 'EmbeddingGemma'; Port = '6971'; Wait = 30; Owner = 'rana_services.ps1'; Check = { Test-Http 'http://127.0.0.1:6971/health' }; Start = { Start-Embedding } },
  @{ Key = 'ollama'; MenuKey = '3'; Name = 'Ollama web API'; Port = '11434'; Wait = 15; Owner = 'rana_services.ps1'; Check = { Test-Port 11434 }; Start = { if ($HiddenLaunch) { Start-HiddenServiceProcess -Key 'ollama' -FilePath $OLLAMA_EXE -ArgumentList @('serve') } else { Start-Process -FilePath $OLLAMA_EXE -ArgumentList 'serve' } } },
  @{ Key = 'lavalink'; MenuKey = '4'; Name = 'Lavalink'; Port = '2333'; Wait = 90; Owner = 'rana_services.ps1'; Check = { Test-Port 2333 }; Start = { if ($HiddenLaunch) { Start-HiddenServiceProcess -Key 'lavalink' -FilePath $LAVALINK_JAVA -ArgumentList @('-Xmx512m', '-Xms128m', '-jar', 'Lavalink.jar') -WorkingDirectory $ROOT } else { Start-Process -FilePath $LAVALINK_JAVA -ArgumentList '-Xmx512m', '-Xms128m', '-jar', 'Lavalink.jar' -WorkingDirectory $ROOT -WindowStyle Hidden } } },
  @{ Key = 'live'; MenuKey = '5'; Name = 'LIVE music API'; Port = '8080'; Wait = 20; Owner = 'rana_services.ps1'; Check = { Test-Live }; Start = { if ($HiddenLaunch) { Start-HiddenServiceProcess -Key 'live' -FilePath $LIVE_PYTHON -ArgumentList @('-m', 'uvicorn', 'LIVE:app', '--host', '127.0.0.1', '--port', '8080') -WorkingDirectory $MUSIC } else { Start-Process -FilePath $LIVE_PYTHON -ArgumentList '-m', 'uvicorn', 'LIVE:app', '--host', '127.0.0.1', '--port', '8080' -WorkingDirectory $MUSIC -WindowStyle Hidden } } },
  @{ Key = 'mygo'; MenuKey = '6'; Name = 'MyGO voice bridges'; Port = '8081-8085'; Wait = 20; Owner = 'rana_services.ps1'; Check = { @(8081..8085 | Where-Object { -not (Test-Port $_) }).Count -eq 0 }; Start = { if ($HiddenLaunch) { Start-HiddenServiceProcess -Key 'mygo' -FilePath 'node' -ArgumentList @('mygo_voice_bridges.js') -WorkingDirectory $MUSIC } else { Start-Process -FilePath 'node' -ArgumentList 'mygo_voice_bridges.js' -WorkingDirectory $MUSIC -WindowStyle Hidden } } },
  @{ Key = 'gateway'; MenuKey = '7'; Name = 'OpenClaw gateway'; Port = '18789'; Wait = 60; Owner = 'OpenClaw Gateway task'; Check = { Test-Port 18789 }; Start = { Start-GatewayOwner } },
  @{ Key = 'hot-tools'; MenuKey = '8'; Name = 'Rana hot tools'; Port = '8091'; Wait = 15; Owner = 'rana_services.ps1'; Check = { Test-Port 8091 }; Start = { if ($HiddenLaunch) { Start-HiddenServiceProcess -Key 'hot-tools' -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $ROOT 'hot_tools_hidden.ps1')) -WorkingDirectory (Join-Path $ROOT 'workspace\services\rana_hot_tools') } else { Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $ROOT 'hot_tools_visible.ps1') } } },
  @{ Key = 'leprechaun'; MenuKey = '9'; Name = 'Leprechaun telemetry'; Port = 'process'; Wait = 15; Owner = 'rana_services.ps1'; Check = { Test-Swarm }; Start = { if ($HiddenLaunch) { Start-HiddenServiceProcess -Key 'leprechaun' -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $ROOT 'leprechaun_swarm_hidden.ps1')) -WorkingDirectory 'D:\_Project\Leprechaun' } else { Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $ROOT 'leprechaun_swarm_visible.ps1') } } },
  @{ Key = 'lolcoach'; MenuKey = '10'; Name = 'lolcoach API'; Port = '8790 /health'; Wait = 30; Owner = 'restart_api.ps1'; Check = { Test-Lolcoach }; Start = { Start-Lolcoach } }
)

function Start-GatewayOwner {
  if ($HiddenLaunch) {
    $p = Start-HiddenServiceProcess -Key 'gateway' -FilePath 'schtasks.exe' -ArgumentList @('/Run', '/TN', '"\OpenClaw Gateway"') -Wait
  } else {
    $p = Start-Process -FilePath 'schtasks.exe' -ArgumentList '/Run','/TN','"\OpenClaw Gateway"' -WindowStyle Hidden -Wait -PassThru
  }
  return ($p.ExitCode -eq 0)
}

function Start-Lolcoach {
  if (-not (Test-Path -LiteralPath $RESTART_API)) { Write-Host "    missing restart script: $RESTART_API"; return $false }
  # The supplied script launches the detached server itself. Do not wait on its
  # process tree; uvicorn child ownership can otherwise make this wrapper hang.
  if ($HiddenLaunch) {
    $null = Start-HiddenServiceProcess -Key 'lolcoach' -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $RESTART_API)
  } else {
    Start-Process -FilePath 'powershell.exe' -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',$RESTART_API -WindowStyle Hidden | Out-Null
  }
  return $true
}

function Write-WatchdogLog([string]$Message) {
  if (-not (Test-Path -LiteralPath $WATCHDOG_DIR)) { New-Item -ItemType Directory -Force -Path $WATCHDOG_DIR | Out-Null }
  Add-Content -LiteralPath $WATCHDOG_LOG -Value ((Get-Date -Format o) + ' ' + $Message) -Encoding UTF8
}

function Load-NotificationState {
  $state = @{}
  if (Test-Path -LiteralPath $NOTIFICATION_STATE) {
    try {
      $raw = Get-Content -LiteralPath $NOTIFICATION_STATE -Raw | ConvertFrom-Json
      foreach ($p in $raw.PSObject.Properties) { $state[$p.Name] = [datetime]$p.Value }
    } catch { Write-WatchdogLog ('notification-state=reset reason=' + $_.Exception.Message) }
  }
  return $state
}

function Save-NotificationState($State) {
  $obj = [ordered]@{}
  foreach ($key in $State.Keys) { $obj[$key] = $State[$key].ToString('o') }
  $obj | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath $NOTIFICATION_STATE -Encoding UTF8
}

function Send-WatchdogNotification([string]$Key, [string]$Message, [switch]$Once) {
  $notificationState = Load-NotificationState
  $now = Get-Date
  # -Once: the key is sent a single time ever (patch notices), not once per hour.
  if ($Once -and $notificationState.ContainsKey($Key)) { return }
  if ($notificationState.ContainsKey($Key) -and $notificationState[$Key] -gt $now.AddHours(-1)) {
    Write-WatchdogLog ('notification=discord deduped key=' + $Key)
    return
  }
  $notifier = Join-Path $ROOT 'notify_discord.ps1'
  if (-not (Test-Path -LiteralPath $notifier)) {
    Write-WatchdogLog ('notification=discord failed key=' + $Key + ' reason=notify_discord.ps1 missing')
    return
  }
  try {
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Message))
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $notifier -MessageBase64 $encoded *> $null
    if ($LASTEXITCODE -eq 0) {
      $notificationState[$Key] = $now
      Save-NotificationState $notificationState
      Write-WatchdogLog ('notification=discord sent key=' + $Key + ' message=' + $Message)
    }
    else { Write-WatchdogLog ('notification=discord failed key=' + $Key + ' exit=' + $LASTEXITCODE) }
  } catch {
    Write-WatchdogLog ('notification=discord failed key=' + $Key + ' error=' + $_.Exception.Message)
  }
}

function Invoke-PatchPendingNotification {
  if (-not (Test-Path -LiteralPath $PATCH_PENDING)) { return }
  try { $patch = Get-Content -LiteralPath $PATCH_PENDING -Raw | ConvertFrom-Json }
  catch { Write-WatchdogLog ('patch-pending=invalid error=' + $_.Exception.Message); return }
  $from = [string]$patch.from
  if (-not $from) { $from = [string]$patch.old_version }
  $to = [string]$patch.to
  if (-not $to) { $to = [string]$patch.new_version }
  $report = [string]$patch.report
  if (-not $to) { Write-WatchdogLog 'patch-pending=ignored reason=missing-to'; return }
  $message = "LoL 改版 $from → $to，lolcoach 已列出受影響的資料：$report"
  Send-WatchdogNotification ('patch:' + $to) $message -Once
}

function Test-LiveRunnerActive {
  $hits = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.CommandLine -and $_.CommandLine -match '(?i)(LIVE14|LIVE15B?|LIVE10[_-]B|_review[\\/]shared[\\/].*runner)'
  })
  return ($hits.Count -gt 0)
}

function Load-RestartState {
  $state = @{}
  if (Test-Path -LiteralPath $WATCHDOG_STATE) {
    try {
      $raw = Get-Content -LiteralPath $WATCHDOG_STATE -Raw | ConvertFrom-Json
      foreach ($p in $raw.PSObject.Properties) { $state[$p.Name] = @($p.Value | ForEach-Object { [datetime]$_ }) }
    } catch { Write-WatchdogLog ('state=reset reason=' + $_.Exception.Message) }
  }
  return $state
}

function Save-RestartState($State) {
  $obj = [ordered]@{}
  foreach ($key in $State.Keys) { $obj[$key] = @($State[$key] | ForEach-Object { $_.ToString('o') }) }
  $obj | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $WATCHDOG_STATE -Encoding UTF8
}

function Get-RecentRestartCount($State, [string]$Key) {
  $now = Get-Date
  if (-not $State.ContainsKey($Key)) { $State[$Key] = @() }
  $State[$Key] = @($State[$Key] | Where-Object { $_ -gt $now.AddHours(-1) })
  return $State[$Key].Count
}

function Show-Status {
  Write-Host ''
  Write-Host '========================================'
  Write-Host ' Rana services'
  Write-Host '========================================'
  foreach ($s in $services) {
    $s.Online = [bool](& $s.Check)
    $state = if ($s.Online) { '[OK]  ' } else { '[MISS]' }
    Write-Host ('  {0,-2} {1} {2,-22} {3}' -f $s.MenuKey, $state, $s.Name, $s.Port)
  }
  $vision = Test-Http ($env:RANA_VISION_BASE_URL.TrimEnd('/') + '/v1/models')
  $vstate = if ($vision) { '[OK]  ' } else { '[MISS]' }
  Write-Host ('  -  {0} {1,-22} {2} (remote, status only)' -f $vstate, 'Remote vision', $env:RANA_VISION_BASE_URL)
  Write-Host ''
}

function Start-RanaService([hashtable]$s) {
  if ($s.Online) { Write-Host ("[{0}] already online, skipped" -f $s.Name); return }
  Write-Host ("[{0}] starting..." -f $s.Name)
  if ($DryRun) { Write-Host '    (dry run, not started)'; return }
  & $s.Start
  $deadline = (Get-Date).AddSeconds($s.Wait)
  while ((Get-Date) -lt $deadline) {
    if (& $s.Check) { Write-Host ("[{0}] ready" -f $s.Name); return }
    Start-Sleep -Seconds 2
  }
  Write-Host ("[{0}] WARNING: not ready after {1}s" -f $s.Name, $s.Wait)
}

function Invoke-Watchdog {
  if (Test-Path -LiteralPath $PAUSE_ALL) { Write-WatchdogLog 'cycle=skipped reason=watchdog.pause'; return }
  Write-WatchdogLog 'cycle=start'
  $state = Load-RestartState
  Invoke-PatchPendingNotification
  foreach ($s in $services) {
    if (Test-Path -LiteralPath (Join-Path $ROOT ('watchdog.pause.' + $s.Key))) { Write-WatchdogLog ('service=' + $s.Key + ' action=skipped reason=per-service-pause'); continue }
    $online = [bool](& $s.Check)
    if ($online) { Write-WatchdogLog ('service=' + $s.Key + ' status=online'); continue }
    if ($s.Key -eq 'gateway' -and (Test-LiveRunnerActive)) { Write-WatchdogLog 'service=gateway action=skipped reason=LIVE-runner-active'; continue }
    $count = Get-RecentRestartCount $state $s.Key
    Send-WatchdogNotification ($s.Key + ':offline') ("$($s.Name) is offline; restart attempt $($count + 1)/3")
    if ($count -ge 3) {
      Write-WatchdogLog ('service=' + $s.Key + ' action=stopped reason=restart-limit count=3')
      Send-WatchdogNotification ($s.Key + ':restart-limit') ("$($s.Name) exceeded 3 restarts in one hour; automatic retry stopped")
      continue
    }
    $state[$s.Key] += ,(Get-Date)
    Save-RestartState $state
    Write-WatchdogLog ('service=' + $s.Key + ' action=restart owner=' + $s.Owner + ' attempt=' + ($count + 1))
    try { $result = & $s.Start; Write-WatchdogLog ('service=' + $s.Key + ' start-result=' + [bool]$result) } catch { Write-WatchdogLog ('service=' + $s.Key + ' start-error=' + $_.Exception.Message) }
    $deadline = (Get-Date).AddSeconds($s.Wait)
    $ready = $false
    while ((Get-Date) -lt $deadline) { if (& $s.Check) { $ready = $true; break }; Start-Sleep -Seconds 2 }
    if ($ready) { Write-WatchdogLog ('service=' + $s.Key + ' status=recovered'); Send-WatchdogNotification ($s.Key + ':recovered') ("$($s.Name) recovered") }
    else { Write-WatchdogLog ('service=' + $s.Key + ' status=failed-after-restart'); Send-WatchdogNotification ($s.Key + ':failed-after-restart') ("$($s.Name) restart did not recover the service") }
  }
  Write-WatchdogLog 'cycle=end'
}

if ($Watchdog) { Invoke-Watchdog; exit 0 }

while ($true) {
  Show-Status
  if ($AutoAll) {
    $picked = @($services | Where-Object { (-not $_.Online) -and (-not ($SkipGateway -and $_.Key -eq 'gateway')) })
  } else {
    $answer = Read-Host 'Start which? numbers separated by space (e.g. 2 7), a = all missing, Enter = exit'
    $answer = "$answer".Trim().ToLowerInvariant()
    if (-not $answer) { break }
    if ($answer -eq 'a') { $picked = @($services | Where-Object { (-not $_.Online) -and (-not ($SkipGateway -and $_.Key -eq 'gateway')) }) }
    else {
      $keys = $answer -split '[\s,]+' | Where-Object { $_ }
      $picked = @($services | Where-Object { (($_.MenuKey -in $keys) -or ($_.Key -in $keys)) -and (-not ($SkipGateway -and $_.Key -eq 'gateway')) })
      $unknown = @($keys | Where-Object { $k = $_; -not ($services | Where-Object { $_.MenuKey -eq $k -or $_.Key -eq $k }) })
      if ($unknown.Count) { Write-Host ('Unknown: ' + ($unknown -join ' ')) }
    }
  }
  if (-not $picked.Count) { Write-Host 'Nothing to start.' }
  foreach ($s in $picked) { Start-RanaService $s }
  if ($AutoAll) { Show-Status; break }
}

if (-not $NoPause -and $AutoAll) { Read-Host 'Done. Press Enter to close' | Out-Null }
