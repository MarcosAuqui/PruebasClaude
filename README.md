# Traductor de Pantalla

App de escritorio (Windows / macOS / Linux) que traduce en tiempo real el texto
que queda dentro de un recuadro casi transparente que colocas en cualquier parte
de la pantalla.

- Ventana principal vertical **9:16** con la paleta *Lunar Slate*
  (`#0B0D10` `#171C22` `#2A333D` `#5D6F82` `#E7EEF5`).
- **Un solo botón**: *Iniciar traducción* / *Finalizar traducción*
  (atajo global `Ctrl/Cmd + Shift + T`).
- Detección automática del idioma de origen.
- Subtítulo opcional bajo el recuadro.
- Pestaña **Guía de uso** dentro de la app.

## Cómo ejecutarla

Requiere [Node.js](https://nodejs.org) 18 o superior.

```bash
npm install
npm start
```

Para generar el instalador (`.exe`, `.dmg` o `.AppImage`):

```bash
npm run dist
```

> En macOS hay que conceder el permiso **Grabación de pantalla** la primera vez.
> La primera traducción descarga los datos de idioma del OCR (necesita internet).

## Cómo funciona

1. Cada 0,8 / 1,5 / 3 s (según la velocidad elegida) se captura la zona de la
   pantalla que queda dentro del recuadro (`desktopCapturer`).
2. Si la imagen no cambió, no se hace nada (ahorra CPU).
3. Si cambió, se lee el texto con **Tesseract.js** (OCR local).
4. Si el texto es nuevo, se traduce (el servicio detecta el idioma) y se muestra
   en la app y en el subtítulo.

El subtítulo está *fuera* de la zona capturada, por eso no se vuelve a leer.

## Estructura

```
src/
  main.js          proceso principal: ventanas, captura, OCR y bucle
  translator.js    proveedor de traducción (fácil de sustituir)
  languages.js     idiomas del OCR según el idioma de origen
  preload.js       puente seguro entre procesos
  renderer/        interfaz vertical (Traducir + Guía de uso)
  overlay/         recuadro transparente y subtítulo
```

## Limitaciones actuales

- El traductor usa el endpoint público gratuito de Google Translate: sin clave,
  pero sin garantías de disponibilidad ni de límite de uso. Para uso intensivo
  cambia `src/translator.js` por DeepL o Google Cloud con tu clave de API.
- La detección automática del OCR cubre idiomas de alfabeto latino. Para
  japonés, chino, coreano, ruso o árabe elige el idioma de origen manualmente.
