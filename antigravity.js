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

// ---------- Uso local: tokens por respuesta en las conversaciones de Antigravity ----------
// Cada respuesta del modelo (type PLANNER_RESPONSE) en ~/.gemini/<producto>/brain/<conversación>/.system_generated/
// logs/chunks/transcript/*.jsonl trae model, input_tokens, output_tokens y created_at. Solo se leen esos números.
const PRODUCTOS = ['antigravity', 'antigravity-cli', 'antigravity-ide'];
const SIETE_DIAS_MS = 7 * 86400000;

// gemini-4-neon-high → 'gemini'; claude-opus-5-5-medium → 'claude'; lo demás (p. ej. gpt-oss) → 'otro'.
const familia = (modelo) => (/^gemini/i.test(modelo) ? 'gemini' : /^claude/i.test(modelo) ? 'claude' : 'otro');

function crearUsoAntigravity({ dirGemini = path.join(os.homedir(), '.gemini') } = {}) {
  const archivos = new Map(); // ruta → { mtime, size, respuestas: [{ id, t, tok, modelo }] }

  function leerArchivo(ruta, conversacion) {
    const respuestas = [];
    let texto = '';
    try { texto = fs.readFileSync(ruta, 'utf8'); } catch (e) { return respuestas; }
    for (const linea of texto.split('\n')) {
      if (!linea.includes('PLANNER_RESPONSE')) continue;
      let d;
      try { d = JSON.parse(linea); } catch (e) { continue; }
      const t = Date.parse(d.created_at);
      if (d.type !== 'PLANNER_RESPONSE' || !Number.isFinite(t)) continue;
      const tok = (Number(d.input_tokens) || 0) + (Number(d.output_tokens) || 0);
      if (tok) respuestas.push({ id: conversacion + ':' + d.step_index, t, tok, modelo: String(d.model || '') });
    }
    return respuestas;
  }

  // Relee solo los archivos que cambiaron en los últimos 7 días.
  function escanear() {
    const limite = Date.now() - SIETE_DIAS_MS;
    const vistos = new Set();
    for (const producto of PRODUCTOS) {
      const brain = path.join(dirGemini, producto, 'brain');
      let conversaciones = [];
      try { conversaciones = fs.readdirSync(brain); } catch (e) { continue; }
      for (const c of conversaciones) {
        const dir = path.join(brain, c, '.system_generated', 'logs', 'chunks', 'transcript');
        let nombres = [];
        try { nombres = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')); } catch (e) { continue; }
        for (const n of nombres) {
          const ruta = path.join(dir, n);
          let st;
          try { st = fs.statSync(ruta); } catch (e) { continue; }
          if (st.mtimeMs < limite) continue;
          vistos.add(ruta);
          const previo = archivos.get(ruta);
          if (previo && previo.mtime === st.mtimeMs && previo.size === st.size) continue;
          archivos.set(ruta, { mtime: st.mtimeMs, size: st.size, respuestas: leerArchivo(ruta, producto + '/' + c) });
        }
      }
    }
    for (const ruta of [...archivos.keys()]) if (!vistos.has(ruta)) archivos.delete(ruta);
  }

  // Mapa día × hora (fila 6 = hoy) con los tokens de cada familia de modelos.
  function mapa(inicioHoy) {
    const vacio = () => Array.from({ length: 7 }, () => new Array(24).fill(0));
    const m = { gemini: vacio(), claude: vacio(), otro: vacio() };
    const vistas = new Set(); // los trozos de una conversación pueden repetir respuestas
    for (const a of archivos.values()) {
      for (const r of a.respuestas) {
        if (vistas.has(r.id)) continue;
        vistas.add(r.id);
        const fila = 6 - (r.t >= inicioHoy ? 0 : Math.floor((inicioHoy - r.t) / 86400000) + 1);
        if (fila >= 0 && fila < 7) m[familia(r.modelo)][fila][new Date(r.t).getHours()] += r.tok;
      }
    }
    return m;
  }

  return { escanear, mapa };
}

module.exports = { buscarAgy, leerUso, consultar, crearUsoAntigravity, familia };
