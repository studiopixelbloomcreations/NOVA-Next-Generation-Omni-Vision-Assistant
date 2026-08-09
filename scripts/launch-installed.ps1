# Launches the installed NOVA Genesis app with CDP debugging.
$exe = "$env:LOCALAPPDATA\Programs\Nova Genesis\Nova Genesis.exe"
if (-not (Test-Path $exe)) { Write-Output "EXE_MISSING"; exit 1 }
# Strip stale env vars so the OS-encrypted vault is the single source of truth.
Remove-Item Env:GROQ_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:GEMINI_API_KEY -ErrorAction SilentlyContinue
Write-Output "Launching: $exe"
$p = Start-Process -FilePath $exe -ArgumentList "--remote-debugging-port=9334" -PassThru
Write-Output "Started PID=$($p.Id)"
# Poll for CDP endpoint up to 30s
$deadline = (Get-Date).AddSeconds(30)
$ok = $false
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:9334/json/version" -UseBasicParsing -TimeoutSec 2
        if ($r.StatusCode -eq 200) { $ok = $true; break }
    } catch { }
}
if ($ok) { Write-Output "CDP_UP" } else { Write-Output "CDP_TIMEOUT" }
