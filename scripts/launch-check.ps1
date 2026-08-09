# Launch + deep diagnostic for the installed NOVA Genesis app.
$exe = "$env:LOCALAPPDATA\Programs\Nova Genesis\Nova Genesis.exe"
Remove-Item Env:GROQ_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:GEMINI_API_KEY -ErrorAction SilentlyContinue
$p = Start-Process -FilePath $exe -ArgumentList "--remote-debugging-port=9336" -PassThru
Write-Output "Started PID=$($p.Id)"
$deadline = (Get-Date).AddSeconds(60)
$cdp = $false
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 3
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:9336/json/version" -UseBasicParsing -TimeoutSec 2
        if ($r.StatusCode -eq 200) { $cdp = $true; break }
    } catch { }
    if ($p.HasExited) { Write-Output "PROCESS_EXITED code=$($p.ExitCode)"; break }
}
if ($cdp) { Write-Output "CDP_UP" } else { Write-Output "CDP_TIMEOUT" }
Write-Output "ProcessCount: $((Get-Process -Name 'Nova Genesis' -ErrorAction SilentlyContinue).Count)"
# Window check
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder t, int m);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
}
"@
$found = @()
[W]::EnumWindows({ param($h, $l)
    $sb = New-Object System.Text.StringBuilder 256
    [void][W]::GetWindowText($h, $sb, 256)
    if ($sb.ToString() -match 'NOVA|Genesis') { $script:found += "$($sb.ToString()) visible=$([W]::IsWindowVisible($h))" }
    return $true
}, [IntPtr]::Zero) | Out-Null
if ($found.Count) { $found | ForEach-Object { Write-Output "WINDOW: $_" } } else { Write-Output "NO_MATCHING_WINDOWS" }
