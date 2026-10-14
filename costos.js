'use strict';
// Costo equivalente (precios de la API de Anthropic) y huella estimada (energía y agua) por mensaje.
//
// Precios por millón de tokens, tomados de la documentación de la API (tabla del 25-sep-2026).
// Escritura de caché: 1.25× la entrada con duración de 5 min y 2× con 1 h. La lectura de caché
// tiene precio propio por modelo. El modo rápido (usage.speed = "fast") cuesta el doble.
const PRECIOS = [
  // [patrón del id, entrada, salida, lectura de caché, nombre]
  [/fable-5-1|mythos-5-1/, 10, 50, 0.25, 'Fable 5.1'],
  [/fable-5|mythos-5/, 10, 50, 1.0, 'Fable 5'],
  [/opus-5-5/, 4, 20, 0.2, 'Opus 5.5'],
  [/opus-5(?!-\d)/, 5, 25, 0.5, 'Opus 5'],
  [/opus-4/, 5, 25, 0.5, 'Opus 4.x'],
  [/sonnet-5-5/, 2, 10, 0.2, 'Sonnet 5.5'],
  [/sonnet-5(?!-\d)/, 2, 10, 0.2, 'Sonnet 5'],
  [/sonnet-4/, 3, 15, 0.3, 'Sonnet 4.x'],
  [/haiku-4/, 1, 5, 0.1, 'Haiku 4.5'],
];
const PRECIO_DESCONOCIDO = PRECIOS[2]; // si aparece un modelo nuevo, se estima como Opus 5.5

function precioDe(modelo) {
  const id = String(modelo || '');
  return PRECIOS.find((p) => p[0].test(id)) || PRECIO_DESCONOCIDO;
}

// Energía por millón de tokens (Wh/MTok), "cuentas de servilleta" de Simon P. Couch (ene-2026),
// derivadas de la estimación de Epoch AI (2.5 Wh por consulta de 10 mil tokens de entrada).
// Anthropic no publica datos por modelo: es un orden de magnitud, no una medición.
const WH_POR_MTOK = { entrada: 390, salida: 1950, escritura: 490, lectura: 39 };

/** Tokens de un `usage` de la transcripción → { usd, wh } */
function medirMensaje(u, modelo) {
  const [, entrada, salida, lectura] = precioDe(modelo);
  const cc = u.cache_creation || {};
  const total = u.cache_creation_input_tokens || 0;
  const unaHora = cc.ephemeral_1h_input_tokens || 0;
  const cincoMin = cc.ephemeral_5m_input_tokens != null ? cc.ephemeral_5m_input_tokens : Math.max(0, total - unaHora);
  const rapido = u.speed === 'fast' ? 2 : 1;
  const usd = rapido * (
    (u.input_tokens || 0) * entrada +
    (u.output_tokens || 0) * salida +
    cincoMin * entrada * 1.25 +
    unaHora * entrada * 2 +
    (u.cache_read_input_tokens || 0) * lectura
  ) / 1e6;
  const wh = (
    (u.input_tokens || 0) * WH_POR_MTOK.entrada +
    (u.output_tokens || 0) * WH_POR_MTOK.salida +
    total * WH_POR_MTOK.escritura +
    (u.cache_read_input_tokens || 0) * WH_POR_MTOK.lectura
  ) / 1e6;
  return { usd, wh };
}

module.exports = { precioDe, medirMensaje, WH_POR_MTOK };
