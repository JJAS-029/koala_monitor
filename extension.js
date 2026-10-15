'use strict';
// Koala científico: mascota de laboratorio que trabaja contigo y vigila tu consumo de Claude Code.
// Sin dependencias ni conexión a internet: todo sale de archivos locales en ~/.claude.

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const monitor = require('./monitor');
const costos = require('./costos');
const { crearRutina } = require('./rutina');
const https = require('https');
const { execFile, execFileSync } = require('child_process');

const DIR_CLAUDE = path.join(os.homedir(), '.claude');
const RUTA_ESTADO_CLAUDE = path.join(DIR_CLAUDE, 'koala-estado.json');
const RUTA_USO = path.join(DIR_CLAUDE, 'koala-uso.json');
const DIR_PROYECTOS = path.join(DIR_CLAUDE, 'projects');
const DIR_SCRIPTS = path.join(DIR_CLAUDE, 'koala');
const RUTA_SETTINGS = path.join(DIR_CLAUDE, 'settings.json');

const CLAVE_ESTADO = 'koala.estado';
const CLAVE_AVISOS = 'koala.avisos';
const TURNO_MAXIMO_MS = 15 * 60 * 1000;
const HORA = 3600 * 1000;
const CINCO_HORAS = 5 * HORA;
const SIETE_DIAS = 7 * 24 * HORA;
const TREINTA_DIAS = 30 * 24 * HORA; // las transcripciones se guardan 30 días (costo del mes)

let contexto = null;
let vista = null;
let barra = null;

// ---------- Tamagotchi ----------
let necesidades = { saciedad: 80, animo: 80, energia: 80 };
let durmiendo = false;
let ultimoTick = Date.now();

// ---------- Trabajo ----------
let ultimaActividad = 0;
let editorTrabajando = false;
let claudeTrabajando = false;
let manual = null; // null | 'trabajar' | 'descansar'
let temporizadorClaude = null;

// ---------- Consumo ----------
let usoOficial = null; // contenido de koala-uso.json
// Consulta directa a Anthropic (opcional): GET /api/oauth/usage con el token de Claude Code.
let usoApi = null; // { five_hour, seven_day, extras, actualizado }
let estadoApi = { activo: false, error: null, ultima: null };
let proximaConsultaApi = 0;
const mensajesLocales = new Map(); // id -> { t, tok, entrada, salida, creados, leidos, modelo, proyecto }
const herramientasLocales = new Map(); // id del tool_use -> { t, nombre }
const cacheArchivos = new Map(); // ruta -> { offset, resto }
let escaneando = false;
let usoLocal = { tokens5h: 0, tokens7d: 0, mensajes5h: 0, mensajes7d: 0, cache5h: 0 };

// ---------- Mediciones del entorno ----------
const CLAVE_ACTIVO = 'koala.activo';
let activo = { fecha: '', segundos: 0 };
let sistema = null;
let servicios = [];
let gitInfo = null;
let diag = { errores: 0, avisos: 0, archivos: 0 };
let climaActual = null;
let rutina = null;
let ventanaPrevia = null; // { reinicio, pct } de la sesión de 5 h, para detectar cuándo cierra

// ---------- Pomodoro ----------
const CLAVE_POMODORO = 'koala.pomodoro';
// fase: null | 'enfoque' | 'descanso' | 'descansoLargo'; fin: ms epoch; pausa: ms restantes si está en pausa
let pomodoro = { fase: null, fin: 0, total: 0, pausa: null, ciclo: 0, hoy: 0, fecha: '' };
let barraPomodoro = null;

const limitar = (v) => Math.max(0, Math.min(100, v));
const config = () => vscode.workspace.getConfiguration('koalaCientifico');

function trabajando() {
  if (manual === 'trabajar') return true;
  if (manual === 'descansar') return false;
  return editorTrabajando || (claudeTrabajando && config().get('reaccionarAClaude', true));
}

// ---------- Persistencia y desgaste ----------
function cargarEstado() {
  const guardado = contexto.globalState.get(CLAVE_ESTADO);
  if (guardado) {
    necesidades = Object.assign(necesidades, guardado.necesidades || {});
    durmiendo = !!guardado.durmiendo;
    const horas = Math.min(72, Math.max(0, (Date.now() - (guardado.ts || Date.now())) / HORA));
    aplicarDesgaste(horas, false);
  }
  ultimoTick = Date.now();
}

function guardarEstado() {
  contexto.globalState.update(CLAVE_ESTADO, { necesidades, durmiendo, ts: Date.now() });
}

function aplicarDesgaste(horas, conTrabajo) {
  necesidades.saciedad = limitar(necesidades.saciedad - 10 * horas);
  const hambre = necesidades.saciedad < 30;
  necesidades.animo = limitar(necesidades.animo - (hambre ? 10 : 7) * horas);
  if (sincronizarEnergia()) return;
  if (durmiendo) necesidades.energia = limitar(necesidades.energia + 600 * horas);
  else necesidades.energia = limitar(necesidades.energia - (conTrabajo ? 12 : 6) * horas);
}

function tick() {
  const ahora = Date.now();
  const horas = (ahora - ultimoTick) / HORA;
  ultimoTick = ahora;
  aplicarDesgaste(horas, trabajando());

  const ligada = energiaDeSesion() !== null;
  const despierta = ligada
    ? necesidades.energia >= 60 || trabajando() || pomodoro.fase === 'enfoque'
    : necesidades.energia >= 100 || (trabajando() && necesidades.energia >= 50);
  if (durmiendo && despierta) {
    durmiendo = false;
  } else if (!durmiendo && necesidades.energia < 22 && !trabajando() && !pomodoro.fase) {
    durmiendo = true;
  }
  guardarEstado();
  enviarEstado();
}

// ---------- Actividad del editor y la terminal ----------
function registrarActividad() {
  ultimaActividad = Date.now();
  if (manual === 'descansar') manual = null;
  if (!editorTrabajando) {
    editorTrabajando = true;
    enviarEstado();
  }
}

function revisarInactividad() {
  const espera = Math.max(2, config().get('segundosParaDescansar', 10)) * 1000;
  if (editorTrabajando && Date.now() - ultimaActividad > espera) {
    editorTrabajando = false;
    enviarEstado();
  }
}

// ---------- Claude Code (hooks) ----------
let claudeNecesita = null; // { mensaje, ts } mientras Claude espera tu permiso o respuesta
let ultimoTsClaude = 0;

function leerEstadoClaude() {
  let datos = null;
  try {
    datos = JSON.parse(fs.readFileSync(RUTA_ESTADO_CLAUDE, 'utf8'));
  } catch (e) {
    return;
  }
  const nuevo = datos.ts && datos.ts !== ultimoTsClaude;
  const primeraLectura = ultimoTsClaude === 0;
  ultimoTsClaude = datos.ts || ultimoTsClaude;
  const fresco = Date.now() - (datos.ts || 0) < TURNO_MAXIMO_MS;

  // Claude espera tu permiso o una respuesta: el koala levanta la mano.
  const necesita = datos.estado === 'necesita' && fresco ? { mensaje: datos.mensaje || '', ts: datos.ts } : null;
  if (necesita && nuevo && !primeraLectura) {
    if (vista && vista.visible) vista.webview.postMessage({ tipo: 'accion', accion: 'pedirAtencion', datos: necesita });
    if (config().get('avisarCuandoClaudeEspera', true)) {
      vscode.window.showWarningMessage(`🐨✋ Claude te necesita${necesita.mensaje ? ': ' + necesita.mensaje : '.'}`);
    }
  }
  if (!!necesita !== !!claudeNecesita) { claudeNecesita = necesita; enviarEstado(); }

  // Turno largo terminado: el koala trae el aviso de "listo".
  const minimo = config().get('avisarTurnoLargoSegundos', 120) * 1000;
  if (datos.estado === 'descanso' && nuevo && !primeraLectura && minimo > 0 && datos.duracion >= minimo) {
    const dur = datos.duracion;
    if (vista && vista.visible) vista.webview.postMessage({ tipo: 'accion', accion: 'claudeListo', datos: { duracion: dur } });
    if (!vscode.window.state.focused || config().get('avisarTurnoLargoSiempre', false)) {
      vscode.window.showInformationMessage(`🐨📜 Claude terminó (${duracionTexto(dur)}).`);
    }
  }

  clearTimeout(temporizadorClaude);
  const vigente = (datos.estado === 'trabajando' || datos.estado === 'necesita') && fresco;
  if (vigente) {
    temporizadorClaude = setTimeout(() => {
      claudeTrabajando = false;
      enviarEstado();
    }, TURNO_MAXIMO_MS - (Date.now() - datos.ts));
  }
  if (vigente !== claudeTrabajando) {
    claudeTrabajando = vigente;
    enviarEstado();
  }
}

