# Navaja PDF

Convierte Word, Excel y PowerPoint (y ODT, ODS, ODP, RTF, TXT, CSV) a PDF **dentro del navegador**:
los archivos nunca salen del dispositivo.

Página: https://abner8963-cmyk.github.io/convertidor/ (y una copia en Cloudflare Pages, para las redes
de datos móviles que no llegan a GitHub Pages por IPv4).

## Cómo funciona

- Usa LibreOffice compilado a WebAssembly, del paquete
  [`@matbee/libreoffice-converter`](https://github.com/matbeedotcom/libreoffice-document-converter) 2.7.2
  (licencia MPL-2.0). Sus archivos van en `lo/` sin cambios, salvo uno: en
  `lo/browser.worker.global.js` el límite para arrancar subió de 120 s a 15 min, porque en
  celulares y computadoras lentas el arranque puede pasar de dos minutos.
- `soffice.wasm` y `soffice.data` (247 MB) van comprimidos con gzip y partidos en pedazos de
  20 MB (Cloudflare Pages acepta hasta 25 MB por archivo) (`lo/partes/`, descritos en `partes.json`). La página los baja una vez (77 MB),
  los descomprime con `DecompressionStream` y los guarda en el almacenamiento del navegador.
- LibreOffice necesita `SharedArrayBuffer`, que exige los encabezados COOP/COEP. En Cloudflare
  los pone `_headers`; GitHub Pages no deja configurarlos, así que ahí los pone `sw.js` (un service worker), que además sirve los
  archivos guardados y deja la página funcionando sin internet.

## Proteger y quitar contraseña

Lo hace [qpdf](https://github.com/qpdf/qpdf) 12.2.0 (Apache-2.0) compilado a WebAssembly, del paquete
[`@neslinesli93/qpdf-wasm`](https://github.com/neslinesli93/qpdf-wasm) 0.3.1 (ISC): `lib/qpdf.js` y
`lib/qpdf.wasm`, sin cambios. Cifra con AES de 256 bits.

## Reconocer texto (OCR)

[Tesseract.js](https://github.com/naptha/tesseract.js) 7.0.0 con `tesseract.js-core` 7.0.0 (Apache-2.0) y los
idiomas español e inglés (`4.0.0_best_int` de `@tesseract.js-data`), todo en `ocr/` sin cambios. Se baja
la primera vez que se usa (unos 9 MB) y `sw.js` lo guarda aparte, para que no se vuelva a bajar cuando
la app se actualiza. El PDF original no se redibuja: solo se le escribe encima el texto, invisible.

Algunos PDF traen texto que se ve bien pero al copiarlo sale basura (fuentes TrueType con un ToUnicode
vacío, como los que hacía Mac OS X 10.5). En esos, la app no lee todo el libro: identifica cada dibujo de
letra por su forma (huella de su contorno en la fuente incrustada), lee con OCR solo las hojas que traen
dibujos que aún no conoce (unas 100 en un libro de 2,000) y escribe en cada fuente la tabla código → letra.
Las hojas quedan intactas y el archivo casi no crece. Lo que el OCR no puede leer (p. ej. griego) se queda
como estaba.

## Firmar PDF

La firma se dibuja en la página (con el dedo o el ratón) o se saca de una foto, quitándole el papel
de fondo. PDF.js muestra la hoja para tocar el lugar, moverla y cambiarle el tamaño; pdf-lib la pega
como imagen PNG transparente. Es una firma dibujada, no una firma electrónica con certificado. Si se
pide, la firma se guarda solo en el navegador (`localStorage`).

## Editar PDF

Para escribir encima de un PDF (llenar un formato), poner palomitas y cruces, tapar con blanco,
resaltar, y agregar líneas, rectángulos, óvalos e imágenes. PDF.js muestra la hoja y cada cosa se
coloca tocándola; pdf-lib la dibuja en el mismo lugar. No cambia el texto que ya trae el PDF, y lo
tapado con blanco sigue dentro del archivo.

También se puede dibujar a mano libre («✎ Dibujar»): cada trazo queda como un objeto que se mueve,
estira o quita, y se guarda como líneas en el PDF. En «Organizar páginas» se agregan hojas en blanco.

## Recortar PDF

Cambia el recuadro visible de las páginas (CropBox y MediaBox). «Quitar los márgenes blancos» dibuja
cada hoja con PDF.js y busca dónde hay tinta; «a mano» usa la misma zona en las páginas elegidas.
Lo que queda fuera se esconde pero sigue dentro del archivo.

## Reparar PDF

Del mejor intento al último recurso: qpdf lo reescribe si lo lee sin errores; pdf-lib lo lee objeto
por objeto sin hacer caso del índice dañado; si se perdió el final (descarga a medias), se buscan las
páginas sueltas —también dentro de los flujos de objetos comprimidos— y se les arma catálogo y árbol
de páginas nuevos (se quitan las que perdieron su contenido); al final, PDF.js dibuja cada página y
se arma un PDF de imágenes. Ojo: el qpdf compilado para el navegador no reconstruye archivos dañados
(sin manejo de excepciones se detiene en el primer error), por eso existe el reconstructor propio.

## Llenar formularios

PDF.js dice dónde está cada campo (texto, casilla, opción, lista); se ponen controles HTML encima de
la hoja y pdf-lib escribe los valores en los campos. «Dejarlo fijo» aplana el formulario (pdf-lib
deja referencias a los campos borrados en `Annots`; se limpian). Los XFA dinámicos no se pueden.

## Sacar imágenes

Recorre los recursos de cada página (y de sus Form XObjects). Los JPG salen tal cual (sus bytes);
gris, RGB, CMYK, paleta, 1–16 bits, máscaras y SMask se decodifican y salen en PNG. JBIG2 y CCITT
(escaneos en blanco y negro) no: para esos, «PDF a imágenes».

## PDF a Word

PDF.js da cada trozo de texto con su lugar, tamaño y fuente (el nombre de la fuente dice negrita y
cursiva). Se juntan en renglones en el orden del PDF y los renglones en párrafos (hueco, sangría,
cambio de tamaño, renglón corto con punto, título en negrita, viñetas, sangría francesa de listas);
se detectan centrado, justificado, títulos y se quitan encabezados y pies repetidos. Las imágenes
se recortan de la hoja dibujada en el lugar que dice la lista de operaciones. El .docx se escribe a
mano (XML de Word en un .zip sin comprimir). Tablas y columnas salen como párrafos.

## Borrar de verdad (Editar PDF)

La hoja con recuadros «■ Borrar de verdad» se vuelve imagen (200 ppp) con los recuadros negros, y se
le pone invisible el texto que quedó fuera (para buscar y copiar). Luego se quitan del archivo todos
los objetos que ya nadie usa (la hoja vieja, su texto, fuentes e imágenes) y las referencias a la
hoja vieja (marcadores) pasan a la nueva.

## Fotos HEIC

Las herramientas con salida JPG, PNG o WebP pueden pasar las fotos HEIC/HEIF a JPG (o PNG si tienen transparencia) al
recibirlas, con libheif 1.23 (`lib/libheif.js` + `lib/libheif.wasm`, paquete libheif-js 1.23.5,
LGPL-3.0; se baja la primera vez que se usa). Hay que pasarle el `.wasm` ya bajado (`wasmBinary`):
este build no sabe bajarlo solo.

## Herramientas de imagen

Comprimir, cambiar tamaño, recortar, convertir (JPG, PNG, WebP) y girar imágenes, sin librerías:
el navegador abre la imagen con `createImageBitmap` (ya derecha, según la orientación EXIF de la
cámara), un `canvas` la transforma y `toBlob` la guarda. Para achicar mucho se reduce a la mitad
varias veces, que se ve mejor que de un solo golpe. Al comprimir, los PNG pasan a PNG de hasta 256
colores (como TinyPNG): si la imagen ya tiene 256 colores o menos se guardan exactos; si no, se
eligen por corte en la mediana con difuminado Floyd-Steinberg, conservando la transparencia, y el
PNG se escribe a mano (zlib con `CompressionStream`). Volver a guardar una imagen le quita los datos
de la cámara (fecha, ubicación). Las fotos HEIC se abren con libheif.

## Comparar PDF y convertir a Markdown, PowerPoint o Excel

- Comparar alinea páginas por su texto y su imagen. Marca palabras agregadas y quitadas y
  superpone las páginas para distinguir cambios de imagen. El reporte PDF incluye ambas vistas.
- Markdown comparte la reconstrucción de párrafos, títulos y fuentes de PDF a Word. Las imágenes
  son opcionales y se entregan con el .md en un ZIP.
- PowerPoint usa una imagen a 160 ppp por página, con un límite de resolución para páginas muy
  grandes. Puede reconstruir texto horizontal como cuadros editables cuando reconoce las fuentes
  y puede retirar el texto del fondo. El tamaño de la presentación se toma de la primera página
  y las demás se ajustan proporcionalmente.
- Excel y Markdown detectan tablas simples por los huecos del texto y por las líneas dibujadas.
  Excel guarda importes y porcentajes como números. Los escaneos deben pasar por OCR para extraer
  texto. Las tablas con celdas combinadas y los diseños de varias columnas pueden requerir ajustes.

## Marca de agua en imágenes

Pone un texto o logo en JPG, PNG, WebP o HEIC, con vista previa y salida del mismo formato.
Para guardar HEIC se usa un codificador WebAssembly de libheif 1.23.6
(LGPL-3.0-or-later) y Kvazaar 2.3.1 (BSD-3-Clause), su único códec HEVC.
También incluye el runtime de Emscripten, musl y componentes de LLVM.
Consulta las [licencias](lib/heic-enc.LICENSE) y la [receta de compilación](lib/heic-enc.BUILD.md).
El navegador carga el codificador al guardar HEIC por primera vez y lo guarda para uso sin conexión.

## Seguir con otra herramienta

Usa «Seguir con…» junto a «Descargar» para cargar el PDF o la imagen en otra herramienta de Navaja PDF.
Si el resultado ofrece un ZIP con varias imágenes, el menú de esa fila pasa todas las imágenes
a la herramienta elegida. Navegar hacia atrás conserva los resultados de la
sesión.

## Abrir desde Compartir en Android

En un navegador compatible, instala Navaja PDF desde el menú del navegador. Luego abre el menú
«Compartir» de un PDF, una imagen o un archivo DOCX, XLSX o PPTX y elige Navaja PDF. La app muestra
las herramientas disponibles para cada archivo y permite mandar el lote completo a las que lo
aceptan. El service worker guarda los archivos temporalmente en el navegador y los retira del
almacenamiento al abrirlos en una herramienta. Los archivos permanecen en el dispositivo.

## Escanear documento

Al crear el PDF, «Girar y enderezar automáticamente» prueba cuatro orientaciones sobre una copia
reducida de la hoja y usa los renglones para corregir inclinaciones de hasta 15°. Puedes girar
cada foto con sus flechas o desactivar el ajuste automático. Con «Hacer buscable (OCR)» se añade
una capa invisible de texto en español e inglés para buscar y copiar desde el lector de PDF.
La primera vez que uses cualquiera de las dos opciones se cargan los modelos de OCR de la app.

## Páginas por herramienta (generar.py)

Cada herramienta tiene su dirección (`unir-pdf/`, `comprimir-pdf/`, `word-a-pdf/`…) con su título,
descripción y texto de ayuda, para que aparezca sola en los buscadores. Todas traen la misma app,
así que cambiar de herramienta no recarga la página; los enlaces viejos (`#unir`) siguen sirviendo.

- Fuente: `fuente/cuerpo.html` (el HTML de la app), `app.css` y `app.js`.
- `python3 generar.py` escribe `index.html`, las carpetas de cada herramienta, `sitemap.xml` y `robots.txt`.
  Ahí mismo están el nombre (`NOMBRE`), la dirección principal (`SITIO`) y los textos de cada página.
