'use strict';
// Capturas del panel para el README (docs/capturas/panel-*.png) con datos de DEMOSTRACIÓN: arma el HTML real de
// vista.js, le manda un estado inventado y lo fotografía con Edge (o Chrome) sin ventana por el protocolo de
// depuración. Nunca usa datos del usuario.
// Uso: node pruebas/capturas-panel.js          (EDGE=<ruta al navegador> si no está en el lugar de siempre)
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');
const { spawn } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const SALIDA = path.join(RAIZ, 'docs', 'capturas');
const ANCHO = 340; // ancho típico de la barra lateral de VS Code
const uriDe = (p) => ({ fsPath: p, toString() { return 'file:///' + p.replace(/\\/g, '/'); } });
const cargar = Module._load;
Module._load = function (req, ...r) {
  if (req === 'vscode') return { Uri: { joinPath: (u, ...p) => uriDe(path.join(u.fsPath, ...p)) }, workspace: { getConfiguration: () => ({ get: (k, d) => d }) }, env: { language: 'es' } };
  return cargar.call(this, req, ...r);
};
const { htmlVista } = require(path.join(RAIZ, 'vista.js'));

// ---------- Estado de demostración ----------
let semilla = 11;
const azar = () => { semilla = (semilla * 1664525 + 1013904223) >>> 0; return semilla / 4294967296; };
const enHoras = (h) => Date.now() + h * 3600e3;
const vacio = () => Array.from({ length: 7 }, () => new Array(24).fill(0));
const mapa = vacio(), gemini = vacio(), claudeAgy = vacio();
for (let i = 0; i < 7; i++) {
  for (let h = 0; h < 24; h++) {
    if (i === 1 || i === 2) continue; // fin de semana tranquilo
    if ((h >= 9 && h <= 13) || (h >= 16 && h <= 18)) if (azar() < 0.8) mapa[i][h] = 40000 + Math.floor(azar() * 160000);
    if (h >= 11 && h <= 15 && azar() < 0.45) gemini[i][h] = 60000 + Math.floor(azar() * 300000);
    if (h === 20 && azar() < 0.5) claudeAgy[i][h] = 50000;
  }
}
const GB = 1024 ** 3;
const estado = {
  tipo: 'estado', necesidades: { saciedad: 78, animo: 64, energia: 58 }, durmiendo: false, trabajando: false,
  energiaLigada: true, umbral: 90, temporada: 'ninguna', sinIconoComida: true,
  horaPrueba: (() => { const d = new Date(); d.setHours(11, 20, 0, 0); return d.getTime(); })(),
  rutina: { agua: 4, metaAgua: 8, logros: [], diasSinErrores: 0 },
  uso: {
    cinco: { pct: 38, reinicio: enHoras(2.6) }, semana: { pct: 21, reinicio: enHoras(98) }, extras: [],
    fuente: 'anthropic', actualizado: Date.now() - 120000, ritmo: { estado: 'holgado' }, local: { tokens5h: 1180000, tokens7d: 6400000 },
  },
  antigravity: {
    estado: 'ok', actualizado: Date.now() - 180000, hooks: true, grupos: [
      { nombre: 'Gemini Models', modelos: 'Gemini 4 Neon, Gemini 4 Hydrogen, Gemini 3.8 Flash', limites: [{ ventana: '5h', restantePct: 81, reinicio: enHoras(3.4) }, { ventana: 'semana', restantePct: 72, reinicio: enHoras(120) }] },
      { nombre: 'Claude and GPT models', modelos: 'Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B', limites: [{ ventana: '5h', restantePct: 100, reinicio: enHoras(5) }, { ventana: 'semana', restantePct: 22, reinicio: enHoras(140) }] },
      { nombre: 'Gemini 4 Argon', modelos: '', limites: [{ ventana: 'semana', restantePct: 95, reinicio: enHoras(121) }] },
    ],
  },
  hoy: {
    mapa, mapaAgy: { gemini, claude: claudeAgy, otro: vacio() }, dias: ['vie', 'sáb', 'dom', 'lun', 'mar', 'mié', 'jue'],
    tokens: 1240000, mensajes: 164, cachePct: 91, modelos: { 'claude-opus-5-5': 980000, 'claude-sonnet-5-5': 260000 },
    proyectos: { 'visor-mapas': 720000, 'api-reportes': 380000, koala: 140000 }, herramientas: { Edit: 41, Bash: 33, Read: 27, Grep: 12 },
  },
  activoHoy: 3 * 3600 + 10 * 60, pomodoro: { fase: null, hoy: 3 },
  sistema: {
    host: 'mi-servidor', nucleos: 16, cpu: 27, carga: 2.4, temperatura: 58, encendido: 9 * 86400,
    memoria: { usada: 21.4 * GB, total: 64 * GB, pct: 33 }, discos: [{ ruta: '/', usada: 310 * GB, total: 512 * GB, pct: 61 }],
  },
  servicios: [
    { nombre: 'API de reportes', url: 'http://localhost:8000/', ok: true, ms: 42 },
    { nombre: 'Visor de mapas', url: 'http://localhost:5173/', ok: true, ms: 18 },
    { nombre: 'Base de datos', url: 'http://localhost:5432/', ok: false, detalle: 'apagado' },
  ],
  clima: { temp: 19, tipo: 'despejado', nombre: 'Toluca de Lerdo' },
  git: [], diag: { errores: 0, avisos: 0, archivos: 0 }, alertas: [],
};

