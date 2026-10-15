'use strict';
// Mediciones del entorno para el Koala científico: servidor, servicios, git y errores del proyecto.
// Sin dependencias: solo os, fs, http(s) y la API de VS Code.

const vscode = require('vscode');
const os = require('os');
const fs = require('fs');
const http = require('http');
const https = require('https');

// ---------- Servidor ----------
let cpuPrevio = null;
function usoCpu() {
  const t = os.cpus().reduce((a, c) => {
    const tot = Object.values(c.times).reduce((x, y) => x + y, 0);
    return { ocupado: a.ocupado + tot - c.times.idle, total: a.total + tot };
  }, { ocupado: 0, total: 0 });
  let pct = null;
  if (cpuPrevio && t.total > cpuPrevio.total) {
    pct = (100 * (t.ocupado - cpuPrevio.ocupado)) / (t.total - cpuPrevio.total);
  }
  cpuPrevio = t;
  return pct;
}

function memoria() {
  const total = os.totalmem();
  let libre = os.freemem();
  try {
    // En Linux, MemAvailable cuenta la caché que se puede liberar (freemem la da por ocupada).
    const m = /MemAvailable:\s+(\d+)/.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    if (m) libre = Number(m[1]) * 1024;
  } catch (e) { /* no es Linux */ }
  return { total, usada: total - libre, pct: (100 * (total - libre)) / total };
}

async function disco(ruta) {
  if (!fs.promises.statfs) return null;
  try {
    const s = await fs.promises.statfs(ruta);
    const total = s.blocks * s.bsize;
    const libre = s.bavail * s.bsize;
    return { ruta, total, usada: total - libre, pct: (100 * (total - libre)) / total };
  } catch (e) {
    return null;
  }
}

// Temperatura del procesador (°C) en Linux; null si el sistema no la expone (Windows, macOS, VMs).
function temperatura() {
  let max = null;
  const leer = (ruta) => {
    try {
      const v = Number(fs.readFileSync(ruta, 'utf8')) / 1000;
      if (v > 0 && v < 130) max = max === null ? v : Math.max(max, v);
    } catch (e) { /* sensor ilegible */ }
  };
  try {
    for (const z of fs.readdirSync('/sys/class/thermal')) if (z.startsWith('thermal_zone')) leer(`/sys/class/thermal/${z}/temp`);
  } catch (e) { /* no es Linux */ }
  if (max === null) {
    try {
      for (const h of fs.readdirSync('/sys/class/hwmon')) leer(`/sys/class/hwmon/${h}/temp1_input`);
    } catch (e) { /* sin hwmon */ }
  }
  return max === null ? null : Math.round(max);
}

// Clima real con Open-Meteo (gratis, sin cuenta). Solo si el usuario escribe su ciudad.
let lugarClima = null; // { ciudad, lat, lon, nombre }
function pedirJson(url) {
  return new Promise((resolver) => {
    const req = https.get(url, { timeout: 8000, headers: { 'User-Agent': 'koala-cientifico' } }, (res) => {
      let t = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (t.length < 100000) t += d; });
      res.on('end', () => { try { resolver(res.statusCode === 200 ? JSON.parse(t) : null); } catch (e) { resolver(null); } });
    });
    req.on('timeout', () => { req.destroy(); resolver(null); });
    req.on('error', () => resolver(null));
  });
}
// Ciudades que coinciden con un texto (para que el usuario elija la suya).
async function buscarCiudades(texto) {
  const g = await pedirJson(`https://geocoding-api.open-meteo.com/v1/search?count=8&language=es&name=${encodeURIComponent(String(texto).trim())}`);
  return ((g && g.results) || []).map((r) => ({
    nombre: r.name, region: [r.admin1, r.country].filter(Boolean).join(', '), lat: r.latitude, lon: r.longitude,
  }));
}

