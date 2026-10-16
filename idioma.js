'use strict';
// Traducción sencilla: el texto fuente está en español; l10n/en.json lo traduce al inglés.
// t('Llevas {0} pomodoros', 3) → "Llevas 3 pomodoros" o "You've done 3 pomodoros".
// El idioma sale de koalaCientifico.idioma (auto = el de VS Code): español si empieza con "es", si no inglés.
const EN = require('./l10n/en.json');

let ingles = false;

function configurarIdioma(preferencia, idiomaVSCode) {
  const p = String(preferencia || 'auto');
  const lang = p === 'auto' ? String(idiomaVSCode || 'es') : p;
  ingles = !lang.toLowerCase().startsWith('es');
}

function formatear(texto, args) {
  return texto.replace(/\{(\d+)\}/g, (m, i) => (args[i] === undefined ? m : String(args[i])));
}

function t(es, ...args) {
  return formatear(ingles && EN[es] !== undefined ? EN[es] : es, args);
}

module.exports = {
  t,
  configurarIdioma,
  esIngles: () => ingles,
  diccionario: () => (ingles ? EN : null), // para el webview
  locale: () => (ingles ? 'en-US' : 'es-MX'),
  formatear,
};
