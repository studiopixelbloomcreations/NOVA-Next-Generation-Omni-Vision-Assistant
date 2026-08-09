# Installs the NOVA Genesis release installer silently.
param([string]$SetupPath = "G:\thenu\Downloads\NOVA-Next-Generation-Omni-Vision-Assistant-main\release\Nova Genesis Setup 1.1.0.exe")

if (-not (Test-Path $SetupPath)) {
    Write-Output "SETUP_MISSING: $SetupPath"
    exit 1
}
Write-Output "Launching installer: $SetupPath"
$p = Start-Process -FilePath $SetupPath -ArgumentList "/S" -PassThru
Write-Output "Started PID=$($p.Id)"
# Poll for completion up to 90s
$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline) {
    if ($p.HasExited) {
        Write-Output "INSTALLER_EXITED code=$($p.ExitCode)"
        break
    }
    Start-Sleep -Seconds 2
}
if (-not $p.HasExited) {
    Write-Output "INSTALLER_TIMEOUT still running"
    $p.Kill()
}
$target = "$env:LOCALAPPDATA\Programs\Nova Genesis\Nova Genesis.exe"
if (Test-Path $target) {
    Write-Output "INSTALLED_OK"
} else {
    Write-Output "INSTALL_CHECK_FAILED"
}