// `lugar` puede ser un lugar ya elegido { nombre, lat, lon } o el texto de una ciudad (se usa la primera coincidencia).
async function clima(lugar) {
  if (lugar && typeof lugar === 'object' && Number.isFinite(lugar.lat)) {
    lugarClima = { ciudad: `${lugar.lat},${lugar.lon}`, lat: lugar.lat, lon: lugar.lon, nombre: lugar.nombre };
    lugar = lugarClima.ciudad;
  }
  const ciudad = String(lugar || '').trim();
  if (!ciudad) return null;
  if (!lugarClima || lugarClima.ciudad !== ciudad) {
    const g = await pedirJson(`https://geocoding-api.open-meteo.com/v1/search?count=1&language=es&name=${encodeURIComponent(ciudad)}`);
    const r = g && g.results && g.results[0];
    if (!r) return { error: `No encontré "${ciudad}"` };
    lugarClima = { ciudad, lat: r.latitude, lon: r.longitude, nombre: r.name };
  }
  const d = await pedirJson(`https://api.open-meteo.com/v1/forecast?latitude=${lugarClima.lat}&longitude=${lugarClima.lon}` +
    '&current=temperature_2m,weather_code,is_day,precipitation&timezone=auto');
  if (!d || !d.current) return { error: 'Sin respuesta del servicio del clima', nombre: lugarClima.nombre };
  const c = d.current.weather_code;
  // Códigos WMO: 0 despejado, 1–3 nubes, 45–48 niebla, 51–67 y 80–82 lluvia, 71–77 y 85–86 nieve, 95–99 tormenta.
  const tipo = c >= 95 ? 'tormenta' : (c >= 71 && c <= 77) || c === 85 || c === 86 ? 'nieve'
    : (c >= 51 && c <= 67) || (c >= 80 && c <= 82) ? 'lluvia' : c >= 45 && c <= 48 ? 'niebla' : c >= 2 ? 'nublado' : 'despejado';
  return { nombre: lugarClima.nombre, temp: Math.round(d.current.temperature_2m), tipo, codigo: c, ts: Date.now() };
}

async function leerSistema() {
  const discos = [];
  const vistos = new Set();
  for (const ruta of ['/', os.homedir()]) {
    const d = await disco(ruta);
    if (!d) continue;
    const clave = `${d.total}:${d.usada}`; // misma partición = mismos números
    if (vistos.has(clave)) continue;
    vistos.add(clave);
    discos.push(d);
  }
  return {
    host: os.hostname(),
    cpu: usoCpu(),
    nucleos: os.cpus().length,
    carga: os.loadavg()[0],
    memoria: memoria(),
    discos,
    encendido: os.uptime(),
    temperatura: temperatura(),
  };
}

// ---------- Servicios ----------
function sondear(url, ms) {
  return new Promise((resolver) => {
    const inicio = Date.now();
    let mod;
    try {
      mod = new URL(url).protocol === 'https:' ? https : http;
    } catch (e) {
      resolver({ ok: false, detalle: 'dirección inválida' });
      return;
    }
    const req = mod.get(url, { timeout: ms, rejectUnauthorized: false }, (res) => {
      res.resume();
      const ok = res.statusCode < 500;
      resolver({ ok, codigo: res.statusCode, ms: Date.now() - inicio, detalle: ok ? `${res.statusCode}` : `error ${res.statusCode}` });
    });
    req.on('timeout', () => { req.destroy(); resolver({ ok: false, detalle: 'no responde' }); });
    req.on('error', (e) => resolver({ ok: false, detalle: e.code === 'ECONNREFUSED' ? 'apagado' : (e.code || 'error') }));
  });
}

async function revisarServicios(lista) {
  return Promise.all((lista || []).filter((s) => s && s.url).map(async (s) => ({
    nombre: s.nombre || s.url, url: s.url, ...(await sondear(s.url, 5000)),
  })));
}

// ---------- Git ----------
function apiGit() {
  const ext = vscode.extensions.getExtension('vscode.git');
  if (!ext || !ext.isActive || !ext.exports || !ext.exports.getAPI) return null;
  try { return ext.exports.getAPI(1); } catch (e) { return null; }
}

