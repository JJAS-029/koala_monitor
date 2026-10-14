'use strict';
// Simula media/koala.js sin navegador: canvas falso que pinta en un búfer RGBA,
// reloj controlado y capturas PNG (zlib de node) de cada escena.
// Uso: node pruebas/simular.js [carpeta-de-salida]

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const SALIDA = process.argv[2] || path.join(__dirname, 'capturas');
fs.mkdirSync(SALIDA, { recursive: true });
const CODIGO = fs.readFileSync(path.join(__dirname, '..', 'media', 'koala.js'), 'utf8');
const DPR = 2, ANCHO = 300, ALTO = 150;

// ---------- Colores ----------
function color(txt) {
  txt = String(txt).trim();
  let m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(txt);
  if (m) {
    const n = parseInt(m[1], 16);
    return [n >> 16, (n >> 8) & 255, n & 255, m[2] ? parseInt(m[2], 16) / 255 : 1];
  }
  m = /^rgba?\(([^)]+)\)$/.exec(txt);
  if (m) {
    const p = m[1].split(',').map(Number);
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  }
  throw new Error('color no reconocido: ' + txt);
}

// ---------- PNG ----------
const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function trozo(tipo, datos) {
  const t = Buffer.from(tipo);
  const largo = Buffer.alloc(4); largo.writeUInt32BE(datos.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, datos])));
  return Buffer.concat([largo, t, datos, crc]);
}
function escribirPNG(ruta, w, h, rgba) {
  const filas = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    filas[y * (w * 4 + 1)] = 0;
    rgba.copy(filas, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  fs.writeFileSync(ruta, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    trozo('IHDR', ihdr), trozo('IDAT', zlib.deflateSync(filas)), trozo('IEND', Buffer.alloc(0)),
  ]));
}

