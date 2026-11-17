# Gera host\pokebot.ico: pokebola discreta (roxo do app em cima, grafite embaixo), em 16/24/32/48/64/256 px.
Add-Type -AssemblyName System.Drawing
$sizes = 16, 24, 32, 48, 64, 256
$pngs = @()
foreach ($s in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap $s, $s
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'; $g.Clear([System.Drawing.Color]::Transparent)
  $m = [math]::Max(1, [math]::Round($s * 0.06)); $d = $s - 2 * $m
  $roxo = [System.Drawing.Color]::FromArgb(139, 108, 246); $grafite = [System.Drawing.Color]::FromArgb(36, 32, 52)
  $linha = [System.Drawing.Color]::FromArgb(17, 15, 24); $claro = [System.Drawing.Color]::FromArgb(236, 233, 245)
  $g.FillEllipse((New-Object System.Drawing.SolidBrush $grafite), $m, $m, $d, $d)
  $g.FillPie((New-Object System.Drawing.SolidBrush $roxo), $m, $m, $d, $d, 180, 180)
  $pw = [math]::Max(1, $s * 0.08)
  $g.DrawLine((New-Object System.Drawing.Pen $linha, $pw), $m, $s / 2, $s - $m, $s / 2)
  $g.DrawEllipse((New-Object System.Drawing.Pen $linha, $pw), $m, $m, $d, $d)
  $r = $s * 0.17
  $g.FillEllipse((New-Object System.Drawing.SolidBrush $linha), $s / 2 - $r, $s / 2 - $r, 2 * $r, 2 * $r)
  $r2 = $s * 0.10
  $g.FillEllipse((New-Object System.Drawing.SolidBrush $claro), $s / 2 - $r2, $s / 2 - $r2, 2 * $r2, 2 * $r2)
  $g.Dispose()
  $ms = New-Object System.IO.MemoryStream; $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $pngs += , $ms.ToArray(); $bmp.Dispose()
}
$out = New-Object System.IO.MemoryStream; $w = New-Object System.IO.BinaryWriter $out
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
$off = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $s = $sizes[$i]; $b = if ($s -ge 256) { 0 } else { $s }
  $w.Write([byte]$b); $w.Write([byte]$b); $w.Write([byte]0); $w.Write([byte]0)
  $w.Write([uint16]1); $w.Write([uint16]32); $w.Write([uint32]$pngs[$i].Length); $w.Write([uint32]$off); $off += $pngs[$i].Length
}
foreach ($p in $pngs) { $w.Write($p) }
[System.IO.File]::WriteAllBytes((Join-Path $PSScriptRoot 'pokebot.ico'), $out.ToArray())
$p256 = Join-Path $PSScriptRoot 'pokebot-256.png'; [System.IO.File]::WriteAllBytes($p256, $pngs[-1]); "ok"
