# Generate Pi Desktop icon set: flat black rounded square + custom white pi mark
# Rendered at 1024 then downscaled (supersampling) for crisp edges
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

function Draw-LogoMaster([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    $margin = [int]($size * 0.02)
    $side = $size - $margin * 2
    $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(16, 16, 16))
    $bgPath = New-RoundedRectPath $margin $margin $side $side ($size * 0.23)
    $g.FillPath($brush, $bgPath)

    $s = [float]$size
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::White), ($s * 0.095)
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

    $g.DrawLine($pen, $s * 0.30, $s * 0.30, $s * 0.70, $s * 0.30)
    $g.DrawLine($pen, $s * 0.41, $s * 0.30, $s * 0.41, $s * 0.70)

    $x1 = [float]($s * 0.59); $y0 = [float]($s * 0.30); $y1 = [float]($s * 0.54)
    $x2 = [float]($s * 0.59); $y2 = [float]($s * 0.68)
    $x3 = [float]($s * 0.70); $y3 = [float]($s * 0.73)
    $leg = New-Object System.Drawing.Drawing2D.GraphicsPath
    $leg.AddLine($x1, $y0, $x1, $y1)
    $p1 = New-Object System.Drawing.PointF($x1, $y1)
    $p2 = New-Object System.Drawing.PointF($x2, $y2)
    $p3 = New-Object System.Drawing.PointF($x3, $y3)
    $leg.AddCurve([System.Drawing.PointF[]]@($p1, $p2, $p3), 0.6)
    $g.DrawPath($pen, $leg)

    $g.Dispose()
    return $bmp
}

$master = Draw-LogoMaster 1024
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
Write-Output "icon set generated (supersampled)"