function diaLocal(d) {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

// Días seguidos con commits (de cualquier repo), contando hasta hoy o hasta ayer si hoy aún no hay.
function racha(repos) {
  const dias = new Set();
  for (const r of repos || []) for (const d of r.dias || []) dias.add(d);
  const cursor = new Date();
  const hoy = dias.has(diaLocal(cursor));
  if (!hoy) cursor.setDate(cursor.getDate() - 1);
  let n = 0;
  while (dias.has(diaLocal(cursor))) { n++; cursor.setDate(cursor.getDate() - 1); }
  return { dias: n, hoy };
}

async function resumenGit() {
  const git = apiGit();
  if (!git) return null;
  const inicioDia = new Date();
  inicioDia.setHours(0, 0, 0, 0);
  const repos = [];
  for (const r of git.repositories.slice(0, 4)) {
    const st = r.state;
    let commitsHoy = 0, ultimo = null;
    const dias = new Set(); // días (locales) con commits tuyos, para la racha
    let correo = '';
    try { correo = String((await r.getConfig('user.email')) || '').toLowerCase(); } catch (e) { /* sin correo configurado */ }
    try {
      const log = await r.log({ maxEntries: 400 });
      for (const c of log) {
        const f = c.commitDate || c.authorDate;
        if (!f) continue;
        if (!ultimo || f > ultimo) ultimo = f;
        if (f >= inicioDia) commitsHoy++;
        if (!correo || String(c.authorEmail || '').toLowerCase() === correo) dias.add(diaLocal(c.authorDate || f));
      }
    } catch (e) { /* repo sin commits */ }
    repos.push({
      nombre: require('path').basename(r.rootUri.fsPath),
      rama: st.HEAD ? st.HEAD.name || (st.HEAD.commit || '').slice(0, 7) : '',
      cambios: st.workingTreeChanges.length + st.indexChanges.length + (st.untrackedChanges ? st.untrackedChanges.length : 0),
      porSubir: st.HEAD && st.HEAD.ahead ? st.HEAD.ahead : 0,
      commitsHoy,
      ultimoCommit: ultimo ? ultimo.getTime() : null,
      dias: [...dias],
    });
  }
  return repos;
}

// Avisa de commits nuevos y de pushes en cualquier repositorio abierto.
// Commit = HEAD avanza en la misma rama con un commit reciente (no un pull de algo viejo).
// Push = el HEAD no cambia y los commits "por subir" bajan a 0.
async function vigilarGit(avisar) {
  const ext = vscode.extensions.getExtension('vscode.git');
  if (!ext) return { dispose() {} };
  try { await ext.activate(); } catch (e) { return { dispose() {} }; }
  if (!ext.exports || !ext.exports.getAPI) return { dispose() {} };
  const git = ext.exports.getAPI(1);
  const subs = [];
  const seguir = (r) => {
    const foto = () => {
      const h = r.state.HEAD || {};
      return { rama: h.name, commit: h.commit, ahead: h.ahead || 0, upstream: !!h.upstream };
    };
    let previa = foto();
    subs.push(r.state.onDidChange(async () => {
      const antes = previa;
      const ahora = foto();
      previa = ahora;
      if (!antes.commit || !ahora.commit || antes.rama !== ahora.rama) return;
      const repo = require('path').basename(r.rootUri.fsPath);
      if (ahora.commit !== antes.commit) {
        try {
          const c = await r.getCommit(ahora.commit);
          const fecha = c.commitDate || c.authorDate;
          const reciente = fecha && Date.now() - fecha.getTime() < 5 * 60000;
          const hijo = (c.parents || []).includes(antes.commit) || (c.parents || []).length === 1; // también un amend
          const propio = !ahora.upstream || ahora.ahead > 0;
          if (reciente && hijo && propio) avisar({ tipo: 'commit', repo, mensaje: (c.message || '').split('\n')[0] });
        } catch (e) { /* commit ilegible: sin festejo */ }
      } else if (antes.ahead > 0 && ahora.ahead === 0 && ahora.upstream) {
        avisar({ tipo: 'push', repo, cuantos: antes.ahead });
      }
    }));
  };
  git.repositories.forEach(seguir);
  subs.push(git.onDidOpenRepository(seguir));
  return { dispose() { subs.forEach((d) => d.dispose()); } };
}

// ---------- Errores del proyecto ----------
function diagnosticos() {
  let errores = 0, avisos = 0, archivos = 0;
  for (const [uri, lista] of vscode.languages.getDiagnostics()) {
    if (uri.scheme !== 'file') continue;
    let cuenta = false;
    for (const d of lista) {
      if (d.severity === vscode.DiagnosticSeverity.Error) { errores++; cuenta = true; }
      else if (d.severity === vscode.DiagnosticSeverity.Warning) { avisos++; cuenta = true; }
    }
    if (cuenta) archivos++;
  }
  return { errores, avisos, archivos };
}

module.exports = { clima, buscarCiudades, leerSistema, revisarServicios, resumenGit, diagnosticos, apiGit, vigilarGit, racha };
