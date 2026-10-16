'use strict';
// Pruebas de la lógica sin VS Code: node --test pruebas/
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

// Los módulos piden 'vscode' aunque estas funciones no lo usan.
const cargar = Module._load;
Module._load = function (req, ...r) { return req === 'vscode' ? {} : cargar.call(this, req, ...r); };
const raiz = path.join(__dirname, '..');
const alarmas = require(path.join(raiz, 'alarmas.js'));

const enFecha = (anio, mes, dia, h, m) => new Date(anio, mes - 1, dia, h, m, 0, 0);
const memoria = () => { const m = new Map(); return { get: (k) => m.get(k), update: (k, v) => { m.set(k, v); return Promise.resolve(); } }; };

test('alarmas: hora válida e inválida', () => {
  assert.equal(alarmas.minutosDelDia('09:15'), 555);
  assert.equal(alarmas.minutosDelDia('24:00'), null);
  assert.equal(alarmas.minutosDelDia('9.15'), null);
});

test('alarmas: repetición por día de la semana', () => {
  const lunes = enFecha(2026, 10, 12, 9, 0), sabado = enFecha(2026, 10, 17, 9, 0);
  assert.equal(alarmas.tocaHoy({ repeticion: 'laborables' }, lunes), true);
  assert.equal(alarmas.tocaHoy({ repeticion: 'laborables' }, sabado), false);
  assert.equal(alarmas.tocaHoy({ repeticion: [6] }, sabado), true);
  assert.equal(alarmas.tocaHoy({ repeticion: 'una', fecha: '2026-10-12' }, lunes), true);
  assert.equal(alarmas.tocaHoy({ repeticion: 'una', fecha: '2026-10-13' }, lunes), false);
});

test('alarmas: suena a tiempo, atrasada hasta 60 min y una sola vez al día', () => {
  const a = { activa: true, repeticion: 'diaria', hora: '14:30', ultimaVez: null };
  assert.equal(alarmas.debeSonar(a, enFecha(2026, 10, 15, 14, 29)), null);
  assert.equal(alarmas.debeSonar(a, enFecha(2026, 10, 15, 14, 30)), 0);
  assert.equal(alarmas.debeSonar(a, enFecha(2026, 10, 15, 15, 10)), 40);
  assert.equal(alarmas.debeSonar(a, enFecha(2026, 10, 15, 15, 31)), null);
  assert.equal(alarmas.debeSonar({ ...a, ultimaVez: '2026-10-15' }, enFecha(2026, 10, 15, 14, 35)), null);
  assert.equal(alarmas.debeSonar({ ...a, activa: false }, enFecha(2026, 10, 15, 14, 30)), null);
});

test('alarmas: "una vez" es hoy o mañana según la hora', () => {
  const ahora = enFecha(2026, 10, 15, 12, 0);
  assert.equal(alarmas.fechaParaUnaVez('13:00', ahora), '2026-10-15');
  assert.equal(alarmas.fechaParaUnaVez('11:00', ahora), '2026-10-16');
});

test('alarmas: crear, sonar, apagar la de una vez y posponer', () => {
  const sonadas = [];
  const g = memoria();
  const al = alarmas.crearAlarmas({ contexto: { globalState: g }, alSonar: (a, atraso, pospuesta) => sonadas.push([a.mensaje, atraso, !!pospuesta]) });
  const ahora = new Date();
  const enUnMin = new Date(ahora.getTime() + 60000);
  const hora = `${String(enUnMin.getHours()).padStart(2, '0')}:${String(enUnMin.getMinutes()).padStart(2, '0')}`;
  if (enUnMin.getDate() !== ahora.getDate()) return; // justo a medianoche: se omite
  const a = al.crear({ hora, mensaje: 'Prueba', repeticion: 'una' });
  al.revisar(ahora);
  assert.equal(sonadas.length, 0, 'aún no es hora');
  al.revisar(enUnMin);
  assert.deepEqual(sonadas[0], ['Prueba', 0, false]);
  assert.equal(g.get('koala.alarmas')[0].activa, false, 'la de una vez se apaga sola');
  al.revisar(enUnMin);
  assert.equal(sonadas.length, 1, 'no suena dos veces');
  al.posponer(a, 0);
  al.revisar(enUnMin);
  assert.deepEqual(sonadas[1], ['Prueba', 0, true]);
  assert.throws(() => al.crear({ hora: '25:00', mensaje: 'x', repeticion: 'diaria' }));
});

