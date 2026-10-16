'use strict';
// Vista previa real del panel: activa extension.js con un VS Code simulado (datos reales de ~/.claude,
// del servidor y de servicios de prueba), toma el HTML del webview y lo pinta en Chromium sin interfaz.
// Uso: PLAYWRIGHT=<ruta a playwright-core> NAVEGADORES=<ruta> node pruebas/vista-previa.js <carpeta-salida>

const path = require('path');
const fs = require('fs');
const http = require('http');
const Module = require('module');

const RAIZ = path.join(__dirname, '..');
const SALIDA = process.argv[2] || path.join(__dirname, 'capturas');
fs.mkdirSync(SALIDA, { recursive: true });

// ---------- VS Code simulado ----------
const mensajes = [];
let proveedor = null;
const evento = () => () => ({ dispose() {} });
const ajustes = {
  servicios: [
    { nombre: 'Servicio de prueba', url: 'http://127.0.0.1:18765/' },
    { nombre: 'Django local', url: 'http://127.0.0.1:18766/' },
  ],
};
const vscodeFalso = {
  Uri: {
    joinPath: (u, ...p) => ({ fsPath: path.join(u.fsPath, ...p), toString() { return 'file://' + this.fsPath; } }),
    file: (p) => ({ fsPath: p }),
  },
  ThemeColor: class {},
  StatusBarAlignment: { Right: 2 },
  DiagnosticSeverity: { Error: 0, Warning: 1 },
  ConfigurationTarget: { Global: 1 },
  window: {
    registerWebviewViewProvider: (id, p) => { proveedor = p; return { dispose() {} }; },
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    onDidChangeActiveTextEditor: evento(), onDidChangeTextEditorSelection: evento(),
    onDidOpenTerminal: evento(), onDidChangeActiveTerminal: evento(),
  },
  workspace: {
    getConfiguration: () => ({ get: (k, d) => (k in ajustes ? ajustes[k] : d), update: async () => {} }),
    onDidChangeTextDocument: evento(), onDidChangeConfiguration: evento(),
  },
  languages: {
    getDiagnostics: () => [[{ scheme: 'file' }, [{ severity: 0 }, { severity: 1 }, { severity: 1 }]]],
    onDidChangeDiagnostics: evento(),
  },
  extensions: { getExtension: () => undefined },
  env: { openExternal: async () => true, language: 'es' },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} },
};
// API_FALSA=1: activa la consulta a Anthropic y responde con datos de ejemplo (no sale a internet).
if (process.env.API_FALSA) {
  ajustes.usoDesdeAnthropic = true;
  ajustes.costoPlanMensualUSD = 100;
  const https = require('https');
  const { PassThrough } = require('stream');
  https.get = (url, opciones, cb) => {
    const res = new PassThrough();
    res.statusCode = 200;
    res.setEncoding = () => {};
    const peticion = new (require('events'))();
    peticion.destroy = () => {};
    setTimeout(() => {
      const enHoras = (h) => new Date(Date.now() + h * 3600e3).toISOString();
      cb(res);
      res.end(JSON.stringify({
        five_hour: { utilization: 64, resets_at: enHoras(1.2) },
        seven_day: { utilization: 31, resets_at: enHoras(80) },
        seven_day_opus: { utilization: 44, resets_at: enHoras(80) },
        seven_day_sonnet: null,
      }));
    }, 50);
    console.log('consulta simulada a', url, '· encabezados:', Object.keys(opciones.headers).join(', '));
    return peticion;
  };
}
// DEMO=1: nombre de equipo ficticio para capturas de documentación.
if (process.env.IDIOMA) ajustes.idioma = process.env.IDIOMA; // IDIOMA=en para ver el panel en inglés
if (process.env.CIUDAD) ajustes['clima.ciudad'] = process.env.CIUDAD; // CIUDAD="Toluca de Lerdo, Estado de México, México"
if (process.env.DEMO) {
  require('os').hostname = () => 'mi-servidor';
  if (!process.env.CIUDAD) ajustes['clima.ciudad'] = 'Toluca';
}
const cargar = Module._load;
Module._load = function (req, ...r) { return req === 'vscode' ? vscodeFalso : cargar.call(this, req, ...r); };