// ---------- Entorno falso ----------
function crearEntorno(semilla) {
  const w = ANCHO * DPR, h = ALTO * DPR;
  const pix = new Float32Array(w * h * 4);
  const estadistica = { rects: 0, nan: 0, colores: new Set() };
  const ctx2d = {
    fillStyle: '#000', globalAlpha: 1,
    setTransform() {},
    clearRect() { pix.fill(0); },
    fillRect(x, y, rw, rh) {
      estadistica.rects++;
      if (![x, y, rw, rh].every(Number.isFinite)) { estadistica.nan++; return; }
      const [r, g, b, a0] = color(this.fillStyle);
      estadistica.colores.add(this.fillStyle);
      const a = a0 * this.globalAlpha;
      for (let yy = Math.max(0, y); yy < Math.min(h, y + rh); yy++) {
        for (let xx = Math.max(0, x); xx < Math.min(w, x + rw); xx++) {
          const i = (yy * w + xx) * 4;
          const ad = pix[i + 3];
          const ao = a + ad * (1 - a);
          if (ao <= 0) continue;
          pix[i] = (r * a + pix[i] * ad * (1 - a)) / ao;
          pix[i + 1] = (g * a + pix[i + 1] * ad * (1 - a)) / ao;
          pix[i + 2] = (b * a + pix[i + 2] * ad * (1 - a)) / ao;
          pix[i + 3] = ao;
        }
      }
    },
  };
  const elementos = {};
  const elemento = (id) => elementos[id] || (elementos[id] = {
    id, style: {}, textContent: '', width: 0, height: 0,
    clientWidth: ANCHO, clientHeight: ALTO,
    oyentes: {},
    getContext: () => ctx2d,
    addEventListener(t, fn) { (this.oyentes[t] = this.oyentes[t] || []).push(fn); },
    getAttribute: () => null,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    setPointerCapture() {},
  });
  const oyentes = [];
  const mensajes = [];
  let raf = null;
  const sandbox = {
    console,
    document: {
      body: {},
      getElementById: elemento,
      querySelectorAll: () => [],
    },
    acquireVsCodeApi: () => ({ postMessage: (m) => mensajes.push(m) }),
    requestAnimationFrame: (fn) => { raf = fn; },
    setInterval: () => 0,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    devicePixelRatio: DPR,
    addEventListener: (t, fn) => { if (t === 'message') oyentes.push(fn); },
  };
  sandbox.window = sandbox;
  const contexto = vm.createContext(sandbox);
  let s = semilla >>> 0;
  sandbox.__azar = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  vm.runInContext('Math.random = __azar;', contexto);
  vm.runInContext(CODIGO, contexto, { filename: 'koala.js' });

  let reloj = 0;
  const entorno = {
    w, h, pix, estadistica, mensajes, elementos,
    koala: sandbox.__koala,
    enviar(m) { for (const fn of oyentes) fn({ data: JSON.parse(JSON.stringify(m)) }); },
    avanzar(seg) {
      const cuadros = Math.round(seg * 60);
      for (let i = 0; i < cuadros; i++) { reloj += 1000 / 60; const fn = raf; raf = null; fn(reloj); }
    },
    clic(x, y) { this.puntero('pointerdown', x, y); this.puntero('pointerup', x, y); },
    puntero(tipo, x, y) { for (const fn of elemento('lienzo').oyentes[tipo] || []) fn({ clientX: x, clientY: y, pointerId: 1 }); },
    detalle() {
      // recorte de 140×90 px CSS alrededor del koala, ampliado 2× (vecino más cercano)
      const k = sandbox.__koala.k;
      const cw = 140 * DPR, ch = 90 * DPR, z = 2;
      const x0 = Math.max(0, Math.min(w - cw, Math.round((k.x - 50) * DPR)));
      const y0 = h - ch;
      const base = this.captura();
      const out = Buffer.alloc(cw * z * ch * z * 4);
      for (let y = 0; y < ch * z; y++) {
        for (let x = 0; x < cw * z; x++) {
          base.copy(out, (y * cw * z + x) * 4, ((y0 + Math.floor(y / z)) * w + x0 + Math.floor(x / z)) * 4, ((y0 + Math.floor(y / z)) * w + x0 + Math.floor(x / z)) * 4 + 4);
        }
      }
      return out;
    },
    dw: 140 * DPR * 2, dh: 90 * DPR * 2,
    captura() {
      // fondo oscuro de VS Code
      const out = Buffer.alloc(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        const a = pix[i * 4 + 3];
        out[i * 4] = Math.round(pix[i * 4] * a + 30 * (1 - a));
        out[i * 4 + 1] = Math.round(pix[i * 4 + 1] * a + 30 * (1 - a));
        out[i * 4 + 2] = Math.round(pix[i * 4 + 2] * a + 30 * (1 - a));
        out[i * 4 + 3] = 255;
      }
      return out;
    },
  };
  return entorno;
}

function hoja(nombre, cuadros, w, h) {
  const porFila = 4, sep = 4;
  const filas = Math.ceil(cuadros.length / porFila);
  const W = porFila * w + (porFila + 1) * sep, H = filas * h + (filas + 1) * sep;
  const out = Buffer.alloc(W * H * 4, 90);
  cuadros.forEach((c, i) => {
    const ox = sep + (i % porFila) * (w + sep), oy = sep + Math.floor(i / porFila) * (h + sep);
    for (let y = 0; y < h; y++) c.copy(out, ((oy + y) * W + ox) * 4, y * w * 4, (y + 1) * w * 4);
  });
  const ruta = path.join(SALIDA, nombre + '.png');
  escribirPNG(ruta, W, H, out);
  return ruta;
}

// ---------- Escenas ----------
const NECESIDADES = { saciedad: 80, animo: 80, energia: 80 };
const usoDe = (p5, p7) => ({
  cinco: p5 == null ? null : { pct: p5, reinicio: Date.now() + 2 * 3600e3, reiniciada: false },
  semana: p7 == null ? null : { pct: p7, reinicio: Date.now() + 4 * 86400e3, reiniciada: false },
  modelo: 'Opus', actualizado: Date.now(), local: { tokens5h: 1234567, tokens7d: 9876543 },
});
const estado = (extra) => Object.assign({
  tipo: 'estado', necesidades: NECESIDADES, durmiendo: false, trabajando: false, claude: false,
  uso: usoDe(30, 12), umbral: 90,
}, extra);

