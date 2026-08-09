# Launch installed Nova Genesis cleanly, wait, then dump window text via UI Automation.
$ErrorActionPreference = 'SilentlyContinue'
Get-Process -Name 'Nova Genesis' | Stop-Process -Force
Start-Sleep -Seconds 2
$exe = Join-Path $env:LOCALAPPDATA 'Programs\Nova Genesis\Nova Genesis.exe'
Start-Process -FilePath $exe
Start-Sleep -Seconds 20

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$out = @()
$root = [System.Windows.Automation.AutomationElement]::RootElement
$all = $root.FindAll([System.Windows.Automation.TreeScope]::Children,
        [System.Windows.Automation.Condition]::TrueCondition)
foreach ($w in $all) {
  try {
    $pid_ = $w.Current.ProcessId
    $name = $w.Current.Name
    $cls = $w.Current.ClassName
    $out += "WINDOW pid=$pid_ class=$cls name=[$name]"
    if ($name -match 'Error|Nova|Genesis') {
      $cond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Text)
      $texts = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
      foreach ($t in $texts) { $out += "  TEXT: " + $t.Current.Name }
      $buttons = $w.FindAll([System.Windows.Automation.TreeScope]::Descendants,
        (New-Object System.Windows.Automation.PropertyCondition(
          [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
          [System.Windows.Automation.ControlType]::Button)))
      foreach ($b in $buttons) { $out += "  BUTTON: " + $b.Current.Name }
    }
  } catch { $out += "  ERR: $_" }
}
$out | Out-File -FilePath "$env:TEMP\nova-window-dump.txt" -Encoding utf8
Write-Output ($out -join "`n")
