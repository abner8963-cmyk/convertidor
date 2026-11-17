# Convertidor a PDF

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

## Firmar PDF

La firma se dibuja en la página (con el dedo o el ratón) o se saca de una foto, quitándole el papel
de fondo. PDF.js muestra la hoja para tocar el lugar, moverla y cambiarle el tamaño; pdf-lib la pega
como imagen PNG transparente. Es una firma dibujada, no una firma electrónica con certificado. Si se
pide, la firma se guarda solo en el navegador (`localStorage`).
