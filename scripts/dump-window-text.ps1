Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::NameProperty, 'Error')
$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
if (-not $win) {
  # fallback: any window whose name contains 'Nova' or 'Error'
  $cond2 = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::NameProperty, '*Error*')
  $win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond2)
}
if ($win) {
  Write-Output ('WINDOW: ' + $win.Current.Name)
  $all = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Text)
  $texts = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $all)
  foreach ($t in $texts) {
    if ($t.Current.Name) { Write-Output ('TEXT: ' + $t.Current.Name) }
  }
  # also dump the window's whole tree names shallowly
  $any = [System.Windows.Automation.Condition]::TrueCondition
  $nodes = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $any)
  $count = 0
  foreach ($n in $nodes) {
    if ($count -ge 40) { break }
    if ($n.Current.Name) { Write-Output ('NODE: ' + $n.Current.ControlType.ProgrammaticName + ' | ' + $n.Current.Name) }
    $count++
  }
} else {
  Write-Output 'NO Error window found'
}
