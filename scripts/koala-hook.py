#!/usr/bin/env python3
"""Hook de Claude Code para el Koala científico.

Uso: koala-hook.py trabajando|descanso|necesita
Lo llaman UserPromptSubmit y PreToolUse ("trabajando"), Stop ("descanso") y Notification
("necesita"). El evento real se lee de hook_event_name en la entrada.
Escribe ~/.claude/koala-estado.json, que la extensión vigila. Nunca bloquea a Claude.
"""
import json
import os
import sys
import tempfile
import time

RUTA = os.path.expanduser("~/.claude/koala-estado.json")
# Avisos que no piden nada al usuario (p. ej. "Claude está esperando tu mensaje" tras 60 s).
TIPOS_IGNORADOS = {"idle_prompt", "auth_success"}


def leer_previo():
    try:
        with open(RUTA) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def main():
    estado = sys.argv[1] if len(sys.argv) > 1 else "trabajando"
    try:
        entrada = json.loads(sys.stdin.read() or "{}")
    except (OSError, ValueError):
        entrada = {}
    evento = entrada.get("hook_event_name", "")
    ahora = int(time.time() * 1000)
    previo = leer_previo()
    datos = {"estado": estado, "ts": ahora, "inicio": previo.get("inicio")}

    if estado == "trabajando" and (evento == "UserPromptSubmit" or not datos["inicio"] or previo.get("estado") == "descanso"):
        datos["inicio"] = ahora  # empieza un turno
    if estado == "descanso" and previo.get("inicio"):
        datos["duracion"] = ahora - previo["inicio"]
    if estado == "necesita":
        tipo = entrada.get("notification_type", "")
        mensaje = entrada.get("message", "") or ""
        if tipo in TIPOS_IGNORADOS or "waiting for your input" in mensaje:
            sys.exit(0)
        datos["mensaje"] = mensaje[:200]

    try:
        os.makedirs(os.path.dirname(RUTA), exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(RUTA), prefix=".koala-estado-")
        with os.fdopen(fd, "w") as f:
            json.dump(datos, f)
        os.replace(tmp, RUTA)
    except OSError:
        pass
    sys.exit(0)


if __name__ == "__main__":
    main()
