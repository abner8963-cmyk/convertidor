# Plan de Navaja PDF (2026-11-19)

Ya hecho: 24 herramientas, una página por herramienta para Google (generar.py), nombre Navaja PDF.

## Fase 1 — Tanda rápida (sin servidor) ✅ HECHA 2026-11-19
1. Recortar PDF (márgenes o una zona; CropBox con pdf-lib)
2. Reparar PDF (qpdf, ya incluido)
3. Llenar formularios PDF (pdf-lib)
4. Sacar las imágenes de un PDF
5. Hojas en blanco en Organizar
6. Dibujo a mano libre en Editar

## Fase 2 — Las más buscadas ✅ HECHA 2026-11-20
7. PDF a Word (texto y párrafos con PDF.js → .docx)
8. Redactar: borrar de verdad (hoy «Tapar» deja el texto dentro)
9. HEIC a JPG (libheif en WASM)

## Fase 3 — Que se sienta app ✅ HECHA 2026-11-21
10. Encadenar herramientas («Seguir con…», como los Workflows de iLovePDF)
11. Abrir desde «Compartir» en el celular (Web Share Target en el manifest)
12. Escanear: girar solo + OCR en el mismo paso

## Fase 4 — Resto de iLovePDF y extras de imagen
13. Comparar dos PDF · 14. PDF a Markdown · 15. PDF a PowerPoint · 16. PDF a Excel
17. PDF/A (Ghostscript WASM, AGPL) · 18. Quitar fondo · 19. Mejorar/ampliar foto
20. Marca de agua en imágenes · 21. Difuminar caras

## Fase 5 — Con servidor ☁ (etiqueta + aviso antes de usar)
22. HTML a PDF (Cloudflare Browser Rendering)
23. Pedir firmas a otros (cifrado en el dispositivo, clave en el #, borrado a 7 días)
24. Traducir PDF · 25. Resumir con IA (IA integrada de Chrome; si no, Gemini con aviso)
26. Contra abuso: Turnstile + límites por persona

## Fase 6 — Lanzamiento
27. Ícono con navaja (PNG 192/512 para Play Store) · 28. Página de privacidad y contacto
29. Inglés · 30. Dominio navajapdf.me (lo saca el usuario con GitHub Student Pack)
31. Estadísticas sin cookies (Cloudflare) · 32. Donaciones
33. Play Store: TWA con PWABuilder, cuenta 25 USD, prueba cerrada 12 personas × 14 días, assetlinks.json

Pendiente del usuario: probar en el celular Firmar, Editar, OCR y Proteger.
