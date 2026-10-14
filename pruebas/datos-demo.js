'use strict';
// Crea transcripciones FICTICIAS de Claude Code en <home>/.claude/projects/demo/ para capturas
// de la documentación (nunca se usan datos reales del usuario).
// Uso: node pruebas/datos-demo.js <home-temporal>
const fs = require('fs');
const path = require('path');

const home = process.argv[2];
if (!home) throw new Error('falta la carpeta home temporal');
let s = 7;
const azar = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
const modelos = ['claude-opus-5-5', 'claude-opus-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5'];
const proyectos = ['/home/demo/visor-mapas', '/home/demo/api-reportes', '/home/demo/koala'];
const herramientas = ['Bash', 'Read', 'Edit', 'Edit', 'Grep', 'Write'];
const lineas = [];
const ahora = Date.now();
let n = 0;
for (let dia = 6; dia >= 0; dia--) {
  for (const hora of [9, 10, 11, 12, 13, 16, 17, 18]) {
    if (azar() < 0.35) continue;
    for (let i = 0; i < 6; i++) {
      const t = new Date(ahora - dia * 86400000);
      t.setHours(hora, Math.floor(azar() * 60), 0, 0);
      if (t.getTime() > ahora) continue;
      const id = 'msg_demo_' + (n++);
      const usage = {
        input_tokens: 5 + Math.floor(azar() * 40), output_tokens: 150 + Math.floor(azar() * 900),
        cache_creation_input_tokens: Math.floor(azar() * 4000), cache_read_input_tokens: 30000 + Math.floor(azar() * 60000),
      };
      const content = azar() < 0.6 ? [{ type: 'tool_use', id: 'toolu_' + id, name: herramientas[Math.floor(azar() * herramientas.length)] }] : [{ type: 'text', text: '' }];
      lineas.push(JSON.stringify({
        type: 'assistant', timestamp: t.toISOString(), cwd: proyectos[Math.floor(azar() * proyectos.length)],
        message: { id, model: modelos[Math.floor(azar() * modelos.length)], usage, content },
      }));
    }
  }
}
const dir = path.join(home, '.claude', 'projects', 'demo');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'sesion-demo.jsonl'), lineas.join('\n') + '\n');
console.log(`${lineas.length} mensajes ficticios en ${dir}`);
