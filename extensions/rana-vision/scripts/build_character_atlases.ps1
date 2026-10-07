$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

$moduleRoot = Split-Path -Parent $PSScriptRoot
$catalog = Get-Content -Raw -Encoding UTF8 (Join-Path $moduleRoot "character_catalog.json") | ConvertFrom-Json
$referenceRoot = Join-Path $moduleRoot "references"
$sourceRoot = Join-Path $referenceRoot "source"

function New-CharacterAtlas {
    param($Atlas)

    # Keep all three atlases plus the target under ToriiGate's 4096-token visual context.
    $size = 768
    $cell = 256
    $labelHeight = 38
    $canvas = New-Object System.Drawing.Bitmap($size, $size)
    $graphics = [System.Drawing.Graphics]::FromImage($canvas)
    $graphics.Clear([System.Drawing.Color]::FromArgb(244, 246, 244))
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $font = New-Object System.Drawing.Font("Yu Gothic UI", 14, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(22, 43, 38))
    $bar = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(226, 236, 229))
    $border = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(115, 139, 128), 2)

    try {
        for ($index = 0; $index -lt $Atlas.characters.Count; $index += 1) {
            $id = [string]$Atlas.characters[$index]
            $character = $catalog.characters | Where-Object { $_.id -eq $id } | Select-Object -First 1
            if (-not $character) { throw "Unknown character id: $id" }
            $sourcePath = Join-Path $referenceRoot ([string]$character.reference)
            $image = [System.Drawing.Image]::FromFile($sourcePath)
            try {
                $column = $index % 3
                $row = [math]::Floor($index / 3)
                $x = $column * $cell
                $y = $row * $cell
                $imageHeight = $cell - $labelHeight
                $targetRatio = $cell / $imageHeight
                if ([string]$Atlas.crop -eq "face") {
                    # Official character sheets place the head near the top-center. Keep enough hair and shoulders
                    # for close-up matching while excluding most outfit/body pixels.
                    $sourceHeight = [int]([math]::Min($image.Height * 0.42, $image.Width / $targetRatio))
                    $sourceHeight = [math]::Max(1, $sourceHeight)
                    $sourceWidth = [int]([math]::Min($image.Width, $sourceHeight * $targetRatio))
                    $sourceX = [int](($image.Width - $sourceWidth) / 2)
                    $sourceY = 0
                } else {
                    $sourceRatio = $image.Width / $image.Height
                    if ($sourceRatio -gt $targetRatio) {
                        $sourceHeight = $image.Height
                        $sourceWidth = [int]($sourceHeight * $targetRatio)
                        $sourceX = [int](($image.Width - $sourceWidth) / 2)
                        $sourceY = 0
                    } else {
                        $sourceWidth = $image.Width
                        $sourceHeight = [int]($sourceWidth / $targetRatio)
                        $sourceX = 0
                        $sourceY = [int]([math]::Max(0, [math]::Min(($image.Height - $sourceHeight) * 0.18, $image.Height - $sourceHeight)))
                    }
                }
                $destination = New-Object System.Drawing.Rectangle($x, $y, $cell, $imageHeight)
                $source = New-Object System.Drawing.Rectangle($sourceX, $sourceY, $sourceWidth, $sourceHeight)
                $graphics.DrawImage($image, $destination, $source, [System.Drawing.GraphicsUnit]::Pixel)
                $graphics.FillRectangle($bar, $x, $y + $imageHeight, $cell, $labelHeight)
                # The visual model receives only a neutral grid coordinate. Identity names
                # stay in the resolver and are never exposed to the visual comparison prompt.
                $label = "R{0}C{1}" -f ($row + 1), ($column + 1)
                $graphics.DrawString($label, $font, $brush, $x + 6, $y + $imageHeight + 9)
                $graphics.DrawRectangle($border, $x, $y, $cell - 1, $cell - 1)
            } finally {
                $image.Dispose()
            }
        }
        $output = Join-Path $referenceRoot ([string]$Atlas.file)
        $canvas.Save($output, [System.Drawing.Imaging.ImageFormat]::Png)
        Write-Output $output
    } finally {
        $border.Dispose()
        $bar.Dispose()
        $brush.Dispose()
        $font.Dispose()
        $graphics.Dispose()
        $canvas.Dispose()
    }
}

foreach ($atlas in $catalog.atlases) {
    New-CharacterAtlas -Atlas $atlas
}
