Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class CatAdblockerCursor {
  [DllImport("user32.dll")]
  public static extern bool SetProcessDPIAware();

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool SetCursorPos(int X, int Y);
}
"@

[CatAdblockerCursor]::SetProcessDPIAware() | Out-Null

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) {
    break
  }

  try {
    $parts = $line.Trim() -split "\s+"
    if ($parts.Length -ne 2) {
      throw "Invalid cursor command"
    }

    $x = [int][double]::Parse($parts[0], [System.Globalization.CultureInfo]::InvariantCulture)
    $y = [int][double]::Parse($parts[1], [System.Globalization.CultureInfo]::InvariantCulture)

    if (-not [CatAdblockerCursor]::SetCursorPos($x, $y)) {
      $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      throw "SetCursorPos failed with Win32 error $errorCode"
    }

    [Console]::Out.WriteLine("OK")
  } catch {
    $message = $_.Exception.Message
    if (-not $message) {
      $message = [string]$_
    }

    [Console]::Out.WriteLine("ERR $message")
  }

  [Console]::Out.Flush()
}