const errores = [];
const verificar = (ok, msg) => { if (!ok) errores.push(msg); console.log((ok ? '  ✓ ' : '  ✗ ') + msg); };

function escena(nombre, semilla, pasos) {
  console.log(nombre);
  const e = createSafe(semilla);
  const cuadros = [], detalles = [];
  const tomar = () => { cuadros.push(e.captura()); detalles.push(e.detalle()); };
  pasos(e, tomar);
  verificar(e.estadistica.nan === 0, `${nombre}: sin coordenadas NaN (${e.estadistica.rects} rectángulos)`);
  const ruta = hoja(nombre, cuadros, e.w, e.h);
  hoja(nombre + '-detalle', detalles, e.dw, e.dh);
  console.log('  → ' + ruta);
  return e;
}
function createSafe(semilla) { return crearEntorno(semilla); }

function cada(e, tomar, total, intervalo) {
  for (let t = 0; t < total; t += intervalo) { e.avanzar(intervalo); tomar(); }
}

escena('01-ocio', 7, (e, tomar) => {
  e.enviar(estado());
  cada(e, tomar, 12, 0.75);
  verificar(e.mensajes.some((m) => m.tipo === 'listo'), 'avisa "listo" a la extensión');
});

escena('02-trabajar', 3, (e, tomar) => {
  e.enviar(estado());
  e.avanzar(0.1);
  e.enviar(estado({ trabajando: true, claude: true }));
  for (let i = 0; i < 9; i++) { e.avanzar(0.25); tomar(); }
  e.avanzar(1.5); tomar();
  verificar(e.koala.k.modo === 'trabajo' && e.koala.k.pose === 'sentado', 'se sienta a trabajar con la laptop');
  e.enviar(estado({ trabajando: false }));
  for (let i = 0; i < 7; i++) { e.avanzar(0.35); tomar(); }
  e.avanzar(0.5);
  verificar(e.koala.k.modo === 'libre' && !e.koala.k.laptop, 'guarda la laptop al terminar');
});

escena('03-comer', 11, (e, tomar) => {
  e.enviar(estado({ necesidades: { saciedad: 20, animo: 80, energia: 80 } }));
  e.avanzar(1); tomar();
  e.enviar({ tipo: 'accion', accion: 'comer' });
  cada(e, tomar, 7, 0.5);
  verificar(e.mensajes.some((m) => m.tipo === 'efecto' && m.accion === 'comer'), 'come y reporta el efecto');
});

escena('04-jugar', 5, (e, tomar) => {
  let tomados = 0;
  e.enviar(estado());
  e.enviar({ tipo: 'accion', accion: 'jugar' });
  for (let t = 0; t < 30 && !e.mensajes.some((m) => m.tipo === 'efecto'); t += 0.5) {
    e.avanzar(0.5);
    if (Math.round(t * 2) % 3 === 0 && ++tomados <= 12) tomar();
  }
  verificar(e.mensajes.some((m) => m.tipo === 'efecto' && m.accion === 'jugar'), 'patea la pelota 5 veces y reporta el efecto');
});

escena('05-mimar-y-clic', 9, (e, tomar) => {
  e.enviar(estado());
  e.avanzar(0.5);
  const k = e.koala.k;
  e.clic(k.x, 134 - 5 * 5);
  verificar(e.mensajes.some((m) => m.tipo === 'accion' && m.accion === 'mimar'), 'un clic sobre el koala pide mimar');
  e.enviar({ tipo: 'accion', accion: 'mimar' });
  cada(e, tomar, 2, 0.25);
  verificar(e.mensajes.some((m) => m.tipo === 'efecto' && m.accion === 'mimar'), 'mimar reporta el efecto');
});

