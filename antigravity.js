'use strict';
// Cuotas de Antigravity con su CLI oficial `agy`: `agy -p /usage --output-format json` es un comando local
// (no le pregunta nada al modelo ni gasta tokens) y responde los grupos de modelos con su límite de 5 h y
// semanal: { command: { name: 'usage', data: { groups: [{ name, description, buckets: [{ id, name, window,
// remaining_fraction, reset_time }] }] } }, response: 'texto con tabuladores' }.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

// agy no siempre queda en el PATH: el instalador de Windows lo pone en %LOCALAPPDATA%\agy\bin.
function buscarAgy(entorno = process.env) {
  if (entorno.AGY_BIN && fs.existsSync(entorno.AGY_BIN)) return entorno.AGY_BIN;
  const local = entorno.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const candidatos = process.platform === 'win32'
    ? [path.join(local, 'agy', 'bin', 'agy.exe'), path.join(local, 'Programs', 'agy', 'agy.exe'), path.join(os.homedir(), '.local', 'bin', 'agy.exe')]
    : [path.join(os.homedir(), '.local', 'bin', 'agy'), '/usr/local/bin/agy', '/opt/homebrew/bin/agy'];
  return candidatos.find((c) => fs.existsSync(c)) || 'agy'; // si no, se prueba el del PATH
}

const fraccionAPct = (f) => (Number.isFinite(Number(f)) ? Math.max(0, Math.min(100, Math.round(Number(f) * 100))) : null);
const fecha = (v) => { const ms = Date.parse(v); return Number.isFinite(ms) ? ms : null; };

// Respuesta de agy → { grupos: [{ nombre, modelos, limites: [{ id, nombre, ventana, restantePct, reinicio }] }] }
function leerUso(texto) {
  const crudo = String(texto || '').trim();
  let json = null;
  try { json = JSON.parse(crudo); } catch (e) {
    const m = crudo.match(/\{[\s\S]*\}/); // por si imprime algo antes del JSON
    if (m) try { json = JSON.parse(m[0]); } catch (e2) { /* no es JSON */ }
  }
  const grupos = [];
  const datos = json && json.command && json.command.data;
  for (const g of (datos && datos.groups) || []) {
    const modelos = String(g.description || '').replace(/^Models within this group:\s*/i, '');
    grupos.push({
      nombre: String(g.name || ''),
      modelos: /^Models within/i.test(g.description || '') ? modelos : '',
      limites: (g.buckets || []).map((b) => ({
        id: String(b.id || ''),
        nombre: String(b.name || ''),
        ventana: b.window === '5h' ? '5h' : b.window === 'weekly' ? 'semana' : String(b.window || ''),
        restantePct: fraccionAPct(b.remaining_fraction),
        reinicio: fecha(b.reset_time),
      })).filter((l) => l.restantePct !== null),
    });
  }
  // Respaldo: el texto con tabuladores "Grupo\tLímite\t74%\t2026-11-26T19:03:53Z".
  if (!grupos.length && json && typeof json.response === 'string') {
    for (const linea of json.response.split(/\r?\n/)) {
      const [nombre, limite, pct, reinicio] = linea.split('\t');
      const n = parseFloat(pct);
      if (!nombre || !Number.isFinite(n)) continue;
      let g = grupos.find((x) => x.nombre === nombre);
      if (!g) grupos.push(g = { nombre, modelos: '', limites: [] });
      g.limites.push({ id: '', nombre: limite || '', ventana: /five|5/i.test(limite) ? '5h' : /week/i.test(limite) ? 'semana' : '', restantePct: Math.round(n), reinicio: fecha(reinicio) });
    }
  }
  return { grupos: grupos.filter((g) => g.limites.length), json };
}

// Corre en una carpeta vacía, en sandbox y en modo plan: /usage no usa herramientas, pero si algún día agy
// no lo reconociera y lo mandara al modelo, no podría tocar ningún proyecto.
function consultar({ bin = buscarAgy(), carpeta = path.join(os.tmpdir(), 'koala-agy'), espera = 30000 } = {}) {
  return new Promise((resolver) => {
    try { fs.mkdirSync(carpeta, { recursive: true }); } catch (e) { /* se usa igual */ }
    execFile(bin, ['-p', '/usage', '--output-format', 'json', '--sandbox', '--mode', 'plan', '--print-timeout', '25s'],
      { cwd: carpeta, timeout: espera, windowsHide: true, env: { ...process.env, NO_COLOR: '1' }, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        const ahora = Date.now();
        if (err && err.code === 'ENOENT') return resolver({ estado: 'sin_agy', grupos: [], actualizado: ahora });
        const detalle = String(stderr || '').trim();
        const { grupos, json } = leerUso(stdout);
        if (grupos.length) return resolver({ estado: 'ok', grupos, actualizado: ahora });
        const todo = detalle + ' ' + String(stdout || '') + ' ' + (err ? err.message : '');
        if (/log ?in|sign ?in|not logged|unauthenticated|credential/i.test(todo)) return resolver({ estado: 'sin_sesion', grupos: [], actualizado: ahora });
        const error = (json && json.status && json.status !== 'SUCCESS' ? json.status : '') || detalle.split(/\r?\n/).pop() || (err ? err.message : '');
        resolver({ estado: 'error', grupos: [], error: String(error || 'agy no devolvió cuotas').slice(0, 200), actualizado: ahora });
      });
  });
}

module.exports = { buscarAgy, leerUso, consultar };
