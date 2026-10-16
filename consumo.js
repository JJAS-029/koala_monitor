'use strict';
// Consumo de Claude Code a partir de las transcripciones locales (~/.claude/projects/**/*.jsonl):
// tokens por ventana, resumen del día, costo equivalente, huella y ritmo. Sin red.
const fs = require('fs');
const path = require('path');
const costos = require('./costos');

const HORA = 3600 * 1000;
const CINCO_HORAS = 5 * HORA;
const SIETE_DIAS = 7 * 24 * HORA;
const TREINTA_DIAS = 30 * 24 * HORA; // las transcripciones se guardan 30 días (costo del mes)

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

function nombreModelo(id) {
  const m = /claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id || '');
  if (!m) return id || '?';
  return m[1][0].toUpperCase() + m[1].slice(1) + ' ' + m[2] + (m[3] && m[3].length < 3 ? '.' + m[3] : '');
}

function inicioVentana(ventana, duracion) {
  const ahora = Date.now();
  if (ventana && ventana.resets_at && ventana.resets_at * 1000 > ahora) {
    return ventana.resets_at * 1000 - duracion;
  }
  return ahora - duracion;
}

function inicioDeHoy() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function ventanaVigente(v) {
  if (!v || typeof v.pct !== 'number') return null;
  const reinicio = v.resets_at ? v.resets_at * 1000 : null;
  if (reinicio && reinicio <= Date.now()) return { pct: 0, reinicio: null, reiniciada: true };
  return { pct: v.pct, reinicio, reiniciada: false };
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

/**
 * oficial(): dato oficial vigente ({ five_hour, seven_day, ... }), para alinear las ventanas.
 * alActualizar(): se llama al terminar cada escaneo.
 */
function crearConsumo({ dirProyectos, oficial = () => ({}), alActualizar = () => {} }) {
  const mensajes = new Map(); // id -> { t, tok, entrada, salida, creados, leidos, usd, wh, modelo, proyecto }
  const herramientas = new Map(); // id del tool_use -> { t, nombre }
  const archivosLeidos = new Map(); // ruta -> { offset, resto }
  let escaneando = false;
  let usoLocal = { tokens5h: 0, tokens7d: 0, mensajes5h: 0, mensajes7d: 0, cache5h: 0 };

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
    mensajes.set(m.id || obj.requestId || obj.uuid, {
      t, tok: entrada + salida + creados, entrada, salida, creados, leidos, usd, wh,
      modelo: nombreModelo(m.model), proyecto: obj.cwd ? path.basename(obj.cwd) : '?',
    });
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b && b.type === 'tool_use' && b.id) herramientas.set(b.id, { t, nombre: b.name || '?' });
    }
  }

  async function escanearTranscripciones() {
    if (escaneando) return;
    escaneando = true;
    try {
      const ahora = Date.now();
      const limite = ahora - TREINTA_DIAS;
      const archivos = [];
      await listarTranscripciones(dirProyectos, 4, limite, archivos);
      for (const { ruta, tam } of archivos) {
        let cache = archivosLeidos.get(ruta);
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
        archivosLeidos.set(ruta, cache);
      }
      for (const [id, msj] of mensajes) if (msj.t < limite) mensajes.delete(id);
      for (const [id, h] of herramientas) if (h.t < limite) herramientas.delete(id);
    } catch (e) {
      console.error('[koala] error al leer transcripciones', e);
    } finally {
      escaneando = false;
    }
    alActualizar();
  }

  function calcularUsoLocal() {
    const of = oficial();
    const desde5 = inicioVentana(of.five_hour, CINCO_HORAS);
    const desde7 = inicioVentana(of.seven_day, SIETE_DIAS);
    const r = { tokens5h: 0, tokens7d: 0, mensajes5h: 0, mensajes7d: 0, cache5h: 0 };
    for (const m of mensajes.values()) {
      if (m.t >= desde7) { r.tokens7d += m.tok; r.mensajes7d++; }
      if (m.t >= desde5) { r.tokens5h += m.tok; r.mensajes5h++; r.cache5h += m.leidos; }
    }
    usoLocal = r;
  }

  // Resumen del día, eficiencia de caché y mapa de calor semanal (día × hora).
  function resumenHoy() {
    const desde = inicioDeHoy();
    const r = { tokens: 0, mensajes: 0, entrada: 0, creados: 0, leidos: 0, proyectos: {}, modelos: {}, herramientas: {} };
    const mapa = Array.from({ length: 7 }, () => new Array(24).fill(0));
    for (const m of mensajes.values()) {
      const dias = Math.floor((desde - m.t) / 86400000) + 1; // 0 = hoy
      const fila = 6 - (m.t >= desde ? 0 : dias);
      if (fila >= 0 && fila < 7) mapa[fila][new Date(m.t).getHours()] += m.tok;
      if (m.t < desde) continue;
      r.tokens += m.tok; r.mensajes++;
      r.entrada += m.entrada; r.creados += m.creados; r.leidos += m.leidos;
      r.proyectos[m.proyecto] = (r.proyectos[m.proyecto] || 0) + m.tok;
      r.modelos[m.modelo] = (r.modelos[m.modelo] || 0) + m.tok;
    }
    for (const h of herramientas.values()) {
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
  function resumenCostos({ aguaMlPorWh = 2, planUsd = 0 } = {}) {
    const ahora = Date.now();
    const desde5 = inicioVentana(oficial().five_hour, CINCO_HORAS);
    const hoy = inicioDeHoy();
    const periodos = { cinco: desde5, hoy, semana: ahora - SIETE_DIAS, mes: ahora - TREINTA_DIAS };
    const r = {};
    for (const k of Object.keys(periodos)) r[k] = { usd: 0, wh: 0, tok: 0 };
    const modelosHoy = {};
    let primero = ahora;
    for (const m of mensajes.values()) {
      primero = Math.min(primero, m.t);
      for (const [k, desde] of Object.entries(periodos)) {
        if (m.t >= desde) { r[k].usd += m.usd; r[k].wh += m.wh; r[k].tok += m.tok; }
      }
      if (m.t >= hoy) modelosHoy[m.modelo] = (modelosHoy[m.modelo] || 0) + m.usd;
    }
    return {
      ...r,
      modelosHoy,
      diasMes: Math.max(1, Math.min(30, Math.ceil((ahora - primero) / 86400000))),
      aguaMlPorWh,
      planUsd,
    };
  }

  // Ritmo de los últimos 30 min proyectado sobre el % oficial de la sesión.
  function calcularRitmo(cinco) {
    const ahora = Date.now();
    let tok30 = 0;
    for (const m of mensajes.values()) if (m.t >= ahora - 30 * 60000) tok30 += m.tok;
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

  return {
    escanearTranscripciones, procesarLinea, calcularUsoLocal, resumenHoy, resumenCostos, calcularRitmo,
    usoLocal: () => usoLocal, mensajes, herramientas,
  };
}

module.exports = {
  crearConsumo, nombreModelo, inicioVentana, inicioDeHoy, ventanaVigente, formatoTokens, duracionTexto,
  HORA, CINCO_HORAS, SIETE_DIAS, TREINTA_DIAS,
};