escena('06-dormir', 2, (e, tomar) => {
  e.enviar(estado({ necesidades: { saciedad: 80, animo: 80, energia: 15 } }));
  e.avanzar(0.3);
  e.enviar(estado({ durmiendo: true, necesidades: { saciedad: 80, animo: 80, energia: 15 } }));
  cada(e, tomar, 4, 0.5);
  verificar(e.koala.k.modo === 'dormido', 'se duerme');
  e.enviar(estado({ durmiendo: false }));
  e.avanzar(1.5); tomar();
  verificar(e.koala.k.modo === 'libre', 'despierta');
});

escena('07-uso-50-80-95', 4, (e, tomar) => {
  for (const [p5, p7] of [[50, 20], [80, 40], [95, 60]]) {
    e.enviar(estado({ uso: usoDe(p5, p7) }));
    e.avanzar(0.6);
    e.koala.k.t = 0.5; // el globo se ve en los primeros 3.2 s de cada 8
    e.avanzar(0.1); tomar();
    e.enviar(estado({ uso: usoDe(p5, p7), trabajando: true }));
    e.avanzar(3.5); tomar();
    e.enviar(estado({ uso: usoDe(p5, p7), trabajando: false }));
    e.avanzar(3);
  }
  verificar(e.elementos['p-cinco'].textContent === '95 %', 'la probeta de sesión muestra 95 %');
  verificar(/se reinicia en/.test(e.elementos['s-cinco'].textContent), 'muestra cuándo se reinicia');
  verificar(e.elementos['t-cinco'].style.width === '95%', 'el líquido llega al 95 %');
});

escena('08-pedir-algo-trabajando', 8, (e, tomar) => {
  e.enviar(estado({ trabajando: true }));
  e.avanzar(3); tomar();
  e.enviar({ tipo: 'accion', accion: 'mimar' });
  const modos = new Set();
  for (let i = 0; i < 24; i++) { e.avanzar(0.25); modos.add(e.koala.k.modo); if (i % 3 === 0) tomar(); }
  verificar(e.mensajes.some((m) => m.tipo === 'efecto' && m.accion === 'mimar'), 'deja la laptop, lo mima y...');
  e.avanzar(3); tomar();
  verificar(e.koala.k.modo === 'trabajo', '...vuelve a trabajar');
});

escena('09-festejo-reinicio', 6, (e, tomar) => {
  e.enviar(estado({ uso: usoDe(85, 40) }));
  e.avanzar(0.5);
  e.enviar(estado({ uso: { ...usoDe(85, 40), cinco: { pct: 0, reinicio: null, reiniciada: true } } }));
  let festejo = false;
  for (let i = 0; i < 8; i++) { e.avanzar(0.3); tomar(); festejo = festejo || /reinici/.test(e.elementos['estado'].textContent); }
  verificar(festejo, 'festeja el reinicio de la ventana');
});

const pomo = (fase, extra) => Object.assign({ fase, total: 25 * 60000, restante: 15 * 60000, pausado: false, hoy: 2, enfoque: 25 }, extra);