const memoria = new Map();
if (process.env.DEMO) {
  memoria.set('koala.alarmas', [
    { id: 'a1', hora: '09:00', mensaje: 'Revisar pendientes del día', repeticion: 'laborables', activa: true, ultimaVez: null },
    { id: 'a2', hora: '14:30', mensaje: 'Junta con el equipo', repeticion: [2, 4], activa: true, ultimaVez: null },
    { id: 'a3', hora: '18:00', mensaje: 'Subir los cambios', repeticion: 'diaria', activa: false, ultimaVez: null },
  ]);
}
const ctx = {
  extensionUri: { fsPath: RAIZ }, extensionPath: RAIZ, subscriptions: [],
  globalState: { get: (k, d) => (memoria.has(k) ? memoria.get(k) : d), update: async (k, v) => memoria.set(k, v), setKeysForSync() {} },
};

(async () => {
  // un servicio que responde y otro apagado (18766 sin servidor)
  const srv = http.createServer((q, r) => r.end('ok')).listen(18765);
  const ext = require(path.join(RAIZ, 'extension.js'));
  ext.activate(ctx);

  let html = '';
  const vista = {
    visible: true,
    webview: {
      options: {}, cspSource: 'file:',
      asWebviewUri: (u) => 'file://' + u.fsPath,
      postMessage: (m) => { mensajes.push(m); return Promise.resolve(true); },
      onDidReceiveMessage: () => ({ dispose() {} }),
      set html(v) { html = v; }, get html() { return html; },
    },
    onDidChangeVisibility: () => ({ dispose() {} }),
    onDidDispose: () => ({ dispose() {} }),
  };
  proveedor.resolveWebviewView(vista);
  await new Promise((r) => setTimeout(r, 9000)); // escaneo + mediciones
  const estado = [...mensajes].reverse().find((m) => m.tipo === 'estado');
  srv.close();
  ext.deactivate();
  for (const d of ctx.subscriptions) try { d.dispose(); } catch (e) { /* */ }

  // ---------- Chromium ----------
  const { chromium } = require(process.env.PLAYWRIGHT);
  const navegador = await chromium.launch({ executablePath: process.env.CHROMIUM });
  const pagina = await navegador.newPage({ viewport: { width: 330, height: 900 }, deviceScaleFactor: 2 });
  const errores = [];
  pagina.on('pageerror', (e) => errores.push(e.message));
  pagina.on('console', (m) => { if (m.type() === 'error') errores.push(m.text()); });
  // Variables de tema oscuro de VS Code y el canal simulado.
  const tema = `<style>body{background:#181818;--vscode-foreground:#ccc;--vscode-font-family:sans-serif;--vscode-editorWidget-border:#454545;
    --vscode-editorWidget-background:#252526;--vscode-button-background:#0e639c;--vscode-button-foreground:#fff;--vscode-button-secondaryBackground:#3a3d41;
    --vscode-button-secondaryForeground:#ccc;--vscode-charts-green:#89d185;--vscode-charts-red:#f14c4c;--vscode-charts-yellow:#cca700;
    --vscode-charts-blue:#3794ff;--vscode-charts-purple:#b180d7;--vscode-focusBorder:#0078d4}</style>
    <script>window.acquireVsCodeApi=()=>({postMessage(){},getState(){return null},setState(){}});</script>`;
  const pag = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '').replace('<head>', '<head>' + tema);
  const ruta = path.join(SALIDA, 'vista.html');
  fs.writeFileSync(ruta, pag);
  await pagina.goto('file://' + ruta);
  await pagina.evaluate((m) => window.postMessage(m, '*'), estado);
  await pagina.waitForTimeout(1500);
  for (const p of ['mascota', 'consumo', 'hoy', 'sistema']) {
    await pagina.click(`[data-pestana="${p}"]`);
    await pagina.waitForTimeout(400);
    const alto = await pagina.evaluate(() => document.body.scrollHeight);
    await pagina.setViewportSize({ width: 330, height: Math.min(1400, alto + 10) });
    await pagina.screenshot({ path: path.join(SALIDA, `panel-${p}.png`) });
    console.log('captura', p);
  }
  const texto = await pagina.evaluate(() => document.body.innerText);
  console.log(/undefined|NaN/.test(texto) ? '✗ hay "undefined" o "NaN" en el panel' : '✓ sin undefined/NaN en el texto');
  console.log(errores.length ? '✗ errores: ' + errores.join(' | ') : '✓ sin errores de JavaScript');
  console.log('alertas:', JSON.stringify(estado.alertas));
  await navegador.close();
  process.exit(0);
})();
