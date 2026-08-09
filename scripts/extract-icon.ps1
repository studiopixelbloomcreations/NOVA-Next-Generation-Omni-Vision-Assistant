# Extract the center app-icon tile (dark rounded square with the circular N
# mark) from the NOVA design sheet: locate its bounding box by pixel scan,
# crop, knock out light-grey background pixels to transparent, scale to 512.
Add-Type -AssemblyName System.Drawing

$src = 'G:\thenu\Downloads\ChatGPT Image Aug 7, 2026, 10_40_41 PM.png'
$outPng = 'build/icon.png'
$bmp = New-Object System.Drawing.Bitmap($src)

# Scan window covering the center-bottom tile (x 560-830, y 860-1100 per the
# column-index luminance map: the dark rounded-square icon sits on light grey).
$scanX0 = 545; $scanX1 = 775
$scanY0 = 850; $scanY1 = 1105

$minX = $scanX1; $minY = $scanY1; $maxX = $scanX0; $maxY = $scanY0
$step = 2
for ($y = $scanY0; $y -lt $scanY1; $y += $step) {
  for ($x = $scanX0; $x -lt $scanX1; $x += $step) {
    $c = $bmp.GetPixel($x, $y)
    $lum = 0.299*$c.R + 0.587*$c.G + 0.114*$c.B
    # The tile is dark navy/black on a light grey background.
    if ($lum -lt 70) {
      if ($x -lt $minX) { $minX = $x }
      if ($x -gt $maxX) { $maxX = $x }
      if ($y -lt $minY) { $minY = $y }
      if ($y -gt $maxY) { $maxY = $y }
    }
  }
}
Write-Output "tile bbox: x=$minX..$maxX y=$minY..$maxY (w=$($maxX-$minX) h=$($maxY-$minY))"

# Crop exactly the tile bbox (it is already square); no extra padding so the
# adjacent dark column background cannot bleed in.
$pad = 0
$cropX = $minX - $pad
$cropY = $minY - $pad
$cropW = ($maxX - $minX) + 2*$pad
$cropH = ($maxY - $minY) + 2*$pad
if ($cropW -lt $cropH) { $cropX -= [int](($cropH - $cropW)/2); $cropW = $cropH }
else { $cropY -= [int](($cropW - $cropH)/2); $cropH = $cropW }
if ($cropX -lt 0) { $cropX = 0 }
if ($cropY -lt 0) { $cropY = 0 }

$crop = New-Object System.Drawing.Bitmap($cropW, $cropH)
$g = [System.Drawing.Graphics]::FromImage($crop)
$g.InterpolationMode = 'HighQualityBicubic'
$g.DrawImage($bmp, (New-Object System.Drawing.Rectangle(0,0,$cropW,$cropH)),
             (New-Object System.Drawing.Rectangle($cropX,$cropY,$cropW,$cropH)),
             [System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose()

# Knock out light background (rounded corners + shadow area) to transparency.
$size = 512
$icon = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g2 = [System.Drawing.Graphics]::FromImage($icon)
$g2.InterpolationMode = 'HighQualityBicubic'
$g2.DrawImage($crop, 0, 0, $size, $size)
$g2.Dispose()

for ($y = 0; $y -lt $size; $y++) {
  for ($x = 0; $x -lt $size; $x++) {
    $p = $icon.GetPixel($x, $y)
    $lum = 0.299*$p.R + 0.587*$p.G + 0.114*$p.B
    # Light grey background -> transparent; keep everything dark/colored.
    if ($lum -gt 150 -and $p.R -gt 140) {
      $icon.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(0, 0, 0, 0))
    }
  }
}

# Auto-trim to the opaque bounding box (removes the design sheet's light-grey
# margins and the drop-shadow halo), then re-render centered at 512x512.
$tMinX = $size; $tMinY = $size; $tMaxX = -1; $tMaxY = -1
for ($y = 0; $y -lt $size; $y++) {
  for ($x = 0; $x -lt $size; $x++) {
    if ($icon.GetPixel($x, $y).A -gt 8) {
      if ($x -lt $tMinX) { $tMinX = $x }
      if ($x -gt $tMaxX) { $tMaxX = $x }
      if ($y -lt $tMinY) { $tMinY = $y }
      if ($y -gt $tMaxY) { $tMaxY = $y }
    }
  }
}
Write-Output "opaque bbox: x=$tMinX..$tMaxX y=$tMinY..$tMaxY"

$final = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g3 = [System.Drawing.Graphics]::FromImage($final)
$g3.InterpolationMode = 'HighQualityBicubic'
$tw = $tMaxX - $tMinX + 1
$th = $tMaxY - $tMinY + 1
# Fit into 92% of the canvas, centered.
$target = [int]($size * 0.92)
$scale = [Math]::Min($target / $tw, $target / $th)
$dw = [int]($tw * $scale)
$dh = [int]($th * $scale)
$dx = [int](($size - $dw) / 2)
$dy = [int](($size - $dh) / 2)
$g3.DrawImage($icon, (New-Object System.Drawing.Rectangle($dx, $dy, $dw, $dh)),
             (New-Object System.Drawing.Rectangle($tMinX, $tMinY, $tw, $th)),
             [System.Drawing.GraphicsUnit]::Pixel)
$g3.Dispose()
$final.Save($outPng, [System.Drawing.Imaging.ImageFormat]::Png)
$final.Dispose()
$crop.Dispose()
$icon.Dispose()
$bmp.Dispose()
Write-Output "saved $outPng ($size x $size)"