// ---------- Consumo: dato oficial de la status line ----------
function leerUsoOficial() {
  try {
    usoOficial = JSON.parse(fs.readFileSync(RUTA_USO, 'utf8'));
  } catch (e) {
    usoOficial = null;
  }
  actualizarConsumo();
}

// ---------- Consumo: tokens de las transcripciones locales ----------
async function listarTranscripciones(dir, profundidad, limite, salida) {
  let entradas;
  try {
    entradas = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const e of entradas) {
    const ruta = path.join(dir, e.name);
    if (e.isDirectory() && profundidad > 0) {
      await listarTranscripciones(ruta, profundidad - 1, limite, salida);
    } else if (e.isFile() && e.name.endsWith('.jsonl')) {
      try {
        const st = await fs.promises.stat(ruta);
        if (st.mtimeMs >= limite) salida.push({ ruta, tam: st.size });
      } catch (err) { /* archivo borrado mientras se listaba */ }
    }
  }
}

function procesarLinea(linea, limite) {
  if (linea.indexOf('"usage"') < 0) return;
  let obj;
  try {
    obj = JSON.parse(linea);
  } catch (e) {
    return;
  }
  const m = obj.message;
  if (!m || !m.usage) return;
  const t = Date.parse(obj.timestamp);
  if (!Number.isFinite(t) || t < limite) return;
  const u = m.usage;
  const entrada = u.input_tokens || 0, salida = u.output_tokens || 0;
  const creados = u.cache_creation_input_tokens || 0, leidos = u.cache_read_input_tokens || 0;
  // Claude Code repite el mismo mensaje en varias líneas (una por bloque): se cuenta una vez.
  const { usd, wh } = costos.medirMensaje(u, m.model);
  mensajesLocales.set(m.id || obj.requestId || obj.uuid, {
    t, tok: entrada + salida + creados, entrada, salida, creados, leidos, usd, wh,
    modelo: nombreModelo(m.model), proyecto: obj.cwd ? path.basename(obj.cwd) : '?',
  });
  for (const b of Array.isArray(m.content) ? m.content : []) {
    if (b && b.type === 'tool_use' && b.id) herramientasLocales.set(b.id, { t, nombre: b.name || '?' });
  }
}

function nombreModelo(id) {
  const m = /claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id || '');
  if (!m) return id || '?';
  return m[1][0].toUpperCase() + m[1].slice(1) + ' ' + m[2] + (m[3] && m[3].length < 3 ? '.' + m[3] : '');
}

async function escanearTranscripciones() {
  if (escaneando) return;
  escaneando = true;
  try {
    const ahora = Date.now();
    const limite = ahora - TREINTA_DIAS;
    const archivos = [];
    await listarTranscripciones(DIR_PROYECTOS, 4, limite, archivos);
    for (const { ruta, tam } of archivos) {
      let cache = cacheArchivos.get(ruta);
      if (!cache || tam < cache.offset) cache = { offset: 0, resto: '' };
      if (tam > cache.offset) {
        const fh = await fs.promises.open(ruta, 'r');
        try {
          const buf = Buffer.alloc(tam - cache.offset);
          await fh.read(buf, 0, buf.length, cache.offset);
          const lineas = (cache.resto + buf.toString('utf8')).split('\n');
          cache.resto = lineas.pop();
          for (const linea of lineas) procesarLinea(linea, limite);
          cache.offset = tam;
        } finally {
          await fh.close();
        }
      }
      cacheArchivos.set(ruta, cache);
    }
    for (const [id, msj] of mensajesLocales) if (msj.t < limite) mensajesLocales.delete(id);
    for (const [id, h] of herramientasLocales) if (h.t < limite) herramientasLocales.delete(id);
  } catch (e) {
    console.error('[koala] error al leer transcripciones', e);
  } finally {
    escaneando = false;
  }
  actualizarConsumo();
}

function inicioVentana(ventana, duracion) {
  const ahora = Date.now();
  if (ventana && ventana.resets_at && ventana.resets_at * 1000 > ahora) {
    return ventana.resets_at * 1000 - duracion;
  }
  return ahora - duracion;
}

// Dato oficial: el más reciente entre la status line y la consulta directa a Anthropic.
function oficial() {
  const base = usoOficial || {};
  if (usoApi && (!base.actualizado || usoApi.actualizado >= base.actualizado)) {
    return { ...base, five_hour: usoApi.five_hour, seven_day: usoApi.seven_day, actualizado: usoApi.actualizado, fuente: 'anthropic' };
  }
  return base.actualizado ? { ...base, fuente: 'statusline' } : base;
}

function calcularUsoLocal() {
  const of = oficial();
  const desde5 = inicioVentana(of.five_hour, CINCO_HORAS);
  const desde7 = inicioVentana(of.seven_day, SIETE_DIAS);
  const r = { tokens5h: 0, tokens7d: 0, mensajes5h: 0, mensajes7d: 0, cache5h: 0 };
  for (const m of mensajesLocales.values()) {
    if (m.t >= desde7) { r.tokens7d += m.tok; r.mensajes7d++; }
    if (m.t >= desde5) { r.tokens5h += m.tok; r.mensajes5h++; r.cache5h += m.leidos; }
  }
  usoLocal = r;
}

function inicioDeHoy() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Resumen del día, eficiencia de caché y mapa de calor semanal (día × hora).
function resumenHoy() {
  const desde = inicioDeHoy();
  const r = { tokens: 0, mensajes: 0, entrada: 0, creados: 0, leidos: 0, proyectos: {}, modelos: {}, herramientas: {} };
  const mapa = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const m of mensajesLocales.values()) {
    const dias = Math.floor((desde - m.t) / 86400000) + 1; // 0 = hoy
    const fila = 6 - (m.t >= desde ? 0 : dias);
    if (fila >= 0 && fila < 7) mapa[fila][new Date(m.t).getHours()] += m.tok;
    if (m.t < desde) continue;
    r.tokens += m.tok; r.mensajes++;
    r.entrada += m.entrada; r.creados += m.creados; r.leidos += m.leidos;
    r.proyectos[m.proyecto] = (r.proyectos[m.proyecto] || 0) + m.tok;
    r.modelos[m.modelo] = (r.modelos[m.modelo] || 0) + m.tok;
  }
  for (const h of herramientasLocales.values()) {
    if (h.t >= desde) r.herramientas[h.nombre] = (r.herramientas[h.nombre] || 0) + 1;
  }
  const base = r.leidos + r.entrada + r.creados;
  r.cachePct = base ? (100 * r.leidos) / base : null;
  const dias = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(desde - i * 86400000 + 12 * HORA);
    dias.push(['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'][d.getDay()]);
  }
  return { ...r, mapa, dias };
}

// Costo equivalente en la API y huella estimada (energía y agua) por periodo.
function resumenCostos() {
  const ahora = Date.now();
  const desde5 = inicioVentana(oficial().five_hour, CINCO_HORAS);
  const hoy = inicioDeHoy();
  const periodos = { cinco: desde5, hoy, semana: ahora - SIETE_DIAS, mes: ahora - TREINTA_DIAS };
  const r = {};
  for (const k of Object.keys(periodos)) r[k] = { usd: 0, wh: 0, tok: 0 };
  const modelosHoy = {};
  let primero = ahora;
  for (const m of mensajesLocales.values()) {
    primero = Math.min(primero, m.t);
    for (const [k, desde] of Object.entries(periodos)) {
      if (m.t >= desde) { r[k].usd += m.usd; r[k].wh += m.wh; r[k].tok += m.tok; }
    }
    if (m.t >= hoy) modelosHoy[m.modelo] = (modelosHoy[m.modelo] || 0) + m.usd;
  }
  const c = config();
  return {
    ...r,
    modelosHoy,
    diasMes: Math.max(1, Math.min(30, Math.ceil((ahora - primero) / 86400000))),
    aguaMlPorWh: c.get('aguaMlPorWh', 2),
    planUsd: c.get('costoPlanMensualUSD', 0),
  };
}

// Ritmo de los últimos 30 min proyectado sobre el % oficial de la sesión.
function calcularRitmo(cinco) {
  const ahora = Date.now();
  let tok30 = 0;
  for (const m of mensajesLocales.values()) if (m.t >= ahora - 30 * 60000) tok30 += m.tok;
  const r = { tokPorMin: tok30 / 30, pctPorHora: null, eta: null, estado: 'sin-dato' };
  if (!cinco || cinco.reiniciada || cinco.pct < 2 || !usoLocal.tokens5h) return r;
  const tokPorPct = usoLocal.tokens5h / cinco.pct;
  const pctPorMin = r.tokPorMin / tokPorPct;
  r.pctPorHora = pctPorMin * 60;
  if (pctPorMin <= 0.001) { r.estado = 'quieto'; return r; }
  r.eta = ahora + ((100 - cinco.pct) / pctPorMin) * 60000;
  r.estado = cinco.reinicio && r.eta < cinco.reinicio ? 'alcanza' : 'holgado';
  return r;
}

