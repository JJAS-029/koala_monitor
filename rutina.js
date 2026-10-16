'use strict';
// Rutina del día del koala: buenos días, comida, pausas activas, despedida, agua, logros y ánimo del código.
// Todo se guarda en globalState; los logros y contadores viajan con Settings Sync.

const { t } = require('./idioma');

const LOGROS = [
  { id: 'primer_pomodoro', icono: '🧪', nombre: 'Primer experimento', desc: 'Completa tu primer pomodoro' },
  { id: 'diez_pomodoros', icono: '⚗️', nombre: 'Laboratorio a todo vapor', desc: '10 pomodoros en un día' },
  { id: 'racha_7', icono: '🥈', nombre: 'Semana constante', desc: 'Racha de 7 días con commits' },
  { id: 'racha_30', icono: '🏆', nombre: 'Mes imparable', desc: 'Racha de 30 días con commits' },
  { id: 'cien_commits', icono: '💯', nombre: 'Cien commits', desc: '100 commits festejados por el koala' },
  { id: 'cohetero', icono: '🚀', nombre: 'Cohetero', desc: '10 pushes' },
  { id: 'barrendero', icono: '🧹', nombre: 'Barrendero', desc: 'Deja los errores en cero 10 veces' },
  { id: 'sesion_tranquila', icono: '🧘', nombre: 'Sesión zen', desc: 'Termina una ventana de 5 h usando Claude sin pasar del 50 %' },
  { id: 'hidratado', icono: '💧', nombre: 'Bien hidratado', desc: 'Toma toda tu meta de agua en un día' },
  { id: 'madrugador', icono: '🌅', nombre: 'Madrugador', desc: 'Trabaja antes de las 7:00' },
  { id: 'noctambulo', icono: '🦉', nombre: 'Noctámbulo', desc: 'Trabaja después de las 23:00' },
  { id: 'veterano', icono: '🎖️', nombre: 'Veterano', desc: '30 días distintos con el koala' },
  { id: 'visitas', icono: '🐼', nombre: 'Buen anfitrión', desc: 'Recibe 5 visitas de otros animales' },
  { id: 'sin_errores_semana', icono: '✨', nombre: 'Código impecable', desc: '7 días seguidos sin errores en el proyecto' },
];

function hoyTexto(d = new Date()) {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function crearRutina({ contexto, animar, notificar, config }) {
  const G = contexto.globalState;
  const diaNuevo = () => ({ fecha: hoyTexto(), saludo: false, despedida: false, lonche: false, agua: 0, inicioContinuo: null, pausaAvisada: false });
  let dia = Object.assign(diaNuevo(), G.get('koala.dia') || {});
  let logros = G.get('koala.logros') || {};
  let cont = Object.assign({ commits: 0, pushes: 0, barridas: 0, visitas: 0, dias: 0 }, G.get('koala.contadores') || {});
  let ultimoError = G.get('koala.ultimoError') || Date.now();
  const arranque = Date.now();

  const guardar = () => {
    G.update('koala.dia', dia);
    G.update('koala.logros', logros);
    G.update('koala.contadores', cont);
    G.update('koala.ultimoError', ultimoError);
  };

  function logro(id) {
    if (logros[id]) return;
    const l = LOGROS.find((x) => x.id === id);
    if (!l) return;
    logros[id] = Date.now();
    guardar();
    notificar('🏅 ' + t('Logro desbloqueado: {0} {1}. {2}.', l.icono, t(l.nombre), t(l.desc)));
    animar('logro', { nombre: t(l.nombre), icono: l.icono });
  }

  // Se llama cada 15 s. c = { inactivoMin, visible, resumen }
  function revisar(c) {
    const ahora = new Date();
    if (dia.fecha !== hoyTexto(ahora)) { dia = diaNuevo(); guardar(); }
    const h = ahora.getHours() + ahora.getMinutes() / 60;
    const activo = c.inactivoMin < 5;
    if (activo && !dia.usado) {
      dia.usado = true;
      cont.dias++;
      if (cont.dias >= 30) logro('veterano');
      guardar();
    }
    if (activo && h < 7) logro('madrugador');
    if (activo && h >= 23) logro('noctambulo');
    if ((Date.now() - ultimoError) / 86400000 >= 7) logro('sin_errores_semana');
    if (c.racha >= 7) logro('racha_7');
    if (c.racha >= 30) logro('racha_30');

    // Pausas activas: actividad continua (sin huecos de 10 min) por más de N minutos.
    const umbral = config().get('minutosPausaActiva', 90);
    if (activo) {
      if (!dia.inicioContinuo) dia.inicioContinuo = Date.now();
      const min = Math.round((Date.now() - dia.inicioContinuo) / 60000);
      if (umbral > 0 && min >= umbral && !dia.pausaAvisada && c.visible) {
        dia.pausaAvisada = true;
        animar('pausaActiva', { minutos: min });
      }
    } else if (c.inactivoMin >= 10) {
      dia.inicioContinuo = null;
      dia.pausaAvisada = false;
    }

    if (!c.visible || Date.now() - arranque < 10000) { guardar(); return; } // las animaciones necesitan el panel
    if (!dia.saludo && activo) {
      dia.saludo = true;
      animar('buenosDias', c.resumen);
    } else if (!dia.lonche && activo && h >= 14 && h < 15.5) {
      dia.lonche = true;
      animar('lonche', {});
    } else if (dia.saludo && !dia.despedida && h >= 18 && c.inactivoMin >= 10) {
      dia.despedida = true;
      animar('despedida', c.resumen);
    }
    guardar();
  }

  return {
    revisar,
    logro,
    agua() {
      dia.agua++;
      guardar();
      animar('tomarAgua', { vasos: dia.agua, meta: config().get('metaAgua', 8) });
      if (dia.agua >= config().get('metaAgua', 8)) logro('hidratado');
    },
    alPomodoro(hoy) {
      logro('primer_pomodoro');
      if (hoy >= 10) logro('diez_pomodoros');
    },
    alCommit() { cont.commits++; guardar(); if (cont.commits >= 100) logro('cien_commits'); },
    alPush() { cont.pushes++; guardar(); if (cont.pushes >= 10) logro('cohetero'); },
    alBarrer() { cont.barridas++; guardar(); if (cont.barridas >= 10) logro('barrendero'); },
    alVisita() { cont.visitas++; guardar(); if (cont.visitas >= 5) logro('visitas'); },
    alError() { ultimoError = Date.now(); },
    // Una ventana de 5 h terminó: si se usó Claude y no pasó del 50 %, sesión zen.
    alCerrarVentana(pct) { if (pct >= 5 && pct <= 50) logro('sesion_tranquila'); },
    estado() {
      return {
        agua: dia.agua,
        metaAgua: config().get('metaAgua', 8),
        diasSinErrores: Math.floor((Date.now() - ultimoError) / 86400000),
        logros: LOGROS.map((l) => ({ ...l, nombre: t(l.nombre), desc: t(l.desc), fecha: logros[l.id] || null })),
        contadores: cont,
      };
    },
  };
}

module.exports = { crearRutina, LOGROS };
