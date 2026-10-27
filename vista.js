'use strict';
// HTML y CSS del panel del koala (webview). Todo con nonce: la CSP no permite estilos ni scripts en línea.
const vscode = require('vscode');
const crypto = require('crypto');
const idioma = require('./idioma');
const { t } = idioma;

function htmlVista(webview, extensionUri) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const script = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'koala.js'));
  const scriptPanel = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'panel.js'));
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="${idioma.esIngles() ? 'en' : 'es-MX'}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${t('Koala científico')}</title>
<style nonce="${nonce}">
  body { margin: 0; padding: 6px 10px 12px; font-family: var(--vscode-font-family); font-size: 12px;
         color: var(--vscode-foreground); }
  #lienzo { width: 100%; height: 150px; display: block; cursor: pointer; image-rendering: pixelated; }
  #estado { text-align: center; margin: 4px 0 8px; min-height: 16px; opacity: .9; }
  .fila { display: grid; grid-template-columns: 64px 1fr 30px; align-items: center; gap: 6px; margin: 3px 0; }
  .barra { height: 8px; background: var(--vscode-editorWidget-border, #8884); border-radius: 4px; overflow: hidden; }
  .barra > i { display: block; height: 100%; width: 50%; background: var(--vscode-charts-green, #4caf50);
               transition: width .4s ease, background-color .4s ease; }
  .num { text-align: right; font-variant-numeric: tabular-nums; opacity: .8; }
  .botones { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; margin: 8px 0 10px; }
  .botones button { font: inherit; padding: 4px 0; border: none; border-radius: 3px; cursor: pointer;
                    color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  .botones button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  .probeta { margin: 6px 0 8px; }
  .probeta .tit { display: flex; justify-content: space-between; margin-bottom: 3px; }
  .probeta .tit b { font-variant-numeric: tabular-nums; }
  .tubo { position: relative; height: 14px; border: 1px solid var(--vscode-foreground); border-radius: 0 7px 7px 0;
          opacity: .95; overflow: hidden; }
  .tubo > i { position: absolute; left: 0; top: 0; bottom: 0; width: 0; transition: width .6s ease;
              background: var(--vscode-charts-green, #4caf50); }
  .tubo > i::after { content: ''; position: absolute; right: 0; top: 0; bottom: 0; width: 3px; background: #fff6; }
  .tubo .marcas { position: absolute; inset: 0;
                  background: repeating-linear-gradient(90deg, transparent 0 calc(10% - 1px), var(--vscode-foreground) calc(10% - 1px) 10%);
                  opacity: .25; }
  .sub { opacity: .7; font-size: 11px; margin-top: 2px; }
  #uso-nota { opacity: .7; font-size: 11px; margin-top: 4px; }
  .boton-agua { width: 100%; font: inherit; margin: -4px 0 10px; padding: 4px 0; border: none; border-radius: 3px; cursor: pointer;
                color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  .logros { display: grid; grid-template-columns: repeat(auto-fill, minmax(38px, 1fr)); gap: 6px; }
  .logro { text-align: center; font-size: 20px; padding: 4px 0; border-radius: 4px; background: var(--vscode-editorWidget-background, #8881); }
  .logro.bloqueado { filter: grayscale(1); opacity: .3; }
  .alarma { display: grid; grid-template-columns: 18px 44px 1fr auto 16px; gap: 6px; align-items: center; font-size: 11px; margin: 3px 0; }
  .alarma.apagada { opacity: .45; }
  .alarma .hora { font-variant-numeric: tabular-nums; font-weight: 600; }
  .alarma .msg { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .alarma .rep { opacity: .65; }
  .alarma button { border: none; background: none; color: var(--vscode-foreground); cursor: pointer; padding: 0; font: inherit; }
  .alarma-form { display: grid; grid-template-columns: 76px 1fr 84px 24px; gap: 4px; margin-top: 4px; }
  .alarma-form input, .alarma-form select { font: inherit; font-size: 11px; min-width: 0; padding: 2px 4px;
    color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, #8884); border-radius: 2px; }
  .alarma-form button { font: inherit; border: none; border-radius: 3px; cursor: pointer;
    color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  [data-tj="pomodoro"] { padding-bottom: 4px; }
  [data-tj="pomodoro"] .barra > i { width: 0; background: var(--vscode-charts-red, #e0524d); transition: width 1s linear; }
  [data-tj="pomodoro"] .barra > i.descanso { background: var(--vscode-charts-green, #5bc46a); }
  .pomo-botones { display: grid; grid-template-columns: 2fr 1fr; gap: 4px; }
  .pomo-botones button { font: inherit; padding: 4px 0; border: none; border-radius: 3px; cursor: pointer;
                         color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  .pomo-botones button:hover { background: var(--vscode-button-hoverBackground); }
  .pomo-botones #pomo-detener { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  /* Carruseles: cada uno muestra una tarjeta; flechas, lista para saltar y deslizar con el mouse. */
  .carrusel { border: 1px solid var(--vscode-editorWidget-border, #8884); border-radius: 6px; margin: 0 0 8px; overflow: hidden;
              background: var(--vscode-editorWidget-background, #8881); }
  .car-cab { display: grid; grid-template-columns: 22px 1fr auto 22px 20px; align-items: center; gap: 2px; padding: 3px 4px;
             border-bottom: 1px solid var(--vscode-editorWidget-border, #8884); }
  .car-cab button { font: inherit; border: none; background: none; color: var(--vscode-foreground); cursor: pointer;
                    padding: 0; height: 20px; border-radius: 3px; opacity: .75; }
  .car-cab button:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground, #8883); }
  .car-cab .flecha { font-size: 15px; line-height: 1; }
  .car-sel { font: inherit; font-size: 11px; font-weight: 600; min-width: 0; width: 100%; border: none; border-radius: 3px;
             padding: 2px 2px; cursor: pointer; color: var(--vscode-foreground); background: transparent; }
  .car-sel:hover, .car-sel:focus { background: var(--vscode-dropdown-background, #8882); }
  .car-sel option, .car-sel optgroup { color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
                                       background: var(--vscode-dropdown-background, #252526); }
  .car-pos { font-size: 10px; opacity: .55; font-variant-numeric: tabular-nums; padding: 0 3px; }
  .car-puntos { display: flex; justify-content: center; gap: 3px; padding: 0 0 5px; }
  .car-puntos i { width: 4px; height: 4px; border-radius: 2px; background: var(--vscode-foreground); opacity: .2; }
  .car-puntos i.sel { opacity: .8; width: 10px; }
  .car-puntos i.alerta-punto { background: var(--vscode-charts-red, #e0524d); opacity: .9; }
  .car-cuerpo { padding: 6px 8px 4px; touch-action: pan-y; }
  .car-cuerpo.entra-der { animation: entraDer .18s ease-out; }
  .car-cuerpo.entra-izq { animation: entraIzq .18s ease-out; }
  @keyframes entraDer { from { transform: translateX(14px); opacity: .2; } to { transform: none; opacity: 1; } }
  @keyframes entraIzq { from { transform: translateX(-14px); opacity: .2; } to { transform: none; opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { .car-cuerpo.entra-der, .car-cuerpo.entra-izq { animation: none; } }
  .car-pie { display: flex; gap: 6px; justify-content: center; }
  .car-pie .boton-chico { margin-top: 0; }
  .tj .botones { margin: 8px 0 8px; }
  .tj .boton-agua { margin: 0 0 4px; }
  .tj .probeta:first-child { margin-top: 0; }
  .alerta[data-ir] { cursor: pointer; }
  #alertas:empty { display: none; }
  #alertas { margin: 0 0 8px; }
  .alerta { font-size: 11px; padding: 4px 6px; border-radius: 3px; margin-bottom: 3px; border-left: 3px solid;
            background: var(--vscode-editorWidget-background, #8881); }
  .alerta.n3 { border-color: var(--vscode-charts-red, #e0524d); }
  .alerta.n2 { border-color: var(--vscode-charts-yellow, #f2b33d); }
  .alerta.n1 { border-color: var(--vscode-charts-blue, #3794ff); }
  .cifras { display: grid; grid-template-columns: repeat(auto-fit, minmax(70px, 1fr)); gap: 6px; }
  .cifra b { display: block; font-size: 15px; font-variant-numeric: tabular-nums; }
  .cifra span { font-size: 11px; opacity: .7; }
  .renglon { display: grid; grid-template-columns: minmax(60px, 36%) 1fr 92px; align-items: center; gap: 6px; margin: 3px 0; font-size: 11px; }
  .renglon .nom { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .renglon .val { font-variant-numeric: tabular-nums; opacity: .8; text-align: right; }
  .medidor { height: 6px; background: var(--vscode-editorWidget-border, #8884); border-radius: 3px; overflow: hidden; }
  .medidor > i { display: block; height: 100%; width: 0; background: var(--vscode-charts-blue, #3794ff); }
  .medidor > i.verde { background: var(--vscode-charts-green, #5bc46a); }
  .medidor > i.ambar { background: var(--vscode-charts-yellow, #f2b33d); }
  .medidor > i.rojo { background: var(--vscode-charts-red, #e0524d); }
  .medidor > i.morado { background: var(--vscode-charts-purple, #a77be0); }
  .nota { font-size: 11px; opacity: .7; margin-top: 3px; }
  .ritmo { font-size: 12px; margin: 2px 0 4px; }
  .ritmo.alcanza { color: var(--vscode-charts-red, #e0524d); }
  .ritmo.holgado { color: var(--vscode-charts-green, #5bc46a); }
  .calor { display: grid; grid-template-columns: 26px repeat(24, 1fr); gap: 1px; font-size: 10px; align-items: center; }
  .calor .c { height: 9px; border-radius: 1px; background: var(--vscode-charts-blue, #3794ff); }
  .calor .c0 { background: var(--vscode-editorWidget-border, #8884); opacity: .35; }
  .calor .h { opacity: .6; text-align: center; }
  .servicio { display: grid; grid-template-columns: 10px 1fr auto 16px; gap: 6px; align-items: center; font-size: 11px; margin: 4px 0; }
  .luz { width: 8px; height: 8px; border-radius: 4px; background: var(--vscode-charts-green, #5bc46a); }
  .luz.mal { background: var(--vscode-charts-red, #e0524d); }
  .servicio .quitar { border: none; background: none; color: var(--vscode-foreground); opacity: .5; cursor: pointer; padding: 0; font: inherit; }
  .boton-chico { font: inherit; font-size: 11px; border: none; border-radius: 3px; padding: 3px 8px; cursor: pointer; margin-top: 4px;
                 color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  .repo { font-size: 11px; margin: 4px 0; }
  .repo b { font-weight: 600; }
  #btn-configurar { display: none; margin-top: 6px; font: inherit; border: none; border-radius: 3px; padding: 4px 8px;
                    cursor: pointer; color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
</style>
</head>
<body>
  <canvas id="lienzo" title="${t('Clic para mimar al koala')}"></canvas>
  <div id="estado">${t('Preparando el laboratorio…')}</div>
  <div id="alertas"></div>
  <div id="carruseles"></div>
  <div class="car-pie">
    <button class="boton-chico" id="car-agregar">${t('+ Agregar carrusel')}</button>
    <button class="boton-chico" id="car-restablecer" title="${t('Vuelve a los carruseles de inicio')}">${t('Restablecer')}</button>
  </div>
  <!-- Depósito: todas las tarjetas viven aquí y los carruseles las toman (koala.js las actualiza por id aunque no se vean). -->
  <div id="deposito" hidden>
  <div class="tj" data-tj="mascota">
  <div class="fila"><span>${t('Saciedad')}</span><div class="barra"><i id="b-saciedad"></i></div><span class="num" id="n-saciedad"></span></div>
  <div class="fila"><span>${t('Ánimo')}</span><div class="barra"><i id="b-animo"></i></div><span class="num" id="n-animo"></span></div>
  <div class="fila"><span id="l-energia">${t('Energía')}</span><div class="barra"><i id="b-energia"></i></div><span class="num" id="n-energia"></span></div>
  <div class="sub" id="s-energia"></div>
  <div class="fila"><span>${t('Agua')}</span><div class="barra"><i id="b-agua"></i></div><span class="num" id="n-agua"></span></div>
  <div class="botones">
    <button data-accion="comer">${t('Comer')}</button>
    <button data-accion="jugar">${t('Jugar')}</button>
    <button data-accion="mimar">${t('Mimar')}</button>
    <button data-accion="dormir" id="btn-dormir">${t('Dormir')}</button>
  </div>
  <button class="boton-agua" id="btn-agua" title="${t('Suma un vaso a tu meta del día')}">${t('💧 Tomé un vaso de agua')}</button>
  </div>
  <div class="tj" data-tj="alarmas">
    <div id="alarmas-lista"></div>
    <div class="alarma-form">
      <input type="time" id="alarma-hora" aria-label="${t('Hora')}">
      <input type="text" id="alarma-msg" placeholder="${t('¿Qué te recuerdo?')}" maxlength="80" aria-label="${t('Mensaje')}">
      <select id="alarma-rep" aria-label="${t('Repetición')}">
        <option value="una">${t('Una vez')}</option><option value="diaria">${t('Diaria')}</option><option value="laborables">${t('Lun–vie')}</option>
      </select>
      <button id="alarma-agregar" title="${t('Agregar alarma')}">+</button>
    </div>
  </div>
  <div class="tj" data-tj="pomodoro">
    <div class="probeta">
      <div class="tit"><span id="pomo-fase">Pomodoro</span><b id="pomo-reloj">25:00</b></div>
      <div class="barra"><i id="pomo-barra"></i></div>
      <div class="sub" id="pomo-sub"></div>
    </div>
    <div class="pomo-botones">
      <button id="pomo-alternar">${t('Iniciar experimento')}</button>
      <button id="pomo-detener">${t('Detener')}</button>
    </div>
  </div>
  <div class="tj" data-tj="limites">
    <div class="probeta">
      <div class="tit"><span>${t('Sesión (5 h)')}</span><b id="p-cinco">—</b></div>
      <div class="tubo"><i id="t-cinco"></i><span class="marcas"></span></div>
      <div class="sub" id="s-cinco"></div>
    </div>
    <div class="probeta">
      <div class="tit"><span>${t('Semana')}</span><b id="p-semana">—</b></div>
      <div class="tubo"><i id="t-semana"></i><span class="marcas"></span></div>
      <div class="sub" id="s-semana"></div>
    </div>
    <div id="uso-nota"></div>
    <button id="btn-configurar">${t('Configurar monitor')}</button>
  </div>
  ${['fuente', 'ritmo', 'costo', 'huella', 'conversacion', 'cache', 'resumen', 'proyectos', 'modelos', 'herramientas', 'git',
     'problemas', 'calor', 'logros', 'servidor', 'clima', 'servicios'].map((id) => `<div class="tj" data-tj="${id}" id="c-${id}"></div>`).join('\n  ')}
  </div>
  <script nonce="${nonce}">
    window.KOALA_DIC = ${JSON.stringify(idioma.diccionario() || {}).replace(/</g, '\\u003c')};
    window.KOALA_LOCALE = '${idioma.locale()}';
    window.koalaT = function (s) {
      var a = arguments, x = (window.KOALA_DIC && window.KOALA_DIC[s] !== undefined) ? window.KOALA_DIC[s] : s;
      return x.replace(/\\{(\\d+)\\}/g, function (m, i) { var v = a[+i + 1]; return v === undefined ? m : String(v); });
    };
  </script>
  <script nonce="${nonce}" src="${script}"></script>
  <script nonce="${nonce}" src="${scriptPanel}"></script>
</body>
</html>`;
}

module.exports = { htmlVista };
