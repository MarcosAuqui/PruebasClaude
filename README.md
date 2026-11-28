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
- **Traductor a elegir**: modo gratis sin clave (Google y, si Google lo limita,
  MyMemory), o con clave propia **Microsoft Translator** (2 millones de
  caracteres gratis al mes), **DeepL** o **Google Cloud** (500.000 al mes). La
  clave se valida, se guarda cifrada con el almacén seguro del sistema y, si
  falla, se usa el modo gratis como respaldo.
- **Historial** con búsqueda y exportación a TXT, CSV (Excel), SRT y JSON.
- **Lectura en voz alta** con las voces del sistema (prioriza las neuronales).
- **Perfiles** que guardan la distribución de recuadros y se activan solos
  cuando una app concreta pasa a primer plano.
- **Mejora de imagen** para el OCR (contraste, inversión de fondos oscuros,
  binarización) y ampliación adaptativa según el tamaño del texto.
- **Icono en la bandeja** con todas las acciones; la configuración se guarda sola.
- Ventana vertical **9:16**, paleta *Lunar Slate*, botón único
  *Iniciar / Finalizar traducción* (`Ctrl/Cmd + Shift + T`).

## Descargar e instalar

| Sistema | Archivo | Cómo instalar |
|---|---|---|
| Windows | `…-instalador-windows.exe` | Ábrelo y sigue el asistente (crea acceso directo). |
| Windows | `…-portable-windows.exe` o `…-win-x64.zip` | Sin instalar: ejecútalo / descomprime y abre `Traductor de Pantalla.exe`. |
| macOS (Apple M1–M4) | `…-mac-arm64.dmg` | Arrastra la app a Aplicaciones. |
| macOS (Intel) | `…-mac-x64.dmg` | Arrastra la app a Aplicaciones. |
| Linux | `…-linux-x86_64.AppImage` | `chmod +x` y ejecútalo. |
| Ubuntu / Debian | `…-linux-amd64.deb` | `sudo apt install ./archivo.deb` |

Los instaladores se generan solos con GitHub Actions (pestaña **Actions** →
*Compilar instaladores* → sección *Artifacts*). Al crear una etiqueta `v*`
(p. ej. `v2.0.0`) se publican además en **Releases** como descarga pública.

> **Aviso de seguridad la primera vez.** La app no está firmada con un
> certificado comercial, así que el sistema avisa:
> - **Windows** («Windows protegió su PC»): *Más información* → *Ejecutar de todas formas*.
> - **macOS**: clic derecho sobre la app → *Abrir* → *Abrir*. Si dice que está
>   dañada: `xattr -cr "/Applications/Traductor de Pantalla.app"`.
>
> Para quitar estos avisos hace falta un certificado de firma de código
> (Windows) y una cuenta de Apple Developer (macOS).

Los modelos de OCR de los alfabetos de la detección automática vienen
incluidos: funciona sin descargar nada la primera vez (solo la traducción
necesita internet).

## Compilar desde el código

```bash
npm install
npm run dist          # el sistema actual
npm run dist:win-zip  # Windows portable desde Linux/macOS sin Wine
```

## Ejecutar en desarrollo

Requiere [Node.js](https://nodejs.org) 18 o superior.

```bash
npm install
npm start
```

Pruebas automáticas (la del OCR necesita `npm run prepare-ocr` antes):

```bash
npm test
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

- Los servicios gratuitos sin clave tienen límites: Google puede bloquear su
  servicio gratuito para una conexión y MyMemory permite unos 5.000 caracteres
  al día. Para uso continuo, usa una clave gratis de Microsoft o DeepL.
- El recuadro tampoco aparece al compartir pantalla o grabar (es intencionado).
- En Linux el modo atravesable se alterna solo con el atajo, y la detección de
  la app en primer plano necesita `xprop` (X11).
