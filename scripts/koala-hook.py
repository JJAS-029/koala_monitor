#!/usr/bin/env python3
"""Hook de Claude Code (y de Antigravity) para el Koala científico.

Uso: koala-hook.py trabajando|descanso|necesita [--antigravity]
Claude Code lo llama en UserPromptSubmit y PreToolUse ("trabajando"), Stop ("descanso") y Notification
("necesita"); el evento real se lee de hook_event_name en la entrada. Escribe ~/.claude/koala-estado.json.
Con --antigravity lo llaman los hooks de agy (PreInvocation y PostToolUse "trabajando", Stop "descanso"):
escribe ~/.claude/koala-estado-antigravity.json con "fuente": "antigravity" y responde {} (agy espera JSON).
La extensión vigila los dos archivos. Nunca bloquea al agente.
"""
import json
import os
import sys
import tempfile
import time

ANTIGRAVITY = "--antigravity" in sys.argv
ARGUMENTOS = [a for a in sys.argv[1:] if a != "--antigravity"]
RUTA = os.path.expanduser("~/.claude/koala-estado-antigravity.json" if ANTIGRAVITY else "~/.claude/koala-estado.json")
# Avisos que no piden nada al usuario (p. ej. "Claude está esperando tu mensaje" tras 60 s).
TIPOS_IGNORADOS = {"idle_prompt", "auth_success"}


def leer_previo():
    try:
        with open(RUTA) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def guardar(datos):
    try:
        os.makedirs(os.path.dirname(RUTA), exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(RUTA), prefix=".koala-estado-")
        with os.fdopen(fd, "w") as f:
            json.dump(datos, f)
        os.replace(tmp, RUTA)
    except OSError:
        pass


def main():
    estado = ARGUMENTOS[0] if ARGUMENTOS else "trabajando"
    try:
        entrada = json.loads(sys.stdin.read() or "{}")
    except (OSError, ValueError):
        entrada = {}
    evento = entrada.get("hook_event_name") or entrada.get("hookEventName", "")  # agy usa camelCase
    ahora = int(time.time() * 1000)
    previo = leer_previo()
    datos = {"estado": estado, "ts": ahora, "inicio": previo.get("inicio")}
    if ANTIGRAVITY:
        datos["fuente"] = "antigravity"

    empieza = evento in ("UserPromptSubmit",) or not datos["inicio"] or previo.get("estado") == "descanso"
    if estado == "trabajando" and empieza:
        datos["inicio"] = ahora  # empieza un turno
    if estado == "descanso" and previo.get("inicio"):
        datos["duracion"] = ahora - previo["inicio"]
    if estado == "necesita":
        tipo = entrada.get("notification_type", "")
        mensaje = entrada.get("message", "") or ""
        if tipo in TIPOS_IGNORADOS or "waiting for your input" in mensaje:
            return
        datos["mensaje"] = mensaje[:200]
    guardar(datos)


if __name__ == "__main__":
    try:
        main()
    finally:
        if ANTIGRAVITY:
            print("{}")
        sys.exit(0)
