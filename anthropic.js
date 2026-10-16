'use strict';
// Consulta directa del uso real en Anthropic (GET /api/oauth/usage) con el token OAuth que Claude Code
// guarda en el equipo (~/.claude/.credentials.json o el llavero de macOS). El token solo viaja a
// api.anthropic.com; nunca se muestra ni se registra. No se renueva aquí: Claude Code lo renueva al usarlo.
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');
const { t } = require('./idioma');

function tokenClaude(dirClaude) {
  let datos = null;
  try {
    datos = JSON.parse(fs.readFileSync(path.join(dirClaude, '.credentials.json'), 'utf8'));
  } catch (e) {
    // En macOS Claude Code guarda la sesión en el llavero; macOS puede pedir permiso la primera vez.
    if (process.platform === 'darwin') {
      try {
        const crudo = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: 5000, encoding: 'utf8' });
        datos = JSON.parse(crudo.trim());
      } catch (err) { datos = null; }
    }
    if (!datos) return { error: t('No encontré la sesión de Claude Code (~/.claude/.credentials.json o el llavero de macOS).') };
  }
  const o = datos && datos.claudeAiOauth;
  if (!o || !o.accessToken) return { error: t('La sesión de Claude Code no tiene token OAuth (¿usas una API key?).') };
  if (o.expiresAt && o.expiresAt < Date.now()) return { error: t('El token de Claude Code venció; se renueva solo la próxima vez que uses Claude.') };
  return { token: o.accessToken };
}

/** { utilization: 42, resets_at: ISO } → { pct, resets_at (epoch s) } */
function ventanaApi(v) {
  if (!v || typeof v.utilization !== 'number') return null;
  const t = Date.parse(v.resets_at);
  return { pct: v.utilization, resets_at: Number.isFinite(t) ? Math.round(t / 1000) : null };
}

const NOMBRES_EXTRA = { seven_day_opus: 'Semana · Opus', seven_day_sonnet: 'Semana · Sonnet', seven_day_oauth_apps: 'Semana · apps' };

/** Cuerpo JSON de la respuesta → { five_hour, seven_day, extras, actualizado } */
function interpretarUso(cuerpo) {
  const d = JSON.parse(cuerpo);
  const extras = [];
  for (const [clave, valor] of Object.entries(d)) {
    if (clave === 'five_hour' || clave === 'seven_day') continue;
    const v = ventanaApi(valor);
    if (v) extras.push({ nombre: NOMBRES_EXTRA[clave] ? t(NOMBRES_EXTRA[clave]) : clave.replace(/_/g, ' '), pct: v.pct, reinicio: v.resets_at ? v.resets_at * 1000 : null });
  }
  return { five_hour: ventanaApi(d.five_hour), seven_day: ventanaApi(d.seven_day), extras, actualizado: Math.round(Date.now() / 1000) };
}

function pedirUso(token) {
  return new Promise((resolver) => {
    const req = https.get('https://api.anthropic.com/api/oauth/usage', {
      timeout: 10000,
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'koala-cientifico', Accept: 'application/json' },
    }, (res) => {
      let cuerpo = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (cuerpo.length < 200000) cuerpo += d; });
      res.on('end', () => resolver({ codigo: res.statusCode, cuerpo }));
    });
    req.on('timeout', () => { req.destroy(); resolver({ error: t('sin respuesta de api.anthropic.com') }); });
    req.on('error', (e) => resolver({ error: t('sin conexión ({0})', e.code || 'error') }));
  });
}

/** → { uso } si salió bien; { error, esperarMin? } si no. */
async function consultarUso(dirClaude) {
  const cred = tokenClaude(dirClaude);
  if (cred.error) return { error: cred.error };
  const r = await pedirUso(cred.token);
  if (r.error) return { error: r.error };
  if (r.codigo === 401 || r.codigo === 403) return { error: t('Anthropic rechazó el token; abre Claude Code para renovar la sesión.') };
  if (r.codigo === 429) return { error: t('Demasiadas consultas; el koala espera 15 min.'), esperarMin: 15 };
  if (r.codigo !== 200) return { error: t('Respuesta inesperada ({0}).', r.codigo) };
  try {
    return { uso: interpretarUso(r.cuerpo) };
  } catch (e) {
    return { error: t('No se pudo leer la respuesta de Anthropic.') };
  }
}

module.exports = { consultarUso, tokenClaude, ventanaApi, interpretarUso };
