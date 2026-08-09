Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WinEnum {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
"@
$rows = New-Object System.Collections.ArrayList
$cb = {
  param($h, $l)
  $len = [WinEnum]::GetWindowTextLength($h)
  if ($len -gt 0) {
    $sb = New-Object System.Text.StringBuilder ($len + 1)
    [WinEnum]::GetWindowText($h, $sb, $sb.Capacity) | Out-Null
    $p = 0
    [WinEnum]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null
    $vis = [WinEnum]::IsWindowVisible($h)
    $rows.Add([PSCustomObject]@{ Pid = $p; Visible = $vis; Title = $sb.ToString() }) | Out-Null
  }
  return $true
}
[WinEnum]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
$rows | Sort-Object Pid | Format-Table -AutoSize | Out-String | Write-Output
