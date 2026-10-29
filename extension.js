'use strict';
// Koala científico: mascota de laboratorio que trabaja contigo y vigila tu consumo de Claude Code.
// Sin dependencias: todo sale de archivos locales en ~/.claude (internet solo para lo que actives: clima,
// dato directo de Anthropic y sincronización con GitHub).

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');
const monitor = require('./monitor');
const { crearRutina } = require('./rutina');
const { crearAlarmas } = require('./alarmas');
const { htmlVista } = require('./vista');
const anthropic = require('./anthropic');
const idioma = require('./idioma');
const { t } = idioma;
const { crearPomodoro } = require('./pomodoro');
const { crearConfigurador } = require('./configurar');
const { crearCompartido, crearLider } = require('./compartido');
const { crearNube } = require('./nube');
const {
  crearConsumo, inicioVentana, ventanaVigente, formatoTokens, duracionTexto, HORA, CINCO_HORAS, SIETE_DIAS,
} = require('./consumo');

const DIR_CLAUDE = path.join(os.homedir(), '.claude');
const RUTA_ESTADO_CLAUDE = path.join(DIR_CLAUDE, 'koala-estado.json');
const RUTA_USO = path.join(DIR_CLAUDE, 'koala-uso.json');
const DIR_PROYECTOS = path.join(DIR_CLAUDE, 'projects');

const CLAVE_ESTADO = 'koala.estado';
const CLAVE_AVISOS = 'koala.avisos';
// Lo que comparten todas las ventanas y editores de esta computadora (y la cuenta de GitHub, si la activas).
const CLAVES_RUTINA = ['koala.dia', 'koala.logros', 'koala.contadores', 'koala.ultimoError'];
const CLAVES_COMPARTIDAS = [CLAVE_ESTADO, 'koala.pomodoro', 'koala.alarmas', 'koala.carruseles', 'koala.lugarClima',
  'koala.ajustes', 'koala.monitorAceptado', ...CLAVES_RUTINA];
const RUTA_COMPARTIDO = path.join(DIR_CLAUDE, 'koala', 'compartido.json');
const RUTA_LIDER = path.join(DIR_CLAUDE, 'koala', 'lider.json');
const TURNO_MAXIMO_MS = 15 * 60 * 1000;

let contexto = null; // el de VS Code, pero con globalState compartido entre ventanas
let compartido = null;
let lider = null;
let nube = null;
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
const consumo = crearConsumo({ dirProyectos: DIR_PROYECTOS, oficial: () => oficial(), alActualizar: () => actualizarConsumo() });

// ---------- Mediciones del entorno ----------
const CLAVE_ACTIVO = 'koala.activo';
let activo = { fecha: '', segundos: 0 };
let sistema = null;
let servicios = [];
let gitInfo = null;
let diag = { errores: 0, avisos: 0, archivos: 0 };
let climaActual = null;
let rutina = null;
let alarmas = null;
let ventanaPrevia = null; // { reinicio, pct } de la sesión de 5 h, para detectar cuándo cierra

// ---------- Pomodoro ----------
// fase: null | 'enfoque' | 'descanso' | 'descansoLargo'; fin: ms epoch; pausa: ms restantes si está en pausa
let pomodoro = null; // ver pomodoro.js
let configurador = null; // ver configurar.js

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

