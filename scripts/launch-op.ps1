$exe = "$env:LOCALAPPDATA\Programs\Nova Genesis\Nova Genesis.exe"
if (-not (Test-Path $exe)) { Write-Output "MISSING"; exit 1 }
$p = Start-Process -FilePath $exe -ArgumentList "--remote-debugging-port=9334" -PassThru
Write-Output "PID=$($p.Id)"
