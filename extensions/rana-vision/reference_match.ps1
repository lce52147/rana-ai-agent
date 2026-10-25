param(
  [Parameter(Mandatory = $true)][string]$ImagePath,
  [Parameter(Mandatory = $true)][string]$ReferenceRoot
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Drawing

function Get-NormalizedBitmap([string]$Path, [int]$Width, [int]$Height) {
  $source = [System.Drawing.Image]::FromFile($Path)
  $canvas = New-Object System.Drawing.Bitmap($Width, $Height)
  $graphics = [System.Drawing.Graphics]::FromImage($canvas)
  try {
    $graphics.Clear([System.Drawing.Color]::White)
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $ratio = [Math]::Min($Width / $source.Width, $Height / $source.Height)
    $drawWidth = [Math]::Max(1, [int]($source.Width * $ratio))
    $drawHeight = [Math]::Max(1, [int]($source.Height * $ratio))
    $x = [int](($Width - $drawWidth) / 2)
    $y = [int](($Height - $drawHeight) / 2)
    $graphics.DrawImage($source, $x, $y, $drawWidth, $drawHeight)
    return $canvas
  } finally {
    $graphics.Dispose()
    $source.Dispose()
  }
}

function Get-Signature([string]$Path) {
  $bitmap = Get-NormalizedBitmap $Path 33 32
  try {
    $gray = New-Object 'double[,]' 32,32
    $sum = 0.0
    $hist = New-Object 'double[]' 64
    for ($y = 0; $y -lt 32; $y++) {
      for ($x = 0; $x -lt 32; $x++) {
        $pixel = $bitmap.GetPixel($x, $y)
        $value = (0.299 * $pixel.R) + (0.587 * $pixel.G) + (0.114 * $pixel.B)
        $gray[$x,$y] = $value
        $sum += $value
        $rBin = [int][Math]::Floor($pixel.R / 64.0)
        $gBin = [int][Math]::Floor($pixel.G / 64.0)
        $bBin = [int][Math]::Floor($pixel.B / 64.0)
        $bin = ($rBin * 16) + ($gBin * 4) + $bBin
        $hist[$bin] += 1
      }
    }
    $mean = $sum / 1024.0
    $aHash = New-Object 'bool[]' 1024
    $dHash = New-Object 'bool[]' 1024
    $index = 0
    for ($y = 0; $y -lt 32; $y++) {
      for ($x = 0; $x -lt 32; $x++) {
        $aHash[$index] = $gray[$x,$y] -ge $mean
        $right = $bitmap.GetPixel($x + 1, $y)
        $rightGray = (0.299 * $right.R) + (0.587 * $right.G) + (0.114 * $right.B)
        $dHash[$index] = $gray[$x,$y] -gt $rightGray
        $index++
      }
    }
    return [pscustomobject]@{
      sha256 = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
      ahash = $aHash
      dhash = $dHash
      histogram = $hist
    }
  } finally {
    $bitmap.Dispose()
  }
}

function Get-HammingSimilarity($Left, $Right) {
  $different = 0
  for ($i = 0; $i -lt $Left.Count; $i++) { if ($Left[$i] -ne $Right[$i]) { $different++ } }
  return 1.0 - ($different / [double]$Left.Count)
}

function Get-HistogramSimilarity($Left, $Right) {
  $intersection = 0.0
  for ($i = 0; $i -lt $Left.Count; $i++) { $intersection += [Math]::Min($Left[$i], $Right[$i]) }
  return $intersection / 1024.0
}

$target = Get-Signature $ImagePath
$matches = foreach ($file in Get-ChildItem -LiteralPath $ReferenceRoot -File | Where-Object { $_.Extension -match '^\.(png|jpg|jpeg|webp)$' }) {
  $reference = Get-Signature $file.FullName
  $exact = $target.sha256 -eq $reference.sha256
  $aHashSimilarity = Get-HammingSimilarity $target.ahash $reference.ahash
  $dHashSimilarity = Get-HammingSimilarity $target.dhash $reference.dhash
  $histogramSimilarity = Get-HistogramSimilarity $target.histogram $reference.histogram
  $similarity = if ($exact) { 1.0 } else { (0.4 * $dHashSimilarity) + (0.35 * $aHashSimilarity) + (0.25 * $histogramSimilarity) }
  [pscustomobject]@{
    id = $file.BaseName
    similarity = [Math]::Round($similarity, 6)
    exact_sha256 = $exact
    ahash_similarity = [Math]::Round($aHashSimilarity, 6)
    dhash_similarity = [Math]::Round($dHashSimilarity, 6)
    histogram_similarity = [Math]::Round($histogramSimilarity, 6)
    reference = $file.FullName
  }
}

[pscustomobject]@{
  status = 'ok'
  source = 'local official-reference matcher'
  target_sha256 = $target.sha256
  matches = @($matches | Sort-Object similarity -Descending | Select-Object -First 5)
} | ConvertTo-Json -Depth 6 -Compress
