'use strict';
// Conectar el koala con Claude Code: copia los scripts a ~/.claude/koala y agrega a ~/.claude/settings.json
// la status line (límites de 5 h y semana) y los hooks (cuándo trabaja, termina o te necesita Claude).
// Siempre con respaldo previo del settings.json.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { t } = require('./idioma');

// Busca un Python 3 que funcione: python3, python o el lanzador py (Windows).
function probarComando(cmd, args) {
  return new Promise((resolver) => {
    execFile(cmd, [...args, '--version'], { timeout: 5000, windowsHide: true }, (err, out, errOut) => {
      resolver(!err && /Python 3/.test(String(out) + String(errOut)));
    });
  });
}
async function encontrarPython() {
  const candidatos = process.platform === 'win32'
    ? [['py', ['-3']], ['python', []], ['python3', []]]
    : [['python3', []], ['python', []]];
  for (const [cmd, args] of candidatos) {
    if (await probarComando(cmd, args)) return [cmd, ...args].join(' ');
  }
  return null;
}
// Rutas con / para que funcionen igual en bash, Git Bash (Windows) y cmd.
const rutaComando = (p) => p.split(path.sep).join('/');

function crearConfigurador({ extensionPath, globalState, dirClaude }) {
  const DIR_SCRIPTS = path.join(dirClaude, 'koala');
  const RUTA_SETTINGS = path.join(dirClaude, 'settings.json');
  const DIR_CLAUDE = dirClaude;

  function copiarScripts() {
    fs.mkdirSync(DIR_SCRIPTS, { recursive: true });
    for (const nombre of ['koala-statusline.py', 'koala-hook.py']) {
      const destino = path.join(DIR_SCRIPTS, nombre);
      fs.copyFileSync(path.join(extensionPath, 'scripts', nombre), destino);
      fs.chmodSync(destino, 0o755);
    }
  }

  function monitorConfigurado() {
    try { return fs.readFileSync(RUTA_SETTINGS, 'utf8').includes('koala-hook.py'); } catch (e) { return false; }
  }

  // En una computadora nueva: ofrecerlo una sola vez.
  async function ofrecerConfiguracion() {
    if (monitorConfigurado() || globalState.get('koala.ofrecido')) return;
    globalState.update('koala.ofrecido', true);
    const r = await vscode.window.showInformationMessage(
      '🐨 ' + t('¿Conecto al koala con Claude Code en esta computadora? (sabrá cuándo trabaja Claude, cuándo te necesita y cuánto llevas de tu plan)'),
      t('Configurar'), t('Ahora no'));
    if (r === t('Configurar')) configurarMonitor(true);
  }

  async function configurarMonitor(yaConfirmado) {
    const ok = yaConfirmado === true ? 'Configurar' : await vscode.window.showInformationMessage(
      t('El koala agregará a ~/.claude/settings.json una status line (para leer el % de sesión y semana) y hooks (para saber cuándo trabaja Claude, cuándo termina y cuándo te necesita). Se guarda un respaldo antes.'),
      { modal: true },
      t('Configurar')
    );
    if (ok !== t('Configurar')) return;
    const py = await encontrarPython();
    if (!py) {
      const r = await vscode.window.showErrorMessage(
        t('El monitor necesita Python 3 y no lo encontré (probé python3, python y py). Instálalo y vuelve a intentarlo; la mascota y el pomodoro funcionan sin él.'),
        t('Descargar Python'));
      if (r) vscode.env.openExternal(vscode.Uri.parse('https://www.python.org/downloads/'));
      return;
    }
    try {
      copiarScripts();
      let texto = '{}';
      try { texto = fs.readFileSync(RUTA_SETTINGS, 'utf8'); } catch (e) { /* aún no existe */ }
      const ajustes = JSON.parse(texto || '{}');
      const cmdStatus = `${py} "${rutaComando(path.join(DIR_SCRIPTS, 'koala-statusline.py'))}"`;
      const cmdHook = (arg) => `${py} "${rutaComando(path.join(DIR_SCRIPTS, 'koala-hook.py'))}" ${arg}`;

      const actual = ajustes.statusLine && String(ajustes.statusLine.command || '');
      if (actual && !actual.includes('koala-statusline')) {
        const r = await vscode.window.showWarningMessage(
          t('Ya tienes una status line ({0}). ¿Reemplazarla por la del koala?', actual), { modal: true }, t('Reemplazar'));
        if (r !== t('Reemplazar')) return;
      }
      fs.writeFileSync(`${RUTA_SETTINGS}.koala-respaldo-${Date.now()}`, texto);

      ajustes.statusLine = { type: 'command', command: cmdStatus, padding: 0 };
      ajustes.hooks = ajustes.hooks || {};
      for (const [evento, arg] of [['UserPromptSubmit', 'trabajando'], ['PreToolUse', 'trabajando'], ['PostToolUse', 'trabajando'],
        ['Stop', 'descanso'], ['Notification', 'necesita']]) {
        const lista = (ajustes.hooks[evento] || []).filter(
          (g) => !(g.hooks || []).some((h) => String(h.command || '').includes('koala-hook.py')));
        const grupo = { hooks: [{ type: 'command', command: cmdHook(arg), timeout: 5 }] };
        if (evento === 'PreToolUse' || evento === 'PostToolUse') grupo.matcher = '*';
        lista.push(grupo);
        ajustes.hooks[evento] = lista;
      }
      fs.mkdirSync(DIR_CLAUDE, { recursive: true });
      fs.writeFileSync(RUTA_SETTINGS, JSON.stringify(ajustes, null, 2) + '\n');
      vscode.window.showInformationMessage('🐨 ' + t('Monitor configurado. Los porcentajes llegarán con la siguiente respuesta de Claude Code.'));
    } catch (e) {
      vscode.window.showErrorMessage(t('No se pudo configurar el monitor: {0}', e.message));
    }
  }

  return { configurarMonitor, ofrecerConfiguracion, copiarScripts, monitorConfigurado, DIR_SCRIPTS };
}

module.exports = { crearConfigurador, encontrarPython, rutaComando };
