$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut("C:\Users\Leo\Desktop\Pi Desktop.lnk")
$sc.TargetPath = "C:\Users\Leo\AppData\Local\Programs\Pi Desktop\Pi Desktop.exe"
$sc.IconLocation = "C:\Users\Leo\AppData\Local\Programs\Pi Desktop\Pi Desktop.exe,0"
$sc.Save()
Write-Output "shortcut recreated"
