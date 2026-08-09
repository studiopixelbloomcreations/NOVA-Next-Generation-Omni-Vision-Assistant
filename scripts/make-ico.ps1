Add-Type -AssemblyName System.Drawing
$src = New-Object System.Drawing.Bitmap('build/icon.png')
$outDir = 'build/ico-sizes'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
foreach ($s in @(16, 24, 32, 48, 64, 128, 256)) {
  $bmp = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.SmoothingMode = 'AntiAlias'
  $g.DrawImage($src, 0, 0, $s, $s)
  $g.Dispose()
  $bmp.Save("$outDir\icon-$s.png", [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output "size $s done"
}
$src.Dispose()
