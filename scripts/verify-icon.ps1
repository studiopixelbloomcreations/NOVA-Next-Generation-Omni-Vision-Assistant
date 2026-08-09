Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap('build/icon.png')
$W = $bmp.Width; $H = $bmp.Height
Write-Output "icon: ${W}x${H}"
$cols = 40; $rows = 40
for ($r = 0; $r -lt $rows; $r++) {
  $line = ''
  for ($c = 0; $c -lt $cols; $c++) {
    $x = [int](($c + 0.5) * $W / $cols)
    $y = [int](($r + 0.5) * $H / $rows)
    $p = $bmp.GetPixel($x, $y)
    if ($p.A -lt 40) { $line += '.'; continue }
    $lum = 0.299*$p.R + 0.587*$p.G + 0.114*$p.B
    if ($lum -lt 40)      { $line += '#' }
    elseif ($lum -lt 100) { $line += '+' }
    else                  { $line += '-' }
  }
  Write-Output $line
}
$bmp.Dispose()
