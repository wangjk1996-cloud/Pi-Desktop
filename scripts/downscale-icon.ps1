# Downscale icon-1024.png to the icon set sizes
Add-Type -AssemblyName System.Drawing

$master = [System.Drawing.Bitmap]::FromFile("$PWD\build\icon-1024.png")
foreach ($sz in @(256, 64, 48, 32, 16)) {
    $bmp = New-Object System.Drawing.Bitmap $sz, $sz
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.DrawImage($master, 0, 0, $sz, $sz)
    $bmp.Save("build\icon-$sz.png", [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
}
$master.Dispose()
Write-Output "icon set downscaled"