function datosSesion() {
  const s = usoOficial && usoOficial.sesion;
  if (!s || !s.ts || Date.now() - s.ts * 1000 > 6 * HORA) return null;
  return { ...s, ts: s.ts * 1000 };
}

function ventanaVigente(v) {
  if (!v || typeof v.pct !== 'number') return null;
  const reinicio = v.resets_at ? v.resets_at * 1000 : null;
  if (reinicio && reinicio <= Date.now()) return { pct: 0, reinicio: null, reiniciada: true };
  return { pct: v.pct, reinicio, reiniciada: false };
}

function resumenUso() {
  const of = oficial();
  return {
    cinco: ventanaVigente(of.five_hour),
    semana: ventanaVigente(of.seven_day),
    modelo: of.model || '',
    actualizado: of.actualizado ? of.actualizado * 1000 : null,
    local: usoLocal,
    ritmo: calcularRitmo(ventanaVigente(of.five_hour)),
    sesion: datosSesion(),
    fuente: of.fuente || null,
    extras: usoApi && of.fuente === 'anthropic' ? usoApi.extras : [],
    api: estadoApi,
  };
}

function formatoTokens(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + ' M';
  if (n >= 1e3) return Math.round(n / 1e3) + ' mil';
  return String(n);
}

function duracionTexto(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} min ${s % 60} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

// ---------- Comandos de la terminal: éxito o fallo ----------
const inicioComandos = new WeakMap();
const PATRON_IMPORTANTE = /\b(test|tests|pytest|jest|vitest|mocha|unittest|tox|nox|build|make|cargo|gradle|mvn|tsc|lint|eslint|ruff|flake8|mypy|migrate|makemigrations|collectstatic|check|deploy|npm (run|ci|install)|pip install|docker (build|compose)|build\.sh)\b/i;

function alIniciarComando(e) {
  registrarActividad();
  inicioComandos.set(e.execution, Date.now());
}
function alTerminarComando(e) {
  registrarActividad();
  if (!config().get('reaccionarAComandos', true)) return;
  const linea = (e.execution && e.execution.commandLine && e.execution.commandLine.value || '').trim();
  const codigo = e.exitCode;
  if (!linea || codigo === undefined) return;
  const inicio = inicioComandos.get(e.execution);
  const dur = inicio ? Date.now() - inicio : 0;
  // Solo comandos que importan: pruebas, builds, migraciones… o cualquiera que tardó 15 s o más.
  if (!PATRON_IMPORTANTE.test(linea) && dur < 15000) return;
  const datos = { ok: codigo === 0, codigo, comando: linea.slice(0, 80), duracion: dur };
  if (vista && vista.visible) vista.webview.postMessage({ tipo: 'accion', accion: datos.ok ? 'comandoOk' : 'comandoFallo', datos });
  necesidades.animo = limitar(necesidades.animo + (datos.ok ? 3 : -3));
}

// Minutos sin actividad en el editor, la terminal ni Claude (para la siesta sobre la laptop).
function minutosInactivo() {
  if (claudeTrabajando) return 0;
  return Math.floor((Date.now() - Math.max(ultimaActividad, inicioExtension)) / 60000);
}
const inicioExtension = Date.now();

// ---------- Temporada (Día de Muertos…) ----------
function temporada() {
  const t = config().get('temporada', 'auto');
  if (t !== 'auto') return t;
  const d = new Date();
  const mes = d.getMonth() + 1, dia = d.getDate();
  const diaDelAnio = Math.round((new Date(d.getFullYear(), mes - 1, dia) - new Date(d.getFullYear(), 0, 0)) / 86400000);
  // Cumpleaños del usuario: "DD/MM" (p. ej. "29/03").
  const cumple = /^(\d{1,2})[/-](\d{1,2})$/.exec(String(config().get('cumpleanos', '')).trim());
  if (cumple && Number(cumple[1]) === dia && Number(cumple[2]) === mes) return 'cumple';
  // Días festivos de un solo día (mandan sobre las temporadas largas).
  if ((mes === 12 && dia === 31) || (mes === 1 && dia === 1)) return 'anionuevo';
  if (mes === 1 && dia === 6) return 'reyes';
  if (mes === 2 && dia === 2) return 'marmota'; // y Día de la Candelaria: tamales
  if (mes === 2 && dia === 14) return 'sanvalentin';
  if (mes === 3 && dia === 14) return 'pi';
  if (mes === 3 && (dia === 20 || dia === 21)) return 'primavera';
  if (mes === 4 && dia === 30) return 'nino';
  if (mes === 5 && dia === 10) return 'madres';
  if (diaDelAnio === 256) return 'programador'; // 13 de sep. (12 en año bisiesto)
  if (mes === 10 && dia === 12) return 'pluricultural';
  if ((mes === 10 && dia >= 28) || (mes === 11 && dia <= 2)) return 'muertos';
  if ((mes === 12 && dia >= 12) || (mes === 1 && dia <= 6)) return 'navidad';
  if (mes === 9 && dia >= 13 && dia <= 16) return 'patrias';
  return 'ninguna';
}

