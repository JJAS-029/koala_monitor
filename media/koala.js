// Koala científico: dibujo en canvas (pixel art) y comportamiento.
// Corre dentro del webview. Solo usa fillRect: nítido a cualquier escala y fácil de probar.
(function () {
  'use strict';

  const vscode = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : { postMessage() {} };
  window.koalaVscode = vscode; // panel.js usa el mismo canal (acquireVsCodeApi solo se puede llamar una vez)
  const lienzo = document.getElementById('lienzo');
  const ctx = lienzo.getContext('2d');
  const C = 6; // tamaño de una celda del pixel art, en px de CSS

  const COL = {
    pelaje: '#9AA3AD', pelajeS: '#7D8590', pata: '#737B85', pie: '#5C636C', oreja: '#E3E6EA',
    bata: '#F2F2F2', bataS: '#CFD3D8', camisa: '#7FB8E0', nariz: '#2B2B2B', narizL: '#4A4A4A',
    negro: '#141414', boca: '#6B2F2F', lente: '#7FD3F0', correa: '#3A4A5A', pluma: '#E0524D',
    laptop: '#8E9196', laptopS: '#6B6E73', pantalla: '#9FE8FF', vidrio: '#CFE9F5',
    tallo: '#8B5A3C', hoja: '#5DAE6B', hojaS: '#3F8A50', pelota: '#E0524D', pelotaS: '#B53A36',
    corazon: '#E85A7A', z: '#7FB8E0', blanco: '#FFFFFF', borde: '#3A3A3A', sudor: '#7FD3F0',
    verde: '#5BC46A', ambar: '#F2B33D', rojo: '#E0524D', morado: '#A77BE0',
  };

  // ---------- Estado que manda la extensión ----------
  let est = {
    necesidades: { saciedad: 80, animo: 80, energia: 80 },
    durmiendo: false, trabajando: false, claude: false, uso: null, umbral: 90,
  };
  const pendientes = [];
  const datosAccion = {}; // datos del último evento (p. ej. mensaje del commit)

  // ---------- Lienzo ----------
  let W = 300, H = 150, dpr = 1, suelo = 134;
  function ajustar() {
    dpr = window.devicePixelRatio || 1;
    W = lienzo.clientWidth || 300;
    H = lienzo.clientHeight || 150;
    lienzo.width = Math.round(W * dpr);
    lienzo.height = Math.round(H * dpr);
    suelo = H - 16;
    if (k) k.x = Math.max(7 * C, Math.min(W - 7 * C, k.x));
  }

  function rect(x, y, w, h, color, alfa) {
    if (w < 0) { x += w; w = -w; }
    if (h < 0) { y += h; h = -h; }
    const x0 = Math.round(x * dpr), y0 = Math.round(y * dpr);
    const x1 = Math.round((x + w) * dpr), y1 = Math.round((y + h) * dpr);
    if (x1 <= x0 || y1 <= y0) return;
    ctx.globalAlpha = alfa == null ? 1 : alfa;
    ctx.fillStyle = color;
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  }

  // Sistema de referencia del sprite: (0,0) = centro de los pies; y negativa hacia arriba.
  let S = { ox: 0, oy: 0, sx: 1, sy: 1 };
  function cel(x, y, w, h, color, alfa) {
    rect(S.ox + x * C * S.sx, S.oy + y * C * S.sy, w * C * S.sx, h * C * S.sy, color, alfa);
  }
  function glifo(patron, x, y, px, color, alfa) {
    for (let f = 0; f < patron.length; f++) {
      for (let c = 0; c < patron[f].length; c++) {
        if (patron[f][c] === 'X') rect(x + c * px, y + f * px, px, px, color, alfa);
      }
    }
  }
  const G_CORAZON = ['.XX.XX.', 'XXXXXXX', 'XXXXXXX', '.XXXXX.', '..XXX..', '...X...'];
  const G_Z = ['XXXXX', '...X.', '..X..', '.X...', 'XXXXX'];
  const G_PELOTA = ['.XXX.', 'XXXXX', 'XXXXX', 'XXXXX', '.XXX.'];
  const G_EXCL = ['X', 'X', 'X', '.', 'X'];
  const G_PREGUNTA = ['.XXX.', 'X...X', '...X.', '..X..', '.....', '..X..'];

  const suave = (p) => p * p * (3 - 2 * p); // smoothstep
  const mezcla = (a, b, p) => a + (b - a) * p;
  const azar = (a, b) => a + Math.random() * (b - a);

  // ---------- El koala ----------
  const k = {
    x: 150, alt: 0, balanceo: 0,
    pose: 'frente', tVolteo: 1, def: { sx: 1, sy: 1 },
    ojos: null, mirar: 0, dir: 1, paso: 0, caminando: false,
    brazos: 'normal', tecleo: 0, boca: false, sudor: false,
    laptop: null, frasco: null, sosteniendo: null, exp: null, brazoY: 0, hollin: 0,
    cargado: false, cayendo: false, vAlt: 0, cabeceo: 0, escobaX: 0,
    modo: 'libre', texto: '',
    parpadeo: 0, proxParpadeo: 3.7, t: 0,
  };
  const DEFORMACION = { frente: [1, 1], aplastado: [1.18, 0.8], estirado: [0.9, 1.13], sentado: [1, 1] };

  function ponerPose(pose) {
    if (pose === k.pose) return;
    k.pose = pose;
    k.tVolteo = 0; // se "voltea": se estrecha y vuelve a su ancho en 0.16 s
  }
  function posturaBase() {
    k.alt = 0; k.balanceo = 0; k.caminando = false; k.brazos = 'normal';
    k.ojos = null; k.boca = false; k.sudor = false; k.frasco = null; k.sosteniendo = null;
    ponerPose('frente');
  }

  function usoMaximo() {
    const u = est.uso;
    if (!u) return 0;
    return Math.max(u.cinco && !u.cinco.reiniciada ? u.cinco.pct : 0, u.semana && !u.semana.reiniciada ? u.semana.pct : 0);
  }
  function ojosBase() {
    const n = est.necesidades;
    if (usoMaximo() >= est.umbral || Math.min(n.saciedad, n.animo) < 20) return 'tristes';
    return 'abiertos';
  }

  // ---------- Motor de pasos ----------
  // Un paso = { d: segundos, ini(), act(p, dt, t), hasta(), fin(), libre: interrumpible }
  let cola = [];
  let paso = null, tPaso = 0;

  function correrPasos(dt) {
    let guarda = 0;
    while (!paso && guarda++ < 5) {
      if (!cola.length) decidir();
      paso = cola.shift() || null;
      tPaso = 0;
      if (paso && paso.ini) paso.ini();
    }
    if (!paso) return;
    tPaso += dt;
    const p = paso.d === Infinity ? 0 : Math.min(1, tPaso / paso.d);
    if (paso.act) paso.act(p, dt, tPaso);
    if (p >= 1 || (paso.hasta && paso.hasta()) || tPaso > (paso.max || 60)) {
      const fin = paso.fin;
      paso = null;
      if (fin) fin();
    }
  }

  function interrumpir() {
    if (!paso || !paso.libre) return;
    if (cola.some((p) => !p.libre)) return;
    cola = [];
    paso = null;
    if (k.modo === 'libre') posturaBase();
  }

  const esperar = (d, extra) => Object.assign({ d }, extra || {});

  function caminarA(xd, libre, velocidad) {
    let x0 = 0, dist = 0;
    const v = velocidad || 38;
    return {
      d: 0.01, libre,
      ini() {
        x0 = k.x;
        xd = Math.max(7 * C, Math.min(W - 7 * C, xd));
        dist = Math.abs(xd - x0);
        this.d = Math.max(0.01, dist / v);
        k.dir = xd >= x0 ? 1 : -1;
        k.caminando = dist > 2;
        ponerPose('frente');
      },
      act(p) {
        const x = mezcla(x0, xd, suave(p));
        k.paso += Math.abs(x - k.x) * 0.35;
        k.x = x;
        k.mirar = k.dir;
      },
      fin() { k.caminando = false; },
    };
  }

  // ---------- Qué hacer ahora ----------
  // Sale del modo actual (guarda la laptop, recoge la mesa o despierta). true si encoló pasos.
  function salir() {
    if (k.modo === 'trabajo') { guardarLaptop(); return true; }
    if (k.modo === 'experimento') { recogerExperimento(); return true; }
    if (k.modo === 'dormido') { despertar(); return true; }
    if (k.modo === 'siesta') { despertarDeSiesta(); return true; }
    return false;
  }
  const enSiesta = () => est.minutosSiesta > 0 && est.inactivoMin >= est.minutosSiesta && !est.trabajando;
  const enEnfoque = () => !!(est.pomodoro && est.pomodoro.fase === 'enfoque');

  function decidir() {
    if (pendientes.length) {
      if (salir()) return;
      return accion(pendientes.shift());
    }
    if (est.claudeNecesita) {
      if (salir()) return;
      return manoLevantada();
    }
    if (est.durmiendo) {
      if (k.modo === 'dormido') return seguirDormido();
      if (salir()) return;
      return dormirse();
    }
    if (enEnfoque()) {
      if (k.modo === 'experimento') return experimentar();
      if (salir()) return;
      return prepararExperimento();
    }
    if (enSiesta()) {
      if (k.modo === 'siesta') return seguirSiesta();
      if (salir()) return;
      return sentarseATrabajar('siesta');
    }
    if (est.trabajando) {
      if (k.modo === 'trabajo') return teclear();
      if (salir()) return;
      return sentarseATrabajar();
    }
    if (salir()) return;
    return ocio();
  }

  function accion(a) {
    if (a === 'comer') return comer();
    if (a === 'jugar') return jugar();
    if (a === 'mimar') return mimar();
    if (a === 'festejar') return bailar(true);
    if (a === 'festejarPomodoro') return bailar(true, '¡Experimento terminado! Hora de descansar');
    if (a === 'pedirAtencion') return saltar();
    if (a === 'errores0') return barrer(datosAccion.errores0 || {});
    if (a === 'servicioCaido') return apagarFuego(datosAccion.servicioCaido || {});
    if (a === 'servicioVuelve') return aplaudir('✓ ' + ((datosAccion.servicioVuelve || {}).nombre || 'El servicio') + ' volvió a responder');
    if (a === 'claudeListo') return claudeListo(datosAccion.claudeListo || {});
    if (a === 'comandoOk') return comandoOk(datosAccion.comandoOk || {});
    if (a === 'comandoFallo') return comandoFallo(datosAccion.comandoFallo || {});
    if (a === 'festejarCommit') return festejarCommit(datosAccion.festejarCommit || {});
    if (a === 'festejarPush') return festejarPush(datosAccion.festejarPush || {});
    return ocio();
  }

  // ---------- Trabajo ----------
  function sentarseATrabajar(modoFinal) {
    const xMax = W - 14 * C, xMin = 7 * C;
    if (k.x > xMax || k.x < xMin) cola.push(caminarA(Math.max(xMin, xMax > xMin ? Math.min(k.x, xMax) : xMin)));
    cola.push(
      esperar(0.45, { ini() { posturaBase(); k.mirar = 0; k.ojos = 'guino'; k.brazos = 'atras'; k.texto = 'Saca su laptop…'; } }),
      esperar(0.5, {
        ini() { k.ojos = null; k.brazos = 'arriba-der'; k.laptop = { x: 1.5, y: -7, abierta: false }; },
        act(p) { const q = suave(p); k.laptop.x = mezcla(1.5, 2.5, q); k.laptop.y = mezcla(-7, -11.5, q); },
      }),
      esperar(0.45, {
        ini() { k.brazos = 'lado'; },
        act(p) { const q = suave(p); k.laptop.x = mezcla(2.5, 6.5, q); k.laptop.y = mezcla(-11.5, -5, q); },
      }),
      esperar(0.4, {
        ini() { ponerPose('aplastado'); k.brazos = 'normal'; },
        act(p) { const q = suave(p); k.laptop.x = mezcla(6.5, 5, q); k.laptop.y = mezcla(-5, -0.8, q); },
      }),
      esperar(0.3, { ini() { ponerPose('estirado'); k.laptop.abierta = true; k.brazos = 'arriba'; } }),
      esperar(0.2, { ini() { ponerPose('sentado'); k.brazos = 'normal'; k.modo = modoFinal || 'trabajo'; } })
    );
  }

  function guardarLaptop() {
    cola.push(
      esperar(0.3, { ini() { ponerPose('estirado'); k.brazos = 'arriba'; k.laptop.abierta = false; k.texto = 'Guarda la laptop…'; } }),
      esperar(0.3, { ini() { ponerPose('aplastado'); k.brazos = 'normal'; k.mirar = 0; } }),
      esperar(0.4, {
        ini() { ponerPose('frente'); k.brazos = 'lado'; },
        act(p) { const q = suave(p); k.laptop.x = mezcla(5, 6.5, q); k.laptop.y = mezcla(-0.8, -5, q); },
      }),
      esperar(0.45, {
        ini() { k.brazos = 'arriba-der'; },
        act(p) { const q = suave(p); k.laptop.x = mezcla(6.5, 2.5, q); k.laptop.y = mezcla(-5, -11.5, q); },
      }),
      esperar(0.45, {
        act(p) { const q = suave(p); k.laptop.x = mezcla(2.5, 1.5, q); k.laptop.y = mezcla(-11.5, -7, q); },
        fin() { k.laptop = null; },
      }),
      esperar(0.3, { ini() { k.brazos = 'atras'; k.ojos = 'guino'; }, fin() { posturaBase(); k.modo = 'libre'; } })
    );
  }

  function teclear() {
    cola.push(esperar(1, {
      libre: true,
      ini() {
        k.texto = est.claude ? 'Claude está trabajando: el koala toma notas' : 'Trabajando contigo';
        const u = usoMaximo();
        const al = alertaMayor();
        k.sudor = u >= 75 || !!(al && al.nivel >= 2);
        if (al && al.nivel >= 2) k.texto = al.texto;
        k.ojos = u >= est.umbral ? 'tristes' : null;
        k.mirar = Math.random() < 0.2 ? -1 : 1;
      },
      act(p, dt, t) {
        k.tecleo = Math.floor(t * 9) % 2;
        if (Math.random() < dt * 2.2) burbujaFrasco();
      },
    }));
  }

  // ---------- Experimento (pomodoro de enfoque) ----------
  const COLORES_EXP = [COL.verde, COL.morado, COL.lente, COL.ambar, COL.corazon];
  function puf(cx, cy) {
    for (let i = 0; i < 7; i++) {
      particulas.push({ tipo: 'humo', x: cx + azar(-8, 8), y: cy + azar(-4, 4), vx: azar(-10, 10), vy: -azar(10, 26), vida: 0, max: azar(0.7, 1.2) });
    }
  }
  function prepararExperimento() {
    const xMax = W - 14 * C, xMin = 7 * C;
    if (k.x > xMax || k.x < xMin) cola.push(caminarA(Math.max(xMin, xMax > xMin ? Math.min(k.x, xMax) : xMin)));
    cola.push(
      esperar(0.4, { ini() { posturaBase(); k.mirar = 1; k.ojos = 'guino'; k.texto = 'Prepara un experimento…'; } }),
      esperar(0.4, {
        ini() {
          ponerPose('estirado'); k.brazos = 'arriba'; k.ojos = 'felices';
          k.exp = { color: COLORES_EXP[0], tubo: false };
          puf(k.x + 9 * C, suelo - 3 * C);
        },
      }),
      esperar(0.2, { ini() { ponerPose('aplastado'); k.brazos = 'normal'; } }),
      esperar(0.2, { ini() { ponerPose('sentado'); k.ojos = null; k.modo = 'experimento'; } })
    );
  }
  function recogerExperimento() {
    cola.push(
      esperar(0.4, {
        ini() { ponerPose('estirado'); k.brazos = 'arriba'; k.texto = 'Recoge el laboratorio…'; puf(k.x + 9 * C, suelo - 3 * C); },
        fin() { k.exp = null; },
      }),
      esperar(0.2, { ini() { ponerPose('aplastado'); k.brazos = 'normal'; } }),
      esperar(0.2, { ini() { posturaBase(); k.modo = 'libre'; } })
    );
  }
  function experimentar() {
    const pausado = est.pomodoro && est.pomodoro.pausado;
    const r = Math.random();
    const tipo = pausado ? 'observar' : r < 0.35 ? 'verter' : r < 0.6 ? 'agitar' : r < 0.88 ? 'observar' : 'puf';
    cola.push(esperar(1.4, {
      libre: true,
      ini() {
        k.texto = pausado ? 'Experimento en pausa' : 'Experimentando: concéntrate';
        k.ojos = null; k.brazoY = 0; k.exp.tubo = tipo === 'verter';
        k.mirar = 1;
      },
      act(p, dt) {
        const flasco = { x: k.x + 8.2 * C, y: suelo - 6.6 * C };
        if (tipo === 'verter') {
          k.brazoY = Math.sin(Math.PI * p) * 1.6;
          if (p > 0.3 && p < 0.75 && Math.random() < dt * 14) {
            particulas.push({ tipo: 'gota', color: k.exp.color, x: k.x + 7.4 * C, y: suelo - (4.6 + k.brazoY) * C, vx: 8, vy: 10, vida: 0, max: 0.35 });
          }
          if (p > 0.75 && !k.exp.cambio) { k.exp.cambio = true; k.exp.color = COLORES_EXP[Math.floor(Math.random() * COLORES_EXP.length)]; }
        } else if (tipo === 'agitar') {
          k.brazoY = Math.abs(Math.sin(p * Math.PI * 8)) * 0.6;
        } else if (tipo === 'observar') {
          k.brazoY = 0;
          k.ojos = p > 0.7 && !pausado ? 'felices' : null;
        } else if (tipo === 'puf' && p > 0.4 && !k.exp.cambio) {
          k.exp.cambio = true;
          puf(flasco.x, flasco.y);
          k.ojos = 'cerrados';
        } else if (tipo === 'puf' && p > 0.75) {
          k.ojos = 'felices';
        }
        if (!pausado && Math.random() < dt * 3) {
          particulas.push({ tipo: 'burbuja', x: flasco.x + azar(-2, 2), y: flasco.y, vx: azar(-3, 3), vy: -azar(10, 18), vida: 0, max: 1.1 });
        }
      },
      fin() { k.brazoY = 0; k.exp.tubo = false; k.exp.cambio = false; },
    }));
  }

  function dibujarMesa() {
    const e = k.exp;
    if (!e) return;
    const prev = S;
    S = { ox: k.x, oy: suelo, sx: 1, sy: 1 };
    // mechero con flama que parpadea
    cel(7, -0.6, 2.4, 0.6, COL.laptopS);
    cel(7.8, -1.8, 0.8, 1.2, COL.laptop);
    if (k.modo === 'experimento') {
      const f = 0.8 + Math.sin(k.t * 23) * 0.15 + Math.sin(k.t * 7) * 0.1;
      cel(7.75, -1.8 - f, 0.9, f, '#5AA0F0');
      cel(7.95, -1.8 - f * 0.55, 0.5, f * 0.55, '#BFE3FF');
    }
    // tripié
    cel(6.6, -3.6, 3.2, 0.3, COL.laptopS);
    cel(6.6, -3.6, 0.3, 3.6, COL.laptopS);
    cel(9.5, -3.6, 0.3, 3.6, COL.laptopS);
    // gradilla con tubos de ensayo
    cel(10.4, -0.5, 3, 0.5, COL.tallo);
    cel(10.4, -2, 3, 0.3, COL.tallo);
    [COL.morado, COL.ambar, COL.lente].forEach((c, i) => {
      if (e.tubo && i === 0) return; // ese tubo lo tiene en la mano
      cel(10.7 + i * 0.95, -2.8, 0.6, 2.3, COL.vidrio);
      cel(10.7 + i * 0.95, -1.5, 0.6, 1, c);
    });
    S = prev;
    matraz(k.x + 8.2 * C, suelo - 3.6 * C, e.color, 1);
  }

  // ---------- Sueño ----------
  function dormirse() {
    cola.push(
      esperar(0.5, { ini() { posturaBase(); k.ojos = 'cerrados'; k.texto = 'Bosteza…'; ponerPose('estirado'); k.brazos = 'arriba'; } }),
      esperar(0.3, { ini() { ponerPose('aplastado'); k.brazos = 'normal'; k.modo = 'dormido'; } })
    );
  }
  function seguirDormido() {
    cola.push(esperar(1.2, {
      libre: true,
      ini() { ponerPose('aplastado'); k.ojos = 'cerrados'; k.texto = 'Durmiendo… zzz'; zeta(); },
    }));
  }
  function despertar() {
    cola.push(
      esperar(0.4, { ini() { ponerPose('estirado'); k.brazos = 'arriba'; k.ojos = 'abiertos'; k.texto = '¡Despierta!'; } }),
      esperar(0.3, { ini() { posturaBase(); k.modo = 'libre'; } })
    );
  }

  // ---------- Ocio ----------
  function ocio() {
    k.texto = textoOcio();
    const h = ahoraLocal();
    const viernes = h.getDay() === 5 && h.getHours() >= 16;
    const opciones = [
      [3, pasear], [2, mirarLados], [1, saltar], [viernes ? 4 : 1, () => bailar(false)],
      [1, saludar], [2, descansar], [1.5, revisarMatraz],
      [momentoDelDia() === 'manana' ? 2.5 : 0, tomarCafe],
    ];
    let total = opciones.reduce((s, o) => s + o[0], 0);
    let r = Math.random() * total;
    for (const [peso, fn] of opciones) {
      if ((r -= peso) <= 0) return fn();
    }
    return descansar();
  }
  const alertaMayor = () => (est.alertas && est.alertas[0]) || null;
  function textoOcio() {
    const n = est.necesidades;
    const al = alertaMayor();
    if (al && al.nivel >= 2) return al.texto;
    const corte = minutosAlCorte();
    if (corte !== null) return '⏳ Corte de la sesión en ' + corte + ' min';
    const r = est.racha && est.racha.dias;
    if (r >= 3 && !est.racha.hoy && ahoraLocal().getHours() >= 17) return '🏅 Racha de ' + r + ' días: ¡no la rompas hoy!';
    if (usoMaximo() >= est.umbral) return '¡Casi al límite de Claude Code!';
    if (est.pomodoro && est.pomodoro.fase && est.pomodoro.fase !== 'enfoque') return 'Descanso del pomodoro: estírate tú también';
    if (n.energia < 30 && est.energiaLigada) return 'Sin energía: la sesión de Claude se recarga ' + horaReinicio();
    if (n.energia < 30) return 'Tiene sueño';
    if (n.saciedad < 35) return 'Tiene hambre: quiere eucalipto';
    if (n.animo < 35) return 'Está aburrido: quiere jugar';
    if (usoMaximo() >= 75) return 'Revisa tus mediciones con cuidado';
    const fecha = TEXTO_TEMPORADA[est.temporada];
    if (fecha && (k.t % 40) < 20) return fecha;
    if (ahoraLocal().getDay() === 5 && ahoraLocal().getHours() >= 16) return '¡Viernes por la tarde! 🎶';
    if (momentoDelDia() === 'noche') return 'Trabajando de noche… no te desveles';
    return 'Paseando por el laboratorio';
  }

  const TEXTO_TEMPORADA = {
    muertos: 'Día de Muertos: el koala va de catrina 💀🌼',
    navidad: '¡Felices fiestas! 🎄',
    patrias: '¡Viva México! 🇲🇽',
    anionuevo: '¡Feliz año nuevo! 🎆',
    reyes: 'Día de Reyes: ¿a quién le tocará el niño? 👑',
    marmota: 'Día de la Marmota… ¿verá su sombra? (y es Candelaria: tamales) 🫔',
    sanvalentin: 'Día del amor y la amistad 💕',
    pi: 'Día de Pi: π ≈ 3.14159… 🥧',
    primavera: '¡Llegó la primavera! 🌼',
    nino: '¡Feliz Día del Niño! 🎈',
    madres: '¡Feliz Día de las Madres! 💐',
    programador: 'Día del Programador: día 256 del año (2⁸) 💻',
    pluricultural: '12 de octubre: Día de la Nación Pluricultural 🌎',
    cumple: '¡Feliz cumpleaños! 🎂',
  };

  // ---------- Decoraciones de fechas (detrás del koala) ----------
  // decorarFecha(0) dibuja; decorarFecha(dt) solo lanza efectos (desde actualizar).
  function decorarFecha(dt) {
    const t = est.temporada;
    if (dt) return efectosFecha(t, dt);
    if (t === 'marmota') marmota();
    else if (t === 'pi') pizarronPi();
    else if (t === 'primavera') { flores(); mariposa(); }
    else if (t === 'nino') globos();
    else if (t === 'madres') floreroMadres();
    else if (t === 'pluricultural') globoTerraqueo();
    else if (t === 'cumple') pastel();
  }
  function efectosFecha(t, dt) {
    if (t === 'anionuevo' && Math.random() < dt * 0.5) fuegoArtificial();
    if (t === 'sanvalentin' && Math.random() < dt * 0.8) {
      particulas.push({ tipo: 'corazon', x: azar(10, W - 10), y: suelo - 4, vx: azar(-6, 6), vy: -azar(15, 28), vida: 0, max: 2.2 });
    }
    if (t === 'programador' && Math.random() < dt * 6) {
      particulas.push({ tipo: 'bit', uno: Math.random() < 0.5, x: azar(0, W), y: -6, vx: 0, vy: azar(25, 45), vida: 0, max: 3.5 });
    }
    if (t === 'cumple' && Math.random() < dt * 0.15) confeti(25);
  }
  function enFondo(x, f) { const prev = S; S = { ox: x, oy: suelo, sx: 1, sy: 1 }; f(); S = prev; }

  // La marmota sale de su madriguera, mira su sombra y se vuelve a meter (ciclo de 9 s).
  function marmota() {
    const x = W - 5 * C;
    const c = k.t % 9;
    const alto = c < 1 ? c : c < 4 ? 1 : c < 5 ? 5 - c : 0; // 0 = escondida, 1 = afuera
    enFondo(x, () => {
      cel(-2, -0.4, 4, 0.6, '#4A3B2A'); // agujero
      if (alto <= 0) return;
      const h = 4 * alto;
      cel(-1.3, -h, 2.6, h, '#8B6B47'); cel(-1, -h + 0.9, 2, h - 0.9, '#A7845A');
      cel(-1.3, -h - 0.6, 0.7, 0.7, '#8B6B47'); cel(0.6, -h - 0.6, 0.7, 0.7, '#8B6B47'); // orejas
      const mira = c > 2 && c < 3.5 ? -0.3 : 0; // voltea a ver su sombra
      cel(-0.7 + mira, -h + 0.5, 0.4, 0.4, COL.negro); cel(0.3 + mira, -h + 0.5, 0.4, 0.4, COL.negro);
      cel(-0.25 + mira, -h + 1.1, 0.5, 0.35, '#3A2A1A');
      if (alto === 1) cel(-4.5, -0.25, 3, 0.25, '#000000', 0.25); // su sombra
    });
  }
  const G_PI = ['XXXXXXX', '.X...X.', '.X...X.', '.X...X.', '.X...X.', 'X....X.'];
  function pizarronPi() {
    const x = 4 + 5 * C, y = suelo - 11 * C;
    rect(x - 4 * C - 2, y - 2, 8 * C + 4, 6 * C + 4, COL.tallo);
    rect(x - 4 * C, y, 8 * C, 6 * C, '#2F4F3A');
    glifo(G_PI, x - 3.4 * C, y + 1.2 * C, 2.4, '#F2F2F2');
    for (let i = 0; i < 3; i++) rect(x + 0.6 * C + i * 4, y + 4.2 * C, 2, 2, '#F2F2F2'); // ≈ 3.14…
    rect(x - 2.5 * C, y + 6 * C + 2, 0.2 * C, 5 * C - 2, COL.tallo); rect(x + 2.3 * C, y + 6 * C + 2, 0.2 * C, 5 * C - 2, COL.tallo);
  }
  function flores() {
    [0.08, 0.22, 0.78, 0.92].forEach((f, i) => enFondo(W * f, () => {
      cel(-0.1, -2, 0.2, 2, COL.hoja);
      const p = ['#FFD34D', '#F06292', COL.blanco, '#A77BE0'][i];
      cel(-0.7, -2.9, 1.4, 1.4, p); cel(-0.25, -2.45, 0.5, 0.5, '#F28C1B');
    }));
  }
  function mariposa() {
    const x = W / 2 + Math.sin(k.t * 0.7) * W * 0.35, y = 30 + Math.sin(k.t * 2.1) * 12;
    const ala = Math.floor(k.t * 10) % 2 ? 4 : 2;
    rect(x - ala - 1, y - 3, ala, 5, '#F28C1B'); rect(x + 1, y - 3, ala, 5, '#F28C1B'); rect(x - 0.5, y - 3, 1.5, 6, COL.negro);
  }
  function globos() {
    const base = W - 3 * C;
    [[0, COL.rojo], [1.8, COL.lente], [3.6, '#FFD34D']].forEach(([dx, color], i) => {
      const x = base - dx * C + Math.sin(k.t * 1.3 + i) * 3, y = 18 + i * 6 + Math.sin(k.t * 1.7 + i) * 3;
      rect(x - 6, y - 8, 12, 14, color); rect(x - 4, y - 10, 8, 2, color); rect(x - 3, y - 6, 2, 3, COL.blanco, 0.6);
      rect(x, y + 6, 1, suelo - y - 6, COL.borde, 0.6);
    });
  }
  function floreroMadres() {
    enFondo(4 + 3 * C, () => {
      cel(-1.2, -2.6, 2.4, 2.6, COL.lente); cel(-0.8, -2.9, 1.6, 0.4, COL.lente);
      [[-1.6, -5.5, '#F06292'], [0, -6.4, '#E85A7A'], [1.4, -5.2, '#F48FB1']].forEach(([fx, fy, c]) => {
        cel(fx * 0.4, fy + 1.2, 0.2, -fy - 3.8, COL.hoja); cel(fx - 0.6, fy, 1.4, 1.3, c);
      });
    });
  }
  function globoTerraqueo() {
    enFondo(4 + 3.5 * C, () => {
      cel(-1.5, -0.5, 3, 0.5, COL.tallo); cel(-0.15, -2, 0.3, 1.5, COL.tallo);
      cel(-2, -6.5, 4, 4, '#3B82C4'); cel(-1.5, -7, 3, 5, '#3B82C4'); cel(-2.5, -6, 5, 3, '#3B82C4');
      const g = (k.t * 0.6) % 4; // los continentes giran
      [[0, -6.2, 1.4, 1.2], [1.6, -4.8, 1.2, 1.4], [2.8, -5.8, 1, 0.9]].forEach(([cx, cy, w, h]) => {
        const xx = ((cx + g) % 4.6) - 2.3;
        if (xx + w > 2.4) return;
        cel(xx, cy, w, h, '#5BC46A');
      });
    });
  }
  function pastel() {
    enFondo(4 + 3.5 * C, () => {
      cel(-2.2, -2.4, 4.4, 2.4, '#F8BBD0'); cel(-2.2, -2.6, 4.4, 0.5, COL.blanco); cel(-2.2, -1.2, 4.4, 0.3, COL.corazon);
      [-1.3, 0, 1.3].forEach((vx, i) => {
        cel(vx - 0.15, -3.6, 0.3, 1, [COL.lente, '#FFD34D', COL.verde][i]);
        if (Math.random() > 0.15) cel(vx - 0.2, -4.2, 0.4, 0.5, '#FFB13B');
      });
    });
  }
  const COLORES_FUEGO = ['#FFD34D', '#E85A7A', '#7FD3F0', '#5BC46A', '#A77BE0'];
  function fuegoArtificial() {
    const x = azar(W * 0.15, W * 0.85), y = azar(15, 50), c = COLORES_FUEGO[Math.floor(Math.random() * COLORES_FUEGO.length)];
    for (let i = 0; i < 22; i++) {
      const a = (i / 22) * Math.PI * 2, v = azar(30, 55);
      particulas.push({ tipo: 'fuego', color: c, x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, vida: 0, max: azar(0.8, 1.3) });
    }
  }
  const G_CERO = ['XXX', 'X.X', 'X.X', 'X.X', 'XXX'], G_UNO = ['.X.', 'XX.', '.X.', '.X.', 'XXX'];

  // ---------- Hora del día ----------
  function ahoraLocal() { return est.horaPrueba ? new Date(est.horaPrueba) : new Date(); }
  function momentoDelDia() {
    const h = ahoraLocal().getHours();
    if (h >= 22 || h < 6) return 'noche';
    if (h >= 6 && h < 10) return 'manana';
    return 'dia';
  }
  function tomarCafe() {
    cola.push(esperar(2.6, {
      libre: true,
      ini() { k.texto = 'Café de la mañana ☕'; k.sosteniendo = 'taza'; k.brazos = 'frasco'; k.mirar = 1; },
      act(p, dt) {
        k.ojos = p > 0.4 && p < 0.6 ? 'cerrados' : p > 0.6 ? 'felices' : null; // sorbo
        if (Math.random() < dt * 5) particulas.push({ tipo: 'vapor', x: k.x + 6.3 * C + azar(-2, 2), y: suelo - 8 * C, vx: azar(-3, 3), vy: -azar(8, 14), vida: 0, max: 1.2 });
      },
      fin() { k.sosteniendo = null; k.brazos = 'normal'; k.ojos = null; },
    }));
  }
  // Reloj de arena: los últimos 10 min antes del corte de la sesión (si ya gastaste bastante).
  function minutosAlCorte() {
    const v = est.uso && est.uso.cinco;
    if (!v || v.reiniciada || !v.reinicio || v.pct < 60) return null;
    const min = Math.ceil((v.reinicio - Date.now()) / 60000);
    return min > 0 && min <= 10 ? min : null;
  }
  function dibujarRelojArena() {
    const min = minutosAlCorte();
    if (min === null) return;
    const prev = S;
    S = { ox: Math.max(3 * C, k.x - 9 * C), oy: suelo, sx: 1, sy: 1 };
    const arriba = min / 10; // arena que falta por caer
    cel(-1.5, -5, 3, 0.5, COL.tallo); cel(-1.5, -0.5, 3, 0.5, COL.tallo);
    cel(-1.2, -4.5, 2.4, 1.6, COL.vidrio, 0.6); cel(-0.4, -2.9, 0.8, 0.8, COL.vidrio, 0.6); cel(-1.2, -2.1, 2.4, 1.6, COL.vidrio, 0.6);
    cel(-1, -2.9 - 1.4 * arriba, 2, 1.4 * arriba, COL.ambar);
    cel(-1, -0.5 - 1.4 * (1 - arriba), 2, 1.4 * (1 - arriba), COL.ambar);
    if (Math.floor(k.t * 6) % 2) cel(-0.1, -2.9, 0.2, 2.2, COL.ambar);
    S = prev;
  }

  // ---------- Siesta sobre la laptop ----------
  function seguirSiesta() {
    cola.push(esperar(1.5, {
      libre: true,
      ini() { k.ojos = 'cerrados'; k.texto = 'Se quedó dormido sobre la laptop… (' + est.inactivoMin + ' min sin actividad)'; zeta(); },
      act(p) { k.cabeceo = Math.sin(p * Math.PI) * 0.5; },
      fin() { k.cabeceo = 0; },
    }));
  }
  function despertarDeSiesta() {
    cola.push(
      esperar(0.5, {
        ini() { k.ojos = 'abiertos'; k.texto = '¡Ah! Ya volviste'; k.cabeceo = 0; puf(k.x, suelo - 10 * C); },
        act(p) { k.alt = Math.sin(Math.PI * p) * 8; },
        fin() { k.alt = 0; k.modo = 'trabajo'; }, // sigue con la laptop afuera
      })
    );
    if (!est.trabajando) guardarLaptop();
  }

  // ---------- Errores en cero: escoba ----------
  function barrer(d) {
    cola.push(
      esperar(0.01, { ini() { posturaBase(); k.texto = '✨ ¡Cero errores!' + (d.antes ? ' (eran ' + d.antes + ')' : ''); k.sosteniendo = 'escoba'; k.ojos = 'felices'; } }),
      esperar(2.4, {
        act(p, dt) {
          const lado = Math.sin(p * Math.PI * 6);
          k.balanceo = lado * 0.8;
          k.escobaX = lado;
          if (Math.random() < dt * 25) particulas.push({ tipo: 'polvo', x: k.x + (lado * 3 + 5) * C + azar(-4, 4), y: suelo - 2, vx: azar(-20, 20), vy: -azar(5, 25), vida: 0, max: 0.7 });
        },
        fin() { k.sosteniendo = null; k.balanceo = 0; k.escobaX = 0; },
      })
    );
    aplaudir();
  }
  function aplaudir(texto) {
    cola.push(esperar(1.4, {
      ini() { if (texto) { posturaBase(); k.texto = texto; } k.brazos = 'aplauso'; k.ojos = 'felices'; },
      fin() { posturaBase(); },
    }));
  }

  // ---------- Servicio caído: extintor ----------
  function apagarFuego(d) {
    cola.push(
      esperar(0.01, {
        ini() {
          posturaBase(); k.texto = '🧯 ' + (d.nombre || 'Un servicio') + ' no responde' + (d.detalle ? ' (' + d.detalle + ')' : '');
          k.ojos = 'abiertos'; k.sudor = true; k.sosteniendo = 'extintor';
        },
      }),
      caminarA(k.x - 4 * C, false, 90),
      esperar(2.2, {
        ini() { k.mirar = 1; k.dir = 1; },
        act(p, dt) {
          k.balanceo = Math.sin(p * 50) * 0.08;
          for (let i = 0; i < 3; i++) {
            if (Math.random() < dt * 30) particulas.push({ tipo: 'espuma', x: k.x + 7.5 * C, y: suelo - 5 * C + azar(-3, 3), vx: azar(70, 120), vy: azar(-25, 15), vida: 0, max: azar(0.5, 0.9) });
          }
        },
        fin() { k.sosteniendo = null; k.balanceo = 0; k.sudor = false; },
      }),
      esperar(0.8, { ini() { k.ojos = 'tristes'; k.brazos = 'rascar'; }, fin() { posturaBase(); } })
    );
  }
  function pasear() {
    cola.push(caminarA(azar(7 * C, W - 7 * C), true), esperar(azar(0.4, 1.2), { libre: true, ini() { k.mirar = 0; } }));
  }
  function mirarLados() {
    cola.push(
      esperar(0.7, { libre: true, ini() { k.mirar = -1; } }),
      esperar(0.7, { libre: true, ini() { k.mirar = 1; } }),
      esperar(0.4, { libre: true, ini() { k.mirar = 0; } })
    );
  }
  function salto(altura, d, extra) {
    return [
      esperar(0.13, { libre: true, ini() { ponerPose('aplastado'); } }),
      esperar(d, Object.assign({
        libre: true,
        ini() { ponerPose('estirado'); k.brazos = 'arriba'; },
        act(p) { k.alt = 4 * altura * p * (1 - p); },
        fin() { k.alt = 0; },
      }, extra || {})),
      esperar(0.13, { libre: true, ini() { ponerPose('aplastado'); k.brazos = 'normal'; } }),
    ];
  }
  function saltar() {
    cola.push(...salto(24, 0.5), esperar(0.2, { libre: true, ini() { ponerPose('frente'); } }));
  }
  function bailar(festejo, texto) {
    const lado = [1, -1, 1, -1, 1, -1];
    cola.push(esperar(0.01, { libre: !festejo, ini() { k.ojos = 'felices'; if (festejo) k.texto = texto || '¡Se reinició tu ventana de uso!'; } }));
    lado.forEach((l) => {
      cola.push(...salto(9, 0.32, {
        libre: !festejo,
        act(p) { k.alt = 4 * 9 * p * (1 - p); k.balanceo = l * Math.sin(Math.PI * p) * 1.2; k.ojos = 'felices'; },
        fin() { k.alt = 0; k.balanceo = 0; },
      }));
    });
    cola.push(esperar(0.2, { libre: !festejo, ini() { posturaBase(); } }));
  }
  function saludar() {
    cola.push(esperar(1.4, {
      libre: true,
      ini() { k.brazos = 'saludo'; k.ojos = 'felices'; k.mirar = 0; },
      fin() { k.brazos = 'normal'; k.ojos = null; },
    }));
  }
  function descansar() {
    cola.push(esperar(azar(1.5, 3), { libre: true, ini() { k.mirar = 0; } }));
  }
  function revisarMatraz() {
    const colores = [COL.verde, COL.morado, COL.lente];
    cola.push(esperar(2.6, {
      libre: true,
      ini() { k.texto = 'Revisa un experimento'; k.frasco = { color: colores[0] }; k.brazos = 'frasco'; k.mirar = 1; },
      act(p, dt) {
        k.frasco.color = colores[Math.min(2, Math.floor(p * 3))];
        k.ojos = p > 0.8 ? 'felices' : null;
        if (Math.random() < dt * 4) particulas.push({ tipo: 'burbuja', x: k.x + 6 * C, y: suelo - k.alt - 8.4 * C, vx: azar(-4, 4), vy: -azar(12, 22), vida: 0, max: 1.1 });
      },
      fin() { k.frasco = null; k.brazos = 'normal'; k.ojos = null; },
    }));
  }

  // ---------- Claude: te necesita / terminó ----------
  function traducirAviso(t) {
    t = String(t || '');
    let m = /permission to use (.+)$/i.exec(t);
    if (m) return 'permiso para usar ' + m[1];
    if (/permission/i.test(t)) return 'tu permiso';
    if (/question|input|answer/i.test(t)) return 'una respuesta';
    return t;
  }
  function manoLevantada() {
    cola.push(esperar(1.2, {
      libre: true,
      ini() {
        posturaBase();
        k.brazos = 'saludo'; k.mirar = 0; k.ojos = 'abiertos';
        const msj = traducirAviso(est.claudeNecesita && est.claudeNecesita.mensaje);
        k.texto = '✋ Claude te necesita' + (msj ? ': ' + recortar(msj, 46) : '');
      },
    }));
  }
  function duracionCorta(ms) {
    const s = Math.round((ms || 0) / 1000);
    return s < 60 ? s + ' s' : Math.floor(s / 60) + ' min ' + (s % 60) + ' s';
  }
  function claudeListo(d) {
    cola.push(
      esperar(0.3, { ini() { posturaBase(); k.mirar = 0; k.ojos = 'felices'; k.texto = '📜 ¡Claude terminó! (' + duracionCorta(d.duracion) + ')'; } }),
      ...salto(14, 0.4, { ini() { ponerPose('estirado'); k.brazos = 'arriba-der'; k.sosteniendo = 'papel'; } }),
      esperar(2.2, {
        ini() { k.brazos = 'arriba-der'; k.sosteniendo = 'papel'; ponerPose('frente'); },
        act(p) { k.balanceo = Math.sin(p * Math.PI * 4) * 0.3; },
        fin() { k.sosteniendo = null; posturaBase(); },
      })
    );
  }

  // ---------- Comandos de la terminal ----------
  function nombreComando(c) { return recortar(String(c || '').replace(/^(sudo|npx|python3?|node)\s+/, ''), 34); }
  function comandoOk(d) {
    cola.push(
      esperar(0.01, {
        ini() {
          posturaBase(); k.mirar = 0; k.ojos = 'felices';
          k.texto = '✓ ' + nombreComando(d.comando) + (d.duracion >= 1000 ? ' (' + duracionCorta(d.duracion) + ')' : '');
          k.frasco = { color: COL.verde };
          k.brazos = 'frasco';
        },
      }),
      esperar(1.0, {
        act(p, dt) {
          if (Math.random() < dt * 12) {
            particulas.push({ tipo: 'chispa', x: k.x + 6 * C + azar(-8, 8), y: suelo - 8 * C + azar(-8, 8), vx: azar(-20, 20), vy: -azar(10, 40), vida: 0, max: 0.7 });
          }
        },
        fin() { k.frasco = null; },
      }),
      esperar(1.4, {
        ini() { k.brazos = 'aplauso'; },
        fin() { posturaBase(); },
      })
    );
  }
  function comandoFallo(d) {
    cola.push(
      esperar(0.5, {
        ini() {
          posturaBase(); k.mirar = 0;
          k.texto = '✗ Falló ' + nombreComando(d.comando) + (d.codigo != null ? ' (código ' + d.codigo + ')' : '');
          k.frasco = { color: COL.rojo }; k.brazos = 'frasco'; k.ojos = 'abiertos';
        },
        act(p) { k.balanceo = Math.sin(p * 40) * 0.12 * p; }, // el matraz tiembla
      }),
      esperar(0.35, {
        ini() {
          k.frasco = null; k.brazos = 'arriba'; ponerPose('aplastado'); k.ojos = 'cerrados'; k.balanceo = 0;
          puf(k.x + 3 * C, suelo - 8 * C); puf(k.x, suelo - 6 * C); puf(k.x - 2 * C, suelo - 9 * C);
          k.hollin = 6; // segundos con la cara tiznada
          destello = 0.25;
        },
      }),
      esperar(0.4, { ini() { ponerPose('frente'); k.brazos = 'normal'; k.ojos = 'tristes'; } }),
      esperar(1.8, { ini() { k.brazos = 'rascar'; k.ojos = 'tristes'; }, fin() { k.brazos = 'normal'; k.ojos = null; } })
    );
  }
  let destello = 0;

  // ---------- Git: commit (confeti) y push (cohete) ----------
  const COLORES_CONFETI = [COL.rojo, COL.ambar, COL.verde, COL.lente, COL.morado, COL.corazon];
  function confeti(cuantos) {
    for (let i = 0; i < cuantos; i++) {
      particulas.push({
        tipo: 'confeti', color: COLORES_CONFETI[i % COLORES_CONFETI.length],
        x: azar(0, W), y: -azar(0, 40), vx: azar(-15, 15), vy: azar(35, 70),
        fase: azar(0, 6), vida: 0, max: azar(2.2, 3.2),
      });
    }
  }
  function recortar(t, n) {
    t = String(t || '');
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
  }
  function festejarCommit(d) {
    const texto = '¡Commit' + (d.repo ? ' en ' + d.repo : '') + '!' + (d.mensaje ? ' «' + recortar(d.mensaje, 30) + '»' : '') +
      (d.racha >= 2 ? ' · racha de ' + d.racha + ' días 🏅' : '');
    cola.push(esperar(0.01, { ini() { posturaBase(); k.mirar = 0; k.texto = texto; k.ojos = 'felices'; confeti(60); } }));
    cola.push(...salto(26, 0.55, { ini() { ponerPose('estirado'); k.brazos = 'arriba'; k.ojos = 'felices'; } }));
    cola.push(esperar(0.25, { ini() { confeti(30); } }));
    cola.push(...salto(18, 0.45, { ini() { ponerPose('estirado'); k.brazos = 'arriba'; k.ojos = 'felices'; } }));
    bailar(true, texto);
  }

  let cohete = null;
  function festejarPush(d) {
    const texto = '¡Push! ' + (d.cuantos ? d.cuantos + ' commit' + (d.cuantos === 1 ? '' : 's') + ' ' : '') + 'volando' + (d.repo ? ' a ' + d.repo : '');
    cola.push(
      esperar(0.5, {
        ini() {
          posturaBase(); k.texto = texto; k.mirar = 1; k.ojos = 'felices';
          const x = Math.min(W - 4 * C, k.x + 9 * C);
          cohete = { x, alt: 0, v: 0, encendido: false };
          puf(x, suelo - C);
        },
      }),
      esperar(0.8, { ini() { cohete.encendido = true; k.brazos = 'saludo'; } }),
      esperar(2.2, {
        act(p, dt) {
          cohete.v += 260 * dt;
          cohete.alt += cohete.v * dt;
          if (Math.random() < dt * 30) {
            particulas.push({ tipo: 'humo', x: cohete.x + azar(-3, 3), y: suelo - cohete.alt + 2, vx: azar(-12, 12), vy: azar(5, 20), vida: 0, max: azar(0.6, 1.1) });
          }
        },
        fin() { cohete = null; confeti(25); },
      }),
      esperar(0.6, { ini() { k.brazos = 'arriba'; ponerPose('estirado'); }, fin() { posturaBase(); } })
    );
  }
  function dibujarCohete() {
    if (!cohete) return;
    const prev = S;
    S = { ox: cohete.x, oy: suelo - cohete.alt, sx: 1, sy: 1 };
    if (cohete.encendido) {
      const f = 1 + Math.sin(k.t * 40) * 0.3 + Math.random() * 0.4;
      cel(-0.6, 0, 1.2, f * 1.6, COL.ambar);
      cel(-0.3, 0, 0.6, f * 1.1, COL.blanco);
    }
    cel(-1.6, -1.6, 0.8, 1.6, COL.rojo); // aletas
    cel(0.8, -1.6, 0.8, 1.6, COL.rojo);
    cel(-0.8, -5, 1.6, 5, COL.bata); // cuerpo
    cel(0.4, -5, 0.4, 5, COL.bataS);
    cel(-0.4, -3.8, 0.8, 0.8, COL.lente); // ventanilla
    cel(-0.6, -5.8, 1.2, 0.8, COL.rojo); // punta
    cel(-0.2, -6.3, 0.4, 0.5, COL.rojo);
    S = prev;
  }

  // ---------- Comer ----------
  let comida = null;
  function comer() {
    cola.push(
      esperar(Infinity, {
        max: 6,
        ini() {
          posturaBase();
          k.texto = est.temporada === 'marmota' ? '¡Tamales de Candelaria!' : est.temporada === 'reyes' ? '¡Rosca de Reyes! ¿Le saldrá el niño?' : '¡Eucalipto!';
          const lejos = k.x < W / 2 ? azar(W * 0.55, W - 9 * C) : azar(9 * C, W * 0.45);
          comida = comidaSoltada
            ? { x: Math.max(4 * C, Math.min(W - 4 * C, comidaSoltada.x)), alt: Math.max(0, comidaSoltada.alt), v: 0, hojas: 3, enSuelo: false }
            : { x: lejos, alt: H, v: 0, hojas: 3, enSuelo: false };
          comidaSoltada = null;
          k.ojos = 'felices';
        },
        act() { k.mirar = comida.x > k.x ? 1 : -1; },
        hasta() { return comida.enSuelo; },
      }),
      {
        d: 0.01,
        ini() {
          const lado = comida.x > k.x ? -1 : 1;
          cola.unshift(caminarA(comida.x + lado * 5 * C), esperar(0.25, {
            ini() { k.sosteniendo = 'comida'; k.mirar = 0; k.ojos = 'felices'; },
          }));
        },
      },
      ...[0, 1, 2].flatMap((i) => [
        esperar(0.28, { ini() { ponerPose('aplastado'); k.boca = true; k.ojos = 'cerrados'; } }),
        esperar(0.3, {
          ini() {
            ponerPose('frente'); k.boca = false; k.ojos = 'felices';
            comida.hojas = 2 - i;
            for (let j = 0; j < 4; j++) particulas.push({ tipo: 'miga', x: k.x + azar(-6, 6), y: suelo - 4.5 * C, vx: azar(-25, 25), vy: -azar(20, 50), vida: 0, max: 0.7 });
          },
        }),
      ]),
      esperar(0.6, {
        ini() { k.sosteniendo = null; comida = null; k.ojos = 'felices'; k.texto = '¡Qué rico!'; vscode.postMessage({ tipo: 'efecto', accion: 'comer' }); },
        fin() { k.ojos = null; },
      })
    );
  }

  // ---------- Jugar ----------
  let pelota = null;
  function jugar() {
    let patadas = 0, golpe = 0;
    cola.push(esperar(Infinity, {
      max: 28,
      ini() {
        posturaBase();
        k.texto = '¡A jugar!';
        k.ojos = 'felices';
        pelota = { x: azar(W * 0.25, W * 0.75), alt: 90, vx: azar(-30, 30), v: 0, giro: 0, alfa: 1 };
      },
      act(p, dt) {
        golpe = Math.max(0, golpe - dt);
        if (golpe > 0) return;
        if (k.pose !== 'frente') ponerPose('frente');
        const lado = pelota.x > k.x ? -1 : 1;
        const meta = pelota.x + lado * 4.5 * C;
        const dx = meta - k.x;
        k.dir = dx >= 0 ? 1 : -1;
        k.mirar = pelota.x > k.x ? 1 : -1;
        const v = 72;
        if (Math.abs(dx) > 3) {
          const mov = Math.sign(dx) * Math.min(Math.abs(dx), v * dt);
          k.x = Math.max(7 * C, Math.min(W - 7 * C, k.x + mov));
          k.paso += Math.abs(mov) * 0.35;
          k.caminando = true;
        } else {
          k.caminando = false;
        }
        const cerca = Math.abs(pelota.x - k.x) < 6 * C;
        if (cerca && pelota.alt < 8 && patadas < 5) {
          patadas++;
          golpe = 0.22;
          k.caminando = false;
          ponerPose('aplastado');
          const haciaCentro = pelota.x < W / 2 ? 1 : -1;
          const sentido = Math.random() < 0.75 ? haciaCentro : -haciaCentro;
          pelota.vx = sentido * azar(110, 190);
          pelota.v = azar(150, 230);
        }
      },
      hasta() { return patadas >= 5 && pelota.alt === 0 && Math.abs(pelota.vx) < 25; },
      fin() {
        k.caminando = false;
        pelota.desvanecer = true;
        k.ojos = 'felices';
        k.texto = '¡Buen partido!';
        vscode.postMessage({ tipo: 'efecto', accion: 'jugar' });
      },
    }), esperar(0.7, { fin() { k.ojos = null; ponerPose('frente'); } }));
  }

  function fisicaPelota(dt) {
    if (!pelota) return;
    const g = 520, r = 1.5 * C;
    pelota.v -= g * dt;
    pelota.alt += pelota.v * dt;
    if (pelota.alt <= 0) {
      pelota.alt = 0;
      pelota.v = Math.abs(pelota.v) > 40 ? -pelota.v * 0.55 : 0;
      pelota.vx *= Math.pow(0.35, dt);
    }
    pelota.x += pelota.vx * dt;
    pelota.giro += pelota.vx * dt / r;
    if (pelota.x < r) { pelota.x = r; pelota.vx = Math.abs(pelota.vx) * 0.7; }
    if (pelota.x > W - r) { pelota.x = W - r; pelota.vx = -Math.abs(pelota.vx) * 0.7; }
    if (pelota.desvanecer) {
      pelota.alfa -= dt * 1.5;
      if (pelota.alfa <= 0) pelota = null;
    }
  }

  // ---------- Mimar ----------
  function mimar() {
    cola.push(
      esperar(0.2, { ini() { posturaBase(); ponerPose('aplastado'); k.ojos = 'felices'; k.texto = '¡Le encanta!'; } }),
      esperar(1.5, {
        ini() { ponerPose('frente'); },
        act(p, dt) { if (Math.random() < dt * 4.5) corazon(); },
        fin() { vscode.postMessage({ tipo: 'efecto', accion: 'mimar' }); k.ojos = null; },
      })
    );
  }

  // ---------- Partículas ----------
  const particulas = [];
  function corazon() {
    particulas.push({ tipo: 'corazon', x: k.x + azar(-4, 4) * C, y: suelo - k.alt - 10 * C, vx: azar(-8, 8), vy: -azar(20, 34), vida: 0, max: 1.4 });
  }
  function zeta() {
    particulas.push({ tipo: 'z', x: k.x + 3 * C, y: suelo - 9 * C, vx: 7, vy: -16, vida: 0, max: 2.2 });
  }
  function burbujaFrasco() {
    particulas.push({ tipo: 'burbuja', x: k.x + 11.2 * C, y: suelo - 3.2 * C, vx: azar(-3, 3), vy: -azar(10, 18), vida: 0, max: 1.2 });
  }
  function moverParticulas(dt) {
    for (let i = particulas.length - 1; i >= 0; i--) {
      const q = particulas[i];
      q.vida += dt;
      if (q.tipo === 'miga') q.vy += 160 * dt;
      if (q.tipo === 'fuego') { q.vy += 40 * dt; q.vx *= 0.98; }
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      if (q.tipo === 'z') q.x += Math.sin(q.vida * 3) * 0.3;
      if (q.tipo === 'confeti') q.x += Math.sin(q.fase + q.vida * 4) * 0.5;
      if (q.vida >= q.max) particulas.splice(i, 1);
    }
  }
  function dibujarParticulas() {
    for (const q of particulas) {
      const a = 1 - q.vida / q.max;
      if (q.tipo === 'corazon') glifo(G_CORAZON, q.x - 5, q.y, 1.5, COL.corazon, a);
      else if (q.tipo === 'z') glifo(G_Z, q.x, q.y, 1 + q.vida * 0.6, COL.z, a);
      else if (q.tipo === 'burbuja') rect(q.x, q.y, 2, 2, COL.vidrio, a);
      else if (q.tipo === 'miga') rect(q.x, q.y, 2, 2, COL.hoja, a);
      else if (q.tipo === 'gota') rect(q.x, q.y, 2, 3, q.color, a);
      else if (q.tipo === 'fuego') rect(q.x, q.y, 2, 2, q.color, a);
      else if (q.tipo === 'bit') glifo(q.uno ? G_UNO : G_CERO, q.x, q.y, 1.5, COL.verde, a * 0.5);
      else if (q.tipo === 'polvo') rect(q.x, q.y, 3, 2, '#B9AE95', a * 0.8);
      else if (q.tipo === 'espuma') { const t = 2 + q.vida * 5; rect(q.x, q.y, t, t, COL.blanco, a * 0.9); }
      else if (q.tipo === 'vapor') rect(q.x, q.y, 2, 3, COL.blanco, a * 0.5);
      else if (q.tipo === 'chispa') { rect(q.x - 2, q.y, 5, 1, COL.ambar, a); rect(q.x, q.y - 2, 1, 5, COL.ambar, a); }
      else if (q.tipo === 'confeti') {
        const ancho = 1 + Math.abs(Math.sin(q.fase + q.vida * 9)) * 2.5; // gira al caer
        rect(q.x, q.y, ancho, 2.5, q.color, Math.min(1, a * 1.6));
      }
      else if (q.tipo === 'humo') { const t = 3 + q.vida * 6; rect(q.x - t / 2, q.y - t / 2, t, t, '#C8CCD2', a * 0.8); }
    }
  }

  // ---------- Dibujo del koala ----------
  function ojo(x, y, tipo, lado) {
    const n = COL.negro;
    if (tipo === 'cerrados') cel(x - 0.1, y + 0.6, 1.2, 0.35, n);
    else if (tipo === 'felices') { cel(x - 0.2, y + 0.55, 0.45, 0.45, n); cel(x + 0.28, y + 0.15, 0.45, 0.45, n); cel(x + 0.75, y + 0.55, 0.45, 0.45, n); }
    else if (tipo === 'tristes') {
      cel(x, y + 0.35, 1, 0.65, n);
      cel(x + (lado < 0 ? -0.2 : 0.6), y - 0.45, 0.6, 0.3, n);
      cel(x + (lado < 0 ? 0.4 : 0), y - 0.65, 0.6, 0.3, n);
    } else cel(x, y, 1, 1, n);
  }
  function ojosDe(tipo, xI, xD, y) {
    if (tipo === 'guino') { ojo(xI, y, 'abiertos', -1); ojo(xD, y, 'cerrados', 1); return; }
    ojo(xI, y, tipo, -1);
    ojo(xD, y, tipo, 1);
  }
  function ojosActuales() {
    const t = k.ojos || ojosBase();
    if (t === 'abiertos' && k.parpadeo > 0) return 'cerrados';
    return t;
  }

  function koalaFrente() {
    const P = COL.pelaje, m = k.mirar;
    const enAire = k.alt > 0.5;
    const fase = Math.sin(k.paso);
    // dos piernas de 2×2 con pie; al caminar alternan
    [-3, 1].forEach((px, i) => {
      const alza = k.caminando ? Math.max(0, i === 0 ? fase : -fase) * 0.8 : 0;
      const h = enAire ? 2.3 : 2 - alza;
      cel(px, -2, 2, h, COL.pata);
      cel(px - 0.2, -2 + h - 0.5, 2.4, 0.5, COL.pie);
    });
    // brazo derecho detrás (antes del cuerpo)
    // orejas
    cel(-5.5, -10, 2, 3, P); cel(-6, -9.5, 3, 2, P); cel(-5, -9.3, 1, 1.4, COL.oreja);
    cel(3.5, -10, 2, 3, P); cel(3, -9.5, 3, 2, P); cel(4, -9.3, 1, 1.4, COL.oreja);
    // cuerpo 8×6
    cel(-4, -8, 8, 6, P);
    cel(3.5, -8, 0.5, 4, COL.pelajeS);
    // bata de laboratorio
    cel(-4, -4, 8, 2, COL.bata);
    cel(3.2, -4, 0.8, 2, COL.bataS);
    cel(-4, -2.4, 8, 0.4, COL.bataS);
    cel(-1, -4, 2, 0.7, COL.camisa); cel(-0.5, -3.3, 1, 0.6, COL.camisa);
    cel(-3.2, -3.2, 1.4, 0.25, COL.bataS);
    cel(-2.8, -3.8, 0.3, 0.7, COL.pluma);
    // lentes de seguridad en la frente
    cel(-4, -7.9, 8, 0.5, COL.correa);
    cel(-3.2, -8.4, 2.2, 1.2, COL.correa); cel(-3, -8.2, 1.8, 0.8, COL.lente);
    cel(1, -8.4, 2.2, 1.2, COL.correa); cel(1.2, -8.2, 1.8, 0.8, COL.lente);
    cel(-2.9, -8.15, 0.45, 0.35, COL.blanco); cel(1.3, -8.15, 0.45, 0.35, COL.blanco);
    // ojos y nariz (miran hacia donde va)
    antifazMuertos(-2.6 + m * 0.5, 1.6 + m * 0.5, -6.7);
    ojosDe(ojosActuales(), -2.6 + m * 0.5, 1.6 + m * 0.5, -6.7);
    cel(-1.1 + m * 0.35, -6.0, 2.2, 1.8, COL.nariz);
    cel(-0.7 + m * 0.35, -5.8, 0.5, 0.4, COL.narizL);
    if (k.boca) cel(-0.5 + m * 0.35, -4.2, 1, 0.5, COL.boca);
    if (k.sudor) cel(4.4, -7.6, 0.6, 1, COL.sudor);
    // brazos 2×2
    brazoIzq();
    brazoDer();
    if (k.sosteniendo === 'comida' && comida) dibujarRama(S.ox, S.oy - 4.6 * C * S.sy, comida.hojas, 0.8);
    if (k.frasco) matraz(S.ox + 6 * C * S.sx, S.oy - 5.4 * C * S.sy, k.frasco.color, 0.8);
    if (k.sosteniendo === 'papel') {
      cel(3.4, -14.2, 3.4, 3.8, '#F4E9C8'); cel(3.4, -14.2, 3.4, 0.4, '#D9C79A'); cel(3.4, -10.8, 3.4, 0.4, '#D9C79A');
      cel(3.9, -13.4, 2.4, 0.25, COL.borde); cel(3.9, -12.7, 2, 0.25, COL.borde); cel(3.9, -12, 2.2, 0.25, COL.borde);
      cel(5.5, -11.6, 0.9, 0.6, COL.verde);
    }
    if (k.hollin > 0) hollin(-2.6 + m * 0.5, 1.6 + m * 0.5, -6.7);
    adornoOreja(-5.8, -10.8);
    sombrero(0, -10.2);
    medallas(-3.4, -3.4);
    if (est.temporada === 'patrias') monoTricolor(2, -3.8);
    if (k.sosteniendo === 'taza') taza(S.ox + 6.3 * C * S.sx, S.oy - 5.6 * C * S.sy);
    if (k.sosteniendo === 'escoba') escoba(S.ox + (5 + (k.escobaX || 0) * 1.5) * C * S.sx, S.oy);
    if (k.sosteniendo === 'extintor') extintor(S.ox + 5.6 * C * S.sx, S.oy - 3.4 * C * S.sy);
  }

  // Gorro según temporada u hora (Navidad > pijama de noche).
  function sombrero(x, y) {
    const t = est.temporada;
    if (t === 'nino' || t === 'anionuevo' || t === 'cumple') { // gorro de fiesta a rayas
      const c1 = t === 'anionuevo' ? '#FFD34D' : COL.corazon, c2 = t === 'anionuevo' ? COL.morado : COL.lente;
      cel(x - 1.6, y - 0.2, 3.2, 1, c1); cel(x - 1.1, y - 1.2, 2.2, 1, c2); cel(x - 0.6, y - 2.2, 1.2, 1, c1);
      cel(x - 0.5, y - 3, 1, 0.8, COL.blanco);
      return;
    }
    if (t === 'reyes') { // corona
      cel(x - 2.4, y - 0.2, 4.8, 1.2, '#FFD34D');
      cel(x - 2.4, y - 1.2, 0.9, 1, '#FFD34D'); cel(x - 0.45, y - 1.4, 0.9, 1.2, '#FFD34D'); cel(x + 1.5, y - 1.2, 0.9, 1, '#FFD34D');
      cel(x - 1.5, y + 0.2, 0.6, 0.6, COL.rojo); cel(x - 0.3, y + 0.2, 0.6, 0.6, COL.lente); cel(x + 0.9, y + 0.2, 0.6, 0.6, COL.verde);
      return;
    }
    if (est.temporada === 'navidad') {
      cel(x - 3.6, y + 0.6, 7.2, 1, COL.bata);
      cel(x - 3, y - 0.8, 6, 1.5, COL.rojo); cel(x - 1.5, y - 2, 4.5, 1.3, COL.rojo); cel(x + 2, y - 2.6, 2, 1, COL.rojo);
      cel(x + 3.6, y - 3, 1.3, 1.3, COL.bata);
    } else if (momentoDelDia() === 'noche') {
      cel(x - 3.4, y + 0.4, 6.8, 1.2, '#5B6EE1');
      cel(x - 2.6, y - 0.8, 5, 1.3, '#5B6EE1'); cel(x - 1, y - 1.8, 3.4, 1.1, '#5B6EE1'); cel(x + 2, y - 2.2, 1.6, 0.9, '#5B6EE1');
      cel(x + 3.3, y - 2.6, 1.2, 1.2, '#FFE7A0');
      cel(x - 1.8, y + 0.6, 0.5, 0.5, '#FFE7A0'); cel(x + 1.2, y + 0.7, 0.5, 0.5, '#FFE7A0');
    }
  }
  const COLOR_MEDALLA = [['#CD7F32', 3], ['#C9CED6', 7], ['#FFD34D', 14]];
  function medallas(x, y) {
    const r = (est.racha && est.racha.dias) || 0;
    let i = 0;
    for (const [color, minimo] of COLOR_MEDALLA) {
      if (r < minimo) continue;
      const xx = x + i * 1.1;
      cel(xx + 0.15, y - 0.9, 0.3, 0.8, COL.rojo); cel(xx + 0.45, y - 0.9, 0.3, 0.8, COL.lente);
      cel(xx, y - 0.2, 0.9, 0.9, color); cel(xx + 0.2, y, 0.3, 0.3, COL.blanco, 0.7);
      i++;
    }
  }
  function monoTricolor(x, y) {
    cel(x, y, 0.5, 1.4, '#1E8E3E'); cel(x + 0.5, y, 0.5, 1.4, COL.blanco); cel(x + 1, y, 0.5, 1.4, '#CE1126');
    cel(x + 0.2, y + 1.4, 0.4, 0.8, '#1E8E3E'); cel(x + 0.9, y + 1.4, 0.4, 0.8, '#CE1126');
  }
  function taza(cx, cy) {
    const prev = S; S = { ox: cx, oy: cy, sx: 1, sy: 1 };
    cel(-0.9, -1.6, 1.8, 1.8, COL.bata); cel(-0.7, -1.4, 1.4, 0.4, '#6F4E37'); cel(0.9, -1.2, 0.5, 0.9, COL.bata);
    S = prev;
  }
  function escoba(cx, base) {
    const prev = S; S = { ox: cx, oy: base, sx: 1, sy: 1 };
    cel(-0.15, -9, 0.3, 7.5, COL.tallo);
    cel(-1.1, -1.6, 2.2, 1.6, COL.ambar); cel(-1.1, -1.6, 2.2, 0.3, '#B8860B');
    S = prev;
  }
  function extintor(cx, cy) {
    const prev = S; S = { ox: cx, oy: cy, sx: 1, sy: 1 };
    cel(-0.8, -1.2, 1.6, 3.4, COL.rojo); cel(-0.8, -1.2, 0.4, 3.4, COL.pelotaS);
    cel(-0.4, -1.8, 0.8, 0.6, COL.borde); cel(0.4, -1.8, 1.8, 0.4, COL.borde);
    cel(-0.6, 0, 1.2, 0.6, COL.bata);
    S = prev;
  }
  // Lámpara de noche junto al koala (con su cono de luz).
  function dibujarLampara() {
    if (momentoDelDia() !== 'noche') return;
    const x = Math.max(3 * C, k.x - 11 * C);
    rect(x - 3 * C, suelo - 9 * C, 7 * C, 9 * C, '#FFE7A0', 0.06);
    const prev = S; S = { ox: x, oy: suelo, sx: 1, sy: 1 };
    cel(-1.2, -0.5, 2.4, 0.5, COL.laptopS); cel(-0.15, -6, 0.3, 5.5, COL.laptopS);
    cel(-1.4, -7.6, 2.8, 1.6, '#E8C15A'); cel(-1, -6.2, 2, 0.4, '#FFE7A0');
    S = prev;
  }

  // Tizne tras una explosión: manchas oscuras y pelo erizado.
  function hollin(ojoI, ojoD, y) {
    const a = Math.min(1, k.hollin / 1.5) * 0.75, g = '#2E2E2E';
    cel(ojoI - 0.8, y + 0.9, 1.6, 0.8, g, a); cel(ojoD + 0.4, y - 0.5, 1.4, 0.9, g, a);
    cel(-3.6, -3.6, 1.8, 0.9, g, a * 0.8); cel(1.6, -3, 1.6, 0.7, g, a * 0.8);
    for (let i = 0; i < 5; i++) cel(-2.4 + i * 1.1, -8.7 - (i % 2) * 0.4, 0.4, 0.7 + (i % 2) * 0.4, g, a);
  }
  // Día de Muertos: antifaz blanco de catrina alrededor de los ojos (se pinta antes de los ojos).
  function antifazMuertos(ojoI, ojoD, y) {
    if (est.temporada !== 'muertos') return;
    for (const x of [ojoI, ojoD]) {
      cel(x - 0.6, y - 0.6, 2.2, 2.2, COL.bata);
      cel(x - 0.3, y - 0.9, 1.6, 0.3, COL.corazon);
      cel(x - 0.9, y - 0.3, 0.3, 1.6, COL.ambar); cel(x + 1.6, y - 0.3, 0.3, 1.6, COL.ambar);
    }
  }
  function adornoOreja(x, y) {
    const t = est.temporada;
    if (t === 'muertos') cempasuchil(x, y);
    else if (t === 'sanvalentin') { // moño rosa
      cel(x, y + 0.4, 0.9, 1, COL.corazon); cel(x + 1.1, y + 0.4, 0.9, 1, COL.corazon); cel(x + 0.8, y + 0.6, 0.5, 0.6, '#C2185B');
    } else if (t === 'madres' || t === 'primavera') { // flor
      const p = t === 'madres' ? '#F06292' : '#FFD34D';
      cel(x + 0.5, y, 1, 1.8, p); cel(x, y + 0.4, 2, 1, p); cel(x + 0.65, y + 0.55, 0.7, 0.7, t === 'madres' ? '#FFD34D' : '#F28C1B');
    }
  }
  function cempasuchil(x, y) {
    const n = '#F28C1B', a = '#FFC93C';
    cel(x + 0.5, y, 1, 1.8, n); cel(x, y + 0.4, 2, 1, n);
    cel(x + 0.6, y + 0.5, 0.8, 0.8, a);
    cel(x + 0.9, y + 1.7, 0.25, 0.8, COL.hoja);
  }

  function brazoIzq() {
    const P = COL.pata, B = COL.bata;
    if (k.sosteniendo === 'comida') { cel(-3, -4.9, 1.4, 1, P); return; }
    if (k.brazos === 'aplauso') {
      const junto = Math.floor(k.t * 7) % 2 ? 1 : 0; // manos que se juntan y se abren
      cel(-5.5, -4.6, 2.4, 1.2, B); cel(3.1, -4.6, 2.4, 1.2, B);
      cel(-3.3 + junto * 1.9, -4.8, 1.5, 1.4, P); cel(1.8 - junto * 1.9, -4.8, 1.5, 1.4, P);
      if (junto) { cel(-1.6, -6.4, 0.6, 0.6, COL.ambar, 0.9); cel(1, -6.4, 0.6, 0.6, COL.ambar, 0.9); }
      return;
    }
    if (k.brazos === 'arriba') { cel(-6, -9.5, 2, 2.4, B); cel(-6, -10.5, 2, 1, P); return; }
    cel(-6, -5, 2, 1.2, B); cel(-6, -3.8, 2, 0.8, P);
  }
  function brazoDer() {
    const P = COL.pata, B = COL.bata;
    switch (k.brazos) {
      case 'atras': return; // la mano está detrás de la espalda
      case 'arriba':
      case 'arriba-der': cel(4, -9.5, 2, 2.4, B); cel(4, -10.5, 2, 1, P); return;
      case 'saludo': {
        const o = Math.sin(k.t * 14) * 0.5;
        cel(4 + o * 0.5, -9.5, 2, 2.4, B); cel(4 + o, -10.6, 2, 1.1, P); return;
      }
      case 'lado': cel(4, -5, 2, 1.2, B); cel(6, -5, 1, 1.2, P); return;
      case 'frasco': cel(4, -5.2, 1.6, 1.2, B); cel(5.4, -5.6, 1.2, 1.2, P); return;
      case 'rascar': {
        const o = Math.sin(k.t * 18) * 0.3;
        cel(4, -8.6, 1.6, 3, B); cel(2.6 + o, -9.4, 1.6, 1, P); return;
      }
      case 'aplauso': return; // lo dibuja brazoIzq con las dos manos
    }
    if (k.sosteniendo === 'comida') { cel(1.6, -4.9, 1.4, 1, P); return; }
    cel(4, -5, 2, 1.2, B); cel(4, -3.8, 2, 0.8, P);
  }

  // Tres cuartos, sentado, mirando a la derecha (hacia la laptop).
  function koalaSentado() {
    const P = COL.pelaje, PS = COL.pelajeS;
    // oreja lejana y cercana
    cel(-5.6, -9.4, 2, 2.6, PS); cel(-6, -8.9, 2.8, 1.6, PS); cel(-5, -8.7, 0.9, 1.1, COL.oreja);
    cel(2.4, -9.6, 2, 3, P); cel(2, -9.1, 3, 2, P); cel(2.9, -8.9, 1, 1.4, COL.oreja);
    // cuerpo con el costado izquierdo sombreado
    cel(-4, -7, 8, 6, P);
    cel(-4, -7, 2, 6, PS);
    // bata
    cel(-4, -3, 8, 2, COL.bata);
    cel(-4, -3, 2, 2, COL.bataS);
    cel(-4, -1.4, 8, 0.4, COL.bataS);
    cel(1, -3, 2, 0.7, COL.camisa); cel(1.5, -2.3, 1, 0.5, COL.camisa);
    // lentes
    cel(-2, -6.9, 6, 0.5, COL.correa);
    cel(-1.4, -7.4, 2, 1.2, COL.correa); cel(-1.2, -7.2, 1.6, 0.8, COL.lente);
    cel(1.8, -7.4, 2, 1.2, COL.correa); cel(2, -7.2, 1.6, 0.8, COL.lente);
    // dos ojos, nariz de perfil a tres cuartos
    const cuerpo = S;
    if (k.modo === 'siesta') S = Object.assign({}, S, { oy: S.oy + (0.6 + (k.cabeceo || 0)) * C }); // cabecea
    antifazMuertos(-0.8, 2.3, -5.7);
    ojosDe(ojosActuales(), -0.8, 2.3, -5.7);
    cel(2.7, -5.0, 2.1, 1.8, COL.nariz);
    cel(3.1, -4.8, 0.5, 0.4, COL.narizL);
    S = cuerpo;
    if (k.sudor) cel(-3.2, -6.6, 0.6, 1, COL.sudor);
    if (k.hollin > 0) hollin(-0.8, 2.3, -5.7);
    adornoOreja(-6.4, -10.2);
    sombrero(1, -9.2);
    medallas(-1.6, -2.4);
    if (est.temporada === 'patrias') monoTricolor(2.4, -2.8);
    // pies hacia adelante
    cel(0.6, -1, 1.7, 1, COL.pata); cel(2.8, -1, 1.7, 1, COL.pata);
    // mano derecha que sube y baja sobre el teclado
    const sube = k.modo === 'experimento' || k.exp ? (k.brazoY || 0) + 1.2 : k.tecleo ? 0.7 : 0;
    cel(4, -2.6 - sube, 2, 1.1, COL.bata);
    cel(6, -2.6 - sube, 1.2, 1, P);
    if (k.exp && k.exp.tubo) {
      cel(6.4, -4.4 - sube, 0.6, 2.2, COL.vidrio);
      cel(6.4, -2.9 - sube, 0.6, 0.7, COL.morado);
    }
  }

  function dibujarLaptop() {
    const l = k.laptop;
    if (!l) return;
    const prev = S;
    S = { ox: k.x, oy: suelo, sx: 1, sy: 1 };
    if (!l.abierta) {
      cel(l.x, l.y, 4.5, 0.8, COL.laptop);
      cel(l.x, l.y + 0.6, 4.5, 0.2, COL.laptopS);
      cel(l.x + 1.9, l.y + 0.2, 0.6, 0.35, COL.lente); // calcomanía de matraz
    } else {
      cel(l.x, l.y, 4.5, 0.8, COL.laptop);
      cel(l.x + 0.4, l.y, 2.8, 0.25, COL.laptopS);
      cel(l.x + 4, l.y - 3.4, 0.8, 3.6, COL.laptopS);
      cel(l.x + 3.6, l.y - 3.2, 0.4, 3.0, COL.pantalla, 0.75);
      if (k.modo === 'trabajo') matraz(k.x + 11.4 * C, suelo, colorUso(), 1);
    }
    S = prev;
  }

  function matraz(cx, base, liquido, escala) {
    const prev = S;
    S = { ox: cx, oy: base, sx: escala, sy: escala };
    cel(-0.4, -3.2, 0.8, 1.1, COL.vidrio);
    cel(-1, -2.2, 2, 0.8, COL.vidrio);
    cel(-1.4, -1.4, 2.8, 1.4, COL.vidrio);
    cel(-1.2, -1.2, 2.4, 1.1, liquido);
    cel(-0.8, -1.8, 1.6, 0.6, liquido);
    cel(-0.6, -3.4, 1.2, 0.3, COL.laptopS);
    S = prev;
  }

  function colorUso() {
    const u = usoMaximo();
    if (u >= est.umbral) return COL.rojo;
    if (u >= 75) return COL.ambar;
    return COL.verde;
  }

  function dibujarRama(x, y, hojas, escala) {
    if (est.temporada === 'marmota') return dibujarTamal(x, y, hojas, escala);
    if (est.temporada === 'reyes') return dibujarRosca(x, y, hojas, escala);
    const prev = S;
    S = { ox: x, oy: y, sx: escala, sy: escala };
    cel(-2.5, -0.5, 5, 0.5, COL.tallo);
    const pos = [[-2.2, -1.4], [-0.6, -1.7], [1, -1.4]];
    for (let i = 0; i < hojas; i++) {
      cel(pos[i][0], pos[i][1], 1.4, 0.9, COL.hoja);
      cel(pos[i][0] + 0.2, pos[i][1] + 0.6, 1, 0.2, COL.hojaS);
    }
    S = prev;
  }

  function dibujarTamal(x, y, partes, escala) {
    const prev = S; S = { ox: x, oy: y, sx: escala, sy: escala };
    const largo = 1.4 + partes * 1.2; // se acorta con cada mordida
    cel(-2.5, -1.6, largo + 0.4, 1.6, '#C9B27C'); // hoja de maíz
    cel(-2.2, -1.3, largo - 0.3, 1, '#F2C94C'); // masa
    cel(-2.6 + largo + 0.2, -1.4, 0.6, 1.2, '#A8925E'); cel(-2.9, -1.2, 0.5, 0.8, '#A8925E');
    S = prev;
  }
  function dibujarRosca(x, y, partes, escala) {
    const prev = S; S = { ox: x, oy: y, sx: escala, sy: escala };
    const ancho = 2 + partes * 1.2;
    cel(-ancho / 2, -1.8, ancho, 0.7, '#C98B3E'); cel(-ancho / 2, -0.7, ancho, 0.7, '#C98B3E');
    cel(-ancho / 2, -1.8, 0.8, 1.8, '#C98B3E'); cel(ancho / 2 - 0.8, -1.8, 0.8, 1.8, '#C98B3E');
    cel(-ancho / 2 + 0.6, -2, 0.6, 0.4, COL.rojo); cel(-0.2, -2, 0.6, 0.4, COL.verde); cel(ancho / 2 - 1.2, -2, 0.6, 0.4, '#FFD34D');
    S = prev;
  }

  function dibujarPelota() {
    if (!pelota) return;
    const px = 0.6 * C;
    const x = pelota.x - 2.5 * px, y = suelo - pelota.alt - 5 * px;
    glifo(G_PELOTA, x, y, px, COL.pelota, pelota.alfa);
    const franja = ((Math.floor(pelota.giro * 1.5) % 5) + 5) % 5;
    rect(x + franja * px, y + px, px, 3 * px, COL.blanco, pelota.alfa * 0.9);
    rect(x + px, y + 4 * px, 3 * px, px, COL.pelotaS, pelota.alfa);
  }

  // Globo de petición sobre la cabeza.
  function peticion() {
    if (est.claudeNecesita) return 'pregunta';
    if (k.modo !== 'libre' || paso && !paso.libre) return null;
    const n = est.necesidades, u = usoMaximo();
    const al = alertaMayor();
    if (u >= est.umbral || (al && al.nivel >= 3)) return 'limite';
    if (al && al.nivel === 2) return 'matraz';
    if (n.energia < 30) return 'sueno';
    if (n.saciedad < 35) return 'comida';
    if (n.animo < 35) return 'pelota';
    if (u >= 75) return 'matraz';
    return null;
  }
  function dibujarGlobo() {
    const tipo = peticion();
    if (!tipo || (tipo !== 'pregunta' && (k.t % 8) > 3.2)) return;
    const w = 9 * C, h = 7 * C;
    let x = k.x + 4 * C, y = suelo - k.alt - 18 * C;
    if (x + w > W - 2) x = k.x - 4 * C - w;
    y = Math.max(2, y);
    rect(x, y, w, h, COL.blanco);
    rect(x, y, w, 1, COL.borde); rect(x, y + h - 1, w, 1, COL.borde);
    rect(x, y, 1, h, COL.borde); rect(x + w - 1, y, 1, h, COL.borde);
    const colaX = x < k.x ? x + w - 3 * C : x + C;
    rect(colaX, y + h - 1, 2 * C, 1, COL.blanco);
    rect(colaX + 0.5 * C, y + h, C, C * 0.8, COL.borde);
    const cx = x + w / 2, cy = y + h / 2;
    if (tipo === 'pregunta') glifo(G_PREGUNTA, cx - 6, cy - 2.5 * C, 3, COL.lente);
    else if (tipo === 'comida') dibujarRama(cx, cy + 1.2 * C, 3, 1);
    else if (tipo === 'pelota') glifo(G_PELOTA, cx - 7.5, cy - 7.5, 3, COL.pelota);
    else if (tipo === 'sueno') glifo(G_Z, cx - 7.5, cy - 7.5, 3, COL.z);
    else if (tipo === 'matraz') matraz(cx, cy + 1.8 * C, COL.ambar, 1);
    else if (tipo === 'limite') {
      matraz(cx - 1.2 * C, cy + 1.8 * C, COL.rojo, 1);
      glifo(G_EXCL, cx + 1.6 * C, cy - 2.5 * C, 2.6, COL.rojo);
    }
  }

  function dibujarComida() {
    if (!comida || k.sosteniendo === 'comida') return;
    dibujarRama(comida.x, suelo - comida.alt, comida.hojas, 1);
  }
  function fisicaComida(dt) {
    if (!comida || comida.enSuelo) return;
    comida.v -= 600 * dt;
    comida.alt += comida.v * dt;
    if (comida.alt <= 0) {
      comida.alt = 0;
      if (Math.abs(comida.v) > 120) comida.v = -comida.v * 0.25;
      else { comida.v = 0; comida.enSuelo = true; }
    }
  }

  let colorSuelo = 'rgba(128,128,128,0.4)';
  function leerColores() {
    try {
      const fg = getComputedStyle(document.body).getPropertyValue('--vscode-foreground').trim();
      if (fg) colorSuelo = fg;
    } catch (e) { /* sin estilos */ }
  }

  const G_TOMATE = ['..X.X..', '...X...', '.XXXXX.', 'XXXXXXX', 'XXXXXXX', 'XXXXXXX', '.XXXXX.'];
  const G_TAZA = ['.X.X..', '..X.X.', 'XXXXX.', 'XXXXXX', 'XXXX.X', 'XXXXX.', '.XXX..'];
  let pomoRecibido = 0;
  function restantePomo() {
    const p = est.pomodoro;
    if (!p || !p.fase) return 0;
    return p.pausado ? p.restante : Math.max(0, p.restante - (Date.now() - pomoRecibido));
  }
  function dibujarPomodoro() {
    const p = est.pomodoro;
    if (!p || !p.fase) return;
    const enfoque = p.fase === 'enfoque';
    const x = 6, y = est.temporada === 'muertos' ? 24 : 6, px = 2; // debajo del papel picado
    if (enfoque) {
      glifo(G_TOMATE, x, y, px, COL.rojo);
      rect(x + 4 * px, y, px, 2 * px, COL.hoja);
      rect(x + 2 * px, y, px, px, COL.hoja);
    } else {
      glifo(G_TAZA, x, y, px, COL.oreja);
      rect(x, y + 2 * px, 5 * px, px, COL.tallo);
    }
    const frac = p.total ? 1 - restantePomo() / p.total : 0;
    const bx = x + 9 * px, bw = 50;
    rect(bx, y + 5, bw, 4, colorSuelo, 0.25);
    rect(bx, y + 5, bw * Math.max(0, Math.min(1, frac)), 4, enfoque ? COL.rojo : COL.verde, p.pausado && Math.floor(k.t * 2) % 2 ? 0.4 : 1);
  }

  // Papel picado de Día de Muertos que se mece arriba del lienzo.
  const COLORES_PICADO = ['#E85A7A', '#F28C1B', '#A77BE0', '#5BC46A', '#7FD3F0', '#FFC93C'];
  function papelPicado() {
    const y0 = 4, paso = 22;
    rect(0, y0, W, 1, colorSuelo, 0.4);
    for (let i = 0, x = 6; x < W - 10; i++, x += paso) {
      const c = COLORES_PICADO[i % COLORES_PICADO.length];
      const vaiven = Math.sin(k.t * 1.6 + i) * 1.2;
      const xx = x + vaiven;
      rect(xx, y0 + 1, 14, 13, c, 0.9);
      rect(xx + 3, y0 + 4, 2, 2, '#000000', 0.35); rect(xx + 9, y0 + 4, 2, 2, '#000000', 0.35);
      rect(xx + 6, y0 + 7, 2, 2, '#000000', 0.35);
      for (let j = 0; j < 3; j++) rect(xx + 1 + j * 5, y0 + 13, 3, 2, c, 0.9); // borde recortado
    }
  }

  // ---------- Arrastrar: al koala y la comida ----------
  let arrastre = null; // { tipo: 'koala'|'comida', x0, y0, movido, x, y }
  let comidaSoltada = null;
  const ICONO_COMIDA = () => ({ x: 14, y: suelo + 9 });
  function dibujarComidaArrastrable() {
    const ic = ICONO_COMIDA();
    if (arrastre && arrastre.tipo === 'comida' && arrastre.movido) dibujarRama(arrastre.x, arrastre.y, 3, 1);
    else dibujarRama(ic.x, ic.y, 3, 0.6);
  }
  function puntoEn(e) {
    const r = lienzo.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  function sobreKoala(p) {
    return Math.abs(p.x - (k.x + k.balanceo * C)) < 7 * C && p.y > suelo - k.alt - 11 * C && p.y < suelo - k.alt + 4;
  }
  function sobreComida(p) {
    const ic = ICONO_COMIDA();
    return Math.abs(p.x - ic.x) < 12 && Math.abs(p.y - (ic.y - 3)) < 10;
  }
  function alPresionar(e) {
    const p = puntoEn(e);
    if (sobreComida(p)) arrastre = { tipo: 'comida', x0: p.x, y0: p.y, movido: false, x: p.x, y: p.y };
    else if (sobreKoala(p)) arrastre = { tipo: 'koala', x0: p.x, y0: p.y, movido: false, x: p.x, y: p.y };
    else return;
    try { lienzo.setPointerCapture(e.pointerId); } catch (err) { /* sin captura */ }
  }
  function alMover(e) {
    const p = puntoEn(e);
    lienzo.style.cursor = arrastre ? 'grabbing' : sobreComida(p) || sobreKoala(p) ? 'grab' : 'default';
    if (!arrastre) return;
    arrastre.x = p.x; arrastre.y = p.y;
    if (!arrastre.movido && Math.hypot(p.x - arrastre.x0, p.y - arrastre.y0) > 4) {
      arrastre.movido = true;
      if (arrastre.tipo === 'koala') {
        // Solo se deja cargar cuando no tiene la laptop o la mesa afuera.
        if (k.modo !== 'libre') { arrastre = null; return; }
        cola = []; paso = null; posturaBase();
        k.cargado = true; ponerPose('estirado'); k.brazos = 'arriba'; k.ojos = 'abiertos';
        k.texto = '¡Wiii!';
      }
    }
    if (arrastre.movido && arrastre.tipo === 'koala') {
      k.x = Math.max(6 * C, Math.min(W - 6 * C, p.x));
      k.alt = Math.max(0, suelo - p.y - 5 * C);
    }
  }
  function alSoltar(e) {
    if (!arrastre) return;
    const a = arrastre;
    arrastre = null;
    if (a.tipo === 'koala' && !a.movido) { vscode.postMessage({ tipo: 'accion', accion: 'mimar' }); return; }
    if (a.tipo === 'koala') { k.cargado = false; k.cayendo = true; k.vAlt = 0; return; }
    if (a.tipo === 'comida' && a.movido && a.y < suelo) {
      comidaSoltada = { x: a.x, alt: suelo - a.y };
      vscode.postMessage({ tipo: 'accion', accion: 'comer' });
    }
  }
  // Caída al soltarlo: gravedad y aterrizaje aplastado.
  function caer(dt) {
    if (!k.cayendo) return;
    k.vAlt -= 700 * dt;
    k.alt += k.vAlt * dt;
    if (k.alt <= 0) {
      k.alt = 0; k.cayendo = false;
      cola.push(
        esperar(0.25, { ini() { ponerPose('aplastado'); k.brazos = 'normal'; k.ojos = 'cerrados'; puf(k.x, suelo - C); } }),
        esperar(0.8, { ini() { ponerPose('frente'); k.ojos = 'felices'; k.texto = '¡Otra vez!'; }, fin() { k.ojos = null; } })
      );
    }
  }

  function dibujar() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, lienzo.width, lienzo.height);
    rect(0, suelo, W, 1, colorSuelo, 0.25);
    // sombra
    const ancho = 9 * C * (1 - Math.min(0.5, k.alt / 60));
    rect(k.x + k.balanceo * C - ancho / 2, suelo - 1, ancho, 3, '#000000', 0.16);
    if (pelota) rect(pelota.x - 6, suelo - 1, 12, 2, '#000000', 0.12 * pelota.alfa);

    const volteo = 1 - 0.5 * Math.sin(Math.PI * Math.min(1, k.tVolteo / 0.16));
    S = { ox: k.x + k.balanceo * C, oy: suelo - k.alt, sx: k.def.sx * volteo, sy: k.def.sy };
    decorarFecha(0);
    dibujarLampara();
    const laptopAtras = k.laptop && k.brazos === 'atras';
    if (laptopAtras) dibujarLaptop();
    if (k.pose === 'sentado') koalaSentado(); else koalaFrente();
    if (!laptopAtras) dibujarLaptop();
    dibujarMesa();
    dibujarCohete();
    dibujarRelojArena();
    dibujarComidaArrastrable();
    dibujarComida();
    dibujarPelota();
    dibujarParticulas();
    dibujarGlobo();
    dibujarPomodoro();
    if (est.temporada === 'muertos') papelPicado();
    if (destello > 0) rect(0, 0, W, H, '#FFE7A0', destello * 1.6);
    ctx.globalAlpha = 1;
  }

  // ---------- Bucle ----------
  function actualizar(dt) {
    k.t += dt;
    k.tVolteo += dt;
    const d = DEFORMACION[k.pose] || [1, 1];
    const f = Math.min(1, dt * 18);
    k.def.sx += (d[0] - k.def.sx) * f;
    k.def.sy += (d[1] - k.def.sy) * f;
    // parpadeo cada ~3.7 s
    k.parpadeo = Math.max(0, k.parpadeo - dt);
    k.proxParpadeo -= dt;
    if (k.proxParpadeo <= 0) { k.parpadeo = 0.13; k.proxParpadeo = azar(3.2, 4.2); }
    if (k.cargado) { k.paso = 0; k.caminando = false; } else if (k.cayendo) caer(dt); else correrPasos(dt);
    if (k.hollin > 0) k.hollin = Math.max(0, k.hollin - dt);
    if (destello > 0) destello = Math.max(0, destello - dt);
    fisicaComida(dt);
    fisicaPelota(dt);
    moverParticulas(dt);
    decorarFecha(dt);
    if ((k.modo === 'dormido' || k.modo === 'siesta') && Math.random() < dt * 0.9) zeta();
    pintarTexto();
  }

  let tPrevio = null;
  function cuadro(ahora) {
    if (tPrevio === null) tPrevio = ahora;
    const dt = Math.min(0.05, Math.max(0, (ahora - tPrevio) / 1000));
    tPrevio = ahora;
    actualizar(dt);
    dibujar();
    requestAnimationFrame(cuadro);
  }

  // ---------- Interfaz HTML ----------
  const $ = (id) => document.getElementById(id);
  let textoPrevio = '';
  function pintarTexto() {
    const el = $('estado');
    if (!el) return;
    let t = k.texto || textoOcio();
    if (k.modo === 'dormido') t = est.energiaLigada && est.necesidades.energia < 30
      ? 'Duerme hasta que se recargue la sesión (' + horaReinicio() + ')'
      : 'Durmiendo… zzz';
    if (t !== textoPrevio) { el.textContent = t; textoPrevio = t; }
  }

  function colorBarra(v) {
    if (v < 25) return 'var(--vscode-charts-red, #e0524d)';
    if (v < 50) return 'var(--vscode-charts-yellow, #f2b33d)';
    return 'var(--vscode-charts-green, #5bc46a)';
  }
  function pintarNecesidades() {
    for (const clave of ['saciedad', 'animo', 'energia']) {
      const v = Math.round(est.necesidades[clave]);
      const b = $('b-' + clave), n = $('n-' + clave);
      if (b) { b.style.width = v + '%'; b.style.background = colorBarra(v); }
      if (n) n.textContent = v;
    }
    const le = $('l-energia'), se = $('s-energia');
    if (le) le.title = est.energiaLigada ? 'Energía = lo que te queda de la sesión de 5 h de Claude Code' : 'Energía del koala (sin dato oficial de Claude Code)';
    if (se) se.textContent = est.energiaLigada ? '⚡ ligada a tu sesión de 5 h · se recarga ' + horaReinicio() : '';
    const bd = $('btn-dormir');
    if (bd) bd.textContent = est.durmiendo ? 'Despertar' : 'Dormir';
  }

  function horaReinicio() {
    const v = est.uso && est.uso.cinco;
    if (!v || !v.reinicio) return 'en el próximo corte';
    const d = new Date(v.reinicio);
    return 'a las ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ' (en ' + falta(v.reinicio) + ')';
  }
  const NOMBRE_FASE = { enfoque: 'Experimento (enfoque)', descanso: 'Descanso', descansoLargo: 'Descanso largo' };
  function pintarPomodoroDom() {
    const p = est.pomodoro || {};
    const fase = $('pomo-fase'), reloj = $('pomo-reloj'), barra = $('pomo-barra'), sub = $('pomo-sub');
    const alt = $('pomo-alternar'), det = $('pomo-detener');
    if (!fase || !reloj || !barra) return;
    const ms = p.fase ? restantePomo() : (p.enfoque || 25) * 60000;
    const s = Math.ceil(ms / 1000);
    reloj.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
    fase.textContent = p.fase ? NOMBRE_FASE[p.fase] + (p.pausado ? ' (en pausa)' : '') : 'Pomodoro';
    barra.style.width = (p.fase && p.total ? Math.min(100, 100 * (1 - ms / p.total)) : 0) + '%';
    barra.className = p.fase && p.fase !== 'enfoque' ? 'descanso' : '';
    if (sub) sub.textContent = (p.hoy || 0) + ' pomodoro' + (p.hoy === 1 ? '' : 's') + ' completado' + (p.hoy === 1 ? '' : 's') + ' hoy';
    if (alt) alt.textContent = !p.fase ? 'Iniciar experimento' : p.pausado ? 'Reanudar' : 'Pausar';
    if (det) det.disabled = !p.fase;
  }
  function falta(ms) {
    const min = Math.max(0, Math.round((ms - Date.now()) / 60000));
    if (min < 60) return min + ' min';
    const h = Math.floor(min / 60);
    if (h < 24) return h + ' h ' + (min % 60) + ' min';
    return Math.floor(h / 24) + ' d ' + (h % 24) + ' h';
  }
  function tokens(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + ' M';
    if (n >= 1e3) return Math.round(n / 1e3) + ' mil';
    return String(n);
  }
  function colorUsoCss(p) {
    if (p >= est.umbral) return 'var(--vscode-charts-red, #e0524d)';
    if (p >= 75) return 'var(--vscode-charts-yellow, #f2b33d)';
    return 'var(--vscode-charts-green, #5bc46a)';
  }
  function pintarProbeta(id, v, tok, etiquetaTok) {
    const p = $('p-' + id), t = $('t-' + id), s = $('s-' + id);
    if (!p || !t || !s) return;
    const partes = [];
    if (v) {
      const pct = Math.max(0, Math.min(100, v.pct));
      p.textContent = v.reiniciada ? '0 %' : Math.round(pct) + ' %';
      t.style.width = pct + '%';
      t.style.background = colorUsoCss(pct);
      if (v.reiniciada) partes.push('reiniciada, esperando dato nuevo');
      else if (v.reinicio) partes.push('se reinicia en ' + falta(v.reinicio));
    } else {
      p.textContent = '—';
      t.style.width = '0';
    }
    partes.push(tokens(tok) + ' tokens ' + etiquetaTok);
    s.textContent = partes.join(' · ');
  }
  function pintarUso() {
    const u = est.uso;
    if (!u) return;
    pintarProbeta('cinco', u.cinco, u.local.tokens5h, 'en esta sesión');
    pintarProbeta('semana', u.semana, u.local.tokens7d, 'en la semana');
    const nota = $('uso-nota'), btn = $('btn-configurar');
    const oficial = u.cinco || u.semana;
    if (nota) {
      if (oficial && u.actualizado) {
        const min = Math.max(0, Math.round((Date.now() - u.actualizado) / 60000));
        nota.textContent = (u.fuente === 'anthropic' ? 'Dato real de Anthropic' : 'Dato de la status line') + ' de hace ' + min + ' min' +
          (u.modelo ? ' · ' + u.modelo : '') + '. Tokens contados en tus transcripciones locales.';
      } else {
        nota.textContent = 'Sin porcentaje oficial todavía: configura el monitor para que Claude Code lo comparta. Mientras, el koala cuenta tokens de tus transcripciones.';
      }
    }
    if (btn) btn.style.display = oficial ? 'none' : 'inline-block';
  }

  let pctPrevio = null;
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m) return;
    if (m.tipo === 'estado') {
      const antes = { trabajando: est.trabajando, durmiendo: est.durmiendo, necesita: !!est.claudeNecesita, siesta: enSiesta(),
        fase: est.pomodoro ? est.pomodoro.fase + ':' + est.pomodoro.pausado : '' };
      est = Object.assign(est, m);
      pintarNecesidades();
      pintarUso();
      const pct = est.uso && est.uso.cinco ? (est.uso.cinco.reiniciada ? 0 : est.uso.cinco.pct) : null;
      if (pctPrevio !== null && pct !== null && pctPrevio >= 40 && pct < pctPrevio - 30) { pendientes.push('festejar'); interrumpir(); }
      if (pct !== null) pctPrevio = pct;
      pomoRecibido = Date.now();
      pintarPomodoroDom();
      const fase = est.pomodoro ? est.pomodoro.fase + ':' + est.pomodoro.pausado : '';
      if (antes.trabajando !== est.trabajando || antes.durmiendo !== est.durmiendo || antes.fase !== fase || antes.necesita !== !!est.claudeNecesita || antes.siesta !== enSiesta()) interrumpir();
    } else if (m.tipo === 'accion') {
      if (m.datos) datosAccion[m.accion] = m.datos;
      pendientes.push(m.accion);
      interrumpir();
    }
  });

  document.querySelectorAll('[data-accion]').forEach((b) => {
    b.addEventListener('click', () => vscode.postMessage({ tipo: 'accion', accion: b.getAttribute('data-accion') }));
  });
  const btnPomo = $('pomo-alternar'), btnPomoDet = $('pomo-detener');
  if (btnPomo) btnPomo.addEventListener('click', () => vscode.postMessage({ tipo: 'pomodoro', op: 'alternar' }));
  if (btnPomoDet) btnPomoDet.addEventListener('click', () => vscode.postMessage({ tipo: 'pomodoro', op: 'detener' }));
  const btnConf = $('btn-configurar');
  if (btnConf) btnConf.addEventListener('click', () => vscode.postMessage({ tipo: 'configurar' }));

  lienzo.addEventListener('pointerdown', alPresionar);
  lienzo.addEventListener('pointermove', alMover);
  lienzo.addEventListener('pointerup', alSoltar);
  lienzo.addEventListener('pointercancel', alSoltar);

  if (typeof ResizeObserver === 'function') new ResizeObserver(ajustar).observe(lienzo);
  window.addEventListener('resize', ajustar);
  setInterval(pintarUso, 30 * 1000);
  setInterval(pintarPomodoroDom, 1000);

  ajustar();
  leerColores();
  k.x = W / 2;
  vscode.postMessage({ tipo: 'listo' });
  requestAnimationFrame(cuadro);

  // Gancho para las pruebas sin navegador.
  window.__koala = { k, est: () => est, cola: () => cola };
})();
