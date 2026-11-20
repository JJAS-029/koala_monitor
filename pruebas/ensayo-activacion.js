'use strict';
// Ensayo de activación: carga extension.js con un VS Code simulado (con un contexto como el real: globalState
// es una propiedad fija) en un HOME temporal. Simula dos editores (VS Code y Antigravity) que comparten el koala.
// Uso: node pruebas/ensayo-activacion.js            → estado compartido, ajustes, líder y Antigravity
//      node pruebas/ensayo-activacion.js monitor    → en un equipo nuevo el monitor se configura solo
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const RAIZ = path.join(__dirname, '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'koala-home-'));
process.env.USERPROFILE = HOME; process.env.HOME = HOME;

let actual = null;
const cargar = Module._load;
Module._load = function (req, ...r) { return req === 'vscode' ? actual : cargar.call(this, req, ...r); };

function crearEditor(nombre, ajustesIniciales, enfocado) {
  const ajustes = Object.assign({}, ajustesIniciales);
  const memoria = new Map();
  const comandos = {};
  const mensajes = [];
  const oyentesConfig = [];
  let proveedor = null;
  const evento = () => () => ({ dispose() {} });
  const config = () => ({
    get: (k, d) => (k in ajustes ? ajustes[k] : d),
    inspect: (k) => ({ globalValue: ajustes[k] }),
    update: async (k, v) => {
      if (v === undefined) delete ajustes[k]; else ajustes[k] = v;
      const e = { affectsConfiguration: (s) => ('koalaCientifico.' + k).startsWith(s) || s === 'koalaCientifico' };
      oyentesConfig.forEach((f) => f(e));
    },
  });
  actual = {
    Uri: { joinPath: (u, ...p) => ({ fsPath: path.join(u.fsPath, ...p) }), file: (p) => ({ fsPath: p }), parse: (x) => x },
    ThemeColor: class {}, StatusBarAlignment: { Right: 2 }, DiagnosticSeverity: { Error: 0, Warning: 1 }, ConfigurationTarget: { Global: 1 },
    window: {
      state: { focused: enfocado },
      onDidChangeWindowState: evento(),
      registerWebviewViewProvider: (id, p) => { proveedor = p; return { dispose() {} }; },
      createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
      showWarningMessage: async (m) => { console.log(`  [${nombre}] aviso:`, m); },
      showInformationMessage: async (m) => { console.log(`  [${nombre}] info:`, String(m).slice(0, 110)); },
      showErrorMessage: async (m) => { console.log(`  [${nombre}] error:`, m); },
      onDidChangeActiveTextEditor: evento(), onDidChangeTextEditorSelection: evento(),
      onDidOpenTerminal: evento(), onDidChangeActiveTerminal: evento(),
    },
    workspace: {
      getConfiguration: config,
      onDidChangeTextDocument: evento(),
      onDidChangeConfiguration: (f) => { oyentesConfig.push(f); return { dispose() {} }; },
    },
    languages: { getDiagnostics: () => [], onDidChangeDiagnostics: evento() },
    extensions: { getExtension: () => undefined },
    authentication: { getSession: async () => undefined },
    env: { openExternal: async () => true, language: 'es', sessionId: nombre },
    commands: { registerCommand: (id, f) => { comandos[id] = f; return { dispose() {} }; }, executeCommand: async () => {} },
  };
  for (const k of Object.keys(require.cache)) if (k.startsWith(RAIZ) && !k.includes('pruebas')) delete require.cache[k];
  const ext = require(path.join(RAIZ, 'extension.js'));
  const pkg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8'));
  const ctx = { extensionUri: { fsPath: RAIZ }, extensionPath: RAIZ, subscriptions: [], extension: { packageJSON: pkg } };
  // Como en VS Code real: globalState es una propiedad fija (no configurable ni escribible).
  Object.defineProperty(ctx, 'globalState', {
    value: { get: (k, d) => (memoria.has(k) ? memoria.get(k) : d), update: async (k, v) => memoria.set(k, v), keys: () => [...memoria.keys()], setKeysForSync() {} },
    writable: false, configurable: false, enumerable: true,
  });
  ext.activate(ctx);
  proveedor.resolveWebviewView({
    visible: true,
    webview: {
      options: {}, cspSource: 'file:', asWebviewUri: (u) => 'file://' + u.fsPath,
      postMessage: (m) => { mensajes.push(m); return Promise.resolve(true); },
      onDidReceiveMessage: () => ({ dispose() {} }), html: '',
    },
    onDidChangeVisibility: () => ({ dispose() {} }), onDidDispose: () => ({ dispose() {} }),
  });
  return {
    nombre, ajustes, comandos, config,
    estado: () => [...mensajes].reverse().find((m) => m.tipo === 'estado'),
    cerrar() { for (const d of ctx.subscriptions) try { d.dispose(); } catch (e) { /* */ } },
  };
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
let fallas = 0;
const ok = (c, m) => { console.log((c ? '✓ ' : '✗ ') + m); if (!c) fallas++; };
const terminar = (...editores) => {
  editores.forEach((e) => e.cerrar());
  console.log(fallas ? `\n${fallas} falla(s)` : '\nTodo bien.');
  process.exit(fallas ? 1 : 0);
};

(async () => {
  if (process.argv[2] === 'monitor') {
    // Servidor nuevo: sin ~/.claude/settings.json, pero ya habías aceptado el monitor en otro lado.
    const s = crearEditor('servidor', { configurarMonitorSolo: true }, true);
    await esperar(12000);
    let texto = '';
    try { texto = fs.readFileSync(path.join(HOME, '.claude', 'settings.json'), 'utf8'); } catch (e) { /* */ }
    ok(texto.includes('koala-hook.py') && texto.includes('koala-statusline.py'), 'el monitor se configuró solo, sin preguntar');
    ok(fs.existsSync(path.join(HOME, '.claude', 'koala', 'koala-hook.py')), 'copió los scripts');
    // Hooks de Antigravity: se agregan a ~/.gemini/config/hooks.json sin borrar los que ya había.
    const rutaHooks = path.join(HOME, '.gemini', 'config', 'hooks.json');
    fs.mkdirSync(path.dirname(rutaHooks), { recursive: true });
    fs.writeFileSync(rutaHooks, JSON.stringify({ 'mi-linter': { PostToolUse: [] } }));
    await s.comandos['koalaCientifico.configurarAntigravity']();
    const hooks = JSON.parse(fs.readFileSync(rutaHooks, 'utf8'));
    ok(hooks['mi-linter'] && hooks['koala-monitor'].PreInvocation[0].command.includes('koala-hook.py" trabajando --antigravity'), 'conecta los hooks de Antigravity y respeta los demás');
    ok(fs.readdirSync(path.dirname(rutaHooks)).some((f) => f.includes('koala-respaldo')), 'con respaldo de hooks.json');
    return terminar(s);
  }

  const a = crearEditor('vscode', { 'clima.ciudad': 'Toluca de Lerdo, Estado de México, México', minutosParaTreparse: 90 }, true);
  await esperar(500);
  const b = crearEditor('antigravity', {}, false);
  await esperar(4500);

  ok(b.ajustes['clima.ciudad'] === 'Toluca de Lerdo, Estado de México, México', 'Antigravity adopta la ciudad del clima de VS Code');
  ok(b.ajustes.minutosParaTreparse === 90, 'y los demás ajustes del koala');

  await a.comandos['koalaCientifico.dormir']();
  await esperar(2500);
  ok(b.estado().durmiendo === true, 'mandarlo a dormir en VS Code lo duerme en Antigravity');
  await b.comandos['koalaCientifico.dormir']();
  await esperar(2500);
  ok(a.estado().durmiendo === false, 'despertarlo en Antigravity lo despierta en VS Code');

  await a.comandos['koalaCientifico.pomodoro']();
  await esperar(2500);
  ok(b.estado().pomodoro && b.estado().pomodoro.fase === 'enfoque', 'el pomodoro iniciado en VS Code corre en Antigravity');
  await b.comandos['koalaCientifico.pomodoroDetener']();
  await esperar(2500);
  ok(!a.estado().pomodoro.fase, 'detenerlo en Antigravity lo detiene en VS Code');

  await b.config().update('cumpleanos', '29/03');
  await esperar(2500);
  ok(a.ajustes.cumpleanos === '29/03', 'un ajuste cambiado en Antigravity llega a VS Code');

  const lideres = [a, b].filter((x) => x.estado().sincronizacion && x.estado().sincronizacion.lider).map((x) => x.nombre);
  ok(lideres.length === 1 && lideres[0] === 'vscode', `una sola ventana líder (la enfocada): ${lideres.join(', ')}`);

  // Antigravity: la líder consulta agy (si está en el PATH responde de verdad; si no, «falta agy») y la otra
  // ventana recibe el mismo dato sin consultar.
  await a.comandos['koalaCientifico.antigravity']();
  const agA = a.estado().antigravity;
  ok(agA && ['ok', 'sin_agy', 'sin_sesion', 'error'].includes(agA.estado), `la consulta de Antigravity llega al panel (${agA && agA.estado})`);
  await esperar(2500);
  ok(b.estado().antigravity && b.estado().antigravity.estado === agA.estado, 'y la otra ventana recibe el mismo dato');

  // Claude y Antigravity por separado: el hook de agy escribe su propio archivo; la copia vieja que dejaba en el
  // archivo de Claude (con fuente "antigravity") se ignora.
  const escribir = (nombre, datos) => fs.writeFileSync(path.join(HOME, '.claude', nombre), JSON.stringify(datos));
  escribir('koala-estado-antigravity.json', { estado: 'trabajando', ts: Date.now(), inicio: Date.now(), fuente: 'antigravity' });
  escribir('koala-estado.json', { estado: 'trabajando', ts: Date.now(), inicio: Date.now(), fuente: 'antigravity' });
  await esperar(2500);
  ok(a.estado().antigravityActivo === true && a.estado().claude === false, 'Antigravity trabajando no se confunde con Claude');
  escribir('koala-estado.json', { estado: 'trabajando', ts: Date.now(), inicio: Date.now() });
  await esperar(2500);
  ok(a.estado().antigravityActivo === true && a.estado().claude === true, 'y los dos a la vez');
  escribir('koala-estado-antigravity.json', { estado: 'descanso', ts: Date.now(), inicio: Date.now() - 1000, duracion: 1000, fuente: 'antigravity' });
  await esperar(2500);
  ok(a.estado().antigravityActivo === false && a.estado().claude === true, 'Antigravity termina y Claude sigue');

  const doc = JSON.parse(fs.readFileSync(path.join(HOME, '.claude', 'koala', 'compartido.json'), 'utf8'));
  ok(!JSON.stringify(doc).includes('accessToken'), 'el archivo compartido no lleva tokens');
  terminar(a, b);
})().catch((e) => { console.error(e); process.exit(1); });
