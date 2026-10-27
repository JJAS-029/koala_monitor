// Koala científico: tarjetas de datos en carruseles (cada carrusel muestra la que elijas) y alertas.
// Se apoya en koala.js, que abre el canal con la extensión (window.koalaVscode).
// Textos: T('texto en español', ...) traduce con el diccionario que inyecta la extensión (window.koalaT).
(function () {
  'use strict';

  const vscode = window.koalaVscode || { postMessage() {}, getState() {}, setState() {} };
  const $ = (id) => document.getElementById(id);
  const T = window.koalaT || function (s) {
    const a = arguments;
    return String(s).replace(/\{(\d+)\}/g, (m, i) => (a[+i + 1] === undefined ? m : String(a[+i + 1])));
  };
  const LOCALE = window.KOALA_LOCALE || 'es-MX';
  let est = null;

  // ---------- Utilidades ----------
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function tokens(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + ' M';
    if (n >= 1e3) return T('{0} mil', Math.round(n / 1e3));
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
    if (min < 60) return T('hace {0} min', min);
    const h = Math.floor(min / 60);
    return h < 24 ? T('hace {0} h', h) : T('hace {0} d', Math.floor(h / 24));
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
  function ranking(obj, n, formato, clase) {
    const filas = Object.entries(obj || {}).sort((a, b) => b[1] - a[1]).slice(0, n);
    if (!filas.length) return '<div class="nota">' + T('Sin datos todavía.') + '</div>';
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

  // ---------- Carruseles ----------
  // Todas las tarjetas viven en #deposito; cada carrusel muestra una. Elegir una que ya está en otro carrusel las intercambia.
  const GRUPOS = [
    [T('Mascota'), [['mascota', T('Mascota')], ['alarmas', T('Alarmas')], ['pomodoro', T('Pomodoro')]]],
    [T('Consumo'), [['limites', T('Límites de tu plan')], ['fuente', T('Fuente del dato')], ['ritmo', T('Ritmo y proyección')],
      ['costo', T('Costo equivalente en la API')], ['huella', T('Huella estimada')], ['conversacion', T('Conversación actual')],
      ['cache', T('Eficiencia de caché (hoy)')]]],
    [T('Hoy'), [['resumen', T('Resumen del día')], ['proyectos', T('Por proyecto')], ['modelos', T('Por modelo')],
      ['herramientas', T('Herramientas de Claude')], ['git', 'Git'], ['problemas', T('Problemas del proyecto')],
      ['calor', T('Uso de Claude por hora (7 días)')], ['logros', T('Logros')]]],
    [T('Sistema'), [['servidor', T('Servidor')], ['clima', T('Clima')], ['servicios', T('Servicios')]]],
  ];
  const TARJETAS = [].concat(...GRUPOS.map((g) => g[1]));
  const IDS = TARJETAS.map((x) => x[0]);
  const NOMBRE = Object.fromEntries(TARJETAS);
  const INICIO = ['mascota', 'limites', 'resumen'];
  const MAX_CARRUSELES = 8;
  let carruseles = null; // ids de la tarjeta que muestra cada carrusel
  let conAlerta = new Set();

  const valido = (lista) => Array.isArray(lista) && lista.length > 0 && lista.every((x) => IDS.includes(x));
  function guardar(enviar) {
    try { vscode.setState(Object.assign({}, vscode.getState() || {}, { carruseles })); } catch (e) { /* sin estado */ }
    if (enviar) vscode.postMessage({ tipo: 'carruseles', valor: carruseles });
  }
  function nodo(id) { return document.querySelector('.tj[data-tj="' + id + '"]'); }

  function armar(animar) {
    const caja = $('carruseles'), dep = $('deposito');
    if (!caja || !dep) return;
    // devuelve las tarjetas al depósito y rehace los carruseles
    document.querySelectorAll('#carruseles .tj').forEach((n) => dep.appendChild(n));
    caja.innerHTML = '';
    carruseles.forEach((id, i) => {
      const c = document.createElement('div');
      c.className = 'carrusel';
      c.setAttribute('data-i', i);
      const opciones = GRUPOS.map((g) => '<optgroup label="' + esc(g[0]) + '">' +
        g[1].map((x) => '<option value="' + x[0] + '"' + (x[0] === id ? ' selected' : '') + '>' + esc(x[1]) +
          (conAlerta.has(x[0]) ? ' •' : '') + '</option>').join('') + '</optgroup>').join('');
      c.innerHTML = '<div class="car-cab">' +
        '<button class="flecha" data-car="prev" title="' + esc(T('Anterior')) + '" aria-label="' + esc(T('Anterior')) + '">‹</button>' +
        '<select class="car-sel" data-car="sel" title="' + esc(T('Elige qué ver aquí')) + '" aria-label="' + esc(T('Elige qué ver aquí')) + '">' + opciones + '</select>' +
        '<span class="car-pos">' + (IDS.indexOf(id) + 1) + '/' + IDS.length + '</span>' +
        '<button class="flecha" data-car="next" title="' + esc(T('Siguiente')) + '" aria-label="' + esc(T('Siguiente')) + '">›</button>' +
        (carruseles.length > 1 ? '<button data-car="quitar" title="' + esc(T('Quitar este carrusel')) + '" aria-label="' + esc(T('Quitar este carrusel')) + '">×</button>' : '<span></span>') +
        '</div><div class="car-cuerpo"></div><div class="car-puntos">' +
        IDS.map((x) => '<i class="' + (x === id ? 'sel' : conAlerta.has(x) ? 'alerta-punto' : '') + '"></i>').join('') + '</div>';
      const cuerpo = c.querySelector('.car-cuerpo');
      const n = nodo(id);
      if (n) cuerpo.appendChild(n);
      if (animar && animar.i === i) cuerpo.classList.add(animar.dir > 0 ? 'entra-der' : 'entra-izq');
      caja.appendChild(c);
    });
    const agregar = $('car-agregar');
    if (agregar) agregar.disabled = carruseles.length >= MAX_CARRUSELES;
  }

  // Muestra `id` en el carrusel i; si ya se veía en otro, los intercambia.
  function mostrar(i, id, dir) {
    const otro = carruseles.indexOf(id);
    if (otro === i) return;
    if (otro >= 0) carruseles[otro] = carruseles[i];
    carruseles[i] = id;
    guardar(true);
    armar({ i, dir: dir || 1 });
  }
  // Flechas: la siguiente tarjeta que no se esté viendo en otro carrusel.
  function mover(i, dir) {
    let k = IDS.indexOf(carruseles[i]);
    for (let n = 0; n < IDS.length; n++) {
      k = (k + dir + IDS.length) % IDS.length;
      if (!carruseles.includes(IDS[k])) return mostrar(i, IDS[k], dir);
    }
  }
  function agregarCarrusel() {
    if (carruseles.length >= MAX_CARRUSELES) return;
    const libre = IDS.find((x) => !carruseles.includes(x));
    if (!libre) return;
    carruseles.push(libre);
    guardar(true);
    armar();
  }
  // Lleva una tarjeta a la vista (p. ej. al tocar una alerta): si no se ve, la pone en el último carrusel.
  function irA(id) {
    if (!IDS.includes(id)) return;
    let i = carruseles.indexOf(id);
    if (i < 0) { i = carruseles.length - 1; mostrar(i, id, 1); }
    const c = document.querySelector('.carrusel[data-i="' + i + '"]');
    if (c && c.scrollIntoView) c.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  document.addEventListener('click', (e) => {
    const b = e.target && e.target.closest ? e.target.closest('[data-car]') : null;
    if (!b || b.tagName === 'SELECT') return;
    const i = Number(b.closest('.carrusel').getAttribute('data-i'));
    const que = b.getAttribute('data-car');
    if (que === 'prev') mover(i, -1);
    else if (que === 'next') mover(i, 1);
    else if (que === 'quitar' && carruseles.length > 1) { carruseles.splice(i, 1); guardar(true); armar(); }
  });
  document.addEventListener('change', (e) => {
    const sel = e.target;
    if (!sel || sel.getAttribute('data-car') !== 'sel') return;
    const i = Number(sel.closest('.carrusel').getAttribute('data-i'));
    mostrar(i, sel.value, IDS.indexOf(sel.value) >= IDS.indexOf(carruseles[i]) ? 1 : -1);
  });
  // Teclado: ← → con el foco en la cabecera de un carrusel.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const cab = e.target && e.target.closest ? e.target.closest('.car-cab') : null;
    if (!cab || e.target.tagName === 'SELECT') return;
    e.preventDefault();
    const i = Number(cab.closest('.carrusel').getAttribute('data-i'));
    mover(i, e.key === 'ArrowRight' ? 1 : -1);
    const nuevo = document.querySelector('.carrusel[data-i="' + i + '"] [data-car="' + (e.key === 'ArrowRight' ? 'next' : 'prev') + '"]');
    if (nuevo) nuevo.focus();
  });
  // Deslizar con el mouse o el dedo sobre el cuerpo (no sobre botones ni campos).
  let arrastre = null;
  document.addEventListener('pointerdown', (e) => {
    const cuerpo = e.target && e.target.closest ? e.target.closest('.car-cuerpo') : null;
    if (!cuerpo || e.target.closest('button, input, select, textarea, a')) return;
    arrastre = { x: e.clientX, y: e.clientY, i: Number(cuerpo.closest('.carrusel').getAttribute('data-i')) };
  });
  document.addEventListener('pointerup', (e) => {
    if (!arrastre) return;
    const dx = e.clientX - arrastre.x, dy = e.clientY - arrastre.y;
    const i = arrastre.i;
    arrastre = null;
    if (Math.abs(dx) > 40 && Math.abs(dx) > 1.5 * Math.abs(dy)) mover(i, dx < 0 ? 1 : -1);
  });
  const btnAgregar = $('car-agregar');
  if (btnAgregar) btnAgregar.addEventListener('click', agregarCarrusel);
  const btnRest = $('car-restablecer');
  if (btnRest) btnRest.addEventListener('click', () => { carruseles = INICIO.slice(); guardar(true); armar(); });

  try {
    const guardados = (vscode.getState() || {}).carruseles;
    if (valido(guardados)) carruseles = guardados.slice();
  } catch (e) { /* sin estado */ }
  const desdeExtension = !!carruseles;
  let cargadoDeExtension = false;
  if (!carruseles) carruseles = INICIO.slice();
  armar();
  // Para la vista previa y pruebas: fijar los carruseles a mano.
  window.koalaCarruseles = { fijar(lista) { if (valido(lista)) { carruseles = lista.slice(); armar(); } }, tarjetas: () => IDS.slice() };

  // ---------- Alertas ----------
  // Tocar una alerta lleva su tarjeta a la vista; las tarjetas con alerta llevan un punto rojo en el carrusel.
  function pintarAlertas() {
    const a = (est.alertas || []).slice(0, 2);
    pintar('alertas', a.map((x) => '<div class="alerta n' + x.nivel + '"' + (x.tarjeta ? ' data-ir="' + esc(x.tarjeta) + '" title="' + esc(T('Ver {0}', NOMBRE[x.tarjeta] || '')) + '"' : '') + '>' + esc(x.texto) + '</div>').join(''));
    const nuevas = new Set((est.alertas || []).map((x) => x.tarjeta).filter(Boolean));
    if ([...nuevas].join() !== [...conAlerta].join()) { conAlerta = nuevas; armar(); }
  }

  // ---------- Consumo ----------
  function pintarConsumo() {
    const u = est.uso || {};
    const r = u.ritmo || {};
    let ritmo;
    if (r.estado === 'alcanza') {
      ritmo = '<div class="ritmo alcanza">⚠ ' + T('A este ritmo llegas al 100 % a las {0}, antes del corte de las {1}.', hora(r.eta), hora(u.cinco.reinicio)) + '</div>';
    } else if (r.estado === 'holgado') {
      ritmo = '<div class="ritmo holgado">✓ ' + T('Vas holgado: a este ritmo llegarías al 100 % hasta las {0}, después del corte.', hora(r.eta)) + '</div>';
    } else if (r.estado === 'quieto') {
      ritmo = '<div class="ritmo">' + T('Sin consumo en los últimos 30 min.') + '</div>';
    } else {
      ritmo = '<div class="ritmo">' + T('Falta el % oficial para proyectar; ritmo local abajo.') + '</div>';
    }
    const cifrasRitmo = '<div class="cifras">' +
      cifra(tokens(r.tokPorMin || 0) + '/min', T('tokens, últimos 30 min')) +
      cifra(r.pctPorHora != null ? r.pctPorHora.toFixed(1) + ' %/h' : '—', T('de la sesión por hora')) + '</div>';

    const s = u.sesion;
    let conv;
    if (s) {
      const ctx = s.contexto_pct;
      conv = (ctx != null ? renglon(T('Contexto'), pct(ctx), ctx, nivel(ctx, 70, 85),
        T('Qué tan llena está la conversación; cerca del 100 % Claude la resume (compacta) y olvida detalles')) : '') +
        '<div class="cifras">' +
        cifra(s.costo_usd != null ? '$' + s.costo_usd.toFixed(2) : '—', T('USD equivalentes')) +
        cifra('+' + (s.lineas_mas || 0) + ' / −' + (s.lineas_menos || 0), T('líneas cambiadas')) +
        cifra(s.duracion_ms ? duracion(s.duracion_ms / 1000) : '—', T('de conversación')) + '</div>' +
        '<div class="nota">' + esc(s.carpeta || T('conversación')) + ' · ' + T('dato {0}', hace(s.ts)) + '</div>';
    } else {
      conv = '<div class="nota">' + T('Llega desde la status line de Claude Code (al usar <code>claude</code> en una terminal).') + '</div>';
    }

    const h = est.hoy || {};
    const cache = h.cachePct;
    const eficiencia = cache == null ? '<div class="nota">' + T('Sin mensajes hoy.') + '</div>' :
      renglon(T('Reutilizado de caché'), pct(cache), cache, nivel(100 - cache, 30, 60),
        T('Parte de la entrada que Claude leyó de caché en vez de procesarla de nuevo; alto = sesiones largas y eficientes')) +
      '<div class="nota">' + (cache >= 80 ? T('Muy eficiente: conversaciones largas y con contexto estable.') :
        cache >= 50 ? T('Aceptable.') : T('Baja: muchas conversaciones nuevas o cambios de contexto.')) + '</div>';

    pintar('c-fuente', tarjetaFuente(u));
    pintar('c-ritmo', ritmo + cifrasRitmo);
    pintar('c-costo', tarjetaCosto());
    pintar('c-huella', tarjetaHuella());
    pintar('c-conversacion', conv);
    pintar('c-cache', eficiencia);
  }

  function dinero(v) {
    if (v >= 1000) return '$' + Math.round(v).toLocaleString(LOCALE);
    if (v >= 100) return '$' + v.toFixed(0);
    return '$' + v.toFixed(2);
  }

  function tarjetaFuente(u) {
    const api = u.api || {};
    let html;
    if (u.fuente === 'anthropic') html = '<div class="nota">✓ ' + T('Dato real de api.anthropic.com, {0}.', hace(u.actualizado)) + '</div>';
    else if (u.fuente === 'statusline') html = '<div class="nota">' + T('Dato de la status line de Claude Code, {0}.', hace(u.actualizado)) + '</div>';
    else html = '<div class="nota">' + T('Sin dato oficial todavía.') + '</div>';
    (u.extras || []).forEach((x) => {
      html += renglon(x.nombre, pct(x.pct), x.pct, nivel(x.pct, 75, 90), x.reinicio ? T('Se reinicia {0}', hora(x.reinicio)) : '');
    });
    if (api.activo) {
      if (api.error) html += '<div class="nota">⚠ ' + esc(api.error) + '</div>';
      html += '<button class="boton-chico" data-msg="consultarApi">' + T('Consultar ahora') + '</button>';
    } else {
      html += '<div class="nota">' + T('Puedes pedir el % real directo a Anthropic con la sesión de Claude Code de este equipo (lo mismo que hace el panel de Claude).') + '</div>' +
        '<button class="boton-chico" data-msg="activarApi">' + T('Usar dato directo de Anthropic') + '</button>';
    }
    return html;
  }

  function tarjetaCosto() {
    const c = est.costos;
    if (!c) return '<div class="nota">' + T('Sin datos todavía.') + '</div>';
    const mensual = (c.mes.usd / c.diasMes) * 30;
    let html = '<div class="cifras">' +
      cifra(dinero(c.hoy.usd), T('hoy')) +
      cifra(dinero(c.cinco.usd), T('esta sesión (5 h)')) +
      cifra(dinero(c.semana.usd), T('7 días')) +
      cifra(dinero(c.mes.usd), c.diasMes < 30 ? T('{0} días registrados', c.diasMes) : T('30 días')) + '</div>';
    html += ranking(c.modelosHoy, 4, dinero, 'morado');
    if (c.planUsd > 0) {
      const veces = mensual / c.planUsd;
      html += '<div class="ritmo ' + (veces >= 1 ? 'holgado' : '') + '">' +
        (veces >= 1
          ? T('A este paso, ~{0} al mes en la API: {1}× lo que pagas ({2}).', dinero(mensual), veces.toFixed(1), dinero(c.planUsd))
          : T('A este paso, ~{0} al mes en la API: menos de lo que pagas ({1}).', dinero(mensual), dinero(c.planUsd))) + '</div>';
    } else {
      html += '<div class="nota">' + T('A este paso, ~{0} al mes. Escribe lo que pagas en <code>koalaCientifico.costoPlanMensualUSD</code> para comparar.', dinero(mensual)) + '</div>';
    }
    html += '<div class="nota">' + T('Lo que costaría pagando por token con los precios de la API (entrada, salida, escritura y lectura de caché de cada modelo). Con una suscripción no se cobra así.') + '</div>';
    return html;
  }

  function energia(wh) {
    return wh >= 1000 ? (wh / 1000).toFixed(1) + ' kWh' : Math.round(wh) + ' Wh';
  }
  function agua(ml) {
    return ml >= 1000 ? (ml / 1000).toFixed(1) + ' L' : Math.round(ml) + ' mL';
  }
  function tarjetaHuella() {
    const c = est.costos;
    if (!c) return '<div class="nota">' + T('Sin datos todavía.') + '</div>';
    const f = c.aguaMlPorWh;
    const vasos = (c.hoy.wh * f) / 250;
    const cargas = c.hoy.wh / 15; // un celular ≈ 15 Wh
    const periodo = c.diasMes < 30 ? c.diasMes + ' d' : '30 d';
    let html = '<div class="cifras">' +
      cifra(energia(c.hoy.wh), T('energía hoy')) +
      cifra(agua(c.hoy.wh * f), T('agua hoy')) +
      cifra(energia(c.mes.wh), T('energía {0}', periodo)) +
      cifra(agua(c.mes.wh * f), T('agua {0}', periodo)) + '</div>';
    html += '<div class="nota">' + T('Hoy ≈ {0} y ≈ {1} cargas de celular. Rango del agua: {2} a {3}.',
      vasos >= 1 ? T('{0} vasos de agua', vasos.toFixed(1)) : T('{0} de agua', agua(c.hoy.wh * f)),
      cargas.toFixed(1), agua(c.hoy.wh * 0.5), agua(c.hoy.wh * 5)) + '</div>';
    html += '<div class="nota">' + T('Estimación, no medición: Anthropic no publica energía ni agua por modelo. Energía con factores por token (entrada 390, salida 1950, escritura 490 y lectura de caché 39 Wh por millón; S. Couch con datos de Epoch AI) y agua con {0} mL por Wh (enfriamiento + generación eléctrica; ajustable en <code>koalaCientifico.aguaMlPorWh</code>).', f) + '</div>';
    return html;
  }

  // ---------- Alarmas ----------
  function pintarAlarmas() {
    const lista = est.alarmas || [];
    pintar('alarmas-lista', lista.length ? lista.map((a) =>
      '<div class="alarma' + (a.activa ? '' : ' apagada') + '">' +
      '<button data-alarma-alternar="' + esc(a.id) + '" title="' + (a.activa ? T('Apagar') : T('Encender')) + '">' + (a.activa ? '⏰' : '💤') + '</button>' +
      '<span class="hora">' + esc(a.hora) + '</span><span class="msg" title="' + esc(a.mensaje) + '">' + esc(a.mensaje) + '</span>' +
      '<span class="rep">' + esc(a.texto) + '</span>' +
      '<button data-alarma-borrar="' + esc(a.id) + '" title="' + T('Borrar') + '">×</button></div>').join('')
      : '<div class="nota">' + T('Sin alarmas. Pon una hora y un mensaje: el koala te avisa con su despertador.') + '</div>');
  }
  const btnAlarma = $('alarma-agregar');
  if (btnAlarma) btnAlarma.addEventListener('click', () => {
    const hora = ($('alarma-hora') || {}).value, msg = $('alarma-msg'), rep = ($('alarma-rep') || {}).value;
    if (!hora) { if ($('alarma-hora')) $('alarma-hora').focus(); return; }
    vscode.postMessage({ tipo: 'crearAlarma', hora, mensaje: msg ? msg.value : '', repeticion: rep || 'una' });
    if (msg) msg.value = '';
  });
  const msgAlarma = $('alarma-msg');
  if (msgAlarma) msgAlarma.addEventListener('keydown', (e) => { if (e.key === 'Enter' && btnAlarma) btnAlarma.click(); });

  // ---------- Hoy ----------
  function pintarHoy() {
    const h = est.hoy || {};
    const p = est.pomodoro || {};
    pintar('c-resumen', '<div class="cifras">' +
      cifra(tokens(h.tokens || 0), T('tokens de Claude')) +
      cifra(String(h.mensajes || 0), T('respuestas')) +
      cifra(duracion(est.activoHoy || 0), T('activo en el editor')) +
      cifra(String(p.hoy || 0), T('pomodoros')) + '</div>');
    pintar('c-proyectos', ranking(h.proyectos, 5, tokens, ''));
    pintar('c-modelos', ranking(h.modelos, 4, tokens, 'morado'));
    pintar('c-herramientas', ranking(h.herramientas, 6, (v) => v + '×', 'verde'));

    // git
    const repos = est.git;
    let git;
    if (!repos) git = '<div class="nota">' + T('La extensión de git de VS Code no está activa.') + '</div>';
    else if (!repos.length) git = '<div class="nota">' + T('No hay repositorios abiertos.') + '</div>';
    else {
      git = repos.map((g) => '<div class="repo"><b>' + esc(g.nombre) + '</b> · ' + esc(g.rama || T('sin rama')) + '<br>' +
        (g.cambios === 1 ? T('1 cambio sin commit') : g.cambios ? T('{0} cambios sin commit', g.cambios) : T('sin cambios pendientes')) +
        ' · ' + (g.commitsHoy === 1 ? T('1 commit hoy') : T('{0} commits hoy', g.commitsHoy)) +
        (g.porSubir ? ' · ' + T('{0} por subir', g.porSubir) : '') +
        (g.ultimoCommit ? ' · ' + T('último {0}', hace(g.ultimoCommit)) : '') + '</div>').join('');
    }
    const r = est.racha || {};
    if (r.dias) {
      const medalla = r.dias >= 14 ? '🥇' : r.dias >= 7 ? '🥈' : r.dias >= 3 ? '🥉' : '';
      git += '<div class="repo">' + medalla + ' ' + (r.dias === 1 ? T('Racha de <b>1 día</b> con commits') : T('Racha de <b>{0} días</b> con commits', r.dias)) +
        (r.hoy ? '' : ' · ' + T('haz uno hoy para no romperla')) + '</div>';
    }
    pintar('c-git', git);

    const d = est.diag || {};
    pintar('c-problemas', '<div class="cifras">' +
      cifra(String(d.errores || 0), T('errores')) + cifra(String(d.avisos || 0), T('advertencias')) +
      cifra(String(d.archivos || 0), T('archivos')) + '</div>' +
      '<button class="boton-chico" data-cmd="workbench.actions.view.problems">' + T('Ver problemas') + '</button>');

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
    pintar('c-calor', calor);

    // vitrina de logros
    const ru = est.rutina;
    if (ru) {
      const hechos = ru.logros.filter((l) => l.fecha).length;
      pintar('c-logros', '<div class="nota">' + T('{0} de {1} desbloqueados', hechos, ru.logros.length) + '</div><div class="logros">' +
        ru.logros.map((l) => '<div class="logro' + (l.fecha ? '' : ' bloqueado') + '" title="' +
          esc(l.nombre + ': ' + l.desc + (l.fecha ? ' · ' + new Date(l.fecha).toLocaleDateString(LOCALE) : ' ' + T('(pendiente)'))) + '">' +
          (l.fecha ? l.icono : '❔') + '</div>').join('') + '</div>' +
        '<div class="nota">💧 ' + T('Agua hoy: {0} de {1} vasos', ru.agua, ru.metaAgua) +
        (ru.diasSinErrores === 1 ? ' · ' + T('1 día sin errores') : ru.diasSinErrores > 1 ? ' · ' + T('{0} días sin errores', ru.diasSinErrores) : '') + '</div>');
    }
  }

  // ---------- Sistema ----------
  const NOMBRE_CLIMA = { despejado: 'despejado', nublado: 'nublado', niebla: 'niebla', lluvia: 'lluvia', tormenta: 'tormenta', nieve: 'nieve' };
  function pintarSistema() {
    const s = est.sistema;
    if (!s) pintar('c-servidor', '<div class="nota">' + T('Midiendo…') + '</div>');
    else {
      const cpu = s.cpu;
      pintar('c-servidor', '<div class="nota">' + esc(s.host) + '</div>' +
        renglon(T('CPU ({0} núcleos)', s.nucleos), pct(cpu), cpu || 0, nivel(cpu || 0, 70, 90), T('Carga 1 min: {0}', s.carga.toFixed(2))) +
        renglon(T('Memoria'), bytes(s.memoria.usada) + ' / ' + bytes(s.memoria.total), s.memoria.pct, nivel(s.memoria.pct, 75, 90)) +
        s.discos.map((d) => renglon(T('Disco {0}', d.ruta), bytes(d.usada) + ' / ' + bytes(d.total), d.pct, nivel(d.pct, 80, 90))).join('') +
        (s.temperatura != null ? renglon(T('Temperatura CPU'), s.temperatura + ' °C', Math.min(100, (s.temperatura / 100) * 100), nivel(s.temperatura, 70, 85)) : '') +
        '<div class="nota">' + T('Encendido hace {0}', s.encendido >= 172800 ? T('{0} días', Math.floor(s.encendido / 86400)) : duracion(s.encendido)) + '</div>');
    }
    const cl = est.clima;
    const ICONO_CLIMA = { despejado: '☀️', nublado: '⛅', niebla: '🌫️', lluvia: '🌧️', tormenta: '⛈️', nieve: '❄️' };
    const cuerpoClima = cl && !cl.error
      ? '<div class="cifras">' + cifra(cl.temp + ' °C', cl.nombre || '') + cifra(ICONO_CLIMA[cl.tipo] || '·', T(NOMBRE_CLIMA[cl.tipo] || cl.tipo)) + '</div>' +
        '<div class="nota">' + T('Open-Meteo · se ve en la ventana y el termómetro del laboratorio') + '</div>'
      : '<div class="nota">' + (cl && cl.error ? '⚠ ' + esc(cl.error) + '. ' : '') +
        T('Elige tu ciudad para ver el clima real en la ventana y el termómetro (necesita internet). El koala no detecta tu ubicación por su cuenta.') + '</div>';
    pintar('c-clima', cuerpoClima +
      '<button class="boton-chico" data-msg="elegirCiudad">' + (cl && !cl.error ? T('Cambiar ciudad') : T('Elegir ciudad')) + '</button>');
    const lista = est.servicios || [];
    const filas = lista.map((x) => '<div class="servicio" title="' + esc(x.url) + '"><span class="luz' + (x.ok ? '' : ' mal') + '"></span>' +
      '<span class="nom">' + esc(x.nombre) + '</span><span class="val">' + esc(x.ok ? (x.ms + ' ms') : x.detalle) + '</span>' +
      '<button class="quitar" data-quitar="' + esc(x.url) + '" title="' + T('Dejar de vigilar') + '">×</button></div>').join('');
    pintar('c-servicios', (filas || '<div class="nota">' + T('Agrega direcciones para que el koala las vigile cada minuto (por ejemplo tu runserver de Django).') + '</div>') +
      '<button class="boton-chico" id="btn-agregar-servicio">' + T('+ Vigilar un servicio') + '</button>');
  }

  // Clics dentro de las pestañas (el contenido se vuelve a pintar, por eso se delega).
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.getAttribute) return;
    const alerta = t.closest && t.closest('.alerta[data-ir]');
    if (alerta) irA(alerta.getAttribute('data-ir'));
    else if (t.id === 'btn-agregar-servicio') vscode.postMessage({ tipo: 'agregarServicio' });
    else if (t.getAttribute('data-quitar')) vscode.postMessage({ tipo: 'quitarServicio', url: t.getAttribute('data-quitar') });
    else if (t.getAttribute('data-cmd')) vscode.postMessage({ tipo: 'comando', id: t.getAttribute('data-cmd') });
    else if (t.getAttribute('data-msg')) vscode.postMessage({ tipo: t.getAttribute('data-msg') });
    else if (t.getAttribute('data-alarma-alternar')) vscode.postMessage({ tipo: 'alternarAlarma', id: t.getAttribute('data-alarma-alternar') });
    else if (t.getAttribute('data-alarma-borrar')) vscode.postMessage({ tipo: 'borrarAlarma', id: t.getAttribute('data-alarma-borrar') });
  });

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || m.tipo !== 'estado') return;
    est = m;
    // Primera vez en este equipo (o tras recargar): los carruseles guardados por la extensión (viajan con Settings Sync).
    if (!desdeExtension && !cargadoDeExtension && valido(m.carruseles)) { carruseles = m.carruseles.slice(); guardar(false); armar(); }
    cargadoDeExtension = true;
    pintarAlertas();
    pintarAlarmas();
    pintarConsumo();
    pintarHoy();
    pintarSistema();
  });
})();
