'use strict';
// Genera media/icono.png (128×128) con el mismo dibujo del koala: de frente, feliz, con un matraz.
// Uso: node pruebas/icono.js
const path = require('path');
const { crearEntorno, escribirPNG } = require('./simular');

const LADO = 128, CUADRO = 92, ESCALA = LADO / CUADRO; // se recorta un cuadro de 92 px de CSS
const ALTO = 104, SUELO = ALTO - 16, MARGEN_PISO = 10;
const e = crearEntorno(3, { ancho: CUADRO, alto: ALTO, dpr: ESCALA });
e.enviar({
  tipo: 'estado', necesidades: { saciedad: 90, animo: 95, energia: 90 }, durmiendo: false, trabajando: false,
  uso: null, umbral: 90, temporada: 'ninguna', sinIconoComida: true,
});
e.avanzar(0.2);
// Pose fija: se "carga" al koala para que nada lo mueva y se le acomoda a mano.
const k = e.koala.k;
Object.assign(k, {
  cargado: true, x: CUADRO / 2 - 4, alt: 0, balanceo: 0, pose: 'frente', tVolteo: 1, def: { sx: 1, sy: 1 },
  ojos: 'felices', mirar: 0, brazos: 'frasco', frasco: { color: '#5BC46A' }, caminando: false, texto: '',
});
e.avanzar(1 / 60);

// Fondo: cuadro redondeado azul pizarra con piso; el koala encima.
const ancho = e.w, y0 = Math.round((SUELO + MARGEN_PISO - CUADRO) * ESCALA);
const salida = Buffer.alloc(LADO * LADO * 4);
const radio = 22;
for (let y = 0; y < LADO; y++) {
  for (let x = 0; x < LADO; x++) {
    const i = (y * LADO + x) * 4;
    const dx = Math.max(radio - x, 0, x - (LADO - 1 - radio)), dy = Math.max(radio - y, 0, y - (LADO - 1 - radio));
    if (dx * dx + dy * dy > radio * radio) continue; // esquina transparente
    const piso = y >= Math.round(SUELO * ESCALA) - y0;
    let r = piso ? 0x1b : 0x2b, g = piso ? 0x2a : 0x45, b = piso ? 0x38 : 0x5c;
    const j = ((y + y0) * ancho + x) * 4;
    const a = e.pix[j + 3] || 0;
    r = Math.round(e.pix[j] * a + r * (1 - a));
    g = Math.round(e.pix[j + 1] * a + g * (1 - a));
    b = Math.round(e.pix[j + 2] * a + b * (1 - a));
    salida[i] = r; salida[i + 1] = g; salida[i + 2] = b; salida[i + 3] = 255;
  }
}
const ruta = path.join(__dirname, '..', 'media', 'icono.png');
escribirPNG(ruta, LADO, LADO, salida);
console.log('→ ' + ruta);
