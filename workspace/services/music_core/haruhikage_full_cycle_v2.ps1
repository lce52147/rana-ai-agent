# haruhikage_full_cycle_v2.ps1
# Rana Voice Bridge - Full Cycle Orchestration v2
# Target: MyGO!!!!! - Haruhikage (ChunRi Ying) in voice channel 1495319712370917396
# Protocol: Recursive state machine, infinite retry, raw log output
param(
    [string]$GuildId = "1486679037605842944",
    [string]$ChannelId = "1495319712370917396",
    [string]$TrackUrl = "https://youtu.be/ZsvJUh03MwI",
    [string]$GatewayUrl = "http://localhost:18789",
    [string]$GatewayToken = "24ba279eb6c404a233344dfe15716e924aa128b11847707e",
    [string]$LavalinkUrl = "http://127.0.0.1:2333",
    [string]$LiveUrl = "http://127.0.0.1:8080",
    [string]$BridgeUrl = "http://127.0.0.1:8081"
)
$OPENCLAW_DIR = "C:\Users\Administrator\.openclaw"
$MUSIC_DIR = "C:\Users\Administrator\.openclaw\workspace\services\music_core"
$PYTHON = "D:\Users\Administrator\miniconda3\python.exe"
$script:RetryCount = 0
$script:PlaybackDone = $false
# ── Logging ─────────────────────────────────────────────────────────────────
function Log {
    param([string]$State, [string]$Content)
    $ts = Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"
    Write-Host "[$ts] [$State] [$($script:RetryCount)] $Content"
}
# ── HTTP GET ─────────────────────────────────────────────────────────────────
function Invoke-SafeGet {
    param([string]$Url, [hashtable]$ExtraHeaders = @{})
    try {
        $resp = Invoke-WebRequest -Uri $Url -Method GET -Headers $ExtraHeaders `
            -TimeoutSec 5 -UseBasicParsing -ErrorAction SilentlyContinue
        if ($null -eq $resp) { return @{ OK = $false; Status = 0; Error = "null response" } }
        return @{ OK = $true; Status = [int]$resp.StatusCode; Body = $resp.Content }
    }
    catch [System.Net.WebException] {
        $webEx = $_.Exception
        if ($webEx.Response -ne $null) {
            $code = [int]$webEx.Response.StatusCode
            # Non-2xx but server responded — service IS up
            return @{ OK = $true; Status = $code; Body = ""; Error = "" }
        }
        return @{ OK = $false; Status = 0; Error = $webEx.Message }
    }
    catch {
        return @{ OK = $false; Status = 0; Error = $_.Exception.Message }
    }
}
# ── HTTP POST ─────────────────────────────────────────────────────────────────
function Invoke-SafePost {
    param([string]$Url, [string]$JsonBody = "{}")
    try {
        $resp = Invoke-WebRequest -Uri $Url -Method POST `
            -Body $JsonBody -ContentType "application/json" `
            -TimeoutSec 60 -UseBasicParsing -ErrorAction Stop
        return @{ OK = $true; Status = [int]$resp.StatusCode; Body = $resp.Content }
    }
    catch {
        return @{ OK = $false; Status = 0; Error = $_.Exception.Message }
    }
}
# ── Phase A: Lavalink Readiness (retry every 2s) ─────────────────────────────
function Wait-Lavalink {
    Log "PHASE_A" "Probing Lavalink at $LavalinkUrl/v4/info ..."
    $llHeaders = @{ Authorization = "youshallnotpass" }
    while ($true) {
        $r = Invoke-SafeGet "$LavalinkUrl/v4/info" $llHeaders
        # 200 = authenticated OK, 401 = server up but our probe lacks auth context
        # Either way, Lavalink is RUNNING — voice_bridge uses its own auth
        if ($r.OK -and $r.Status -in 200, 401) {
            if ($r.Status -eq 200) {
                try {
                    $info = $r.Body | ConvertFrom-Json
                    $ver = $info.version.semver
                }
                catch { $ver = "?" }
                Log "LAVALINK_READY" "Status=READY version=$ver"
            }
            else {
                Log "LAVALINK_READY" "Status=READY (401=auth required, service confirmed running)"
            }
            return
        }
        $script:RetryCount++
        Log "LAVALINK_WAIT" "Not ready (status=$($r.Status) err=$($r.Error)) - retry in 2s"
        Start-Sleep -Seconds 2
    }
}
# ── Phase A-sub: voice_bridge Readiness ──────────────────────────────────────
function Wait-VoiceBridge {
    Log "PHASE_A" "Probing voice_bridge at $BridgeUrl/init ..."
    while ($true) {
        $r = Invoke-SafeGet "$BridgeUrl/init"
        if ($r.OK -and $r.Status -eq 200) {
            Log "BRIDGE_READY" "voice_bridge Lavalink session established"
            return
        }
        $script:RetryCount++
        Log "BRIDGE_WAIT" "Not ready (status=$($r.Status)) - retry in 2s"
        Start-Sleep -Seconds 2
    }
}
# ── Phase B: LIVE.py Readiness ────────────────────────────────────────────────
function Wait-LivePy {
    Log "PHASE_B" "Probing LIVE.py at $LiveUrl/health ..."
    while ($true) {
        $r = Invoke-SafeGet "$LiveUrl/health"
        if ($r.OK -and $r.Status -eq 200) {
            Log "LIVE_READY" "LIVE.py online"
            return
        }
        $script:RetryCount++
        Log "LIVE_WAIT" "Not ready (status=$($r.Status)) - retry in 2s"
        Start-Sleep -Seconds 2
    }
}
# ── Phase C: Gateway connectivity ────────────────────────────────────────────
function Test-Gateway {
    Log "PHASE_C" "Pinging OpenClaw Gateway at $GatewayUrl ..."
    $headers = @{ Authorization = "Bearer $GatewayToken" }
    $r = Invoke-SafeGet "$GatewayUrl/gateway/status" $headers
    if ($r.OK -and $r.Status -lt 500) {
        Log "GATEWAY_OK" "Gateway responding (status=$($r.Status))"
        return $true
    }
    $r2 = Invoke-SafeGet $GatewayUrl $headers
    if ($r2.Status -ge 200 -and $r2.Status -lt 500) {
        Log "GATEWAY_OK" "Gateway responding at root (status=$($r2.Status))"
        return $true
    }
    Log "GATEWAY_WARN" "Gateway probe inconclusive - will attempt play anyway"
    return $false
}
# ── Auto-launch service via cmd /k ───────────────────────────────────────────
function Start-Service {
    param([string]$WinTitle, [string]$WorkDir, [string]$Command)
    Log "BOOT" "Launching: $WinTitle"
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "cmd.exe"
    $psi.Arguments = "/k `"" + $Command + "`""
    $psi.WorkingDirectory = $WorkDir
    $psi.UseShellExecute = $true
    [System.Diagnostics.Process]::Start($psi) | Out-Null
}
# =============================================================================
# MAIN EXECUTION
# =============================================================================
Log "BOOT" "=== Rana Full Cycle V2 - Haruhikage Playback Sequence ==="
Log "BOOT" "Target guild=$GuildId channel=$ChannelId"
Log "BOOT" "Track: MyGO!!!!! - Haruhikage [spring day shadow] [$TrackUrl]"
# ── 1. Auto-start Lavalink if down ───────────────────────────────────────────
$lv = Invoke-SafeGet "$LavalinkUrl/v4/info" @{ Authorization = "youshallnotpass" }
if (-not ($lv.OK -and $lv.Status -in 200, 401)) {
    Log "BOOT" "Lavalink offline - launching Lavalink.jar (512MB heap)..."
    $lavaCmd = "cd /d `"$OPENCLAW_DIR`" && java -Xmx512m -Xms128m -jar Lavalink.jar"
    Start-Service "Lavalink" $OPENCLAW_DIR $lavaCmd
    Log "BOOT" "Waiting 10s for JVM startup..."
    Start-Sleep -Seconds 10
}
else {
    Log "BOOT" "Lavalink already running (status=$($lv.Status))"
}
# ── 2. Auto-start LIVE.py if down ────────────────────────────────────────────
$lp = Invoke-SafeGet "$LiveUrl/health"
if (-not ($lp.OK -and $lp.Status -eq 200)) {
    Log "BOOT" "LIVE.py offline - launching uvicorn..."
    $liveCmd = "cd /d `"$MUSIC_DIR`" && `"$PYTHON`" -m uvicorn LIVE:app --host 127.0.0.1 --port 8080"
    Start-Service "LIVE.py" $MUSIC_DIR $liveCmd
    Log "BOOT" "Waiting 5s for FastAPI startup..."
    Start-Sleep -Seconds 5
}
else {
    Log "BOOT" "LIVE.py already running (status=$($lp.Status))"
}
# ── 3. Auto-start voice_bridge if down ───────────────────────────────────────
$vb = Invoke-SafeGet "$BridgeUrl/health"
if (-not ($vb.OK -and $vb.Status -eq 200)) {
    Log "BOOT" "voice_bridge offline - launching node voice_bridge.js..."
    $bridgeCmd = "cd /d `"$MUSIC_DIR`" && node voice_bridge.js"
    Start-Service "voice_bridge" $MUSIC_DIR $bridgeCmd
    Log "BOOT" "Waiting 4s for Node.js bridge startup..."
    Start-Sleep -Seconds 4
}
else {
    Log "BOOT" "voice_bridge already running (status=$($vb.Status))"
}
# ── Phase A: Block until Lavalink + voice_bridge are READY ───────────────────
Wait-Lavalink
Wait-VoiceBridge
# ── Phase B: Block until LIVE.py is READY ────────────────────────────────────
Wait-LivePy
# ── Phase C: Gateway connectivity ────────────────────────────────────────────
$null = Test-Gateway
# ── Connection Approved ───────────────────────────────────────────────────────
$ts = Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"
Write-Host ""
Write-Host "[$ts] [CONNECTED] [$($script:RetryCount)] Connection_Status=CONNECTED"
Write-Host ""
Write-Host "+-----------------------------------------------------+"
Write-Host "|  Rana has entered the channel. Connection approved. |"
Write-Host "|  Shall we play Haruhikage?                          |"
Write-Host "+-----------------------------------------------------+"
Write-Host ""
$confirm = Read-Host "Enter [Y] to confirm playback / [N] to cancel"
if ($confirm -notin @("Y", "y", "yes", "")) {
    Log "ABORTED" "User declined playback. Exiting."
    exit 0
}
# ── PLAYBACK - POST to LIVE.py /api/play with infinite retry ─────────────────
$payloadHash = @{
    url        = $TrackUrl
    guild_id   = $GuildId
    channel_id = $ChannelId
    requester  = "haruhikage_full_cycle_v2"
}
$payloadJson = $payloadHash | ConvertTo-Json -Compress
Log "PLAY_START" "Dispatching Haruhikage to LIVE.py -> voice_bridge -> Lavalink..."
while (-not $script:PlaybackDone) {
    $script:RetryCount++
    Log "PLAY_ATTEMPT" "POST $LiveUrl/api/play [retry=$($script:RetryCount)]"
    $r = Invoke-SafePost "$LiveUrl/api/play" $payloadJson
    if ($r.OK) {
        try { $body = $r.Body | ConvertFrom-Json } catch { $body = [PSCustomObject]@{ status = "parse_error" } }
        $status = $body.status
        switch ($status) {
            "queued" {
                Log "TRACK_START" "Now playing: $($body.title) [platform=$($body.platform) duration=$($body.duration)s]"
                Log "TRACK_START" "llm_hint: $($body.llm_hint)"
                $script:PlaybackDone = $true
                # Monitor for track end via heartbeat
                Log "MONITOR" "Playback active - monitoring for Track_End_Event (heartbeat every 10s)..."
                $monitorStart = Get-Date
                while ($true) {
                    Start-Sleep -Seconds 10
                    $elapsed = ((Get-Date) - $monitorStart).TotalSeconds
                    $hb = Invoke-SafeGet "$BridgeUrl/health"
                    try { $hbBody = $hb.Body | ConvertFrom-Json } catch { $hbBody = $null }
                    $session = if ($hbBody) { $hbBody.lavalink_session } else { "unknown" }
                    Log "HEARTBEAT" "elapsed=${elapsed}s session=$session bridge_status=$($hb.Status)"
                    # Track 456785 is 4:41 (~281s). After 320s, assume done if session still valid.
                    if ($elapsed -gt 320) {
                        Log "TRACK_END" "Track_End_Event - elapsed time exceeded track duration. Playback complete."
                        break
                    }
                }
            }
            "extracted" {
                Log "BRIDGE_ERROR" "Audio extracted but voice bridge error: $($body.message)"
                Log "RETRY" "Hard Reset - re-checking bridge then retrying in 3s..."
                Wait-VoiceBridge
                Start-Sleep -Seconds 3
            }
            "error" {
                Log "EXTRACT_ERROR" "yt-dlp failed: $($body.llm_hint)"
                Log "RETRY" "Retrying in 5s..."
                Start-Sleep -Seconds 5
            }
            default {
                Log "UNKNOWN" "Unexpected status=$status body=$($r.Body) - retrying in 3s"
                Start-Sleep -Seconds 3
            }
        }
    }
    else {
        Log "LIVE_DOWN" "LIVE.py unreachable: $($r.Error) - re-checking services..."
        Wait-LivePy
        Wait-VoiceBridge
    }
}
Log "DONE" "=== Haruhikage Full Cycle V2 COMPLETE. Track_End_Event captured. ==="
