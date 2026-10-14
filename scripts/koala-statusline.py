#!/usr/bin/env python3
"""Status line de Claude Code para el Koala científico.

Claude Code le pasa por stdin un JSON con rate_limits (sesión de 5 h y semana).
Este script guarda esos datos en ~/.claude/koala-uso.json (los lee la extensión)
e imprime una línea corta para la barra de Claude Code.
"""
import json
import os
import sys
import tempfile
import time

RUTA = os.path.expanduser("~/.claude/koala-uso.json")


def a_epoch(valor):
    """resets_at puede venir en segundos epoch o como texto ISO."""
    if valor is None:
        return None
    if isinstance(valor, (int, float)):
        return int(valor if valor < 1e12 else valor / 1000)
    try:
        from datetime import datetime
        return int(datetime.fromisoformat(str(valor).replace("Z", "+00:00")).timestamp())
    except ValueError:
        return None


def ventana(datos):
    if not isinstance(datos, dict):
        return None
    pct = datos.get("used_percentage")
    if pct is None and datos.get("utilization") is not None:
        pct = datos["utilization"]
    if pct is None:
        return None
    return {"pct": round(float(pct), 1), "resets_at": a_epoch(datos.get("resets_at"))}


def datos_sesion(entrada):
    """Contexto, costo y líneas de la conversación que pintó la status line."""
    ctx = entrada.get("context_window") or {}
    costo = entrada.get("cost") or {}
    if not ctx and not costo:
        return None
    return {
        "id": entrada.get("session_id"),
        "carpeta": os.path.basename((entrada.get("workspace") or {}).get("current_dir") or entrada.get("cwd") or ""),
        "contexto_pct": ctx.get("used_percentage"),
        "contexto_tam": ctx.get("context_window_size"),
        "costo_usd": costo.get("total_cost_usd"),
        "lineas_mas": costo.get("total_lines_added"),
        "lineas_menos": costo.get("total_lines_removed"),
        "duracion_ms": costo.get("total_duration_ms"),
        "ts": int(time.time()),
    }


def main():
    # La consola de Windows no siempre usa UTF-8 (el emoji tronaría).
    for flujo in (sys.stdout, sys.stdin):
        try:
            flujo.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass
    try:
        entrada = json.load(sys.stdin)
    except (ValueError, OSError):
        entrada = {}
    limites = entrada.get("rate_limits") or {}
    cinco = ventana(limites.get("five_hour"))
    semana = ventana(limites.get("seven_day"))
    modelo = (entrada.get("model") or {}).get("display_name") or ""
    sesion = datos_sesion(entrada)

    if cinco or semana or sesion:
        salida = {}
        try:
            with open(RUTA) as f:
                salida = json.load(f)
        except (OSError, ValueError):
            pass
        if cinco or semana:
            salida.update({"five_hour": cinco, "seven_day": semana, "actualizado": int(time.time())})
        if sesion:
            salida["sesion"] = sesion
        if modelo:
            salida["model"] = modelo
        try:
            os.makedirs(os.path.dirname(RUTA), exist_ok=True)
            fd, tmp = tempfile.mkstemp(dir=os.path.dirname(RUTA), prefix=".koala-uso-")
            with os.fdopen(fd, "w") as f:
                json.dump(salida, f)
            os.replace(tmp, RUTA)
        except OSError:
            pass

    partes = []
    if modelo:
        partes.append(modelo)
    if cinco:
        partes.append(f"5h {cinco['pct']:.0f}%")
    if semana:
        partes.append(f"sem {semana['pct']:.0f}%")
    if sesion and sesion.get("contexto_pct") is not None:
        partes.append(f"ctx {sesion['contexto_pct']:.0f}%")
    print("🐨 " + (" · ".join(partes) if partes else "koala científico"))


if __name__ == "__main__":
    main()
