'use strict';
// Imagen de animaciones para el readme: docs/capturas/animaciones.png (3 × 2 cuadros).
// Uso: node pruebas/capturas-readme.js
const path = require('path');
const fs = require('fs');
const { crearEntorno, escribirPNG } = require('./simular');

const base = (extra) => Object.assign({
  tipo: 'estado', necesidades: { saciedad: 80, animo: 80, energia: 80 }, durmiendo: false, trabajando: false,
  uso: null, umbral: 90, temporada: 'ninguna', sinIconoComida: true, horaPrueba: (() => { const d = new Date(); d.setHours(17, 50, 0, 0); return d.getTime(); })(),
}, extra);

const cuadros = [];
function toma(semilla, preparar) {
  const e = crearEntorno(semilla);
  preparar(e);
  cuadros.push({ w: e.w, h: e.h, px: e.captura() });
}
toma(1, (e) => { e.enviar(base()); e.avanzar(0.2); e.enviar(base({ trabajando: true })); e.avanzar(4.2); });
toma(2, (e) => { e.enviar(base({ pomodoro: { fase: 'enfoque', total: 1500000, restante: 900000, pausado: false, hoy: 2, enfoque: 25 } })); e.avanzar(5.5); });
toma(3, (e) => { e.enviar(base()); e.avanzar(0.3); e.enviar({ tipo: 'accion', accion: 'festejarCommit', datos: { repo: 'app', mensaje: 'feat' } }); e.avanzar(2.4); });
toma(4, (e) => { e.enviar(base()); e.avanzar(0.3); e.enviar({ tipo: 'accion', accion: 'comandoFallo', datos: { comando: 'pytest', codigo: 1 } }); e.avanzar(1.3); });
toma(5, (e) => { e.enviar(base({ temporada: 'muertos' })); e.avanzar(1); });
toma(6, (e) => {
  e.enviar(base({ temporada: 'marmota' })); e.avanzar(0.2);
  Object.assign(e.koala.k, { cargado: true, x: 205, pose: 'frente', def: { sx: 1, sy: 1 }, mirar: 1, ojos: 'abiertos', t: 2.4 }); // junto a la madriguera
  e.avanzar(0.3);
});

const col = 3, sep = 6, w = cuadros[0].w, h = cuadros[0].h;
const W = col * w + (col + 1) * sep, H = 2 * h + 3 * sep;
const out = Buffer.alloc(W * H * 4);
for (let i = 0; i < W * H; i++) { out[i * 4] = 0x2b; out[i * 4 + 1] = 0x45; out[i * 4 + 2] = 0x5c; out[i * 4 + 3] = 255; }
cuadros.forEach((c, n) => {
  const ox = sep + (n % col) * (w + sep), oy = sep + Math.floor(n / col) * (h + sep);
  for (let y = 0; y < h; y++) c.px.copy(out, ((oy + y) * W + ox) * 4, y * w * 4, (y + 1) * w * 4);
});
const dir = path.join(__dirname, '..', 'docs', 'capturas');
fs.mkdirSync(dir, { recursive: true });
escribirPNG(path.join(dir, 'animaciones.png'), W, H, out);
console.log('→ docs/capturas/animaciones.png', W + '×' + H);
