[CmdletBinding()]
param(
  [string]$Message,
  # UTF-8 text as base64, used by rana_services.ps1 so no quoting or code page touches it.
  [string]$MessageBase64
)

$ErrorActionPreference = 'Stop'
$ConfigPath = 'C:\Users\Administrator\.openclaw\openclaw.json'
$IdsPath = 'C:\Users\Administrator\.openclaw\discord_ids.local.json'
$Utf8 = New-Object System.Text.UTF8Encoding($false)
if ($MessageBase64) { $Message = $Utf8.GetString([Convert]::FromBase64String($MessageBase64)) }
if ([string]::IsNullOrWhiteSpace($Message)) { Write-Error 'discord_dm_failed stage=args reason=empty message'; exit 1 }

try {
  $stage = 'config'
  $config = Get-Content -LiteralPath $ConfigPath -Encoding UTF8 -Raw | ConvertFrom-Json
  $token = [string]$config.channels.discord.accounts.default.token
  if ([string]::IsNullOrWhiteSpace($token)) { throw 'Rana Discord token is unavailable' }
  $stage = 'ids'
  $EvanOgUserId = [string](Get-Content -LiteralPath $IdsPath -Encoding UTF8 -Raw | ConvertFrom-Json).ownerUserId
  if ($EvanOgUserId -notmatch '^\d{17,20}$') { throw 'ownerUserId missing in discord_ids.local.json' }

    $headers = @{ Authorization = ('Bot ' + $token); 'User-Agent' = 'RanaWatchdog/1.0' }
  $dmBody = @{ recipient_id = $EvanOgUserId } | ConvertTo-Json -Compress
  $stage = 'dm_channel_post'
  $dmResponse = Invoke-WebRequest -UseBasicParsing -Method Post -Uri 'https://discord.com/api/v10/users/@me/channels' -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ($Utf8.GetBytes($dmBody)) -TimeoutSec 20
  $stage = 'dm_channel_parse'
  $dm = $dmResponse.Content | ConvertFrom-Json
    $channelId = [string]$dm.id
  if ($channelId -notmatch '^\d{17,20}$') { throw 'Discord DM channel was not returned' }

  $messageBody = @{ content = $Message } | ConvertTo-Json -Compress
  $stage = 'message_post'
  $null = Invoke-WebRequest -UseBasicParsing -Method Post -Uri ("https://discord.com/api/v10/channels/$channelId/messages") -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ($Utf8.GetBytes($messageBody)) -TimeoutSec 20
  Write-Output ('discord_dm_sent channel=' + $channelId)
  exit 0
} catch {
  $detail = if ($_.Exception.Response) {
      $status = [int]$_.Exception.Response.StatusCode
      $apiMessage = ''
      $apiCode = ''
      try {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        $body = $reader.ReadToEnd()
        $errorBody = $body | ConvertFrom-Json
        $apiMessage = [string]$errorBody.message
        $apiCode = [string]$errorBody.code
      } catch { }
      'http_status=' + $status + ' api_code=' + $apiCode + ' api_message=' + $apiMessage
    } else {
      ([string]$_.Exception.Message -split "`r?`n")[0]
    }
  if ($token) { $detail = $detail.Replace($token, '[redacted]') }
  Write-Error ('discord_dm_failed stage=' + $stage + ' reason=' + $detail)
  exit 1
}
