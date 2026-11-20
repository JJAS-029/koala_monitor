'use strict';
// Qué está sonando en Windows (Spotify, YouTube en el navegador…), con el control multimedia del sistema
// (GlobalSystemMediaTransportControls) desde scripts/media-info.ps1. Solo se lee en este equipo; no sale de aquí.
// En otros sistemas no hace nada.
const path = require('path');
const { execFile } = require('child_process');

// Salida del script → { titulo, artista, app, sonando } o null.
function leerSalida(texto) {
  let d = null;
  try { d = JSON.parse(String(texto || '').trim() || 'null'); } catch (e) { return null; }
  if (!d || typeof d !== 'object' || !d.title) return null;
  const app = String(d.app || '').replace(/\.exe$/i, '').split(/[!\\]/).pop();
  return { titulo: String(d.title), artista: String(d.artist || ''), app, sonando: d.status === 'Playing' };
}

function leerMusica(extensionPath) {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolver) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(extensionPath, 'scripts', 'media-info.ps1')],
    { timeout: 8000, windowsHide: true, encoding: 'utf8' },
    (err, stdout) => resolver(err ? null : leerSalida(stdout)));
  });
}

module.exports = { leerMusica, leerSalida };
