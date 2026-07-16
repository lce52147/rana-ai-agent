param(
  [Parameter(Mandatory = $true)]
  [string]$ImagePath
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]

function Await-WinRt {
  param(
    [Parameter(Mandatory = $true)]$Operation,
    [Parameter(Mandatory = $true)][Type]$ResultType
  )

  $method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
    Where-Object {
      $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1
    } |
    Select-Object -First 1
  $task = $method.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
  $task.Wait()
  return $task.Result
}

$file = Await-WinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
$stream = Await-WinRt ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await-WinRt ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

$available = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages)
$preferred = @('ja', 'zh-Hant-TW')
$results = @()
foreach ($tag in $preferred) {
  $language = $available | Where-Object { $_.LanguageTag -eq $tag } | Select-Object -First 1
  if (-not $language) { continue }
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
  if (-not $engine) { continue }
  $recognized = Await-WinRt ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $lines = @($recognized.Lines | ForEach-Object { $_.Text } | Where-Object { $_ })
  $results += [pscustomobject]@{
    language = $tag
    text = [string]$recognized.Text
    lines = $lines
  }
}

$allLines = @($results | ForEach-Object { $_.lines } | Where-Object { $_ } | Select-Object -Unique)
[pscustomobject]@{
  status = if ($results.Count -gt 0) { 'ok' } else { 'unavailable' }
  source = 'Windows.Media.Ocr'
  languages = @($results | ForEach-Object { $_.language })
  text = ($allLines -join "`n")
  lines = $allLines
  results = $results
} | ConvertTo-Json -Depth 6 -Compress
