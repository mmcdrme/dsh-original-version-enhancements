Add-Type -AssemblyName System.Drawing

# Renders the plugin's icon.svg (blue rounded square, four lines, four dots)
# into a multi-resolution .ico so the companion exe carries it.
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$images = @()

foreach ($size in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)
    $scale = $size / 64.0

    $bg = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#1D4ED8'))
    $radius = 15 * $scale
    $rect = New-Object System.Drawing.RectangleF 0, 0, $size, $size
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $radius * 2
    $path.AddArc(0, 0, $d, $d, 180, 90)
    $path.AddArc($size - $d, 0, $d, $d, 270, 90)
    $path.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
    $path.AddArc(0, $size - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    $g.FillPath($bg, $path)

    $pen = New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml('#DBEAFE')), ([Math]::Max(1.0, 3.6 * $scale))
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $rows = @(
        @(16, 18, 48),
        @(16, 27, 38),
        @(16, 36, 48),
        @(16, 45, 32)
    )
    foreach ($row in $rows) {
        $g.DrawLine($pen, [single]($row[0] * $scale), [single]($row[1] * $scale), [single]($row[2] * $scale), [single]($row[1] * $scale))
    }
    $dotBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml('#93C5FD'))
    $dots = @(
        @(49, 18, 3.4),
        @(43, 27, 2.8),
        @(49, 36, 3.4),
        @(38, 45, 2.8)
    )
    foreach ($dot in $dots) {
        $r = $dot[2] * $scale
        $g.FillEllipse($dotBrush, [single](($dot[0] * $scale) - $r), [single](($dot[1] * $scale) - $r), [single]($r * 2), [single]($r * 2))
    }

    $g.Dispose()
    $stream = New-Object System.IO.MemoryStream
    $bmp.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $images += , $stream.ToArray()
    $bmp.Dispose()
}

$out = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter $out
$writer.Write([UInt16]0)               # reserved
$writer.Write([UInt16]1)               # type: icon
$writer.Write([UInt16]$sizes.Count)
$offset = 6 + (16 * $sizes.Count)
for ($index = 0; $index -lt $sizes.Count; $index++) {
    $size = $sizes[$index]
    $writer.Write([Byte]($(if ($size -ge 256) { 0 } else { $size })))
    $writer.Write([Byte]($(if ($size -ge 256) { 0 } else { $size })))
    $writer.Write([Byte]0)             # palette
    $writer.Write([Byte]0)             # reserved
    $writer.Write([UInt16]1)           # planes
    $writer.Write([UInt16]32)          # bit count
    $writer.Write([UInt32]$images[$index].Length)
    $writer.Write([UInt32]$offset)
    $offset += $images[$index].Length
}
foreach ($bytes in $images) { $writer.Write($bytes) }
$writer.Flush()

$target = Join-Path $PSScriptRoot '..\native\app.ico'
$target = [System.IO.Path]::GetFullPath($target)
[System.IO.File]::WriteAllBytes($target, $out.ToArray())
$out.Dispose()
"wrote $target"
