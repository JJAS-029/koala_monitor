'use strict';
// Estado compartido entre todas las ventanas y editores de esta computadora (VS Code, Antigravity, Cursor…).
// Un archivo JSON guarda cada clave con la hora en que cambió; cada ventana lo vigila y recarga lo que cambió
// (gana lo más reciente por clave). Funciona como un globalState: get/update, y además sigue guardando en el
// globalState de cada editor para que Settings Sync y las versiones anteriores sigan funcionando.
const fs = require('fs');
const path = require('path');

const clon = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * ruta: archivo compartido; claves: las que se comparten (las demás solo van al globalState);
 * alCambiar(claves): otra ventana o la nube cambió esas claves; alGuardar(clave): esta ventana guardó una.
 */
function crearCompartido({ ruta, globalState, claves, alCambiar = () => {}, alGuardar = () => {} }) {
  const compartidas = new Set(claves);
  const doc = { datos: {}, ts: {} };
  let ultimoTexto = '';

  function leer() {
    try {
      const texto = fs.readFileSync(ruta, 'utf8');
      if (texto === ultimoTexto) return null;
      const d = JSON.parse(texto);
      ultimoTexto = texto;
      return { datos: d.datos || {}, ts: d.ts || {} };
    } catch (e) { return null; } // no existe todavía o se está escribiendo
  }

  // Toma de `otro` las claves más recientes que las nuestras; devuelve las que cambiaron de valor.
  function mezclar(otro) {
    const cambiadas = [];
    for (const k of Object.keys(otro.datos || {})) {
      if (!compartidas.has(k)) continue;
      const t = (otro.ts || {})[k] || 0;
      if (t <= (doc.ts[k] || 0)) continue;
      doc.ts[k] = t;
      if (igual(otro.datos[k], doc.datos[k])) continue;
      doc.datos[k] = clon(otro.datos[k]);
      globalState.update(k, doc.datos[k] === null ? undefined : clon(doc.datos[k]));
      cambiadas.push(k);
    }
    return cambiadas;
  }

  function escribir() {
    const otro = leer(); // lo que otra ventana haya guardado mientras tanto
    const cambiadas = otro ? mezclar(otro) : [];
    const texto = JSON.stringify({ version: 1, datos: doc.datos, ts: doc.ts });
    try {
      fs.mkdirSync(path.dirname(ruta), { recursive: true });
      const tmp = `${ruta}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, texto);
      fs.renameSync(tmp, ruta); // reemplazo atómico: nadie lee un archivo a medias
      ultimoTexto = texto;
    } catch (e) { /* sin permisos: esta ventana sigue con su globalState */ }
    if (cambiadas.length) alCambiar(cambiadas);
  }

  // Al arrancar: lo que ya está en el archivo manda; lo que falta se siembra desde el globalState de este
  // editor con fecha 1, para que cualquier dato real (de otra ventana o de la nube) le gane.
  const inicial = leer();
  if (inicial) mezclar(inicial);
  let sembrar = false;
  for (const k of compartidas) {
    if (k in doc.datos) continue;
    const v = globalState.get(k);
    if (v === undefined) continue;
    doc.datos[k] = clon(v); doc.ts[k] = 1; sembrar = true;
  }
  if (sembrar) escribir();

  const vigilar = () => { const o = leer(); if (o) { const c = mezclar(o); if (c.length) alCambiar(c); } };
  fs.watchFile(ruta, { interval: 1000 }, vigilar);

  return {
    get(k, porOmision) {
      if (compartidas.has(k) && k in doc.datos) return doc.datos[k] === null ? porOmision : clon(doc.datos[k]);
      return globalState.get(k, porOmision);
    },
    update(k, v) {
      const p = globalState.update(k, v);
      if (compartidas.has(k)) {
        const valor = v === undefined ? null : clon(v);
        if (!igual(valor, doc.datos[k])) {
          doc.datos[k] = valor; doc.ts[k] = Date.now();
          escribir();
          alGuardar(k);
        }
      }
      return p;
    },
    keys: () => globalState.keys(),
    setKeysForSync: (k) => globalState.setKeysForSync(k),
    // Para la nube: todo lo compartido con sus fechas, y aplicar lo que llegue de otra computadora.
    todo: () => ({ datos: clon(doc.datos), ts: clon(doc.ts) }),
    aplicar(otro) {
      const cambiadas = mezclar(otro);
      if (cambiadas.length) { escribir(); alCambiar(cambiadas); }
      return cambiadas;
    },
    revisar: vigilar, // lo mismo que hace el vigilante cada segundo (para las pruebas)
    cerrar() { fs.unwatchFile(ruta, vigilar); },
  };
}

// Una sola ventana (la "líder") hace lo que no debe repetirse: avanzar el pomodoro, sonar alarmas, saludar,
// gastar energía y sincronizar con la nube. Es la ventana con el foco; si ninguna lo tiene, sigue la última,
// y si se cierra, otra toma su lugar en unos segundos.
function crearLider({ ruta, id, enfocado }) {
  let soyLider = false;
  function latido() {
    let actual = null;
    try { actual = JSON.parse(fs.readFileSync(ruta, 'utf8')); } catch (e) { /* nadie es líder */ }
    const vencido = !actual || Date.now() - (actual.t || 0) > 12000;
    if (enfocado() || vencido || actual.id === id) {
      try {
        fs.mkdirSync(path.dirname(ruta), { recursive: true });
        fs.writeFileSync(ruta, JSON.stringify({ id, t: Date.now() }));
      } catch (e) { /* sin permisos: actúa como si estuviera sola */ }
      soyLider = true;
    } else {
      soyLider = false;
    }
  }
  latido();
  const reloj = setInterval(latido, 3000);
  return {
    esLider: () => soyLider,
    latido,
    cerrar() {
      clearInterval(reloj);
      if (!soyLider) return;
      try { fs.unlinkSync(ruta); } catch (e) { /* ya no existe */ }
    },
  };
}

module.exports = { crearCompartido, crearLider };
