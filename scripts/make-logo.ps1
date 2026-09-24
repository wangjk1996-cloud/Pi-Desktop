# Draw a custom pi glyph logo mark (stroke-based, rounded caps) - not a font glyph
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

function Draw-Logo([string]$name, [int]$size, [int]$bgR, [int]$bgG, [int]$bgB, [int]$fgR, [int]$fgG, [int]$fgB) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)

    $margin = [int]($size * 0.02)
    $side = $size - $margin * 2
    $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb($bgR, $bgG, $bgB))
    $bgPath = New-RoundedRectPath $margin $margin $side $side ($size * 0.23)
    $g.FillPath($brush, $bgPath)

    $s = [float]$size
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb($fgR, $fgG, $fgB)), ($s * 0.115)
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

    # top bar
    $g.DrawLine($pen, $s * 0.26, $s * 0.30, $s * 0.74, $s * 0.30)
    # left leg
    $g.DrawLine($pen, $s * 0.40, $s * 0.30, $s * 0.40, $s * 0.70)
    # right leg with outward flare at the bottom (pi tail)
    $x0 = [float]($s * 0.60); $y0 = [float]($s * 0.30)
    $x1 = [float]($s * 0.60); $y1 = [float]($s * 0.52)
    $x2 = [float]($s * 0.60); $y2 = [float]($s * 0.68)
    $x3 = [float]($s * 0.72); $y3 = [float]($s * 0.72)
    $leg = New-Object System.Drawing.Drawing2D.GraphicsPath
    $leg.AddLine($x0, $y0, $x1, $y1)
    $p1 = New-Object System.Drawing.PointF($x1, $y1)
    $p2 = New-Object System.Drawing.PointF($x2, $y2)
    $p3 = New-Object System.Drawing.PointF($x3, $y3)
    $leg.AddCurve([System.Drawing.PointF[]]@($p1, $p2, $p3), 0.6)
    $g.DrawPath($pen, $leg)

    $out = "build\logo-$name-$size.png"
    $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    Write-Output "OK: $out"
}

Draw-Logo "coral" 256 217 119 87 250 243 235
Draw-Logo "black" 256 16 16 16 255 255 255