escena('10-pomodoro-experimento', 12, (e, tomar) => {
  e.enviar(estado());
  e.avanzar(0.3);
  e.enviar(estado({ pomodoro: pomo('enfoque') }));
  for (let i = 0; i < 5; i++) { e.avanzar(0.3); tomar(); }
  verificar(e.koala.k.modo === 'experimento' && !!e.koala.k.exp, 'monta la mesa y se sienta a experimentar');
  for (let i = 0; i < 8; i++) { e.avanzar(0.7); tomar(); }
  verificar(e.elementos['pomo-reloj'].textContent === '15:00', 'el reloj del panel muestra el tiempo restante');
  verificar(e.elementos['pomo-alternar'].textContent === 'Pausar', 'el botón ofrece pausar');
  e.enviar(estado({ pomodoro: pomo('enfoque', { pausado: true }) }));
  e.avanzar(1.5); tomar();
  verificar(/pausa/.test(e.elementos['estado'].textContent), 'en pausa sigue en la mesa y lo dice');
  e.enviar({ tipo: 'accion', accion: 'festejarPomodoro' });
  e.enviar(estado({ pomodoro: pomo('descanso', { total: 5 * 60000, restante: 5 * 60000, hoy: 3 }) }));
  let festejo = false;
  for (let i = 0; i < 8; i++) { e.avanzar(0.4); tomar(); festejo = festejo || /Experimento terminado/.test(e.elementos['estado'].textContent); }
  verificar(festejo, 'recoge la mesa y festeja el pomodoro');
  verificar(!e.koala.k.exp && e.koala.k.modo === 'libre', 'en el descanso ya no está la mesa');
});

escena('11-energia-ligada', 13, (e, tomar) => {
  const uso = usoDe(90, 40);
  e.enviar(estado({ uso, energiaLigada: true, necesidades: { saciedad: 80, animo: 80, energia: 10 } }));
  e.avanzar(1); tomar();
  verificar(/ligada a tu sesión/.test(e.elementos['s-energia'].textContent), 'explica que la energía es la sesión de 5 h');
  verificar(/a las \d\d:\d\d/.test(e.elementos['s-energia'].textContent), 'dice a qué hora se recarga');
  e.enviar(estado({ uso, energiaLigada: true, durmiendo: true, necesidades: { saciedad: 80, animo: 80, energia: 10 } }));
  e.avanzar(2); tomar();
  verificar(/recargue la sesión/.test(e.elementos['estado'].textContent), 'duerme hasta el corte');
});

escena('12-commit', 21, (e, tomar) => {
  e.enviar(estado());
  e.avanzar(0.5);
  e.enviar({ tipo: 'accion', accion: 'festejarCommit', datos: { tipo: 'commit', repo: 'app', mensaje: 'Agrega filtro de lugar y horario al visor de homicidios' } });
  let visto = false;
  for (let i = 0; i < 12; i++) { e.avanzar(0.3); tomar(); visto = visto || /Commit en app/.test(e.elementos['estado'].textContent); }
  verificar(visto, 'festeja el commit con el nombre del repo y el mensaje');
  verificar(e.koala.k.t > 0, 'sigue animando');
});

escena('13-push', 22, (e, tomar) => {
  e.enviar(estado());
  e.avanzar(0.5);
  e.enviar({ tipo: 'accion', accion: 'festejarPush', datos: { tipo: 'push', repo: 'app', cuantos: 2 } });
  let visto = false;
  for (let i = 0; i < 12; i++) { e.avanzar(0.35); tomar(); visto = visto || /Push! 2 commits volando a app/.test(e.elementos['estado'].textContent); }
  verificar(visto, 'lanza el cohete con el número de commits');
  e.avanzar(2);
  verificar(e.koala.k.modo === 'libre', 'vuelve a lo suyo');
});

escena('14-claude-te-necesita', 31, (e, tomar) => {
  e.enviar(estado({ trabajando: true, claude: true }));
  e.avanzar(3); tomar();
  e.enviar(estado({ trabajando: true, claude: true, claudeNecesita: { mensaje: 'Claude needs your permission to use Bash', ts: 1 } }));
  e.enviar({ tipo: 'accion', accion: 'pedirAtencion' });
  for (let i = 0; i < 12; i++) { e.avanzar(0.4); tomar(); }
  verificar(/Claude te necesita: permiso para usar Bash/.test(e.elementos['estado'].textContent), 'levanta la mano y traduce el aviso');
  verificar(e.koala.k.modo === 'libre' && !e.koala.k.laptop, 'dejó la laptop para pedirte atención');
  e.enviar(estado({ trabajando: true, claude: true, claudeNecesita: null }));
  e.avanzar(3); tomar();
  verificar(e.koala.k.modo === 'trabajo', 'al responder, vuelve a trabajar');
});

