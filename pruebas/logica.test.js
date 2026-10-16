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
