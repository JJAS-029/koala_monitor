'use strict';
// Alarmas del koala: a una hora (HH:MM) con un mensaje; se repiten una vez, diario, entre semana o en días elegidos.
// Se guardan en globalState ('koala.alarmas') y viajan con Settings Sync.

const { t } = require('./idioma');
const DIAS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const VENTANA_ATRASADA_MIN = 60; // si VS Code estaba cerrado, avisa al abrir dentro de esta ventana

const fechaTexto = (d) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
const minutosDelDia = (hora) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hora || '').trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  return h < 24 && mi < 60 ? h * 60 + mi : null;
};

/** ¿Toca el día de `fecha` según la repetición? repeticion: 'una' | 'diaria' | 'laborables' | número[] (0 = domingo). */
function tocaHoy(alarma, fecha) {
  const r = alarma.repeticion;
  if (r === 'una') return alarma.fecha === fechaTexto(fecha);
  if (r === 'diaria') return true;
  if (r === 'laborables') return fecha.getDay() >= 1 && fecha.getDay() <= 5;
  return Array.isArray(r) && r.includes(fecha.getDay());
}

/**
 * ¿Debe sonar ahora? Suena si hoy le toca, ya pasó su hora (sin pasar de VENTANA_ATRASADA_MIN) y no sonó hoy.
 * Devuelve los minutos de atraso (0 = a tiempo) o null.
 */
function debeSonar(alarma, ahora) {
  if (!alarma.activa || !tocaHoy(alarma, ahora)) return null;
  const objetivo = minutosDelDia(alarma.hora);
  if (objetivo === null) return null;
  const actual = ahora.getHours() * 60 + ahora.getMinutes();
  const atraso = actual - objetivo;
  if (atraso < 0 || atraso > VENTANA_ATRASADA_MIN) return null;
  if (alarma.ultimaVez === fechaTexto(ahora)) return null;
  return atraso;
}

function describirRepeticion(r) {
  if (r === 'una') return t('una vez');
  if (r === 'diaria') return t('todos los días');
  if (r === 'laborables') return t('lunes a viernes');
  if (Array.isArray(r)) return r.slice().sort().map((d) => t(DIAS[d])).join(', ');
  return '';
}

/** Para alarmas de "una vez": hoy si la hora no ha pasado, si no mañana. */
function fechaParaUnaVez(hora, ahora = new Date()) {
  const objetivo = minutosDelDia(hora);
  const d = new Date(ahora);
  if (objetivo !== null && objetivo <= ahora.getHours() * 60 + ahora.getMinutes()) d.setDate(d.getDate() + 1);
  return fechaTexto(d);
}

function crearAlarmas({ contexto, alSonar }) {
  let lista = contexto.globalState.get('koala.alarmas') || [];
  const pospuestas = []; // { hasta: ms, alarma } solo en memoria
  const guardar = () => contexto.globalState.update('koala.alarmas', lista);

  // lider = false: otra ventana se encarga de sonar las alarmas (las pospuestas aquí sí suenan aquí).
  function revisar(ahora = new Date(), lider = true) {
    for (const a of lider ? lista : []) {
      const atraso = debeSonar(a, ahora);
      if (atraso === null) continue;
      a.ultimaVez = fechaTexto(ahora);
      if (a.repeticion === 'una') a.activa = false;
      guardar();
      alSonar(a, atraso);
    }
    for (let i = pospuestas.length - 1; i >= 0; i--) {
      if (Date.now() >= pospuestas[i].hasta) { const p = pospuestas.splice(i, 1)[0]; alSonar(p.alarma, 0, true); }
    }
  }

  return {
    revisar,
    recargar() { lista = contexto.globalState.get('koala.alarmas') || []; },
    lista: () => lista.map((a) => ({ ...a, texto: describirRepeticion(a.repeticion) })),
    crear({ hora, mensaje, repeticion }) {
      if (minutosDelDia(hora) === null) throw new Error(t('Hora inválida (usa HH:MM)'));
      const a = {
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        hora: hora.padStart(5, '0'), mensaje: String(mensaje || '').trim() || t('¡Es hora!'), repeticion, activa: true, ultimaVez: null,
      };
      if (repeticion === 'una') a.fecha = fechaParaUnaVez(a.hora);
      // Si se crea para hoy a una hora que ya pasó, no debe sonar de inmediato.
      const ahora = new Date();
      if (repeticion !== 'una' && minutosDelDia(a.hora) <= ahora.getHours() * 60 + ahora.getMinutes()) a.ultimaVez = fechaTexto(ahora);
      lista.push(a);
      lista.sort((x, y) => minutosDelDia(x.hora) - minutosDelDia(y.hora));
      guardar();
      return a;
    },
    alternar(id) {
      const a = lista.find((x) => x.id === id);
      if (!a) return;
      a.activa = !a.activa;
      if (a.activa && a.repeticion === 'una') a.fecha = fechaParaUnaVez(a.hora);
      guardar();
    },
    borrar(id) { lista = lista.filter((x) => x.id !== id); guardar(); },
    posponer(alarma, minutos = 5) { pospuestas.push({ hasta: Date.now() + minutos * 60000, alarma }); },
  };
}

module.exports = { crearAlarmas, debeSonar, tocaHoy, describirRepeticion, fechaParaUnaVez, minutosDelDia };
