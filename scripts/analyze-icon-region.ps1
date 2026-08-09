Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap('G:\thenu\Downloads\ChatGPT Image Aug 7, 2026, 10_40_41 PM.png')
$W = $bmp.Width; $H = $bmp.Height
$cols = 84; $rows = 34
$y0 = [int]($H * 0.60)
$line = '     '
for ($c = 0; $c -lt $cols; $c++) {
  $cx = [int](($c + 0.5) * $W / $cols)
  if ($cx % 100 -lt 30) { $line += [string][char]([int](65 + ($cx / 100))) } else { $line += ' ' }
}
Write-Output $line
for ($r = 0; $r -lt $rows; $r++) {
  $y = $y0 + [int](($r + 0.5) * ($H - $y0) / $rows)
  $line = ('{0,4}:' -f $y)
  for ($c = 0; $c -lt $cols; $c++) {
    $x = [int](($c + 0.5) * $W / $cols)
    $p = $bmp.GetPixel($x, $y)
    $lum = 0.299*$p.R + 0.587*$p.G + 0.114*$p.B
    if ($lum -lt 45)      { $line += '#' }
    elseif ($lum -lt 100) { $line += '+' }
    elseif ($lum -lt 180) { $line += '-' }
    else                  { $line += ' ' }
  }
  Write-Output $line
}
$bmp.Dispose()
