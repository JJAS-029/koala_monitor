# Qué suena en Windows (Spotify, YouTube en el navegador, etc.): título, artista y si está sonando.
# Tomado de monitor_cel (src/media-info.ps1). Imprime JSON en una línea, o null si no hay nada.
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]

  function Await($WinRtTask, $ResultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
    $netTask = $asTask.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
  }

  [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime] | Out-Null
  [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties,Windows.Media.Control,ContentType=WindowsRuntime] | Out-Null

  $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  $s = if ($mgr) { $mgr.GetCurrentSession() } else { $null }
  if ($s) {
    $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    $info = $s.GetPlaybackInfo()
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    [PSCustomObject]@{
      title  = $p.Title
      artist = $p.Artist
      album  = $p.AlbumTitle
      status = $info.PlaybackStatus.ToString()
      app    = $s.SourceAppUserModelId
    } | ConvertTo-Json -Compress
  } else {
    Write-Output 'null'
  }
} catch {
  Write-Output 'null'
}
