# Registro de cambios

## 1.5.0
- **Carruseles en lugar de pestañas**: el panel muestra varios carruseles y cada uno enseña la tarjeta que elijas
  (mascota, alarmas, pomodoro, límites, costo, huella, git, clima, servicios… 21 en total). Flechas, deslizar o
  lista para saltar; elegir una tarjeta visible la intercambia; agregar, quitar y restablecer. Se guarda y viaja
  con Settings Sync.
- Tocar una alerta lleva su tarjeta a la vista; las tarjetas con alerta tienen un punto rojo.

## 1.4.1
- Visitantes redibujados y más grandes: el **ajolote** ahora tiene cabeza ancha, sonrisa, tres branquias
  plumosas, cola con aleta y patitas (antes parecía un puerquito con cuernos); el **panda** tiene cuerpo
  completo y el **tlacuache** más detalle. Caminan moviendo las patas y el negro ya se ve en el tema oscuro.
- Nuevo comando **Invitar a un visitante**: eliges panda, ajolote, tlacuache o al azar y llega en ese momento.

## 1.4.0
- **English**: the whole extension (panel, koala bubbles, notifications, commands and settings) is available
  in English. It follows VS Code's display language, or force it with `koalaCientifico.idioma` (auto/es/en).
- Todo el texto visible sale de `t()`/`T()` con el diccionario `l10n/en.json`; los títulos de comandos y
  ajustes, de `package.nls.json`.
- Código interno partido en módulos (vista, consumo, anthropic, pomodoro, configurar, alarmas, rutina) con
  pruebas de su lógica (`npm test`).

## 1.3.0
- **Alarmas**: a la hora que quieras, con mensaje y repetición (una vez, diaria, lunes a viernes o días
  elegidos). El koala saca un despertador que suena y llega una notificación con *Posponer 5 min*. Si VS Code
  estaba cerrado, avisa al abrir (hasta 60 min tarde). Se crean en la pestaña Mascota o con los comandos
  *nueva alarma* / *ver alarmas*; viajan con Settings Sync.
- Pruebas automáticas de la lógica con `node --test pruebas/*.test.js`.

## 1.2.1
- Corrige el clima con la ciudad escrita completa ("Toluca de Lerdo, Estado de México, México"): se busca por
  el nombre y la región elige entre homónimos.
- Si falla la red, reintenta al minuto y conserva el último dato bueno (antes se quedaba 15 min sin clima).

## 1.2.0
- El termómetro junto a la ventana muestra la **temperatura de afuera** (la del CPU queda en la pestaña Sistema).
- Nuevo comando y botón **Elegir ciudad del clima**: escribes el nombre y escoges de una lista (distingue
  ciudades con el mismo nombre). El koala no detecta tu ubicación por su cuenta.

## 1.1.0
- **Ventana del laboratorio** con el cielo según la hora (amanecer, día, atardecer, noche con luna y
  estrellas) y el **clima real** de tu ciudad (Open-Meteo, opcional): nubes, lluvia, tormenta, nieve, niebla.
- **Termómetro** con la temperatura del CPU del servidor (alerta a 85 °C).
- **Rutina del día**: buenos días con café y resumen, hora de la comida (torta), pausas activas tras
  90 min seguidos y despedida con el resumen del día.
- **Agua**: botón 💧 y meta diaria.
- **Estante** con un matraz por cada pomodoro del día.
- **Logros** (14) en una vitrina de la pestaña Hoy; viajan con Settings Sync.
- **Ánimo del código**: contento con días sin errores, nervioso con muchos cambios sin commit.
- **Clima en el koala**: paraguas con lluvia, abanico con calor, bufanda con frío.
- **Visitantes**: un panda, un ajolote o un tlacuache pasan por el piso o por la ventana a saludar.
- **Sonidos** opcionales (desactivados por omisión).

## 1.0.0 — primera versión pública
- Lista para la tienda: icono, licencia MIT, capturas y aviso de privacidad.

## 0.9.0
- Fechas festivas: marmota y Candelaria (tamales), Nación Pluricultural, Reyes (rosca), San Valentín,
  Pi, primavera, Día del Niño, Día de las Madres, Día del Programador, año nuevo y tu cumpleaños.

## 0.8.0
- Portable: detecta Python (`python3`, `python`, `py`), rutas válidas en Windows, llavero de macOS,
  ofrece configurarse en una computadora nueva y sincroniza el estado del koala con Settings Sync.

## 0.7.0
- Escoba (errores en cero), extintor (servicio caído), medallas por racha de commits, reloj de arena
  antes del corte, ropa según la hora, siesta por inactividad, arrastrar al koala y la comida.

## 0.6.0
- Avisos de Claude: te necesita (mano levantada) y turno largo terminado; reacciones a pruebas y
  builds de la terminal; Día de Muertos.

## 0.5.0
- Festejos de git: confeti con cada commit y cohete con cada push.

## 0.4.0
- Dato directo de Anthropic (opcional), costo equivalente en la API y huella estimada (energía y agua).

## 0.3.0
- Mini monitor en pestañas: consumo, hoy (proyectos, modelos, herramientas, git, errores, mapa de calor)
  y sistema (CPU, memoria, disco y servicios), con alertas.

## 0.2.0
- Energía ligada a la sesión de 5 h y pomodoro con experimentos de laboratorio.

## 0.1.0
- Koala de laboratorio: tamagotchi, trabajo con laptop y monitor de sesión y semana de Claude Code.
