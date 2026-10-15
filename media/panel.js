// Koala científico: pestañas de estadísticas (Consumo, Hoy, Sistema) y alertas.
// Se apoya en koala.js, que abre el canal con la extensión (window.koalaVscode).
(function () {
  'use strict';

  const vscode = window.koalaVscode || { postMessage() {}, getState() {}, setState() {} };
  const $ = (id) => document.getElementById(id);
  let est = null;

  // ---------- Utilidades ----------
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function tokens(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + ' M';
    if (n >= 1e3) return Math.round(n / 1e3) + ' mil';
    return String(Math.round(n || 0));
  }
  function bytes(n) {
    const g = n / 1024 ** 3;
    if (g >= 1000) return (g / 1024).toFixed(1) + ' TB';
    return g >= 100 ? Math.round(g) + ' GB' : g.toFixed(1) + ' GB';
  }
  function duracion(seg) {
    const m = Math.floor(seg / 60);
    if (m < 60) return m + ' min';
    return Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
  }
  function hora(ms) {
    const d = new Date(ms);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }
  function hace(ms) {
    const min = Math.max(0, Math.round((Date.now() - ms) / 60000));
    if (min < 60) return 'hace ' + min + ' min';
    const h = Math.floor(min / 60);
    return h < 24 ? 'hace ' + h + ' h' : 'hace ' + Math.floor(h / 24) + ' d';
  }
  const pct = (v) => (v == null ? '—' : Math.round(v) + ' %');
  const nivel = (v, ambar, rojo) => (v >= rojo ? 'rojo' : v >= ambar ? 'ambar' : 'verde');

  // Las anchuras van en data-w y se aplican por CSSOM (la CSP no permite style en línea).
  function medidor(valor, clase) {
    return '<div class="medidor"><i class="' + (clase || '') + '" data-w="' + Math.max(0, Math.min(100, valor || 0)) + '"></i></div>';
  }
  function renglon(nombre, valor, porcentaje, clase, titulo) {
    return '<div class="renglon"' + (titulo ? ' title="' + esc(titulo) + '"' : '') + '><span class="nom">' + esc(nombre) +
      '</span>' + medidor(porcentaje, clase) + '<span class="val">' + esc(valor) + '</span></div>';
  }
  function cifra(valor, etiqueta) {
    return '<div class="cifra"><b>' + esc(valor) + '</b><span>' + esc(etiqueta) + '</span></div>';
  }
  function tarjeta(titulo, cuerpo) {
    return '<div class="tarjeta"><h3>' + esc(titulo) + '</h3>' + cuerpo + '</div>';
  }
  function ranking(obj, n, formato, clase) {
    const filas = Object.entries(obj || {}).sort((a, b) => b[1] - a[1]).slice(0, n);
    if (!filas.length) return '<div class="nota">Sin datos todavía.</div>';
    const max = filas[0][1] || 1;
    return filas.map(([k, v]) => renglon(k, formato(v), (100 * v) / max, clase)).join('');
  }
  function pintar(id, html) {
    const el = $(id);
    if (!el) return;
    el.innerHTML = html;
    el.querySelectorAll('[data-w]').forEach((i) => { i.style.width = i.getAttribute('data-w') + '%'; });
    el.querySelectorAll('[data-o]').forEach((i) => { i.style.opacity = i.getAttribute('data-o'); });
  }

  // ---------- Pestañas ----------
  function elegirPestana(nombre) {
    document.querySelectorAll('[data-pestana]').forEach((b) => b.classList.toggle('sel', b.getAttribute('data-pestana') === nombre));
    document.querySelectorAll('.vista').forEach((v) => v.classList.toggle('sel', v.id === 'v-' + nombre));
    try { vscode.setState(Object.assign({}, vscode.getState() || {}, { pestana: nombre })); } catch (e) { /* sin estado */ }
  }
  document.querySelectorAll('[data-pestana]').forEach((b) => {
    b.addEventListener('click', () => elegirPestana(b.getAttribute('data-pestana')));
  });
  try {
    const guardada = (vscode.getState() || {}).pestana;
    if (guardada) elegirPestana(guardada);
  } catch (e) { /* sin estado */ }

  // ---------- Alertas ----------
  function pintarAlertas() {
    const a = (est.alertas || []).slice(0, 2);
    pintar('alertas', a.map((x) => '<div class="alerta n' + x.nivel + '">' + esc(x.texto) + '</div>').join(''));
    // punto rojo en la pestaña que corresponde
    const marca = { consumo: false, hoy: false, sistema: false };
    for (const x of est.alertas || []) {
      if (/Claude|ritmo|contexto/.test(x.texto)) marca.consumo = true;
      else if (/error|commit/.test(x.texto)) marca.hoy = true;
      else marca.sistema = true;
    }
    document.querySelectorAll('[data-pestana]').forEach((b) => {
      const p = b.getAttribute('data-pestana');
      let punto = b.querySelector('.punto');
      if (marca[p] && !punto) { punto = document.createElement('span'); punto.className = 'punto'; b.appendChild(punto); }
      if (!marca[p] && punto) punto.remove();
    });
  }

  // ---------- Consumo ----------
  function pintarConsumo() {
    const u = est.uso || {};
    const r = u.ritmo || {};
    let ritmo;
    if (r.estado === 'alcanza') {
      ritmo = '<div class="ritmo alcanza">⚠ A este ritmo llegas al 100 % a las ' + hora(r.eta) + ', antes del corte de las ' + hora(u.cinco.reinicio) + '.</div>';
    } else if (r.estado === 'holgado') {
      ritmo = '<div class="ritmo holgado">✓ Vas holgado: a este ritmo llegarías al 100 % hasta las ' + hora(r.eta) + ', después del corte.</div>';
    } else if (r.estado === 'quieto') {
      ritmo = '<div class="ritmo">Sin consumo en los últimos 30 min.</div>';
    } else {
      ritmo = '<div class="ritmo">Falta el % oficial para proyectar; ritmo local abajo.</div>';
    }
    const cifrasRitmo = '<div class="cifras">' +
      cifra(tokens(r.tokPorMin || 0) + '/min', 'tokens, últimos 30 min') +
      cifra(r.pctPorHora != null ? r.pctPorHora.toFixed(1) + ' %/h' : '—', 'de la sesión por hora') + '</div>';

    const s = u.sesion;
    let conv;
    if (s) {
      const ctx = s.contexto_pct;
      conv = (ctx != null ? renglon('Contexto', pct(ctx), ctx, nivel(ctx, 70, 85),
        'Qué tan llena está la conversación; cerca del 100 % Claude la resume (compacta) y olvida detalles') : '') +
        '<div class="cifras">' +
        cifra(s.costo_usd != null ? '$' + s.costo_usd.toFixed(2) : '—', 'USD equivalentes') +
        cifra('+' + (s.lineas_mas || 0) + ' / −' + (s.lineas_menos || 0), 'líneas cambiadas') +
        cifra(s.duracion_ms ? duracion(s.duracion_ms / 1000) : '—', 'de conversación') + '</div>' +
        '<div class="nota">' + esc(s.carpeta || 'conversación') + ' · dato ' + hace(s.ts) + '</div>';
    } else {
      conv = '<div class="nota">Llega desde la status line de Claude Code (al usar <code>claude</code> en una terminal).</div>';
    }

    const h = est.hoy || {};
    const cache = h.cachePct;
    const eficiencia = cache == null ? '<div class="nota">Sin mensajes hoy.</div>' :
      renglon('Reutilizado de caché', pct(cache), cache, nivel(100 - cache, 30, 60),
        'Parte de la entrada que Claude leyó de caché en vez de procesarla de nuevo; alto = sesiones largas y eficientes') +
      '<div class="nota">' + (cache >= 80 ? 'Muy eficiente: conversaciones largas y con contexto estable.' :
        cache >= 50 ? 'Aceptable.' : 'Baja: muchas conversaciones nuevas o cambios de contexto.') + '</div>';

    pintar('consumo-extra',
      tarjetaFuente(u) +
      tarjeta('Ritmo y proyección', ritmo + cifrasRitmo) +
      tarjetaCosto() +
      tarjetaHuella() +
      tarjeta('Conversación actual', conv) +
      tarjeta('Eficiencia de caché (hoy)', eficiencia));
  }

  function dinero(v) {
    if (v >= 1000) return '$' + Math.round(v).toLocaleString('es-MX');
    if (v >= 100) return '$' + v.toFixed(0);
    return '$' + v.toFixed(2);
  }

  function tarjetaFuente(u) {
    const api = u.api || {};
    let html;
    if (u.fuente === 'anthropic') html = '<div class="nota">✓ Dato real de api.anthropic.com, ' + hace(u.actualizado) + '.</div>';
    else if (u.fuente === 'statusline') html = '<div class="nota">Dato de la status line de Claude Code, ' + hace(u.actualizado) + '.</div>';
    else html = '<div class="nota">Sin dato oficial todavía.</div>';
    (u.extras || []).forEach((x) => {
      html += renglon(x.nombre, pct(x.pct), x.pct, nivel(x.pct, 75, 90), x.reinicio ? 'Se reinicia ' + hora(x.reinicio) : '');
    });
    if (api.activo) {
      if (api.error) html += '<div class="nota">⚠ ' + esc(api.error) + '</div>';
      html += '<button class="boton-chico" data-msg="consultarApi">Consultar ahora</button>';
    } else {
      html += '<div class="nota">Puedes pedir el % real directo a Anthropic con la sesión de Claude Code de este equipo (lo mismo que hace el panel de Claude).</div>' +
        '<button class="boton-chico" data-msg="activarApi">Usar dato directo de Anthropic</button>';
    }
    return tarjeta('Fuente del dato', html);
  }

  function tarjetaCosto() {
    const c = est.costos;
    if (!c) return '';
    const mensual = (c.mes.usd / c.diasMes) * 30;
    let html = '<div class="cifras">' +
      cifra(dinero(c.hoy.usd), 'hoy') +
      cifra(dinero(c.cinco.usd), 'esta sesión (5 h)') +
      cifra(dinero(c.semana.usd), '7 días') +
      cifra(dinero(c.mes.usd), c.diasMes < 30 ? c.diasMes + ' días registrados' : '30 días') + '</div>';
    html += ranking(c.modelosHoy, 4, dinero, 'morado');
    if (c.planUsd > 0) {
      const veces = mensual / c.planUsd;
      html += '<div class="ritmo ' + (veces >= 1 ? 'holgado' : '') + '">A este paso, ~' + dinero(mensual) + ' al mes en la API: ' +
        (veces >= 1 ? veces.toFixed(1) + '× lo que pagas (' + dinero(c.planUsd) + ').' : 'menos de lo que pagas (' + dinero(c.planUsd) + ').') + '</div>';
    } else {
      html += '<div class="nota">A este paso, ~' + dinero(mensual) + ' al mes. Escribe lo que pagas en <code>koalaCientifico.costoPlanMensualUSD</code> para comparar.</div>';
    }
    html += '<div class="nota">Lo que costaría pagando por token con los precios de la API (entrada, salida, escritura y lectura de caché de cada modelo). Con una suscripción no se cobra así.</div>';
    return tarjeta('Costo equivalente en la API', html);
  }

  function energia(wh) {
    return wh >= 1000 ? (wh / 1000).toFixed(1) + ' kWh' : Math.round(wh) + ' Wh';
  }
  function agua(ml) {
    return ml >= 1000 ? (ml / 1000).toFixed(1) + ' L' : Math.round(ml) + ' mL';
  }
  function tarjetaHuella() {
    const c = est.costos;
    if (!c) return '';
    const f = c.aguaMlPorWh;
    const vasos = (c.hoy.wh * f) / 250;
    const cargas = c.hoy.wh / 15; // un celular ≈ 15 Wh
    let html = '<div class="cifras">' +
      cifra(energia(c.hoy.wh), 'energía hoy') +
      cifra(agua(c.hoy.wh * f), 'agua hoy') +
      cifra(energia(c.mes.wh), 'energía ' + (c.diasMes < 30 ? c.diasMes + ' d' : '30 d')) +
      cifra(agua(c.mes.wh * f), 'agua ' + (c.diasMes < 30 ? c.diasMes + ' d' : '30 d')) + '</div>';
    html += '<div class="nota">Hoy ≈ ' + (vasos >= 1 ? vasos.toFixed(1) + ' vasos de agua' : agua(c.hoy.wh * f) + ' de agua') +
      ' y ≈ ' + cargas.toFixed(1) + ' cargas de celular. Rango del agua: ' + agua(c.hoy.wh * 0.5) + ' a ' + agua(c.hoy.wh * 5) + '.</div>';
    html += '<div class="nota">Estimación, no medición: Anthropic no publica energía ni agua por modelo. Energía con factores por token ' +
      '(entrada 390, salida 1950, escritura 490 y lectura de caché 39 Wh por millón; S. Couch con datos de Epoch AI) y agua con ' +
      f + ' mL por Wh (enfriamiento + generación eléctrica; ajustable en <code>koalaCientifico.aguaMlPorWh</code>).</div>';
    return tarjeta('Huella estimada', html);
  }

  // ---------- Hoy ----------
  function pintarHoy() {
    const h = est.hoy || {};
    const p = est.pomodoro || {};
    let html = tarjeta('Resumen del día', '<div class="cifras">' +
      cifra(tokens(h.tokens || 0), 'tokens de Claude') +
      cifra(String(h.mensajes || 0), 'respuestas') +
      cifra(duracion(est.activoHoy || 0), 'activo en el editor') +
      cifra(String(p.hoy || 0), 'pomodoros') + '</div>');
    html += tarjeta('Por proyecto', ranking(h.proyectos, 5, tokens, ''));
    html += tarjeta('Por modelo', ranking(h.modelos, 4, tokens, 'morado'));
    html += tarjeta('Herramientas de Claude', ranking(h.herramientas, 6, (v) => v + '×', 'verde'));

    // git
    const repos = est.git;
    let git;
    if (!repos) git = '<div class="nota">La extensión de git de VS Code no está activa.</div>';
    else if (!repos.length) git = '<div class="nota">No hay repositorios abiertos.</div>';
    else {
      git = repos.map((g) => '<div class="repo"><b>' + esc(g.nombre) + '</b> · ' + esc(g.rama || 'sin rama') + '<br>' +
        (g.cambios ? g.cambios + ' cambio' + (g.cambios === 1 ? '' : 's') + ' sin commit' : 'sin cambios pendientes') +
        ' · ' + g.commitsHoy + ' commit' + (g.commitsHoy === 1 ? '' : 's') + ' hoy' +
        (g.porSubir ? ' · ' + g.porSubir + ' por subir' : '') +
        (g.ultimoCommit ? ' · último ' + hace(g.ultimoCommit) : '') + '</div>').join('');
    }
    const r = est.racha || {};
    if (r.dias) {
      const medalla = r.dias >= 14 ? '🥇' : r.dias >= 7 ? '🥈' : r.dias >= 3 ? '🥉' : '';
      git += '<div class="repo">' + medalla + ' Racha de <b>' + r.dias + ' día' + (r.dias === 1 ? '' : 's') + '</b> con commits' +
        (r.hoy ? '' : ' · haz uno hoy para no romperla') + '</div>';
    }
    html += tarjeta('Git', git);

    const d = est.diag || {};
    html += tarjeta('Problemas del proyecto', '<div class="cifras">' +
      cifra(String(d.errores || 0), 'errores') + cifra(String(d.avisos || 0), 'advertencias') +
      cifra(String(d.archivos || 0), 'archivos') + '</div>' +
      '<button class="boton-chico" data-cmd="workbench.actions.view.problems">Ver problemas</button>');

    // mapa de calor semanal
    const mapa = h.mapa || [];
    let max = 0;
    for (const fila of mapa) for (const v of fila) max = Math.max(max, v);
    let calor = '<div class="calor"><span></span>';
    for (let hh = 0; hh < 24; hh++) calor += '<span class="h">' + (hh % 6 === 0 ? hh : '') + '</span>';
    mapa.forEach((fila, i) => {
      calor += '<span>' + esc((h.dias || [])[i] || '') + '</span>';
      fila.forEach((v, hh) => {
        const o = v && max ? (0.25 + 0.75 * Math.sqrt(v / max)).toFixed(2) : null;
        calor += '<span class="c' + (o ? '' : ' c0') + '"' + (o ? ' data-o="' + o + '"' : '') +
          ' title="' + esc((h.dias || [])[i] + ' ' + hh + ':00 · ' + tokens(v) + ' tokens') + '"></span>';
      });
    });
    calor += '</div>';
    html += tarjeta('Uso de Claude por hora (7 días)', calor);

    // vitrina de logros
    const ru = est.rutina;
    if (ru) {
      const hechos = ru.logros.filter((l) => l.fecha).length;
      html += tarjeta('Logros (' + hechos + ' de ' + ru.logros.length + ')', '<div class="logros">' +
        ru.logros.map((l) => '<div class="logro' + (l.fecha ? '' : ' bloqueado') + '" title="' +
          esc(l.nombre + ': ' + l.desc + (l.fecha ? ' · ' + new Date(l.fecha).toLocaleDateString('es-MX') : ' (pendiente)')) + '">' +
          (l.fecha ? l.icono : '❔') + '</div>').join('') + '</div>' +
        '<div class="nota">💧 Agua hoy: ' + ru.agua + ' de ' + ru.metaAgua + ' vasos' +
        (ru.diasSinErrores >= 1 ? ' · ' + ru.diasSinErrores + ' día' + (ru.diasSinErrores === 1 ? '' : 's') + ' sin errores' : '') + '</div>');
    }
    pintar('hoy', html);
  }

  // ---------- Sistema ----------
  function pintarSistema() {
    const s = est.sistema;
    let html;
    if (!s) html = tarjeta('Servidor', '<div class="nota">Midiendo…</div>');
    else {
      const cpu = s.cpu;
      html = tarjeta('Servidor · ' + s.host,
        renglon('CPU (' + s.nucleos + ' núcleos)', pct(cpu), cpu || 0, nivel(cpu || 0, 70, 90), 'Carga 1 min: ' + s.carga.toFixed(2)) +
        renglon('Memoria', bytes(s.memoria.usada) + ' / ' + bytes(s.memoria.total), s.memoria.pct, nivel(s.memoria.pct, 75, 90)) +
        s.discos.map((d) => renglon('Disco ' + d.ruta, bytes(d.usada) + ' / ' + bytes(d.total), d.pct, nivel(d.pct, 80, 90))).join('') +
        (s.temperatura != null ? renglon('Temperatura CPU', s.temperatura + ' °C', Math.min(100, (s.temperatura / 100) * 100), nivel(s.temperatura, 70, 85)) : '') +
        '<div class="nota">Encendido hace ' + (s.encendido >= 172800 ? Math.floor(s.encendido / 86400) + ' días' : duracion(s.encendido)) + '</div>');
    }
    const cl = est.clima;
    html += tarjeta('Clima', cl && !cl.error
      ? '<div class="cifras">' + cifra(cl.temp + ' °C', esc(cl.nombre || '')) + cifra(({ despejado: '☀️', nublado: '⛅', niebla: '🌫️', lluvia: '🌧️', tormenta: '⛈️', nieve: '❄️' })[cl.tipo] || '·', cl.tipo) + '</div>' +
        '<div class="nota">Open-Meteo · se ve en la ventana del laboratorio</div>'
      : '<div class="nota">' + (cl && cl.error ? '⚠ ' + esc(cl.error) + '. ' : '') +
        'Escribe tu ciudad en <code>koalaCientifico.clima.ciudad</code> para ver el clima real en la ventana (necesita internet).</div>');
    const lista = est.servicios || [];
    const filas = lista.map((x) => '<div class="servicio" title="' + esc(x.url) + '"><span class="luz' + (x.ok ? '' : ' mal') + '"></span>' +
      '<span class="nom">' + esc(x.nombre) + '</span><span class="val">' + esc(x.ok ? (x.ms + ' ms') : x.detalle) + '</span>' +
      '<button class="quitar" data-quitar="' + esc(x.url) + '" title="Dejar de vigilar">×</button></div>').join('');
    html += tarjeta('Servicios', (filas || '<div class="nota">Agrega direcciones para que el koala las vigile cada minuto (por ejemplo tu runserver de Django).</div>') +
      '<button class="boton-chico" id="btn-agregar-servicio">+ Vigilar un servicio</button>');
    pintar('sistema', html);
  }

  // Clics dentro de las pestañas (el contenido se vuelve a pintar, por eso se delega).
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.getAttribute) return;
    if (t.id === 'btn-agregar-servicio') vscode.postMessage({ tipo: 'agregarServicio' });
    else if (t.getAttribute('data-quitar')) vscode.postMessage({ tipo: 'quitarServicio', url: t.getAttribute('data-quitar') });
    else if (t.getAttribute('data-cmd')) vscode.postMessage({ tipo: 'comando', id: t.getAttribute('data-cmd') });
    else if (t.getAttribute('data-msg')) vscode.postMessage({ tipo: t.getAttribute('data-msg') });
  });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || m.tipo !== 'estado') return;
    est = m;
    pintarAlertas();
    pintarConsumo();
    pintarHoy();
    pintarSistema();
  });
})();