// Otra ventana o la nube cambiaron ánimo, saciedad, energía o sueño.
function recargarEstado() {
  const g = contexto.globalState.get(CLAVE_ESTADO);
  if (!g) return;
  necesidades = Object.assign(necesidades, g.necesidades || {});
  durmiendo = !!g.durmiendo;
  ultimoTick = g.ts || Date.now(); // el desgaste ya se aplicó hasta ese momento
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
  if (lider && !lider.esLider()) { enviarEstado(); return; } // otra ventana lleva la cuenta
  const ahora = Date.now();
  const horas = (ahora - ultimoTick) / HORA;
  ultimoTick = ahora;
  aplicarDesgaste(horas, trabajando());

  const ligada = energiaDeSesion() !== null;
  const despierta = ligada
    ? necesidades.energia >= 60 || trabajando() || pomodoro.fase() === 'enfoque'
    : necesidades.energia >= 100 || (trabajando() && necesidades.energia >= 50);
  if (durmiendo && despierta) {
    durmiendo = false;
  } else if (!durmiendo && necesidades.energia < 22 && !trabajando() && !pomodoro.fase()) {
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
      vscode.window.showWarningMessage(`🐨✋ ${t('Claude te necesita')}${necesita.mensaje ? ': ' + necesita.mensaje : '.'}`);
    }
  }
  if (!!necesita !== !!claudeNecesita) { claudeNecesita = necesita; enviarEstado(); }

  // Turno largo terminado: el koala trae el aviso de "listo".
  const minimo = config().get('avisarTurnoLargoSegundos', 120) * 1000;
  if (datos.estado === 'descanso' && nuevo && !primeraLectura && minimo > 0 && datos.duracion >= minimo) {
    const dur = datos.duracion;
    if (vista && vista.visible) vista.webview.postMessage({ tipo: 'accion', accion: 'claudeListo', datos: { duracion: dur } });
    if (!vscode.window.state.focused || config().get('avisarTurnoLargoSiempre', false)) {
      vscode.window.showInformationMessage(t('🐨📜 Claude terminó ({0}).', duracionTexto(dur)));
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

// Dato oficial: el más reciente entre la status line y la consulta directa a Anthropic.
function oficial() {
  const base = usoOficial || {};
  if (usoApi && (!base.actualizado || usoApi.actualizado >= base.actualizado)) {
    return { ...base, five_hour: usoApi.five_hour, seven_day: usoApi.seven_day, actualizado: usoApi.actualizado, fuente: 'anthropic' };
  }
  return base.actualizado ? { ...base, fuente: 'statusline' } : base;
}

function datosSesion() {
  const s = usoOficial && usoOficial.sesion;
  if (!s || !s.ts || Date.now() - s.ts * 1000 > 6 * HORA) return null;
  return { ...s, ts: s.ts * 1000 };
}

function resumenUso() {
  const of = oficial();
  return {
    cinco: ventanaVigente(of.five_hour),
    semana: ventanaVigente(of.seven_day),
    modelo: of.model || '',
    actualizado: of.actualizado ? of.actualizado * 1000 : null,
    local: consumo.usoLocal(),
    ritmo: consumo.calcularRitmo(ventanaVigente(of.five_hour)),
    sesion: datosSesion(),
    fuente: of.fuente || null,
    extras: usoApi && of.fuente === 'anthropic' ? usoApi.extras : [],
    api: estadoApi,
  };
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
  if (mes === 12 || (mes === 1 && dia <= 6)) return 'navidad'; // árbol desde el 1 de diciembre
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
  consumo.calcularUsoLocal();
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
  const nombres = { cinco: t('la sesión (5 h)'), semana: t('la semana') };
  let cambio = false;
  for (const clave of ['cinco', 'semana']) {
    const v = u[clave];
    if (!v || v.reiniciada || v.pct < umbral) continue;
    const id = `${clave}:${v.reinicio || 0}`;
    if (avisos[clave] === id) continue;
    avisos[clave] = id;
    cambio = true;
    vscode.window.showWarningMessage(
      t('🐨 El koala midió {0} % de {1} de Claude Code.', Math.round(v.pct), nombres[clave]) +
        (v.reinicio ? ' ' + t('Se reinicia en {0}.', formatoFalta(v.reinicio)) : ''),
      t('Ver consumo')
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
  if (u.semana) partes.push(`${t('sem')} ${Math.round(u.semana.pct)}%`);
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
  const lineas = [t('Koala científico — consumo de Claude Code')];
  const linea = (nombre, v) => {
    if (!v) return t('{0}: sin dato oficial', nombre);
    if (v.reiniciada) return t('{0}: reiniciada (esperando dato nuevo)', nombre);
    return `${nombre}: ${Math.round(v.pct)} %` + (v.reinicio ? t(', se reinicia en {0}', formatoFalta(v.reinicio)) : '');
  };
  lineas.push(linea(t('Sesión (5 h)'), u.cinco));
  lineas.push(linea(t('Semana'), u.semana));
  lineas.push(t('Tokens locales: {0} en la sesión, {1} en la semana', formatoTokens(u.local.tokens5h), formatoTokens(u.local.tokens7d)));
  if (u.actualizado) lineas.push(t('Dato oficial de hace {0} min', Math.max(0, Math.round((Date.now() - u.actualizado) / 60000))));
  else lineas.push(t('Sin dato oficial: ejecuta "Koala científico: configurar monitor de Claude Code"'));
  return lineas.join('\n');
}

// ---------- Consulta directa a Anthropic (opcional; ver anthropic.js) ----------
async function consultarAnthropic(forzar) {
  estadoApi.activo = config().get('usoDesdeAnthropic', false);
  if (!estadoApi.activo) return;
  if (!forzar && Date.now() < proximaConsultaApi) return;
  proximaConsultaApi = Date.now() + Math.max(2, config().get('minutosEntreConsultas', 5)) * 60000;
  const r = await anthropic.consultarUso(DIR_CLAUDE);
  if (r.uso) {
    usoApi = r.uso;
    estadoApi.error = null;
    estadoApi.ultima = Date.now();
  } else {
    estadoApi.error = r.error;
    if (r.esperarMin) proximaConsultaApi = Date.now() + r.esperarMin * 60000;
  }
  actualizarConsumo();
}

async function activarApi() {
  const ok = await vscode.window.showInformationMessage(
    t('El koala consultará cada pocos minutos tu uso real en api.anthropic.com con la sesión que Claude Code ya guarda en este equipo. El token solo se envía a Anthropic y nunca se muestra. ¿Activar?'),
    { modal: true }, t('Activar'));
  if (ok !== t('Activar')) return;
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
  if (max >= umbral) a.push({ nivel: 3, pestana: 'consumo', tarjeta: 'limites', texto: t('¡Casi al límite de Claude Code ({0} %)!', Math.round(max)) });
  for (const s of servicios) if (!s.ok) a.push({ nivel: 3, pestana: 'sistema', tarjeta: 'servicios', texto: t('{0} no responde ({1})', s.nombre, s.detalle) });
  if (sistema) {
    if (sistema.temperatura >= 85) a.push({ nivel: 3, pestana: 'sistema', tarjeta: 'servidor', texto: t('El servidor está a {0} °C', sistema.temperatura) });
    if (sistema.memoria.pct >= 90) a.push({ nivel: 3, pestana: 'sistema', tarjeta: 'servidor', texto: t('Memoria del servidor al {0} %', Math.round(sistema.memoria.pct)) });
    for (const d of sistema.discos) if (d.pct >= 90) a.push({ nivel: 3, pestana: 'sistema', tarjeta: 'servidor', texto: t('Disco {0} al {1} %', d.ruta, Math.round(d.pct)) });
  }
  if (u.ritmo.estado === 'alcanza') {
    a.push({ nivel: 2, pestana: 'consumo', tarjeta: 'ritmo', texto: t('A este ritmo llegas al 100 % a las {0}, antes del corte', horaCorta(u.ritmo.eta)) });
  }
  if (u.sesion && u.sesion.contexto_pct >= 85) {
    a.push({ nivel: 2, pestana: 'consumo', tarjeta: 'conversacion', texto: t('La conversación de Claude va al {0} % de contexto', Math.round(u.sesion.contexto_pct)) });
  }
  if (diag.errores) a.push({ nivel: 1, pestana: 'hoy', tarjeta: 'problemas', texto: diag.errores === 1 ? t('Hay 1 error en el proyecto') : t('Hay {0} errores en el proyecto', diag.errores) });
  for (const g of gitInfo || []) {
    const viejo = !g.ultimoCommit || Date.now() - g.ultimoCommit > 3 * HORA;
    if (g.cambios >= 1 && viejo) a.push({ nivel: 1, pestana: 'hoy', tarjeta: 'git', texto: g.cambios === 1 ? t('1 cambio sin commit en {0}', g.nombre) : t('{0} cambios sin commit en {1}', g.cambios, g.nombre) });
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
      vscode.window.showWarningMessage('🐨 ' + t('{0} no responde ({1})', s.nombre, s.detalle) + '.');
      animar('servicioCaido', { nombre: s.nombre, detalle: s.detalle });
    }
    if (s.ok && serviciosCaidos.has(s.url)) {
      vscode.window.showInformationMessage('🐨 ' + t('{0} volvió a responder.', s.nombre));
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
  const url = await vscode.window.showInputBox({ prompt: t('Dirección a vigilar (http o https)'), placeHolder: 'http://127.0.0.1:8000/' });
  if (!url) return;
  const nombre = await vscode.window.showInputBox({ prompt: t('Nombre corto'), value: new URL(url).host });
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
    pomodoro: pomodoro.estado(),
    hoy: consumo.resumenHoy(),
    activoHoy: datosActivo(),
    sistema, servicios, git: gitInfo, diag,
    alertas: calcularAlertas(uso),
    costos: consumo.resumenCostos({ aguaMlPorWh: config().get('aguaMlPorWh', 2), planUsd: config().get('costoPlanMensualUSD', 0) }),
    claudeNecesita,
    racha: monitor.racha(gitInfo),
    inactivoMin: minutosInactivo(),
    minutosSiesta: config().get('minutosParaSiesta', 20),
    minutosTreparse: config().get('minutosParaTreparse', 120),
    temporada: temporada(),
    clima: climaActual,
    rutina: rutina ? rutina.estado() : null,
    alarmas: alarmas ? alarmas.lista() : [],
    sonidos: config().get('sonidos', false),
    visitantes: config().get('visitantes', true),
    carruseles: contexto.globalState.get('koala.carruseles') || null,
    sincronizacion: estadoSincronizacion(),
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

// La ciudad se elige con el comando "Elegir ciudad del clima" (lista para distinguir homónimos) o se escribe a mano
// en koalaCientifico.clima.ciudad. El koala NO detecta tu ubicación por su cuenta.
async function medirClima() {
  const ciudad = String(config().get('clima.ciudad', '') || '').trim();
  const elegido = contexto.globalState.get('koala.lugarClima');
  if (!ciudad) { climaActual = null; return; }
  const nuevo = await monitor.clima(elegido && elegido.etiqueta === ciudad ? elegido : ciudad);
  // Si falla la red, se conserva el último dato bueno (hasta 1 h) y se reintenta en 1 min, no en 15.
  if (nuevo && nuevo.reintentar) {
    clearTimeout(reintentoClima);
    reintentoClima = setTimeout(() => medirClima().then(enviarEstado), 60000);
    if (climaActual && !climaActual.error && Date.now() - climaActual.ts < HORA) return;
  }
  climaActual = nuevo;
}
let reintentoClima = null;

// ---------- Alarmas ----------
function alSonarAlarma(a, atraso, pospuesta) {
  const texto = `⏰ ${a.hora} — ${a.mensaje}` + (atraso ? ' ' + t('(hace {0} min)', atraso) : '') + (pospuesta ? ' ' + t('(pospuesta)') : '');
  animar('alarma', { hora: a.hora, mensaje: a.mensaje });
  vscode.window.showWarningMessage(`🐨 ${texto}`, t('Posponer 5 min'), t('Listo')).then((r) => {
    if (r === t('Posponer 5 min')) alarmas.posponer(a, 5);
  });
  enviarEstado();
}
function crearAlarma(datos) {
  try {
    const a = alarmas.crear(datos);
    vscode.window.showInformationMessage('🐨 ' + t('Alarma lista: {0} — {1}', a.hora, a.mensaje));
  } catch (e) {
    vscode.window.showErrorMessage(`🐨 ${e.message}`);
  }
  enviarEstado();
}
async function nuevaAlarmaComando() {
  const hora = await vscode.window.showInputBox({
    prompt: t('¿A qué hora? (24 h, HH:MM)'), placeHolder: '14:30',
    validateInput: (v) => (/^\d{1,2}:\d{2}$/.test(v.trim()) ? null : t('Escribe la hora como HH:MM, por ejemplo 09:15')),
  });
  if (!hora) return;
  const mensaje = await vscode.window.showInputBox({ prompt: t('¿Qué te recuerdo?'), placeHolder: t('Junta con el equipo') });
  if (mensaje === undefined) return;
  const rep = await vscode.window.showQuickPick([
    { label: t('Solo una vez'), valor: 'una' }, { label: t('Todos los días'), valor: 'diaria' },
    { label: t('Lunes a viernes'), valor: 'laborables' }, { label: t('Elegir días…'), valor: 'elegir' },
  ], { placeHolder: t('¿Cuándo se repite?') });
  if (!rep) return;
  let repeticion = rep.valor;
  if (repeticion === 'elegir') {
    const dias = await vscode.window.showQuickPick(
      ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'].map((d, i) => ({ label: t(d), i })),
      { canPickMany: true, placeHolder: t('Días de la semana') });
    if (!dias || !dias.length) return;
    repeticion = dias.map((d) => d.i);
  }
  crearAlarma({ hora: hora.trim(), mensaje, repeticion });
}
async function verAlarmasComando() {
  const lista = alarmas.lista();
  if (!lista.length) {
    const r = await vscode.window.showInformationMessage('🐨 ' + t('No tienes alarmas.'), t('Crear una'));
    if (r) nuevaAlarmaComando();
    return;
  }
  const r = await vscode.window.showQuickPick(lista.map((a) => ({
    label: `${a.activa ? '⏰' : '💤'} ${a.hora} — ${a.mensaje}`, description: a.texto, a,
  })), { placeHolder: t('Elige una alarma para encenderla, apagarla o borrarla') });
  if (!r) return;
  const accion = await vscode.window.showQuickPick([r.a.activa ? t('Apagar') : t('Encender'), t('Borrar')], { placeHolder: `${r.a.hora} — ${r.a.mensaje}` });
  if (accion === t('Borrar')) alarmas.borrar(r.a.id);
  else if (accion) alarmas.alternar(r.a.id);
  enviarEstado();
}

// Llama a un visitante en ese momento (si no, llegan solos cada 20–40 min).
async function invitarVisitante() {
  const opciones = [
    { label: '🐼 ' + t('panda'), tipo: 'panda' }, { label: '🦎 ' + t('ajolote'), tipo: 'ajolote' },
    { label: '🐀 ' + t('tlacuache'), tipo: 'tlacuache' }, { label: '🎲 ' + t('Al azar'), tipo: null },
  ];
  const r = await vscode.window.showQuickPick(opciones, { placeHolder: t('¿Quién viene de visita?') });
  if (!r) return;
  await mostrarPanel();
  setTimeout(() => animar('visitaPrueba', { tipo: r.tipo, modo: 'suelo' }), 600);
}

async function elegirCiudad() {
  const texto = await vscode.window.showInputBox({
    prompt: t('¿En qué ciudad estás? (para el clima de la ventana del laboratorio)'),
    placeHolder: 'Toluca, Guadalajara, Monterrey…',
    value: '',
  });
  if (texto === undefined) return;
  if (!texto.trim()) {
    await config().update('clima.ciudad', '', vscode.ConfigurationTarget.Global);
    await contexto.globalState.update('koala.lugarClima', undefined);
    vscode.window.showInformationMessage('🐨 ' + t('Clima desactivado: la ventana solo seguirá la hora.'));
    return;
  }
  const opciones = await monitor.buscarCiudades(texto, idioma.esIngles() ? 'en' : 'es');
  if (!opciones.length) { vscode.window.showWarningMessage('🐨 ' + t('No encontré "{0}". Prueba con otro nombre.', texto)); return; }
  const r = await vscode.window.showQuickPick(
    opciones.map((o) => ({ label: o.nombre, description: o.region, lugar: o })),
    { placeHolder: t('Elige tu ciudad') });
  if (!r) return;
  const etiqueta = `${r.lugar.nombre}, ${r.lugar.region}`;
  await contexto.globalState.update('koala.lugarClima', { ...r.lugar, etiqueta });
  await config().update('clima.ciudad', etiqueta, vscode.ConfigurationTarget.Global);
  await medirClima();
  enviarEstado();
  if (climaActual && !climaActual.error) vscode.window.showInformationMessage('🐨 ' + t('Clima de {0}: {1} °C.', r.lugar.nombre, climaActual.temp));
}

function revisarRutina() {
  if (!rutina || (lider && !lider.esLider())) return; // saludos y logros, una sola vez aunque haya varias ventanas
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
      pomodoros: pomodoro.hoy() || 0,
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
    webviewView.webview.html = htmlVista(webviewView.webview, contexto.extensionUri);
    webviewView.webview.onDidReceiveMessage((msg) => {
      if (!msg) return;
      if (msg.tipo === 'listo') enviarEstado();
      else if (msg.tipo === 'accion') ejecutarAccion(msg.accion);
      else if (msg.tipo === 'efecto') aplicarEfecto(msg.accion);
      else if (msg.tipo === 'configurar') configurador.configurarMonitor();
      else if (msg.tipo === 'sincronizarCuenta') sincronizarCuentaComando();
      else if (msg.tipo === 'agregarServicio') agregarServicio();
      else if (msg.tipo === 'activarApi') activarApi();
      else if (msg.tipo === 'elegirCiudad') elegirCiudad();
      else if (msg.tipo === 'crearAlarma') crearAlarma(msg);
      else if (msg.tipo === 'alternarAlarma') { alarmas.alternar(msg.id); enviarEstado(); }
      else if (msg.tipo === 'borrarAlarma') { alarmas.borrar(msg.id); enviarEstado(); }
      else if (msg.tipo === 'agua') { if (rutina) rutina.agua(); enviarEstado(); }
      else if (msg.tipo === 'visita') { if (rutina) rutina.alVisita(); }
      else if (msg.tipo === 'carruseles' && Array.isArray(msg.valor)) contexto.globalState.update('koala.carruseles', msg.valor.slice(0, 8).map(String));
      else if (msg.tipo === 'consultarApi') consultarAnthropic(true);
      else if (msg.tipo === 'quitarServicio') quitarServicio(msg.url);
      else if (msg.tipo === 'comando') vscode.commands.executeCommand(msg.id);
      else if (msg.tipo === 'pomodoro') (msg.op === 'detener' ? pomodoro.detener() : pomodoro.alternar());
    });
    webviewView.onDidChangeVisibility(() => { if (webviewView.visible) medirTodo(); });
    webviewView.onDidDispose(() => { vista = null; });
  }
}

// ---------- Pomodoro (lógica en pomodoro.js) ----------
function hoyTexto() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
function minutosDe(fase) {
  const c = config();
  if (fase === 'enfoque') return c.get('pomodoro.minutosEnfoque', 25);
  if (fase === 'descansoLargo') return c.get('pomodoro.minutosDescansoLargo', 15);
  return c.get('pomodoro.minutosDescanso', 5);
}
function alTerminarEnfoque(hoy, descanso) {
  if (rutina) rutina.alPomodoro(hoy);
  necesidades.animo = limitar(necesidades.animo + 10);
  if (vista) vista.webview.postMessage({ tipo: 'accion', accion: 'festejarPomodoro' });
  vscode.window.showInformationMessage(
    '🐨🧪 ' + (hoy === 1 ? t('¡Experimento terminado! Llevas 1 pomodoro hoy. Descansa {0} min.', descanso)
      : t('¡Experimento terminado! Llevas {0} pomodoros hoy. Descansa {1} min.', hoy, descanso)), t('Saltar descanso')
  ).then((r) => { if (r) pomodoro.iniciarFase('enfoque'); });
}
function alTerminarDescanso() {
  vscode.window.showInformationMessage('🐨 ' + t('Se acabó el descanso. ¿Otro experimento?'), t('Iniciar')).then((r) => {
    if (r) pomodoro.iniciarFase('enfoque');
  });
}

// ---------- Sincronización entre ventanas, editores y la cuenta de GitHub ----------
// Ajustes del koala (clima, cumpleaños, pomodoro…): se copian entre editores que no comparten settings.json
// (p. ej. VS Code y Antigravity). Solo los que pusiste tú (valor global), no los de cada carpeta.
let clavesAjustes = [];
let aplicandoAjustesHasta = 0;
function leerAjustes() {
  const a = {};
  for (const k of clavesAjustes) {
    const v = config().inspect(k);
    if (v && v.globalValue !== undefined) a[k] = v.globalValue;
  }
  return a;
}
async function aplicarAjustes() {
  const a = contexto.globalState.get('koala.ajustes') || {};
  aplicandoAjustesHasta = Date.now() + 3000;
  for (const k of clavesAjustes) {
    const v = config().inspect(k);
    const local = v ? v.globalValue : undefined;
    if (JSON.stringify(local) === JSON.stringify(a[k])) continue;
    try { await config().update(k, a[k], vscode.ConfigurationTarget.Global); } catch (e) { /* ajuste de solo lectura */ }
  }
  aplicandoAjustesHasta = Date.now() + 1500;
  contexto.globalState.update('koala.ajustesVistos', leerAjustes());
}
function publicarAjustes() {
  const a = leerAjustes();
  compartido.update('koala.ajustes', a);
  contexto.globalState.update('koala.ajustesVistos', a); // lo último que este editor sincronizó
}
// Solo una ventana configura el monitor (si no, varias escribirían ~/.claude/settings.json a la vez).
function ofrecerMonitor() {
  if (configurador && lider && lider.esLider()) configurador.ofrecerConfiguracion();
}

function alCambiarCompartido(claves) {
  if (claves.includes(CLAVE_ESTADO)) recargarEstado();
  if (claves.includes('koala.pomodoro') && pomodoro) pomodoro.recargar();
  if (claves.includes('koala.alarmas') && alarmas) alarmas.recargar();
  if (claves.some((k) => CLAVES_RUTINA.includes(k)) && rutina) rutina.recargar();
  if (claves.includes('koala.ajustes')) aplicarAjustes();
  if (claves.includes('koala.lugarClima')) medirClima().then(enviarEstado);
  if (claves.includes('koala.monitorAceptado')) ofrecerMonitor();
  enviarEstado();
}

let esperaNube = null;
function alGuardarCompartido() {
  if (!nube || !config().get('sincronizarConGitHub', false)) return;
  clearTimeout(esperaNube);
  esperaNube = setTimeout(() => nube.sincronizar(false), 20000); // junta varios cambios en una subida
}

function estadoSincronizacion() {
  const e = nube && nube.estado();
  return {
    github: config().get('sincronizarConGitHub', false),
    cuenta: e ? e.cuenta : '',
    ultima: e ? e.cuando : null,
    error: e ? e.error : null,
    lider: lider ? lider.esLider() : true,
  };
}

async function sincronizarCuentaComando() {
  if (config().get('sincronizarConGitHub', false)) {
    const e = nube.estado();
    const detalle = e && e.error ? t('Último intento: {0}', e.error)
      : e ? t('Cuenta {0} · última sincronización {1}', e.cuenta || 'GitHub', new Date(e.cuando).toLocaleTimeString()) : '';
    const r = await vscode.window.showQuickPick([
      { label: '$(sync) ' + t('Sincronizar ahora'), id: 'ahora', detail: detalle },
      { label: '$(debug-disconnect) ' + t('Dejar de sincronizar con GitHub'), id: 'apagar' },
    ], { placeHolder: t('El koala se sincroniza con tu cuenta de GitHub') });
    if (!r) return;
    if (r.id === 'apagar') {
      await config().update('sincronizarConGitHub', false, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage('🐨 ' + t('Listo: ya no se sincroniza con GitHub. Las ventanas de esta computadora siguen compartiendo el koala.'));
      return;
    }
    const fin = await nube.sincronizar(true);
    if (fin && fin.error) vscode.window.showWarningMessage('🐨 ' + t('No se pudo sincronizar: {0}', fin.error));
    else vscode.window.showInformationMessage('🐨 ' + t('Sincronizado con tu cuenta de GitHub.'));
    return;
  }
  const r = await vscode.window.showInformationMessage(
    t('El koala guardará su estado (ánimo, pomodoro, alarmas, logros, ajustes y que ya aceptaste el monitor) en un Gist privado de tu cuenta de GitHub. Así es el mismo en otras computadoras, servidores por SSH y otros editores. No sube tus conversaciones ni tu consumo.'),
    { modal: true }, t('Iniciar sesión con GitHub'));
  if (!r) return;
  try {
    if (!(await nube.conectar(true))) return;
  } catch (e) {
    vscode.window.showErrorMessage('🐨 ' + e.message);
    return;
  }
  await config().update('sincronizarConGitHub', true, vscode.ConfigurationTarget.Global);
  const fin = await nube.sincronizar(true);
  if (fin && fin.error) vscode.window.showWarningMessage('🐨 ' + t('No se pudo sincronizar: {0}', fin.error));
  else vscode.window.showInformationMessage('🐨 ' + t('Listo: el koala se sincroniza con la cuenta de GitHub {0}. En otra computadora o servidor, usa este mismo comando.', nube.cuenta()));
  enviarEstado();
}

// ---------- Activación ----------
function activate(ctx) {
  idioma.configurarIdioma(config().get('idioma', 'auto'), vscode.env.language);
  ctx.globalState.setKeysForSync([CLAVE_ESTADO, 'koala.logros', 'koala.contadores', 'koala.alarmas', 'koala.carruseles']); // ánimo, saciedad y energía viajan con Settings Sync
  const propiedades = ((((ctx.extension || {}).packageJSON || {}).contributes || {}).configuration || {}).properties || {};
  clavesAjustes = Object.keys(propiedades)
    .map((k) => k.replace('koalaCientifico.', ''))
    .filter((k) => k !== 'sincronizarConGitHub'); // se activa en cada editor (necesita iniciar sesión ahí)
  compartido = crearCompartido({
    ruta: RUTA_COMPARTIDO, globalState: ctx.globalState, claves: CLAVES_COMPARTIDAS,
    alCambiar: alCambiarCompartido, alGuardar: alGuardarCompartido,
  });
  // Los módulos usan contexto.globalState como siempre, pero ahora es el compartido. Objeto propio y no un Proxy:
  // en VS Code, globalState es una propiedad fija del contexto y un Proxy no puede devolver otra cosa.
  contexto = {
    globalState: compartido,
    subscriptions: ctx.subscriptions,
    extensionUri: ctx.extensionUri,
    extensionPath: ctx.extensionPath,
    extension: ctx.extension,
  };
  lider = crearLider({ ruta: RUTA_LIDER, id: `${vscode.env.sessionId}-${process.pid}`, enfocado: () => vscode.window.state.focused });
  ctx.subscriptions.push(vscode.window.onDidChangeWindowState((e) => { if (e.focused) lider.latido(); }));
  ctx.subscriptions.push({ dispose() { compartido.cerrar(); lider.cerrar(); } });
  // Ajustes: si aquí no cambió nada desde la última vez, se adoptan los de los otros editores; si los
  // cambiaste con este editor cerrado (o no hay de nadie), estos se vuelven los compartidos.
  const vistos = ctx.globalState.get('koala.ajustesVistos');
  const hayCompartidos = (compartido.todo().ts['koala.ajustes'] || 0) > 1;
  if (hayCompartidos && (vistos === undefined || JSON.stringify(vistos) === JSON.stringify(leerAjustes()))) aplicarAjustes();
  else publicarAjustes();
  nube = crearNube({ compartido, config, esLider: () => lider.esLider(), alEstado: () => enviarEstado() });
  cargarEstado();
  configurador = crearConfigurador({
    extensionPath: ctx.extensionPath, globalState: compartido, dirClaude: DIR_CLAUDE,
    // Una vez que lo aceptas (en cualquier equipo), en cada servidor SSH o computadora nueva se configura solo.
    automatico: () => !!compartido.get('koala.monitorAceptado') || config().get('configurarMonitorSolo', false),
    alConfigurar: () => {
      if (!compartido.get('koala.monitorAceptado')) compartido.update('koala.monitorAceptado', true);
      if (!config().get('configurarMonitorSolo', false)) config().update('configurarMonitorSolo', true, vscode.ConfigurationTarget.Global);
    },
  });
  pomodoro = crearPomodoro({
    contexto,
    minutos: minutosDe,
    antesDeLargo: () => config().get('pomodoro.antesDeDescansoLargo', 4),
    alCambiar: () => {
      if (pomodoro.fase() === 'enfoque' && durmiendo) { durmiendo = false; guardarEstado(); }
      enviarEstado();
    },
    alTerminarEnfoque,
    alTerminarDescanso,
  });

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
    await consumo.escanearTranscripciones();
    const r = await vscode.window.showInformationMessage(textoConsumo(resumenUso()), { modal: true }, t('Abrir panel'));
    if (r) mostrarPanel();
  });
  comando('koalaCientifico.configurar', () => configurador.configurarMonitor());
  comando('koalaCientifico.sincronizarCuenta', sincronizarCuentaComando);
  comando('koalaCientifico.pomodoro', () => pomodoro.alternar());
  comando('koalaCientifico.agregarServicio', agregarServicio);
  comando('koalaCientifico.consultarAnthropic', () => (config().get('usoDesdeAnthropic', false) ? consultarAnthropic(true) : activarApi()));
  comando('koalaCientifico.pomodoroDetener', () => pomodoro.detener());

  const barraPomodoro = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 89);
  barraPomodoro.command = 'koalaCientifico.pomodoro';
  ctx.subscriptions.push(barraPomodoro);
  pomodoro.usarBarra(barraPomodoro);

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
    // Lo que cambies a mano se copia a los demás editores (lo que llega de ellos no se reenvía).
    if (e.affectsConfiguration('koalaCientifico') && Date.now() > aplicandoAjustesHasta) publicarAjustes();
    if (e.affectsConfiguration('koalaCientifico.sincronizarConGitHub')) nube.sincronizar(true).then(enviarEstado);
    if (e.affectsConfiguration('koalaCientifico.idioma')) {
      idioma.configurarIdioma(config().get('idioma', 'auto'), vscode.env.language);
      if (vista) vista.webview.html = htmlVista(vista.webview, contexto.extensionUri);
    } else if (e.affectsConfiguration('koalaCientifico.servicios')) medirServicios();
    else if (e.affectsConfiguration('koalaCientifico.clima')) medirClima().then(enviarEstado);
    else if (e.affectsConfiguration('koalaCientifico.usoDesdeAnthropic')) consultarAnthropic(true);
    else if (e.affectsConfiguration('koalaCientifico')) actualizarConsumo();
  }));

  // Claude Code: estado del turno y consumo.
  fs.watchFile(RUTA_ESTADO_CLAUDE, { interval: 1000 }, leerEstadoClaude);
  fs.watchFile(RUTA_USO, { interval: 2000 }, leerUsoOficial);
  leerEstadoClaude();
  leerUsoOficial();
  consumo.escanearTranscripciones();

  // Si el monitor ya está configurado, mantener los scripts al día con esta versión.
  if (fs.existsSync(configurador.DIR_SCRIPTS)) {
    try { configurador.copiarScripts(); } catch (e) { /* sin permisos: se usan los anteriores */ }
  }

  const reloj = setInterval(tick, 15 * 1000);
  const relojActividad = setInterval(() => { revisarInactividad(); pomodoro.revisar(Date.now(), lider.esLider()); contarActivo(); }, 1000);
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
  setTimeout(ofrecerMonitor, 8000);
  rutina = crearRutina({
    contexto,
    animar,
    notificar: (t) => vscode.window.showInformationMessage(t),
    config,
  });
  medirClima().then(enviarEstado);
  const relojRutina = setInterval(revisarRutina, 15000);
  const relojClima = setInterval(() => medirClima().then(enviarEstado), 15 * 60000);
  ctx.subscriptions.push({ dispose() { clearInterval(relojRutina); clearInterval(relojClima); } });
  comando('koalaCientifico.agua', () => { rutina.agua(); enviarEstado(); });
  comando('koalaCientifico.elegirCiudad', elegirCiudad);
  comando('koalaCientifico.invitarVisitante', invitarVisitante);
  alarmas = crearAlarmas({ contexto, alSonar: alSonarAlarma });
  comando('koalaCientifico.nuevaAlarma', nuevaAlarmaComando);
  comando('koalaCientifico.alarmas', verAlarmasComando);
  const relojAlarmas = setInterval(() => alarmas.revisar(new Date(), lider.esLider()), 5000);
  setTimeout(() => alarmas.revisar(new Date(), lider.esLider()), 6000); // las atrasadas, cuando el panel ya pudo abrir
  // Cuenta de GitHub (si la activaste): al abrir y cada 2 min; los cambios de aquí se suben a los 20 s.
  setTimeout(() => nube.sincronizar(true), 2000);
  const relojNube = setInterval(() => nube.sincronizar(false), 2 * 60000);
  ctx.subscriptions.push({ dispose() { clearInterval(relojNube); clearTimeout(esperaNube); } });
  ctx.subscriptions.push({ dispose() { clearInterval(relojAlarmas); } });
  // Commits y pushes: el koala festeja (y se alegra: más ánimo).
  monitor.vigilarGit(alEventoGit).then((d) => ctx.subscriptions.push(d), () => {});
  const relojUso = setInterval(consumo.escanearTranscripciones, 60 * 1000);
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
