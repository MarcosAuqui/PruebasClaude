# Traductor de Pantalla

App de escritorio (Windows / macOS / Linux) que traduce en tiempo real el texto
que queda dentro de uno o varios recuadros casi transparentes en pantalla.

## Funciones

- **Traducción sobre el texto**: tapa el original con la traducción usando sus
  mismos colores de fondo y de letra (estilo cámara de traductor). También
  puede mostrarse como subtítulo bajo el recuadro o solo en la ventana.
- **Varios recuadros** (hasta 6), cada uno con sus idiomas y su modo.
- **Detección automática de alfabeto**: latino, cirílico, japonés, chino,
  coreano, árabe y devanagari, sin elegir nada a mano.
- **Modo atravesable**: los clics pasan a través del recuadro; se mueve desde
  su pestaña (`Ctrl/Cmd + Shift + M`).
- **Historial** con búsqueda y exportación a TXT, CSV (Excel), SRT y JSON.
- **Lectura en voz alta** con las voces del sistema (prioriza las neuronales).
- **Perfiles** que guardan la distribución de recuadros y se activan solos
  cuando una app concreta pasa a primer plano.
- **Mejora de imagen** para el OCR (contraste, inversión de fondos oscuros,
  binarización) y ampliación adaptativa según el tamaño del texto.
- **Icono en la bandeja** con todas las acciones; la configuración se guarda sola.
- Ventana vertical **9:16**, paleta *Lunar Slate*, botón único
  *Iniciar / Finalizar traducción* (`Ctrl/Cmd + Shift + T`).

## Ejecutar

Requiere [Node.js](https://nodejs.org) 18 o superior.

```bash
npm install
npm start
```

Pruebas automáticas y generación del instalador:

```bash
npm test
npm run dist
```

> macOS: concede el permiso **Grabación de pantalla**. La primera vez se
> descargan los idiomas del OCR (necesita internet; luego quedan en caché).

## Arquitectura y rendimiento

```
src/
  main/
    index.js        orquestación: ventanas, IPC, perfiles, atajos
    engine.js       bucle por recuadro: cambio → OCR → traducción → pintado
    capture.js      cliente de captura (+ respaldo con desktopCapturer)
    ocr.js          grupo de workers Tesseract y detección de alfabeto
    translator.js   traductor con caché LRU, reintentos y cancelación
    box-window.js   ventana transparente de cada recuadro
    history.js      historial y exportación
    config.js       configuración validada; json-file.js escritura atómica
    foreground.js   app en primer plano (sin módulos nativos)
    tray.js         bandeja del sistema
  capture/          ventana oculta: stream de pantalla (WebCodecs)
  overlay/          recuadro, capa de traducción y subtítulo
  renderer/         interfaz principal y lectura en voz alta
  shared/imaging.js preprocesado, huellas de cambio y muestreo de color
```

Claves para que vaya fluido:

- **Stream de pantalla persistente** (`MediaStreamTrackProcessor` + `VideoFrame`):
  recortar el recuadro es instantáneo, sin pedir capturas nuevas.
- **Detección de cambios barata** (huella de 48×12 bloques): el OCR solo corre
  cuando el contenido cambia y se estabiliza.
- **OCR sin codificar imágenes**: se pasa escala de grises en bruto (PGM).
- **Workers precalentados** y uno por alfabeto, en paralelo; el alfabeto
  detectado se fija por recuadro (lecturas siguientes de ~40 ms).
- **Traducción por párrafos en paralelo**, con caché, conexión HTTP reutilizada
  (`net.fetch` + preconexión) y cancelación de peticiones obsoletas.
- El recuadro se **excluye de la captura** (`setContentProtection`); si el
  sistema no lo respeta, la app lo detecta sola y oculta la capa un instante
  al capturar.

## Limitaciones

- El traductor usa el endpoint público gratuito de Google Translate: sin clave
  ni garantías de disponibilidad. Se cambia en `src/main/translator.js`.
- El recuadro tampoco aparece al compartir pantalla o grabar (es intencionado).
- En Linux el modo atravesable se alterna solo con el atajo, y la detección de
  la app en primer plano necesita `xprop` (X11).
