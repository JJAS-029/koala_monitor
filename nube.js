'use strict';
// Sincronización con la cuenta de GitHub: el estado compartido viaja en un Gist privado de tu cuenta, así el
// koala es el mismo en otra computadora, en un servidor por SSH o en otro editor. Usa el inicio de sesión de
// GitHub del propio editor (permiso "gist"); el token no se guarda ni se muestra.
const vscode = require('vscode');
const os = require('os');
const { t } = require('./idioma');

const ARCHIVO = 'koala-cientifico-sync.json';
const API = 'https://api.github.com';

function crearNube({ compartido, config, esLider, alEstado = () => {} }) {
  let sesion = null;
  let gistId = null;
  let ocupado = false;
  let ultimo = null; // { cuando, error, cuenta }

  async function api(metodo, ruta, cuerpo) {
    const r = await fetch(API + ruta, {
      method: metodo,
      headers: {
        Authorization: `Bearer ${sesion.accessToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'koala-cientifico',
        ...(cuerpo ? { 'Content-Type': 'application/json' } : {}),
      },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    if (r.status === 401) sesion = null; // el token caducó: se pide de nuevo en silencio
    if (!r.ok) throw new Error(`GitHub ${r.status}`);
    return r.json();
  }

  // interactivo: abre el inicio de sesión si hace falta; si no, solo usa una sesión que ya exista.
  async function conectar(interactivo) {
    try {
      sesion = await vscode.authentication.getSession('github', ['gist'], interactivo ? { createIfNone: true } : { silent: true });
    } catch (e) {
      sesion = null;
      if (interactivo) throw new Error(t('Este editor no permite iniciar sesión con GitHub ({0}).', e.message));
    }
    return !!sesion;
  }

  async function buscarGist() {
    if (gistId) return gistId;
    gistId = compartido.get('koala.gist') || null;
    if (gistId) return gistId;
    for (let pagina = 1; pagina <= 10 && !gistId; pagina++) {
      const lista = await api('GET', `/gists?per_page=100&page=${pagina}`);
      const g = lista.find((x) => x.files && x.files[ARCHIVO]);
      if (g) gistId = g.id;
      if (lista.length < 100) break;
    }
    if (!gistId) {
      const g = await api('POST', '/gists', {
        description: t('Koala científico: estado sincronizado (no lo borres)'),
        public: false,
        files: { [ARCHIVO]: { content: JSON.stringify({ version: 1, datos: {}, ts: {} }) } },
      });
      gistId = g.id;
    }
    compartido.update('koala.gist', gistId);
    return gistId;
  }

  // Trae lo nuevo del Gist, y sube lo que aquí sea más reciente. forzar: aunque esta ventana no sea la líder.
  async function sincronizar(forzar) {
    if (!config().get('sincronizarConGitHub', false) || ocupado) return ultimo;
    if (!forzar && !esLider()) return ultimo;
    ocupado = true;
    try {
      if (!sesion && !(await conectar(false))) throw new Error(t('Falta iniciar sesión en GitHub'));
      const id = await buscarGist();
      let g;
      try {
        g = await api('GET', `/gists/${id}`);
      } catch (e) {
        if (/GitHub 404/.test(e.message)) { gistId = null; compartido.update('koala.gist', undefined); } // lo borraron
        throw e;
      }
      const f = g.files && g.files[ARCHIVO];
      let remoto = { datos: {}, ts: {} };
      if (f) {
        const texto = f.truncated ? await (await fetch(f.raw_url)).text() : f.content;
        try { remoto = JSON.parse(texto); } catch (e) { /* archivo dañado: se reescribe */ }
      }
      compartido.aplicar(remoto);
      const local = compartido.todo();
      const tsRemoto = remoto.ts || {};
      if (Object.keys(local.ts).some((k) => (local.ts[k] || 0) > (tsRemoto[k] || 0))) {
        await api('PATCH', `/gists/${id}`, {
          files: { [ARCHIVO]: { content: JSON.stringify({ version: 1, equipo: os.hostname(), datos: local.datos, ts: local.ts }, null, 1) } },
        });
      }
      ultimo = { cuando: Date.now(), error: null, cuenta: sesion && sesion.account ? sesion.account.label : '' };
    } catch (e) {
      ultimo = { cuando: Date.now(), error: e.message, cuenta: sesion && sesion.account ? sesion.account.label : '' };
    } finally {
      ocupado = false;
    }
    alEstado(ultimo);
    return ultimo;
  }

  return { conectar, sincronizar, estado: () => ultimo, cuenta: () => (sesion && sesion.account ? sesion.account.label : '') };
}

module.exports = { crearNube, ARCHIVO };
