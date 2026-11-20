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

## Herramientas de imagen

Comprimir, cambiar tamaño, recortar, convertir (JPG, PNG, WebP) y girar imágenes, sin librerías:
el navegador abre la imagen con `createImageBitmap` (ya derecha, según la orientación EXIF de la
cámara), un `canvas` la transforma y `toBlob` la guarda. Para achicar mucho se reduce a la mitad
varias veces, que se ve mejor que de un solo golpe. Al comprimir, los PNG pasan a PNG de hasta 256
colores (como TinyPNG): si la imagen ya tiene 256 colores o menos se guardan exactos; si no, se
eligen por corte en la mediana con difuminado Floyd-Steinberg, conservando la transparencia, y el
PNG se escribe a mano (zlib con `CompressionStream`). Volver a guardar una imagen le quita los datos
de la cámara (fecha, ubicación). Las fotos HEIC de iPhone solo se abren donde el navegador las
entiende (Safari).

## Páginas por herramienta (generar.py)

Cada herramienta tiene su dirección (`unir-pdf/`, `comprimir-pdf/`, `word-a-pdf/`…) con su título,
descripción y texto de ayuda, para que aparezca sola en los buscadores. Todas traen la misma app,
así que cambiar de herramienta no recarga la página; los enlaces viejos (`#unir`) siguen sirviendo.

- Fuente: `fuente/cuerpo.html` (el HTML de la app), `app.css` y `app.js`.
- `python3 generar.py` escribe `index.html`, las carpetas de cada herramienta, `sitemap.xml` y `robots.txt`.
  Ahí mismo están el nombre (`NOMBRE`), la dirección principal (`SITIO`) y los textos de cada página.
