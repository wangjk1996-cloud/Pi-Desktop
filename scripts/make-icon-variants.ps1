 
Add-Type -AssemblyName System.Drawing

function New-RoundedRectPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $path.AddArc($x, $y, $d, $d, 180, 90)
    $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    return $path
}

function Draw-Icon([string]$name, [int]$size, [int]$bgR, [int]$bgG, [int]$bgB, [int]$fgR, [int]$fgG, [int]$fgB) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    $margin = [int]($size * 0.02)
    $side = $size - $margin * 2
    $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb($bgR, $bgG, $bgB))
    $path = New-RoundedRectPath $margin $margin $side $side ($size * 0.23)
    $g.FillPath($brush, $path)

    $fontSize = [single]($size * 0.5)
    $font = New-Object System.Drawing.Font("Arial", $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = [System.Drawing.StringAlignment]::Center
    $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
    $textRect = New-Object System.Drawing.RectangleF 0, 0, $size, $size
    $fgBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb($fgR, $fgG, $fgB))
    $g.DrawString([char]0x03C0, $font, $fgBrush, $textRect, $sf)

    $out = "build\icon-$name-$size.png"
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    Write-Output "OK: $out"
}

 
Draw-Icon "a" 256 217 119 87 250 243 235
 
Draw-Icon "b" 256 16 16 16 255 255 255
 
Draw-Icon "c" 256 79 70 229 255 255 255