// [archivo, carruseles que se ven, ¿incluir al koala?]
const CAPTURAS = [
  ['panel-mascota', ['mascota'], true],
  ['panel-cuotas', ['cuotas'], false],
  ['panel-calor', ['calor', 'resumen'], false],
  ['panel-sistema', ['servidor', 'servicios'], false],
];

function html(carruseles) {
  let h = htmlVista({ asWebviewUri: (u) => u.toString(), cspSource: 'file:' }, uriDe(RAIZ));
  h = h.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '').replace('<body>', '<body class="vscode-dark">');
  // Colores del tema oscuro por omisión de VS Code (Dark Modern).
  const tema = 'body{background:#181818;color:#ccc;--vscode-foreground:#cccccc;--vscode-editorWidget-background:#202020;' +
    '--vscode-editorWidget-border:#3c3c3c;--vscode-charts-blue:#3794ff;--vscode-charts-purple:#b180d7;--vscode-charts-green:#89d185;' +
    '--vscode-charts-orange:#d18616;--vscode-charts-red:#f14c4c;--vscode-charts-yellow:#cca700;--vscode-button-background:#0078d4;' +
    '--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#313131;--vscode-button-secondaryForeground:#ccc;' +
    '--vscode-font-family:"Segoe UI",system-ui,sans-serif}';
  h = h.replace('</head>', `<style>${tema}</style></head>`);
  const e = Object.assign({}, estado, { carruseles });
  return h.replace('</body>', `<script>setTimeout(function(){ window.postMessage(${JSON.stringify(e)}, '*'); }, 200);</script></body>`);
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const navegador = process.env.EDGE || ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => fs.existsSync(p));
if (!navegador) throw new Error('No encontré Edge ni Chrome (usa EDGE=<ruta>)');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'koala-capturas-'));
  const PUERTO = 9334;
  const proc = spawn(navegador, ['--headless=new', '--disable-gpu', '--allow-file-access-from-files', `--remote-debugging-port=${PUERTO}`, `--user-data-dir=${path.join(tmp, 'perfil')}`, 'about:blank'], { stdio: 'ignore' });
  try {
    let objetivo = null;
    for (let i = 0; i < 40 && !objetivo; i++) {
      await dormir(250);
      try { objetivo = (await (await fetch(`http://127.0.0.1:${PUERTO}/json`)).json()).find((t) => t.type === 'page'); } catch (e) { /* aún no */ }
    }
    if (!objetivo) throw new Error('el navegador no abrió el puerto de depuración');
    const ws = new WebSocket(objetivo.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener('open', r));
    let n = 0;
    const pendientes = new Map();
    ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pendientes.has(m.id)) { pendientes.get(m.id)(m.result || {}); pendientes.delete(m.id); } });
    const cdp = (method, params = {}) => new Promise((r) => { const id = ++n; pendientes.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
    const evaluar = async (expr) => (await cdp('Runtime.evaluate', { expression: expr, returnByValue: true })).result.value;
    await cdp('Emulation.setDeviceMetricsOverride', { width: ANCHO, height: 900, deviceScaleFactor: 2, mobile: false });
    fs.mkdirSync(SALIDA, { recursive: true });
    for (const [nombre, carruseles, conKoala] of CAPTURAS) {
      const archivo = path.join(tmp, nombre + '.html');
      fs.writeFileSync(archivo, html(carruseles));
      await cdp('Page.navigate', { url: 'file:///' + archivo.replace(/\\/g, '/') });
      await dormir(2500); // que el koala camine un poco y las barras terminen su animación
      const r = JSON.parse(await evaluar(`(() => {
        const cs = [...document.querySelectorAll('#carruseles .carrusel')];
        const arriba = ${conKoala} ? 0 : cs[0].getBoundingClientRect().top - 6;
        const abajo = cs[cs.length - 1].getBoundingClientRect().bottom + 6;
        return JSON.stringify({ arriba, abajo });
      })()`));
      const foto = await cdp('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: r.arriba, width: ANCHO, height: r.abajo - r.arriba, scale: 1 } });
      fs.writeFileSync(path.join(SALIDA, nombre + '.png'), Buffer.from(foto.data, 'base64'));
      console.log('→ docs/capturas/' + nombre + '.png');
    }
    ws.close();
  } finally {
    proc.kill();
    setTimeout(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* el navegador aún lo usa */ } }, 1500);
  }
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
