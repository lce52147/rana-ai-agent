[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ImagePath,
  [string]$InstallDir = "$env:LOCALAPPDATA\RanaIdentitySidecar"
)

$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath (Join-Path $InstallDir 'config.json') -Raw | ConvertFrom-Json
$resolvedPath = (Resolve-Path -LiteralPath $ImagePath).Path
$bytes = [IO.File]::ReadAllBytes($resolvedPath)
$extension = [IO.Path]::GetExtension($resolvedPath).ToLowerInvariant()
$mime = if ($extension -eq '.png') {
  'image/png'
}
elseif ($extension -eq '.webp') {
  'image/webp'
}
else {
  'image/jpeg'
}

$body = @{
  request_id = "manual-$([guid]::NewGuid().ToString('N'))"
  images = @(
    @{
      target_id = 'T1'
      mime_type = $mime
      data_base64 = [Convert]::ToBase64String($bytes)
    }
  )
} | ConvertTo-Json -Depth 6 -Compress

$headers = @{ Authorization = "Bearer $($config.apiKey)" }
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$($config.port)/v1/identity/retrieve" -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 180 | ConvertTo-Json -Depth 12
