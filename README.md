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