escena('15-claude-termino', 32, (e, tomar) => {
  e.enviar(estado());
  e.avanzar(0.5);
  e.enviar({ tipo: 'accion', accion: 'claudeListo', datos: { duracion: 200000 } });
  let visto = false;
  for (let i = 0; i < 8; i++) { e.avanzar(0.35); tomar(); visto = visto || /Claude terminó! \(3 min 20 s\)/.test(e.elementos['estado'].textContent); }
  verificar(visto, 'trae el papel de "listo" con la duración');
});

escena('16-comando-ok', 33, (e, tomar) => {
  e.enviar(estado());
  e.avanzar(0.5);
  e.enviar({ tipo: 'accion', accion: 'comandoOk', datos: { ok: true, codigo: 0, comando: 'python manage.py test homicidios', duracion: 42000 } });
  let visto = false;
  for (let i = 0; i < 8; i++) { e.avanzar(0.35); tomar(); visto = visto || /✓ manage.py test homicidios \(42 s\)/.test(e.elementos['estado'].textContent); }
  verificar(visto, 'matraz verde y aplauso al pasar las pruebas');
});

escena('17-comando-fallo', 34, (e, tomar) => {
  e.enviar(estado());
  e.avanzar(0.5);
  e.enviar({ tipo: 'accion', accion: 'comandoFallo', datos: { ok: false, codigo: 1, comando: 'pytest tests/', duracion: 8000 } });
  let tizne = false;
  for (let i = 0; i < 10; i++) { e.avanzar(0.3); tomar(); tizne = tizne || e.koala.k.hollin > 0; }
  verificar(/Falló pytest tests\/ \(código 1\)/.test(e.elementos['estado'].textContent), 'avisa el fallo con el código');
  verificar(tizne, 'queda tiznado tras la explosión');
  e.avanzar(7);
  verificar(e.koala.k.hollin === 0, 'el tizne se quita solo');
});

escena('18-dia-de-muertos', 35, (e, tomar) => {
  e.enviar(estado({ temporada: 'muertos' }));
  cada(e, tomar, 4, 1);
  e.enviar(estado({ temporada: 'muertos', trabajando: true }));
  e.avanzar(3); tomar();
  verificar(true, 'disfraz dibujado sin errores');
});

escena('19-errores-en-cero', 41, (e, tomar) => {
  e.enviar(estado());
  e.avanzar(0.5);
  e.enviar({ tipo: 'accion', accion: 'errores0', datos: { antes: 7 } });
  for (let i = 0; i < 8; i++) { e.avanzar(0.4); tomar(); }
  verificar(/Cero errores! \(eran 7\)/.test(e.elementos['estado'].textContent) || e.koala.k.brazos === 'aplauso', 'barre y aplaude');
});

escena('20-servicio-caido', 42, (e, tomar) => {
  e.enviar(estado());
  e.avanzar(0.5);
  e.enviar({ tipo: 'accion', accion: 'servicioCaido', datos: { nombre: 'Django local', detalle: 'apagado' } });
  let visto = false;
  for (let i = 0; i < 9; i++) { e.avanzar(0.4); tomar(); visto = visto || /Django local no responde/.test(e.elementos['estado'].textContent); }
  verificar(visto, 'apaga el fuego con el extintor');
  e.enviar({ tipo: 'accion', accion: 'servicioVuelve', datos: { nombre: 'Django local' } });
  e.avanzar(0.6); tomar();
  verificar(/Django local volvió/.test(e.elementos['estado'].textContent), 'aplaude cuando vuelve');
});

