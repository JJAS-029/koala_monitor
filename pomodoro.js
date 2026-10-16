'use strict';
// Pomodoro del koala: fases de enfoque (experimento), descanso y descanso largo, con pausa.
// El estado se guarda en globalState ('koala.pomodoro') para sobrevivir a recargas de VS Code.

const NOMBRE_FASE = { enfoque: 'Experimento (enfoque)', descanso: 'Descanso', descansoLargo: 'Descanso largo' };
const fechaTexto = (d = new Date()) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;

function relojTexto(ms) {
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * minutos(fase) → duración; alCambiar() tras cada cambio; alTerminarEnfoque(hoy) y alTerminarDescanso()
 * al cumplirse el tiempo. barra (opcional): elemento de la barra de estado que se pinta con el reloj.
 */
function crearPomodoro({ contexto, minutos, antesDeLargo = () => 4, alCambiar = () => {}, alTerminarEnfoque = () => {}, alTerminarDescanso = () => {} }) {
  const p = Object.assign({ fase: null, fin: 0, total: 0, pausa: null, ciclo: 0, hoy: 0, fecha: '' }, contexto.globalState.get('koala.pomodoro') || {});
  let barra = null;
  if (p.fecha !== fechaTexto()) { p.hoy = 0; p.fecha = fechaTexto(); }
  // Si VS Code estuvo cerrado y la fase ya venció, se descarta sin avisar.
  if (p.fase && p.pausa === null && p.fin <= Date.now()) p.fase = null;

  const guardar = () => contexto.globalState.update('koala.pomodoro', p);
  const restante = () => (!p.fase ? 0 : p.pausa !== null ? p.pausa : Math.max(0, p.fin - Date.now()));

  function pintar() {
    if (!barra) return;
    if (!p.fase) { barra.hide(); return; }
    const icono = p.fase === 'enfoque' ? '$(beaker)' : '$(coffee)';
    barra.text = `${icono} ${relojTexto(restante())}${p.pausa !== null ? ' ⏸' : ''}`;
    barra.tooltip = `${NOMBRE_FASE[p.fase]} · ${p.hoy} hoy · clic para ${p.pausa !== null ? 'reanudar' : 'pausar'}`;
    barra.show();
  }
  function cambio() { guardar(); pintar(); alCambiar(); }

  function iniciarFase(fase) {
    p.fase = fase;
    p.total = minutos(fase) * 60000;
    p.fin = Date.now() + p.total;
    p.pausa = null;
    cambio();
  }

  return {
    iniciarFase,
    alternar() {
      if (!p.fase) return iniciarFase('enfoque');
      if (p.pausa === null) p.pausa = Math.max(0, p.fin - Date.now());
      else { p.fin = Date.now() + p.pausa; p.pausa = null; }
      cambio();
    },
    detener() { p.fase = null; p.pausa = null; cambio(); },
    revisar(ahora = Date.now()) {
      if (!p.fase) return;
      if (p.pausa === null && ahora >= p.fin) {
        if (p.fase === 'enfoque') {
          if (p.fecha !== fechaTexto()) { p.hoy = 0; p.fecha = fechaTexto(); }
          p.hoy++;
          p.ciclo++;
          iniciarFase(p.ciclo % Math.max(1, antesDeLargo()) === 0 ? 'descansoLargo' : 'descanso');
          alTerminarEnfoque(p.hoy, minutos(p.fase));
        } else {
          p.fase = null; p.pausa = null; cambio();
          alTerminarDescanso();
        }
        return;
      }
      pintar();
    },
    usarBarra(b) { barra = b; pintar(); },
    fase: () => p.fase,
    hoy: () => p.hoy,
    estado: () => ({ fase: p.fase, total: p.total, restante: restante(), pausado: p.pausa !== null, hoy: p.hoy, enfoque: minutos('enfoque') }),
  };
}

module.exports = { crearPomodoro, relojTexto, NOMBRE_FASE };
