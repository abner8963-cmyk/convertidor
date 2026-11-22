# Ghostscript WASM para Navaja PDF

`@okathira/ghostpdl-wasm` 1.1.0 contiene Ghostscript 10.06.0 con el dispositivo
`pdfwrite`, los recursos de inicio y fuentes de Ghostscript en `%rom%`, y las
interfaces de Emscripten `FS` y `callMain`. Se distribuye bajo AGPL-3.0-or-later.
La prueba de conversión cargó NimbusSans-Regular desde los recursos incluidos.
El [aviso de Artifex](fase4/Artifex.LICENSE) detalla además las excepciones de
las fuentes y CMaps.

## Fuentes y procedencia

- [Fuentes y receta del paquete npm, revisión a62b7d6](https://github.com/okathira/ghostpdl-wasm/tree/a62b7d686b21cf88f6425b3e989d1062b9af4256).
- [Fuentes de Ghostscript, submódulo fijado en 2d6e764](https://github.com/ArtifexSoftware/ghostpdl/tree/2d6e764c1f4a73520ed6de6dd3fa78ad30cd6a63).
- [Workflow de compilación](https://github.com/okathira/ghostpdl-wasm/blob/a62b7d686b21cf88f6425b3e989d1062b9af4256/.github/workflows/release.yml),
  con Emscripten 4.0.13 y el script `compile.sh`.
- [Atestaciones de npm](https://registry.npmjs.org/-/npm/v1/attestations/@okathira%2fghostpdl-wasm@1.1.0).
  La declaración SLSA enlaza el workflow anterior, la etiqueta `v1.1.0` y la
  revisión `a62b7d6`. La huella SHA-512 del artefacto coincide con el paquete descargado.

Desde la raíz del repositorio, descargar y verificar el paquete en el directorio
de trabajo local. Los archivos de distribución conservan los bytes del paquete.
Solo se cambia la extensión del módulo ES.

```bash
set -euo pipefail
scratch="$PWD/.build-4b"
mkdir -p "$scratch/tmp"
export TMPDIR="$scratch/tmp"
curl -fL https://registry.npmjs.org/@okathira/ghostpdl-wasm/-/ghostpdl-wasm-1.1.0.tgz -o "$scratch/ghostpdl.tgz"
(cd "$scratch" && sha256sum -c <<'SUMAS'
1c266b526354429272b0a446b3340d86d3652a563a453b2550a2ef32bec4084d  ghostpdl.tgz
SUMAS
)
tar -xOf "$scratch/ghostpdl.tgz" package/dist/gs.js > lib/fase4/gs.mjs
tar -xOf "$scratch/ghostpdl.tgz" package/dist/gs.wasm > lib/fase4/gs.wasm
tar -xOf "$scratch/ghostpdl.tgz" package/LICENSE > lib/fase4/Ghostscript.LICENSE
sha256sum -c <<'SUMAS'
5e7e3b3dfc7afc5e60de8dd6dab66145c75afb74f7d671f711f390b3bb69c6d0  lib/fase4/gs.mjs
e8aaf3af75da65fe0af8d49b30fa717e4ff13eedbbdc0cdd5700f54fb8f667e6  lib/fase4/gs.wasm
eddaf344b5edea13269e0d20055f335610e5e0b6e33e6e536f2701bc18c5f7d5  lib/fase4/srgb.icc
9531ee5ae6046e70338130b9ca4add1b4d5d5fd6664e4ee74788eec12aaf109a  lib/fase4/PDFA_def.ps
SUMAS
```

Para compilar con cambios, obtener la revisión del paquete y sus submódulos
dentro de `.build-4b` y ejecutar `./compile.sh` en el entorno
`emscripten/emsdk:4.0.13` del workflow. El script requiere acceso a los paquetes
de Debian para instalar Autoconf. Los resultados quedan en `dist/gs.js` y
`dist/gs.wasm`.

## Conversión PDF/A

El worker escribe una copia del documento, el perfil sRGB de Artifex y
`PDFA_def.ps` en el sistema de archivos virtual. Ambos recursos provienen del
submódulo indicado. El prefijo usa la ruta `/srgb.icc`, declara tres canales
y conserva el título de entrada. Ghostscript funciona con `SAFER` y un permiso
de lectura específico para ese perfil.

Se usa `-dPDFA=N -dPDFACompatibilityPolicy=1 -sColorConversionStrategy=RGB`.
Para PDF/A-1b, `-r150 -dMaxBitmap=67108864` reduce el costo del aplanado de
transparencias y evita el fallo observado en el WASM con los parámetros
predeterminados. Ghostscript puede omitir características incompatibles con
el nivel solicitado. La app revisa la identificación XMP y el OutputIntent.