escena('21-racha-y-reloj', 43, (e, tomar) => {
  const uso = usoDe(80, 40);
  uso.cinco.reinicio = Date.now() + 6 * 60000;
  e.enviar(estado({ uso, racha: { dias: 15, hoy: true } }));
  e.avanzar(1); tomar();
  verificar(/Corte de la sesión en 6 min/.test(e.elementos['estado'].textContent), 'reloj de arena antes del corte');
  e.enviar({ tipo: 'accion', accion: 'festejarCommit', datos: { repo: 'app', mensaje: 'Corrige T21', racha: 15 } });
  let visto = false;
  for (let i = 0; i < 5; i++) { e.avanzar(0.4); tomar(); visto = visto || /racha de 15 días/.test(e.elementos['estado'].textContent); }
  verificar(visto, 'el commit presume la racha (3 medallas en la bata)');
});

escena('22-noche-y-manana', 44, (e, tomar) => {
  const noche = new Date(); noche.setHours(23, 30, 0, 0);
  e.enviar(estado({ horaPrueba: noche.getTime() }));
  cada(e, tomar, 3, 1);
  const manana = new Date(); manana.setHours(8, 0, 0, 0);
  e.enviar(estado({ horaPrueba: manana.getTime() }));
  let cafe = false;
  for (let i = 0; i < 30 && !cafe; i++) { e.avanzar(0.5); cafe = e.koala.k.sosteniendo === 'taza'; }
  e.avanzar(1); tomar();
  verificar(cafe, 'en la mañana toma café');
});

escena('23-siesta', 45, (e, tomar) => {
  e.enviar(estado({ inactivoMin: 25, minutosSiesta: 20 }));
  for (let i = 0; i < 6; i++) { e.avanzar(0.6); tomar(); }
  e.avanzar(1); tomar();
  verificar(e.koala.k.modo === 'siesta', 'se duerme sobre la laptop por inactividad');
  e.enviar(estado({ inactivoMin: 0, minutosSiesta: 20 }));
  for (let i = 0; i < 4; i++) { e.avanzar(0.5); tomar(); }
  e.avanzar(2);
  verificar(e.koala.k.modo === 'libre' && !e.koala.k.laptop, 'despierta sobresaltado y guarda la laptop');
});

escena('24-arrastrar', 46, (e, tomar) => {
  e.enviar(estado());
  e.avanzar(0.5);
  const k = e.koala.k;
  const x0 = k.x;
  e.puntero('pointerdown', x0, 134 - 25);
  e.puntero('pointermove', x0 + 10, 134 - 40);
  e.puntero('pointermove', 80, 40);
  e.avanzar(0.2); tomar();
  verificar(k.cargado && k.alt > 20, 'lo cargas con el mouse');
  e.puntero('pointerup', 80, 40);
  for (let i = 0; i < 4; i++) { e.avanzar(0.2); tomar(); }
  verificar(!k.cargado && !k.cayendo && k.alt === 0, 'cae y aterriza');
  verificar(!e.mensajes.some((m) => m.accion === 'mimar'), 'arrastrar no cuenta como mimar');
  // comida: del icono de la esquina hasta el aire
  e.puntero('pointerdown', 14, 134 + 6);
  e.puntero('pointermove', 60, 100);
  e.puntero('pointermove', 200, 60);
  e.avanzar(0.1); tomar();
  e.puntero('pointerup', 200, 60);
  verificar(e.mensajes.some((m) => m.tipo === 'accion' && m.accion === 'comer'), 'soltar la comida le da de comer');
  e.enviar({ tipo: 'accion', accion: 'comer' });
  for (let i = 0; i < 6; i++) { e.avanzar(0.5); tomar(); }
});

escena('25-navidad-y-patrias', 47, (e, tomar) => {
  e.enviar(estado({ temporada: 'navidad', racha: { dias: 8, hoy: true } }));
  cada(e, tomar, 2, 1);
  e.enviar(estado({ temporada: 'patrias' }));
  cada(e, tomar, 2, 1);
  verificar(true, 'gorro de Navidad y moño tricolor sin errores');
});

if (errores.length) {
  console.log(`\n${errores.length} verificación(es) fallaron`);
  process.exit(1);
}
console.log('\nTodo bien.');