test('alarmas: una diaria creada con la hora ya pasada no suena de inmediato', () => {
  const sonadas = [];
  const al = alarmas.crearAlarmas({ contexto: { globalState: memoria() }, alSonar: (a) => sonadas.push(a) });
  const ahora = new Date();
  if (ahora.getHours() === 0 && ahora.getMinutes() < 2) return;
  const antes = new Date(ahora.getTime() - 60000);
  al.crear({ hora: `${String(antes.getHours()).padStart(2, '0')}:${String(antes.getMinutes()).padStart(2, '0')}`, mensaje: 'x', repeticion: 'diaria' });
  al.revisar(ahora);
  assert.equal(sonadas.length, 0);
});

// ---------- costos ----------
const costos = require(path.join(raiz, 'costos.js'));

test('costos: precio por modelo y costo de un mensaje', () => {
  assert.equal(costos.precioDe('claude-opus-5-5')[4], 'Opus 5.5');
  assert.equal(costos.precioDe('claude-sonnet-5-5')[4], 'Sonnet 5.5');
  assert.equal(costos.precioDe('claude-opus-5')[4], 'Opus 5');
  assert.equal(costos.precioDe('modelo-nuevo')[4], 'Opus 5.5', 'un modelo desconocido se estima como Opus 5.5');
  // Opus 5.5: 1 M de entrada = $4, 1 M de salida = $20, 1 M de lectura de caché = $0.20, escritura 5 min = 1.25×
  const u = { input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 1e6 };
  assert.equal(Math.round(costos.medirMensaje(u, 'claude-opus-5-5').usd * 100) / 100, 4 + 20 + 0.2 + 5);
  assert.equal(Math.round(costos.medirMensaje({ ...u, speed: 'fast' }, 'claude-opus-5-5').usd * 100) / 100, 2 * 29.2, 'el modo rápido cuesta el doble');
  const unaHora = { cache_creation_input_tokens: 1e6, cache_creation: { ephemeral_1h_input_tokens: 1e6, ephemeral_5m_input_tokens: 0 } };
  assert.equal(costos.medirMensaje(unaHora, 'claude-opus-5-5').usd, 8, 'escritura de 1 h = 2×');
});

// ---------- consumo ----------
const consumo = require(path.join(raiz, 'consumo.js'));