function formatoFalta(ms) {
  if (ms == null) return '';
  const min = Math.max(0, Math.round((ms - Date.now()) / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h ${min % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

// Energía = lo que queda de la sesión de 5 h (dato oficial). Se recarga sola en el corte.
function energiaDeSesion() {
  const v = ventanaVigente(oficial().five_hour);
  if (!v) return null;
  return v.reiniciada ? 100 : limitar(100 - v.pct);
}
function sincronizarEnergia() {
  const e = energiaDeSesion();
  if (e === null) return false;
  necesidades.energia = e;
  return true;
}

function actualizarConsumo() {
  calcularUsoLocal();
  sincronizarEnergia();
  const u = resumenUso();
  if (u.cinco && !u.cinco.reiniciada && u.cinco.reinicio) {
    if (ventanaPrevia && ventanaPrevia.reinicio !== u.cinco.reinicio && rutina) rutina.alCerrarVentana(ventanaPrevia.pct);
    ventanaPrevia = { reinicio: u.cinco.reinicio, pct: u.cinco.pct };
  }
  avisarSiHaceFalta(u);
  pintarBarra(u);
  enviarEstado();
}

function avisarSiHaceFalta(u) {
  const umbral = config().get('avisarEnPorcentaje', 90);
  const avisos = contexto.globalState.get(CLAVE_AVISOS, {});
  const nombres = { cinco: 'la sesión (5 h)', semana: 'la semana' };
  let cambio = false;
  for (const clave of ['cinco', 'semana']) {
    const v = u[clave];
    if (!v || v.reiniciada || v.pct < umbral) continue;
    const id = `${clave}:${v.reinicio || 0}`;
    if (avisos[clave] === id) continue;
    avisos[clave] = id;
    cambio = true;
    vscode.window.showWarningMessage(
      `🐨 El koala midió ${Math.round(v.pct)} % de ${nombres[clave]} de Claude Code.` +
        (v.reinicio ? ` Se reinicia en ${formatoFalta(v.reinicio)}.` : ''),
      'Ver consumo'
    ).then((r) => { if (r) mostrarPanel(); });
  }
  if (cambio) contexto.globalState.update(CLAVE_AVISOS, avisos);
}

function pintarBarra(u) {
  if (!barra) return;
  if (!config().get('barraDeEstado', true)) {
    barra.hide();
    return;
  }
  const partes = [];
  if (u.cinco) partes.push(`5h ${Math.round(u.cinco.pct)}%`);
  if (u.semana) partes.push(`sem ${Math.round(u.semana.pct)}%`);
  if (!partes.length) partes.push(`${formatoTokens(u.local.tokens5h)} tok/5h`);
  barra.text = `$(beaker) ${partes.join(' · ')}`;
  const max = Math.max(u.cinco ? u.cinco.pct : 0, u.semana ? u.semana.pct : 0);
  barra.backgroundColor = max >= config().get('avisarEnPorcentaje', 90)
    ? new vscode.ThemeColor('statusBarItem.errorBackground')
    : max >= 75 ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  barra.tooltip = textoConsumo(u);
  barra.show();
}

function textoConsumo(u) {
  const lineas = ['Koala científico — consumo de Claude Code'];
  const linea = (nombre, v) => {
    if (!v) return `${nombre}: sin dato oficial`;
    if (v.reiniciada) return `${nombre}: reiniciada (esperando dato nuevo)`;
    return `${nombre}: ${Math.round(v.pct)} %` + (v.reinicio ? `, se reinicia en ${formatoFalta(v.reinicio)}` : '');
  };
  lineas.push(linea('Sesión (5 h)', u.cinco));
  lineas.push(linea('Semana', u.semana));
  lineas.push(`Tokens locales: ${formatoTokens(u.local.tokens5h)} en la sesión, ${formatoTokens(u.local.tokens7d)} en la semana`);
  if (u.actualizado) lineas.push(`Dato oficial de hace ${Math.max(0, Math.round((Date.now() - u.actualizado) / 60000))} min`);
  else lineas.push('Sin dato oficial: ejecuta "Koala científico: configurar monitor de Claude Code"');
  return lineas.join('\n');
}

// ---------- Consulta directa a Anthropic ----------
// Usa el token OAuth que Claude Code guarda en ~/.claude/.credentials.json (el mismo con el que
// el panel de Claude muestra el uso). El token solo viaja a api.anthropic.com; nunca se muestra
// ni se registra. No se renueva aquí: si venció, Claude Code lo renueva la próxima vez que lo uses.
function tokenClaude() {
  let datos = null;
  try {
    datos = JSON.parse(fs.readFileSync(path.join(DIR_CLAUDE, '.credentials.json'), 'utf8'));
  } catch (e) {
    // En macOS Claude Code guarda la sesión en el llavero; macOS puede pedir permiso la primera vez.
    if (process.platform === 'darwin') {
      try {
        const crudo = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: 5000, encoding: 'utf8' });
        datos = JSON.parse(crudo.trim());
      } catch (err) { datos = null; }
    }
    if (!datos) return { error: 'No encontré la sesión de Claude Code (~/.claude/.credentials.json o el llavero de macOS).' };
  }
  const o = datos && datos.claudeAiOauth;
  if (!o || !o.accessToken) return { error: 'La sesión de Claude Code no tiene token OAuth (¿usas una API key?).' };
  if (o.expiresAt && o.expiresAt < Date.now()) return { error: 'El token de Claude Code venció; se renueva solo la próxima vez que uses Claude.' };
  return { token: o.accessToken };
}

function ventanaApi(v) {
  if (!v || typeof v.utilization !== 'number') return null;
  const t = Date.parse(v.resets_at);
  return { pct: v.utilization, resets_at: Number.isFinite(t) ? Math.round(t / 1000) : null };
}

const NOMBRES_EXTRA = { seven_day_opus: 'Semana · Opus', seven_day_sonnet: 'Semana · Sonnet', seven_day_oauth_apps: 'Semana · apps' };

async function consultarAnthropic(forzar) {
  estadoApi.activo = config().get('usoDesdeAnthropic', false);
  if (!estadoApi.activo) return;
  if (!forzar && Date.now() < proximaConsultaApi) return;
  const minutos = Math.max(2, config().get('minutosEntreConsultas', 5));
  proximaConsultaApi = Date.now() + minutos * 60000;
  const cred = tokenClaude();
  if (cred.error) { estadoApi.error = cred.error; enviarEstado(); return; }
  const r = await new Promise((resolver) => {
    const req = https.get('https://api.anthropic.com/api/oauth/usage', {
      timeout: 10000,
      headers: {
        Authorization: `Bearer ${cred.token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'koala-cientifico',
        Accept: 'application/json',
      },
    }, (res) => {
      let cuerpo = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (cuerpo.length < 200000) cuerpo += d; });
      res.on('end', () => resolver({ codigo: res.statusCode, cuerpo }));
    });
    req.on('timeout', () => { req.destroy(); resolver({ error: 'sin respuesta de api.anthropic.com' }); });
    req.on('error', (e) => resolver({ error: `sin conexión (${e.code || 'error'})` }));
  });
  if (r.error) estadoApi.error = r.error;
  else if (r.codigo === 401 || r.codigo === 403) estadoApi.error = 'Anthropic rechazó el token; abre Claude Code para renovar la sesión.';
  else if (r.codigo === 429) { estadoApi.error = 'Demasiadas consultas; el koala espera 15 min.'; proximaConsultaApi = Date.now() + 15 * 60000; }
  else if (r.codigo !== 200) estadoApi.error = `Respuesta inesperada (${r.codigo}).`;
  else {
    try {
      const d = JSON.parse(r.cuerpo);
      const extras = [];
      for (const [clave, valor] of Object.entries(d)) {
        if (clave === 'five_hour' || clave === 'seven_day') continue;
        const v = ventanaApi(valor);
        if (v) extras.push({ nombre: NOMBRES_EXTRA[clave] || clave.replace(/_/g, ' '), pct: v.pct, reinicio: v.resets_at ? v.resets_at * 1000 : null });
      }
      usoApi = { five_hour: ventanaApi(d.five_hour), seven_day: ventanaApi(d.seven_day), extras, actualizado: Math.round(Date.now() / 1000) };
      estadoApi.error = null;
      estadoApi.ultima = Date.now();
    } catch (e) {
      estadoApi.error = 'No se pudo leer la respuesta de Anthropic.';
    }
  }
  actualizarConsumo();
}

async function activarApi() {
  const ok = await vscode.window.showInformationMessage(
    'El koala consultará cada pocos minutos tu uso real en api.anthropic.com con la sesión que Claude Code ya guarda en este equipo. El token solo se envía a Anthropic y nunca se muestra. ¿Activar?',
    { modal: true }, 'Activar');
  if (ok !== 'Activar') return;
  await config().update('usoDesdeAnthropic', true, vscode.ConfigurationTarget.Global);
  consultarAnthropic(true);
}

// ---------- Alertas (el koala las dice; la primera manda) ----------
function horaCorta(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function calcularAlertas(u) {
  const a = [];
  const umbral = config().get('avisarEnPorcentaje', 90);
  const max = Math.max(u.cinco && !u.cinco.reiniciada ? u.cinco.pct : 0, u.semana && !u.semana.reiniciada ? u.semana.pct : 0);
  if (max >= umbral) a.push({ nivel: 3, texto: `¡Casi al límite de Claude Code (${Math.round(max)} %)!` });
  for (const s of servicios) if (!s.ok) a.push({ nivel: 3, texto: `${s.nombre} no responde (${s.detalle})` });
  if (sistema) {
    if (sistema.temperatura >= 85) a.push({ nivel: 3, texto: `El servidor está a ${sistema.temperatura} °C` });
    if (sistema.memoria.pct >= 90) a.push({ nivel: 3, texto: `Memoria del servidor al ${Math.round(sistema.memoria.pct)} %` });
    for (const d of sistema.discos) if (d.pct >= 90) a.push({ nivel: 3, texto: `Disco ${d.ruta} al ${Math.round(d.pct)} %` });
  }
  if (u.ritmo.estado === 'alcanza') {
    a.push({ nivel: 2, texto: `A este ritmo llegas al 100 % a las ${horaCorta(u.ritmo.eta)}, antes del corte` });
  }
  if (u.sesion && u.sesion.contexto_pct >= 85) {
    a.push({ nivel: 2, texto: `La conversación de Claude va al ${Math.round(u.sesion.contexto_pct)} % de contexto` });
  }
  if (diag.errores) a.push({ nivel: 1, texto: `Hay ${diag.errores} error${diag.errores === 1 ? '' : 'es'} en el proyecto` });
  for (const g of gitInfo || []) {
    const viejo = !g.ultimoCommit || Date.now() - g.ultimoCommit > 3 * HORA;
    if (g.cambios >= 1 && viejo) a.push({ nivel: 1, texto: `${g.cambios} cambio${g.cambios === 1 ? '' : 's'} sin commit en ${g.nombre}` });
  }
  return a.sort((x, y) => y.nivel - x.nivel);
}

function datosActivo() {
  if (activo.fecha !== hoyTexto()) activo = { fecha: hoyTexto(), segundos: 0 };
  return activo.segundos;
}
function contarActivo() {
  datosActivo();
  if (Date.now() - ultimaActividad < 60000 || claudeTrabajando) {
    activo.segundos++;
    if (activo.segundos % 30 === 0) contexto.globalState.update(CLAVE_ACTIVO, activo);
  }
}

async function medirSistema() {
  sistema = await monitor.leerSistema();
}
let serviciosCaidos = new Set();
async function medirServicios() {
  servicios = await monitor.revisarServicios(config().get('servicios', []));
  const caidos = new Set(servicios.filter((s) => !s.ok).map((s) => s.url));
  for (const s of servicios) {
    if (!s.ok && !serviciosCaidos.has(s.url)) {
      vscode.window.showWarningMessage(`🐨 ${s.nombre} no responde (${s.detalle}).`);
      animar('servicioCaido', { nombre: s.nombre, detalle: s.detalle });
    }
    if (s.ok && serviciosCaidos.has(s.url)) {
      vscode.window.showInformationMessage(`🐨 ${s.nombre} volvió a responder.`);
      animar('servicioVuelve', { nombre: s.nombre });
    }
  }
  serviciosCaidos = caidos;
  enviarEstado();
}
async function medirGit() {
  try { gitInfo = await monitor.resumenGit(); } catch (e) { gitInfo = null; }
}
let ultimaBarrida = 0;
function medirDiag() {
  const antes = diag.errores;
  diag = monitor.diagnosticos();
  if (diag.errores > 0 && rutina) rutina.alError();
  // Barre solo si arreglaste algo hace poco (cerrar un archivo también "borra" sus errores).
  if (antes > 0 && diag.errores === 0 && Date.now() - ultimaActividad < 120000 && Date.now() - ultimaBarrida > 300000) {
    ultimaBarrida = Date.now();
    if (rutina) rutina.alBarrer();
    animar('errores0', { antes });
  }
}

function animar(accion, datos) {
  if (vista && vista.visible) vista.webview.postMessage({ tipo: 'accion', accion, datos });
}

async function agregarServicio() {
  const url = await vscode.window.showInputBox({ prompt: 'Dirección a vigilar (http o https)', placeHolder: 'http://127.0.0.1:8000/' });
  if (!url) return;
  const nombre = await vscode.window.showInputBox({ prompt: 'Nombre corto', value: new URL(url).host });
  const lista = config().get('servicios', []).filter((s) => s.url !== url);
  lista.push({ nombre: nombre || url, url });
  await config().update('servicios', lista, vscode.ConfigurationTarget.Global);
  medirServicios();
}
async function quitarServicio(url) {
  const lista = config().get('servicios', []).filter((s) => s.url !== url);
  await config().update('servicios', lista, vscode.ConfigurationTarget.Global);
  medirServicios();
}

// ---------- Webview ----------
function enviarEstado() {
  if (!vista) return;
  const uso = resumenUso();
  vista.webview.postMessage({
    tipo: 'estado',
    necesidades,
    durmiendo,
    trabajando: trabajando(),
    claude: claudeTrabajando,
    uso,
    umbral: config().get('avisarEnPorcentaje', 90),
    energiaLigada: energiaDeSesion() !== null,
    pomodoro: estadoPomodoro(),
    hoy: resumenHoy(),
    activoHoy: datosActivo(),
    sistema, servicios, git: gitInfo, diag,
    alertas: calcularAlertas(uso),
    costos: resumenCostos(),
    claudeNecesita,
    racha: monitor.racha(gitInfo),
    inactivoMin: minutosInactivo(),
    minutosSiesta: config().get('minutosParaSiesta', 20),
    temporada: temporada(),
    clima: climaActual,
    rutina: rutina ? rutina.estado() : null,
    sonidos: config().get('sonidos', false),
    visitantes: config().get('visitantes', true),
  });
}

function ejecutarAccion(accion) {
  if (accion === 'dormir') {
    durmiendo = !durmiendo;
    guardarEstado();
    enviarEstado();
    return;
  }
  if (accion === 'trabajar') {
    manual = trabajando() ? 'descansar' : 'trabajar';
    enviarEstado();
    return;
  }
  if (durmiendo && accion !== 'mimar') {
    durmiendo = false;
    guardarEstado();
  }
  if (vista && vista.visible) {
    enviarEstado();
    vista.webview.postMessage({ tipo: 'accion', accion });
  } else {
    // Sin panel visible no hay animación: el efecto se aplica de inmediato.
    aplicarEfecto(accion);
    mostrarPanel();
  }
}

const EFECTOS = { comer: ['saciedad', 35], jugar: ['animo', 25], mimar: ['animo', 10] };

function aplicarEfecto(accion) {
  const ef = EFECTOS[accion];
  if (!ef) return;
  necesidades[ef[0]] = limitar(necesidades[ef[0]] + ef[1]);
  guardarEstado();
  enviarEstado();
}

function alEventoGit(ev) {
  if (rutina) (ev.tipo === 'commit' ? rutina.alCommit() : rutina.alPush());
  necesidades.animo = limitar(necesidades.animo + (ev.tipo === 'commit' ? 8 : 5));
  guardarEstado();
  medirGit().then(() => {
    animar(ev.tipo === 'commit' ? 'festejarCommit' : 'festejarPush', { ...ev, racha: monitor.racha(gitInfo).dias });
    enviarEstado();
  });
}

async function medirClima() {
  const ciudad = config().get('clima.ciudad', '');
  climaActual = ciudad ? await monitor.clima(ciudad) : null;
}

function revisarRutina() {
  if (!rutina) return;
  const u = resumenUso();
  rutina.revisar({
    inactivoMin: minutosInactivo(),
    visible: !!(vista && vista.visible),
    racha: monitor.racha(gitInfo).dias,
    resumen: {
      semana: u.semana && !u.semana.reiniciada ? Math.round(u.semana.pct) : null,
      racha: monitor.racha(gitInfo).dias,
      cambios: (gitInfo || []).reduce((n, g) => n + g.cambios, 0),
      commitsHoy: (gitInfo || []).reduce((n, g) => n + g.commitsHoy, 0),
      pomodoros: pomodoro.hoy || 0,
      activo: datosActivo(),
    },
  });
}

async function medirTodo() {
  medirDiag();
  await Promise.all([medirSistema(), medirGit()]);
  await medirServicios(); // envía el estado al terminar
}

function mostrarPanel() {
  vscode.commands.executeCommand('koalaCientifico.panel.focus');
}

class ProveedorVista {
  resolveWebviewView(webviewView) {
    vista = webviewView;
    const media = vscode.Uri.joinPath(contexto.extensionUri, 'media');
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [media] };
    webviewView.webview.html = htmlVista(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((msg) => {
      if (!msg) return;
      if (msg.tipo === 'listo') enviarEstado();
      else if (msg.tipo === 'accion') ejecutarAccion(msg.accion);
      else if (msg.tipo === 'efecto') aplicarEfecto(msg.accion);
      else if (msg.tipo === 'configurar') configurarMonitor();
      else if (msg.tipo === 'agregarServicio') agregarServicio();
      else if (msg.tipo === 'activarApi') activarApi();
      else if (msg.tipo === 'agua') { if (rutina) rutina.agua(); enviarEstado(); }
      else if (msg.tipo === 'visita') { if (rutina) rutina.alVisita(); }
      else if (msg.tipo === 'consultarApi') consultarAnthropic(true);
      else if (msg.tipo === 'quitarServicio') quitarServicio(msg.url);
      else if (msg.tipo === 'comando') vscode.commands.executeCommand(msg.id);
      else if (msg.tipo === 'pomodoro') (msg.op === 'detener' ? detenerPomodoro : alternarPomodoro)();
    });
    webviewView.onDidChangeVisibility(() => { if (webviewView.visible) medirTodo(); });
    webviewView.onDidDispose(() => { vista = null; });
  }
}

function htmlVista(webview) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const script = webview.asWebviewUri(vscode.Uri.joinPath(contexto.extensionUri, 'media', 'koala.js'));
  const scriptPanel = webview.asWebviewUri(vscode.Uri.joinPath(contexto.extensionUri, 'media', 'panel.js'));
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="es-MX">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Koala científico</title>
<style nonce="${nonce}">
  body { margin: 0; padding: 6px 10px 12px; font-family: var(--vscode-font-family); font-size: 12px;
         color: var(--vscode-foreground); }
  #lienzo { width: 100%; height: 150px; display: block; cursor: pointer; image-rendering: pixelated; }
  #estado { text-align: center; margin: 4px 0 8px; min-height: 16px; opacity: .9; }
  .fila { display: grid; grid-template-columns: 64px 1fr 30px; align-items: center; gap: 6px; margin: 3px 0; }
  .barra { height: 8px; background: var(--vscode-editorWidget-border, #8884); border-radius: 4px; overflow: hidden; }
  .barra > i { display: block; height: 100%; width: 50%; background: var(--vscode-charts-green, #4caf50);
               transition: width .4s ease, background-color .4s ease; }
  .num { text-align: right; font-variant-numeric: tabular-nums; opacity: .8; }
  .botones { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; margin: 8px 0 10px; }
  .botones button { font: inherit; padding: 4px 0; border: none; border-radius: 3px; cursor: pointer;
                    color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  .botones button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .lab { border-top: 1px solid var(--vscode-editorWidget-border, #8884); padding-top: 8px; }
  .lab h3 { font-size: 11px; font-weight: 600; margin: 0 0 6px; opacity: .85; }
  .probeta { margin: 6px 0 8px; }
  .probeta .tit { display: flex; justify-content: space-between; margin-bottom: 3px; }
  .probeta .tit b { font-variant-numeric: tabular-nums; }
  .tubo { position: relative; height: 14px; border: 1px solid var(--vscode-foreground); border-radius: 0 7px 7px 0;
          opacity: .95; overflow: hidden; }
  .tubo > i { position: absolute; left: 0; top: 0; bottom: 0; width: 0; transition: width .6s ease;
              background: var(--vscode-charts-green, #4caf50); }
  .tubo > i::after { content: ''; position: absolute; right: 0; top: 0; bottom: 0; width: 3px; background: #fff6; }
  .tubo .marcas { position: absolute; inset: 0;
                  background: repeating-linear-gradient(90deg, transparent 0 calc(10% - 1px), var(--vscode-foreground) calc(10% - 1px) 10%);
                  opacity: .25; }
  .sub { opacity: .7; font-size: 11px; margin-top: 2px; }
  #uso-nota { opacity: .7; font-size: 11px; margin-top: 4px; }
  .boton-agua { width: 100%; font: inherit; margin: -4px 0 10px; padding: 4px 0; border: none; border-radius: 3px; cursor: pointer;
                color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  .logros { display: grid; grid-template-columns: repeat(auto-fill, minmax(38px, 1fr)); gap: 6px; }
  .logro { text-align: center; font-size: 20px; padding: 4px 0; border-radius: 4px; background: var(--vscode-editorWidget-background, #8881); }
  .logro.bloqueado { filter: grayscale(1); opacity: .3; }
  .pomo { border-top: 1px solid var(--vscode-editorWidget-border, #8884); padding: 6px 0 8px; }
  .pomo .barra > i { width: 0; background: var(--vscode-charts-red, #e0524d); transition: width 1s linear; }
  .pomo .barra > i.descanso { background: var(--vscode-charts-green, #5bc46a); }
  .pomo-botones { display: grid; grid-template-columns: 2fr 1fr; gap: 4px; }
  .pomo-botones button { font: inherit; padding: 4px 0; border: none; border-radius: 3px; cursor: pointer;
                         color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  .pomo-botones button:hover { background: var(--vscode-button-hoverBackground); }
  .pomo-botones #pomo-detener { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  .pestanas { display: grid; grid-template-columns: repeat(4, 1fr); gap: 2px; margin: 0 0 8px;
              border-bottom: 1px solid var(--vscode-editorWidget-border, #8884); }
  .pestanas button { font: inherit; font-size: 11px; padding: 4px 0 5px; border: none; background: none; cursor: pointer;
                     color: var(--vscode-foreground); opacity: .65; border-bottom: 2px solid transparent; margin-bottom: -1px; }
  .pestanas button.sel { opacity: 1; border-bottom-color: var(--vscode-focusBorder, #3794ff); font-weight: 600; }
  .pestanas button .punto { display: inline-block; width: 6px; height: 6px; border-radius: 3px; margin-left: 4px;
                            vertical-align: middle; background: var(--vscode-charts-red, #e0524d); }
  .vista { display: none; }
  .vista.sel { display: block; }
  #alertas:empty { display: none; }
  #alertas { margin: 0 0 8px; }
  .alerta { font-size: 11px; padding: 4px 6px; border-radius: 3px; margin-bottom: 3px; border-left: 3px solid;
            background: var(--vscode-editorWidget-background, #8881); }
  .alerta.n3 { border-color: var(--vscode-charts-red, #e0524d); }
  .alerta.n2 { border-color: var(--vscode-charts-yellow, #f2b33d); }
  .alerta.n1 { border-color: var(--vscode-charts-blue, #3794ff); }
  .tarjeta { border-top: 1px solid var(--vscode-editorWidget-border, #8884); padding: 8px 0 6px; }
  .tarjeta h3 { font-size: 11px; font-weight: 600; margin: 0 0 6px; opacity: .85; }
  .cifras { display: grid; grid-template-columns: repeat(auto-fit, minmax(70px, 1fr)); gap: 6px; }
  .cifra b { display: block; font-size: 15px; font-variant-numeric: tabular-nums; }
  .cifra span { font-size: 11px; opacity: .7; }
  .renglon { display: grid; grid-template-columns: minmax(60px, 36%) 1fr 92px; align-items: center; gap: 6px; margin: 3px 0; font-size: 11px; }
  .renglon .nom { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .renglon .val { font-variant-numeric: tabular-nums; opacity: .8; text-align: right; }
  .medidor { height: 6px; background: var(--vscode-editorWidget-border, #8884); border-radius: 3px; overflow: hidden; }
  .medidor > i { display: block; height: 100%; width: 0; background: var(--vscode-charts-blue, #3794ff); }
  .medidor > i.verde { background: var(--vscode-charts-green, #5bc46a); }
  .medidor > i.ambar { background: var(--vscode-charts-yellow, #f2b33d); }
  .medidor > i.rojo { background: var(--vscode-charts-red, #e0524d); }
  .medidor > i.morado { background: var(--vscode-charts-purple, #a77be0); }
  .nota { font-size: 11px; opacity: .7; margin-top: 3px; }
  .ritmo { font-size: 12px; margin: 2px 0 4px; }
  .ritmo.alcanza { color: var(--vscode-charts-red, #e0524d); }
  .ritmo.holgado { color: var(--vscode-charts-green, #5bc46a); }
  .calor { display: grid; grid-template-columns: 26px repeat(24, 1fr); gap: 1px; font-size: 10px; align-items: center; }
  .calor .c { height: 9px; border-radius: 1px; background: var(--vscode-charts-blue, #3794ff); }
  .calor .c0 { background: var(--vscode-editorWidget-border, #8884); opacity: .35; }
  .calor .h { opacity: .6; text-align: center; }
  .servicio { display: grid; grid-template-columns: 10px 1fr auto 16px; gap: 6px; align-items: center; font-size: 11px; margin: 4px 0; }
  .luz { width: 8px; height: 8px; border-radius: 4px; background: var(--vscode-charts-green, #5bc46a); }
  .luz.mal { background: var(--vscode-charts-red, #e0524d); }
  .servicio .quitar { border: none; background: none; color: var(--vscode-foreground); opacity: .5; cursor: pointer; padding: 0; font: inherit; }
  .boton-chico { font: inherit; font-size: 11px; border: none; border-radius: 3px; padding: 3px 8px; cursor: pointer; margin-top: 4px;
                 color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  .repo { font-size: 11px; margin: 4px 0; }
  .repo b { font-weight: 600; }
  #btn-configurar { display: none; margin-top: 6px; font: inherit; border: none; border-radius: 3px; padding: 4px 8px;
                    cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
</style>
</head>
<body>
  <canvas id="lienzo" title="Clic para mimar al koala"></canvas>
  <div id="estado">Preparando el laboratorio…</div>
  <nav class="pestanas" role="tablist">
    <button data-pestana="mascota" class="sel">Mascota</button>
    <button data-pestana="consumo">Consumo</button>
    <button data-pestana="hoy">Hoy</button>
    <button data-pestana="sistema">Sistema</button>
  </nav>
  <div id="alertas"></div>
  <section class="vista sel" id="v-mascota">
  <div class="fila"><span>Saciedad</span><div class="barra"><i id="b-saciedad"></i></div><span class="num" id="n-saciedad"></span></div>
  <div class="fila"><span>Ánimo</span><div class="barra"><i id="b-animo"></i></div><span class="num" id="n-animo"></span></div>
  <div class="fila"><span id="l-energia">Energía</span><div class="barra"><i id="b-energia"></i></div><span class="num" id="n-energia"></span></div>
  <div class="sub" id="s-energia"></div>
  <div class="fila"><span>Agua</span><div class="barra"><i id="b-agua"></i></div><span class="num" id="n-agua"></span></div>
  <div class="botones">
    <button data-accion="comer">Comer</button>
    <button data-accion="jugar">Jugar</button>
    <button data-accion="mimar">Mimar</button>
    <button data-accion="dormir" id="btn-dormir">Dormir</button>
  </div>
  <button class="boton-agua" id="btn-agua" title="Suma un vaso a tu meta del día">💧 Tomé un vaso de agua</button>
  <div class="pomo">
    <div class="probeta">
      <div class="tit"><span id="pomo-fase">Pomodoro</span><b id="pomo-reloj">25:00</b></div>
      <div class="barra"><i id="pomo-barra"></i></div>
      <div class="sub" id="pomo-sub"></div>
    </div>
    <div class="pomo-botones">
      <button id="pomo-alternar">Iniciar experimento</button>
      <button id="pomo-detener">Detener</button>
    </div>
  </div>
  </section>
  <section class="vista" id="v-consumo">
  <div class="lab">
    <h3>Límites de tu plan</h3>
    <div class="probeta">
      <div class="tit"><span>Sesión (5 h)</span><b id="p-cinco">—</b></div>
      <div class="tubo"><i id="t-cinco"></i><span class="marcas"></span></div>
      <div class="sub" id="s-cinco"></div>
    </div>
    <div class="probeta">
      <div class="tit"><span>Semana</span><b id="p-semana">—</b></div>
      <div class="tubo"><i id="t-semana"></i><span class="marcas"></span></div>
      <div class="sub" id="s-semana"></div>
    </div>
    <div id="uso-nota"></div>
    <button id="btn-configurar">Configurar monitor</button>
  </div>
  <div id="consumo-extra"></div>
  </section>
  <section class="vista" id="v-hoy"><div id="hoy"></div></section>
  <section class="vista" id="v-sistema"><div id="sistema"></div></section>
  <script nonce="${nonce}" src="${script}"></script>
  <script nonce="${nonce}" src="${scriptPanel}"></script>
</body>
</html>`;
}

// ---------- Pomodoro ----------
const NOMBRE_FASE = { enfoque: 'Experimento (enfoque)', descanso: 'Descanso', descansoLargo: 'Descanso largo' };

function hoyTexto() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
function cargarPomodoro() {
  pomodoro = Object.assign(pomodoro, contexto.globalState.get(CLAVE_POMODORO) || {});
  if (pomodoro.fecha !== hoyTexto()) { pomodoro.hoy = 0; pomodoro.fecha = hoyTexto(); }
  // Si VS Code estuvo cerrado y la fase ya venció, se descarta sin avisar.
  if (pomodoro.fase && pomodoro.pausa === null && pomodoro.fin <= Date.now()) pomodoro.fase = null;
  pintarPomodoro();
}
function guardarPomodoro() {
  contexto.globalState.update(CLAVE_POMODORO, pomodoro);
}
function minutosDe(fase) {
  const c = config();
  if (fase === 'enfoque') return c.get('pomodoro.minutosEnfoque', 25);
  if (fase === 'descansoLargo') return c.get('pomodoro.minutosDescansoLargo', 15);
  return c.get('pomodoro.minutosDescanso', 5);
}
function iniciarFase(fase) {
  pomodoro.fase = fase;
  pomodoro.total = minutosDe(fase) * 60000;
  pomodoro.fin = Date.now() + pomodoro.total;
  pomodoro.pausa = null;
  if (fase === 'enfoque' && durmiendo) durmiendo = false;
  guardarPomodoro();
  pintarPomodoro();
  enviarEstado();
}
function alternarPomodoro() {
  if (!pomodoro.fase) return iniciarFase('enfoque');
  if (pomodoro.pausa === null) {
    pomodoro.pausa = Math.max(0, pomodoro.fin - Date.now());
  } else {
    pomodoro.fin = Date.now() + pomodoro.pausa;
    pomodoro.pausa = null;
  }
  guardarPomodoro();
  pintarPomodoro();
  enviarEstado();
}
function detenerPomodoro() {
  pomodoro.fase = null;
  pomodoro.pausa = null;
  guardarPomodoro();
  pintarPomodoro();
  enviarEstado();
}
function revisarPomodoro() {
  if (!pomodoro.fase) return;
  if (pomodoro.pausa === null && Date.now() >= pomodoro.fin) {
    const fase = pomodoro.fase;
    if (fase === 'enfoque') {
      if (pomodoro.fecha !== hoyTexto()) { pomodoro.hoy = 0; pomodoro.fecha = hoyTexto(); }
      pomodoro.hoy++;
      pomodoro.ciclo++;
      if (rutina) rutina.alPomodoro(pomodoro.hoy);
      const largo = pomodoro.ciclo % Math.max(1, config().get('pomodoro.antesDeDescansoLargo', 4)) === 0;
      necesidades.animo = limitar(necesidades.animo + 10);
      iniciarFase(largo ? 'descansoLargo' : 'descanso');
      if (vista) vista.webview.postMessage({ tipo: 'accion', accion: 'festejarPomodoro' });
      vscode.window.showInformationMessage(
        `🐨🧪 ¡Experimento terminado! Llevas ${pomodoro.hoy} pomodoro${pomodoro.hoy === 1 ? '' : 's'} hoy. ` +
          `Descansa ${minutosDe(pomodoro.fase)} min.`, 'Saltar descanso'
      ).then((r) => { if (r) iniciarFase('enfoque'); });
    } else {
      detenerPomodoro();
      vscode.window.showInformationMessage('🐨 Se acabó el descanso. ¿Otro experimento?', 'Iniciar').then((r) => {
        if (r) iniciarFase('enfoque');
      });
    }
    return;
  }
  pintarPomodoro();
}
function restantePomodoro() {
  if (!pomodoro.fase) return 0;
  return pomodoro.pausa !== null ? pomodoro.pausa : Math.max(0, pomodoro.fin - Date.now());
}
function relojTexto(ms) {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function estadoPomodoro() {
  return {
    fase: pomodoro.fase, total: pomodoro.total, restante: restantePomodoro(),
    pausado: pomodoro.pausa !== null, hoy: pomodoro.hoy, enfoque: minutosDe('enfoque'),
  };
}
function pintarPomodoro() {
  if (!barraPomodoro) return;
  if (!pomodoro.fase) { barraPomodoro.hide(); return; }
  const icono = pomodoro.fase === 'enfoque' ? '$(beaker)' : '$(coffee)';
  barraPomodoro.text = `${icono} ${relojTexto(restantePomodoro())}${pomodoro.pausa !== null ? ' ⏸' : ''}`;
  barraPomodoro.tooltip = `${NOMBRE_FASE[pomodoro.fase]} · ${pomodoro.hoy} hoy · clic para ${pomodoro.pausa !== null ? 'reanudar' : 'pausar'}`;
  barraPomodoro.show();
}

// ---------- Configuración del monitor en ~/.claude/settings.json ----------
function copiarScripts() {
  fs.mkdirSync(DIR_SCRIPTS, { recursive: true });
  for (const nombre of ['koala-statusline.py', 'koala-hook.py']) {
    const destino = path.join(DIR_SCRIPTS, nombre);
    fs.copyFileSync(path.join(contexto.extensionPath, 'scripts', nombre), destino);
    fs.chmodSync(destino, 0o755);
  }
}

// Busca un Python 3 que funcione: python3, python o el lanzador py (Windows).
function probarComando(cmd, args) {
  return new Promise((resolver) => {
    execFile(cmd, [...args, '--version'], { timeout: 5000, windowsHide: true }, (err, out, errOut) => {
      resolver(!err && /Python 3/.test(String(out) + String(errOut)));
    });
  });
}
async function encontrarPython() {
  const candidatos = process.platform === 'win32'
    ? [['py', ['-3']], ['python', []], ['python3', []]]
    : [['python3', []], ['python', []]];
  for (const [cmd, args] of candidatos) {
    if (await probarComando(cmd, args)) return [cmd, ...args].join(' ');
  }
  return null;
}
// Rutas con / para que funcionen igual en bash, Git Bash (Windows) y cmd.
const rutaComando = (p) => p.split(path.sep).join('/');

function monitorConfigurado() {
  try { return fs.readFileSync(RUTA_SETTINGS, 'utf8').includes('koala-hook.py'); } catch (e) { return false; }
}
// En una computadora nueva: ofrecerlo una sola vez.
async function ofrecerConfiguracion() {
  if (monitorConfigurado() || contexto.globalState.get('koala.ofrecido')) return;
  contexto.globalState.update('koala.ofrecido', true);
  const r = await vscode.window.showInformationMessage(
    '🐨 ¿Conecto al koala con Claude Code en esta computadora? (sabrá cuándo trabaja Claude, cuándo te necesita y cuánto llevas de tu plan)',
    'Configurar', 'Ahora no');
  if (r === 'Configurar') configurarMonitor(true);
}

async function configurarMonitor(yaConfirmado) {
  const ok = yaConfirmado === true ? 'Configurar' : await vscode.window.showInformationMessage(
    'El koala agregará a ~/.claude/settings.json una status line (para leer el % de sesión y semana) y hooks (para saber cuándo trabaja Claude, cuándo termina y cuándo te necesita). Se guarda un respaldo antes.',
    { modal: true },
    'Configurar'
  );
  if (ok !== 'Configurar') return;
  const py = await encontrarPython();
  if (!py) {
    const r = await vscode.window.showErrorMessage(
      'El monitor necesita Python 3 y no lo encontré (probé python3, python y py). Instálalo y vuelve a intentarlo; la mascota y el pomodoro funcionan sin él.',
      'Descargar Python');
    if (r) vscode.env.openExternal(vscode.Uri.parse('https://www.python.org/downloads/'));
    return;
  }
  try {
    copiarScripts();
    let texto = '{}';
    try { texto = fs.readFileSync(RUTA_SETTINGS, 'utf8'); } catch (e) { /* aún no existe */ }
    const ajustes = JSON.parse(texto || '{}');
    const cmdStatus = `${py} "${rutaComando(path.join(DIR_SCRIPTS, 'koala-statusline.py'))}"`;
    const cmdHook = (arg) => `${py} "${rutaComando(path.join(DIR_SCRIPTS, 'koala-hook.py'))}" ${arg}`;

    const actual = ajustes.statusLine && String(ajustes.statusLine.command || '');
    if (actual && !actual.includes('koala-statusline')) {
      const r = await vscode.window.showWarningMessage(
        `Ya tienes una status line (${actual}). ¿Reemplazarla por la del koala?`, { modal: true }, 'Reemplazar');
      if (r !== 'Reemplazar') return;
    }
    fs.writeFileSync(`${RUTA_SETTINGS}.koala-respaldo-${Date.now()}`, texto);

    ajustes.statusLine = { type: 'command', command: cmdStatus, padding: 0 };
    ajustes.hooks = ajustes.hooks || {};
    for (const [evento, arg] of [['UserPromptSubmit', 'trabajando'], ['PreToolUse', 'trabajando'], ['PostToolUse', 'trabajando'],
      ['Stop', 'descanso'], ['Notification', 'necesita']]) {
      const lista = (ajustes.hooks[evento] || []).filter(
        (g) => !(g.hooks || []).some((h) => String(h.command || '').includes('koala-hook.py')));
      const grupo = { hooks: [{ type: 'command', command: cmdHook(arg), timeout: 5 }] };
      if (evento === 'PreToolUse' || evento === 'PostToolUse') grupo.matcher = '*';
      lista.push(grupo);
      ajustes.hooks[evento] = lista;
    }
    fs.mkdirSync(DIR_CLAUDE, { recursive: true });
    fs.writeFileSync(RUTA_SETTINGS, JSON.stringify(ajustes, null, 2) + '\n');
    vscode.window.showInformationMessage('🐨 Monitor configurado. Los porcentajes llegarán con la siguiente respuesta de Claude Code.');
  } catch (e) {
    vscode.window.showErrorMessage(`No se pudo configurar el monitor: ${e.message}`);
  }
}

// ---------- Activación ----------
function activate(ctx) {
  contexto = ctx;
  ctx.globalState.setKeysForSync([CLAVE_ESTADO, 'koala.logros', 'koala.contadores']); // ánimo, saciedad y energía viajan con Settings Sync
  cargarEstado();

  ctx.subscriptions.push(vscode.window.registerWebviewViewProvider('koalaCientifico.panel', new ProveedorVista(), {
    webviewOptions: { retainContextWhenHidden: true },
  }));

  barra = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  barra.command = 'koalaCientifico.mostrar';
  ctx.subscriptions.push(barra);

  const comando = (id, fn) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));
  comando('koalaCientifico.mostrar', mostrarPanel);
  for (const a of ['comer', 'jugar', 'mimar', 'dormir', 'trabajar']) comando(`koalaCientifico.${a}`, () => ejecutarAccion(a));
  comando('koalaCientifico.consumo', async () => {
    await escanearTranscripciones();
    const r = await vscode.window.showInformationMessage(textoConsumo(resumenUso()), { modal: true }, 'Abrir panel');
    if (r) mostrarPanel();
  });
  comando('koalaCientifico.configurar', () => configurarMonitor());
  comando('koalaCientifico.pomodoro', alternarPomodoro);
  comando('koalaCientifico.agregarServicio', agregarServicio);
  comando('koalaCientifico.consultarAnthropic', () => (config().get('usoDesdeAnthropic', false) ? consultarAnthropic(true) : activarApi()));
  comando('koalaCientifico.pomodoroDetener', detenerPomodoro);

  barraPomodoro = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 89);
  barraPomodoro.command = 'koalaCientifico.pomodoro';
  ctx.subscriptions.push(barraPomodoro);
  cargarPomodoro();

  // Actividad del editor y la terminal.
  const w = vscode.window;
  const eventos = [
    vscode.workspace.onDidChangeTextDocument((e) => { if (e.document.uri.scheme !== 'output') registrarActividad(); }),
    w.onDidChangeActiveTextEditor(registrarActividad),
    w.onDidChangeTextEditorSelection(registrarActividad),
    w.onDidOpenTerminal(registrarActividad),
    w.onDidChangeActiveTerminal(registrarActividad),
  ];
  if (w.onDidStartTerminalShellExecution) eventos.push(w.onDidStartTerminalShellExecution(alIniciarComando));
  if (w.onDidEndTerminalShellExecution) eventos.push(w.onDidEndTerminalShellExecution(alTerminarComando));
  if (w.onDidChangeTerminalState) eventos.push(w.onDidChangeTerminalState(registrarActividad));
  ctx.subscriptions.push(...eventos);

  ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('koalaCientifico.servicios')) medirServicios();
    else if (e.affectsConfiguration('koalaCientifico.clima')) medirClima().then(enviarEstado);
    else if (e.affectsConfiguration('koalaCientifico.usoDesdeAnthropic')) consultarAnthropic(true);
    else if (e.affectsConfiguration('koalaCientifico')) actualizarConsumo();
  }));

  // Claude Code: estado del turno y consumo.
  fs.watchFile(RUTA_ESTADO_CLAUDE, { interval: 1000 }, leerEstadoClaude);
  fs.watchFile(RUTA_USO, { interval: 2000 }, leerUsoOficial);
  leerEstadoClaude();
  leerUsoOficial();
  escanearTranscripciones();

  // Si el monitor ya está configurado, mantener los scripts al día con esta versión.
  if (fs.existsSync(DIR_SCRIPTS)) {
    try { copiarScripts(); } catch (e) { /* sin permisos: se usan los anteriores */ }
  }

  const reloj = setInterval(tick, 15 * 1000);
  const relojActividad = setInterval(() => { revisarInactividad(); revisarPomodoro(); contarActivo(); }, 1000);
  // Mediciones del entorno: más seguido solo con el panel a la vista.
  activo = Object.assign(activo, ctx.globalState.get(CLAVE_ACTIVO) || {});
  let vueltas = 0;
  const relojEntorno = setInterval(async () => {
    vueltas++;
    const visible = vista && vista.visible;
    if (visible || vueltas % 6 === 0) await medirSistema();
    if (vueltas % 12 === 0) await medirServicios();
    await consultarAnthropic(false); // respeta su propio intervalo
    if (visible && vueltas % 6 === 0) await medirGit();
    if (visible) enviarEstado();
  }, 5000);
  let esperaDiag = null;
  ctx.subscriptions.push(vscode.languages.onDidChangeDiagnostics(() => {
    clearTimeout(esperaDiag);
    esperaDiag = setTimeout(() => { medirDiag(); enviarEstado(); }, 1500);
  }));
  setTimeout(medirTodo, 3000);
  setTimeout(ofrecerConfiguracion, 8000);
  rutina = crearRutina({
    contexto: ctx,
    animar,
    notificar: (t) => vscode.window.showInformationMessage(t),
    config,
  });
  medirClima().then(enviarEstado);
  const relojRutina = setInterval(revisarRutina, 15000);
  const relojClima = setInterval(() => medirClima().then(enviarEstado), 15 * 60000);
  ctx.subscriptions.push({ dispose() { clearInterval(relojRutina); clearInterval(relojClima); } });
  comando('koalaCientifico.agua', () => { rutina.agua(); enviarEstado(); });
  // Commits y pushes: el koala festeja (y se alegra: más ánimo).
  monitor.vigilarGit(alEventoGit).then((d) => ctx.subscriptions.push(d), () => {});
  const relojUso = setInterval(escanearTranscripciones, 60 * 1000);
  ctx.subscriptions.push({
    dispose() {
      clearInterval(reloj);
      clearInterval(relojActividad);
      clearInterval(relojEntorno);
      contexto.globalState.update(CLAVE_ACTIVO, activo);
      clearInterval(relojUso);
      clearTimeout(temporizadorClaude);
      fs.unwatchFile(RUTA_ESTADO_CLAUDE);
      fs.unwatchFile(RUTA_USO);
    },
  });
}

function deactivate() {
  if (contexto) guardarEstado();
}

module.exports = { activate, deactivate };
