$payload = @{
    url        = "https://youtu.be/ZsvJUh03MwI"
    guild_id   = "1486679037605842944"
    channel_id = "1495319712370917396"
    requester  = "Matcha_Parfait_Trigger"
} | ConvertTo-Json -Compress

$retryMax = 999
$attempt  = 0

while ($attempt -lt $retryMax) {
    $attempt++
    $ts = Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"
    Write-Host "[$ts] [DISPATCH] [$attempt] POST http://127.0.0.1:8080/api/play"

    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:8080/api/play" `
             -Method POST -Body $payload -ContentType "application/json" `
             -UseBasicParsing -TimeoutSec 90 -ErrorAction SilentlyContinue

        $ts = Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"

        if ($null -eq $r) {
            Write-Host "[$ts] [NULL_RESP] [$attempt] No response - retry in 3s"
            Start-Sleep -Seconds 3
            continue
        }

        $body = $r.Content | ConvertFrom-Json -ErrorAction SilentlyContinue
        $status = if ($body) { $body.status } else { "parse_error" }
        Write-Host "[$ts] [HTTP_$($r.StatusCode)] [$attempt] status=$status"

        if ($status -eq "queued") {
            Write-Host "[$ts] [PLAYING] [$attempt] Lavalink_State=PLAYING title=$($body.title)"
            Write-Host ""
            Write-Host "抹茶芭菲收到了，春日影，演奏開始。"
            Write-Host ""
            exit 0
        }

        if ($status -eq "extracted") {
            Write-Host "[$ts] [BRIDGE_ERR] [$attempt] $($body.message) - checking bridge..."
            $br = Invoke-WebRequest -Uri "http://127.0.0.1:8081/health" -UseBasicParsing -TimeoutSec 5 -ErrorAction SilentlyContinue
            if ($null -eq $br -or $br.StatusCode -ne 200) {
                Write-Host "[$ts] [BRIDGE_DOWN] [$attempt] voice_bridge offline - restarting..."
                $scriptPath = "cd /d C:\Users\Administrator\.openclaw\workspace\services\music_core; node voice_bridge.js"
                Start-Process "powershell.exe" -ArgumentList "-NoExit", "-Command", $scriptPath -UseShellExecute $true
                Start-Sleep -Seconds 5
            }
            Start-Sleep -Seconds 2
            continue
        }

        if ($status -eq "error") {
            Write-Host "[$ts] [YTDLP_ERR] [$attempt] $($body.llm_hint) - retry in 5s"
            Start-Sleep -Seconds 5
            continue
        }

        Write-Host "[$ts] [UNKNOWN] [$attempt] body=$($r.Content) - retry in 3s"
        Start-Sleep -Seconds 3

    } catch [System.Net.WebException] {
        $ts = Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"
        $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
        Write-Host "[$ts] [NET_ERR] [$attempt] code=$code $($_.Exception.Message) - retry in 3s"
        Start-Sleep -Seconds 3
    } catch {
        $ts = Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"
        Write-Host "[$ts] [ERR] [$attempt] $($_.Exception.Message) - retry in 3s"
        Start-Sleep -Seconds 3
    }
}