test('consumo: nombres de modelo y formatos', () => {
  assert.equal(consumo.nombreModelo('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(consumo.nombreModelo('claude-haiku-4-5-20251001'), 'Haiku 4.5');
  assert.equal(consumo.formatoTokens(1234567), '1.2 M');
  assert.equal(consumo.formatoTokens(4200), '4 mil');
  assert.equal(consumo.duracionTexto(200000), '3 min 20 s');
});

test('consumo: ventanas vigentes y reiniciadas', () => {
  const ahora = Date.now();
  assert.deepEqual(consumo.ventanaVigente({ pct: 40, resets_at: Math.round(ahora / 1000) - 10 }), { pct: 0, reinicio: null, reiniciada: true });
  assert.equal(consumo.ventanaVigente({ pct: 40, resets_at: Math.round(ahora / 1000) + 3600 }).pct, 40);
  assert.equal(consumo.ventanaVigente(null), null);
  const finVentana = Math.round(ahora / 1000) + 3600;
  assert.equal(consumo.inicioVentana({ resets_at: finVentana }, consumo.CINCO_HORAS), finVentana * 1000 - consumo.CINCO_HORAS);
});

function lineaDe({ id, t, modelo = 'claude-opus-5-5', entrada = 10, salida = 100, leidos = 0, cwd = '/x/proyecto', herramienta }) {
  return JSON.stringify({
    timestamp: new Date(t).toISOString(), cwd,
    message: { id, model: modelo, usage: { input_tokens: entrada, output_tokens: salida, cache_read_input_tokens: leidos },
      content: herramienta ? [{ type: 'tool_use', id: 'tu_' + id, name: herramienta }] : [] },
  });
}

test('consumo: cuenta cada mensaje una vez y separa sesión, semana y hoy', () => {
  const ahora = Date.now();
  const c = consumo.crearConsumo({ dirProyectos: '/no/existe' });
  const limite = ahora - consumo.TREINTA_DIAS;
  c.procesarLinea(lineaDe({ id: 'a', t: ahora - 60000, herramienta: 'Bash' }), limite);
  c.procesarLinea(lineaDe({ id: 'a', t: ahora - 60000 }), limite); // misma respuesta en otra línea
  c.procesarLinea(lineaDe({ id: 'b', t: ahora - 2 * 86400000, modelo: 'claude-sonnet-5-5' }), limite);
  c.procesarLinea(lineaDe({ id: 'c', t: ahora - 40 * 86400000 }), limite); // más vieja que 30 días
  c.procesarLinea('no es json', limite);
  assert.equal(c.mensajes.size, 2);
  c.calcularUsoLocal();
  assert.equal(c.usoLocal().mensajes5h, 1);
  assert.equal(c.usoLocal().mensajes7d, 2);
  assert.equal(c.usoLocal().tokens5h, 110);
  const hoy = c.resumenHoy();
  if (new Date(ahora - 60000).getDate() === new Date(ahora).getDate()) {
    assert.equal(hoy.mensajes, 1);
    assert.deepEqual(hoy.herramientas, { Bash: 1 });
    assert.deepEqual(Object.keys(hoy.proyectos), ['proyecto']);
  }
  const k = c.resumenCostos({ aguaMlPorWh: 2, planUsd: 100 });
  assert.ok(k.semana.usd > k.cinco.usd && k.cinco.usd > 0);
  assert.equal(k.planUsd, 100);
});

test('consumo: ritmo holgado o que alcanza el límite antes del corte', () => {
  const ahora = Date.now();
  const c = consumo.crearConsumo({ dirProyectos: '/no/existe' });
  for (let i = 0; i < 10; i++) c.procesarLinea(lineaDe({ id: 'r' + i, t: ahora - i * 60000, salida: 1000 }), ahora - consumo.TREINTA_DIAS);
  c.calcularUsoLocal();
  assert.equal(c.calcularRitmo(null).estado, 'sin-dato');
  // 10 mensajes (≈10 mil tokens) = 50 % en 10 min → llega al 100 % en otros 10 min: antes del corte en 2 h
  assert.equal(c.calcularRitmo({ pct: 50, reinicio: ahora + 2 * 3600e3, reiniciada: false }).estado, 'alcanza');
  // con el corte en 5 min, no alcanza a llenarse
  assert.equal(c.calcularRitmo({ pct: 50, reinicio: ahora + 5 * 60000, reiniciada: false }).estado, 'holgado');
});

// ---------- monitor: racha de commits ----------
const monitor = require(path.join(raiz, 'monitor.js'));
const dia = (atras) => { const d = new Date(); d.setDate(d.getDate() - atras); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };

test('racha: días seguidos con commits, con o sin commit hoy', () => {
  assert.deepEqual(monitor.racha([{ dias: [dia(0), dia(1), dia(2)] }]), { dias: 3, hoy: true });
  assert.deepEqual(monitor.racha([{ dias: [dia(1), dia(2)] }]), { dias: 2, hoy: false }, 'si hoy aún no hay, cuenta desde ayer');
  assert.deepEqual(monitor.racha([{ dias: [dia(0)] }, { dias: [dia(1)] }]), { dias: 2, hoy: true }, 'se suman los repos');
  assert.deepEqual(monitor.racha([{ dias: [dia(0), dia(2)] }]), { dias: 1, hoy: true }, 'un hueco corta la racha');
  assert.deepEqual(monitor.racha(null), { dias: 0, hoy: false });
});

// ---------- anthropic ----------
const anthropic = require(path.join(raiz, 'anthropic.js'));

test('anthropic: interpreta la respuesta de uso', () => {
  const r = anthropic.interpretarUso(JSON.stringify({
    five_hour: { utilization: 64, resets_at: '2030-01-01T10:00:00Z' },
    seven_day: { utilization: 31, resets_at: '2030-01-05T10:00:00Z' },
    seven_day_opus: { utilization: 44, resets_at: '2030-01-05T10:00:00Z' },
    seven_day_sonnet: null,
  }));
  assert.equal(r.five_hour.pct, 64);
  assert.equal(r.five_hour.resets_at, Date.parse('2030-01-01T10:00:00Z') / 1000);
  assert.deepEqual(r.extras.map((x) => [x.nombre, x.pct]), [['Semana · Opus', 44]]);
  assert.equal(anthropic.ventanaApi({ utilization: 'x' }), null);
  assert.ok(anthropic.tokenClaude('/no/existe').error, 'sin credenciales devuelve un error claro');
});

// ---------- rutina: logros y agua ----------
const { crearRutina, LOGROS } = require(path.join(raiz, 'rutina.js'));

test('rutina: logros por eventos y agua con meta', () => {
  const avisos = [], animaciones = [];
  const r = crearRutina({
    contexto: { globalState: memoria() },
    animar: (a, d) => animaciones.push([a, d]),
    notificar: (t) => avisos.push(t),
    config: () => ({ get: (k, d) => (k === 'metaAgua' ? 2 : d) }),
  });
  const hecho = (id) => r.estado().logros.find((l) => l.id === id).fecha !== null;
  assert.equal(r.estado().logros.length, LOGROS.length);
  r.alPomodoro(1);
  assert.ok(hecho('primer_pomodoro'));
  r.alPomodoro(10);
  assert.ok(hecho('diez_pomodoros'));
  for (let i = 0; i < 9; i++) r.alPush();
  assert.ok(!hecho('cohetero'));
  r.alPush();
  assert.ok(hecho('cohetero'));
  r.agua(); r.agua();
  assert.equal(r.estado().agua, 2);
  assert.ok(hecho('hidratado'));
  r.alCerrarVentana(80);
  assert.ok(!hecho('sesion_tranquila'), 'pasar del 50 % no cuenta');
  r.alCerrarVentana(30);
  assert.ok(hecho('sesion_tranquila'));
  const n = avisos.length;
  r.alPomodoro(1);
  assert.equal(avisos.length, n, 'un logro no se repite');
  assert.ok(animaciones.some(([a]) => a === 'tomarAgua'));
});

// ---------- pomodoro ----------
const { crearPomodoro, relojTexto } = require(path.join(raiz, 'pomodoro.js'));

test('pomodoro: enfoque, pausa, descanso y descanso largo', () => {
  const eventos = [];
  const p = crearPomodoro({
    contexto: { globalState: memoria() }, minutos: (f) => (f === 'enfoque' ? 25 : f === 'descansoLargo' ? 15 : 5),
    antesDeLargo: () => 2, alTerminarEnfoque: (hoy, min) => eventos.push(['fin', hoy, min]), alTerminarDescanso: () => eventos.push(['descansado']),
  });
  assert.equal(p.fase(), null);
  p.alternar();
  assert.equal(p.fase(), 'enfoque');
  p.alternar();
  assert.equal(p.estado().pausado, true);
  p.revisar(Date.now() + 3600e3);
  assert.equal(p.fase(), 'enfoque', 'en pausa no avanza');
  p.alternar();
  p.revisar(Date.now() + 26 * 60000);
  assert.deepEqual(eventos[0], ['fin', 1, 5]);
  assert.equal(p.fase(), 'descanso');
  p.revisar(Date.now() + 6 * 60000);
  assert.equal(p.fase(), null);
  assert.deepEqual(eventos[1], ['descansado']);
  p.iniciarFase('enfoque');
  p.revisar(Date.now() + 26 * 60000);
  assert.equal(p.fase(), 'descansoLargo', 'cada 2 pomodoros, descanso largo');
  assert.equal(p.hoy(), 2);
  assert.equal(relojTexto(65000), '1:05');
});

// ---------- configurar ----------
const { rutaComando } = require(path.join(raiz, 'configurar.js'));

test('configurar: rutas con / para cualquier consola', () => {
  assert.equal(rutaComando(['home', 'josue', '.claude', 'koala', 'x.py'].join(path.sep)), 'home/josue/.claude/koala/x.py');
});
