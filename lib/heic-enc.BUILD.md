# Codificador HEIC para Navaja PDF

`heic-enc.mjs` carga `heic-enc.wasm` cuando se guarda una foto en HEIC. El
módulo enlaza libheif 1.23.6 y Kvazaar 2.3.1. Kvazaar es el único códec
compilado. El decodificador de HEIC de la app se distribuye por separado.
La interfaz de enlace está en [heic-enc.cc](heic-enc.cc) y las licencias en
[heic-enc.LICENSE](heic-enc.LICENSE).

Se evaluó [elheif 0.1.0](https://registry.npmjs.org/elheif/-/elheif-0.1.0.tgz).
El paquete incluye el aviso MIT del envoltorio y el WASM embebido. Su
[receta de compilación](https://github.com/hpp2334/elheif/blob/42867c3/core/CMakeLists.txt)
obtiene libheif, libde265 y Kvazaar sin fijar revisiones. Esta compilación fija
las versiones y enlaza solo el codificador de HEVC.

## Fuentes y herramientas

Ejecutar desde la raíz del repositorio con Bash en Linux x86-64. Se usaron
CMake 4.5.1 y Ninja 1.13.2. Las fuentes, herramientas y archivos
temporales quedan bajo `.build-heic/`.

```bash
set -euo pipefail
repo=$PWD
scratch="$repo/.build-heic"
mkdir -p "$scratch/tmp"
export TMPDIR="$scratch/tmp"
cd "$scratch"

curl -fL https://codeload.github.com/emscripten-core/emsdk/tar.gz/refs/tags/4.0.23 -o emsdk.tgz
curl -fL https://codeload.github.com/strukturag/libheif/tar.gz/refs/tags/v1.23.6 -o libheif.tgz
curl -fL https://codeload.github.com/ultravideo/kvazaar/tar.gz/refs/tags/v2.3.1 -o kvazaar.tgz
sha256sum -c <<'SUMAS'
a91a4c1f42dbb0345faac093161e27d43e9b6964840d8c8d80976ab8d3eaf2d3  emsdk.tgz
c9a00b0452f5c16d72ef71e5e40c0e90fbe2ad37148d27a1b2f9bb21546f5f03  libheif.tgz
c5a1699d0bd50bc6bdba485b3438a5681a43d7b2c4fd6311a144740bfa59c9cc  kvazaar.tgz
SUMAS

tar -xf emsdk.tgz
tar -xf libheif.tgz
tar -xf kvazaar.tgz

cd "$scratch/emsdk-4.0.23"
./emsdk install 4.0.23
./emsdk activate 4.0.23
cd "$repo"
```

En Linux x86-64, emsdk 4.0.23 usa estos dos archivos:

| Archivo | SHA-256 |
| --- | --- |
| [Emscripten 4.0.23, revisión aaa43392544d695232b70eda706d751f18980c2a](https://storage.googleapis.com/webassembly/emscripten-releases-builds/linux/aaa43392544d695232b70eda706d751f18980c2a/wasm-binaries.tar.xz) | `5f1565fe45a1223cedf3b0300f5089c2c64954d2895b2aaedc85043c719be965` |
| [Node.js 22.16.0](https://storage.googleapis.com/webassembly/emscripten-releases-builds/deps/node-v22.16.0-linux-x64.tar.xz) | `f4cb75bb036f0d0eddf6b79d9596df1aaab9ddccd6a20bf489be5abe9467e84e` |

## Compilación y reenlace

Para reenlazar el módulo con una versión modificada de libheif, aplicar
los cambios a `.build-heic/libheif-1.23.6/` antes de ejecutar estos comandos.
El código de la interfaz de enlace se compila desde este repositorio.

```bash
set -e
repo=$PWD
scratch="$repo/.build-heic"
export TMPDIR="$scratch/tmp"
export SOURCE_DATE_EPOCH=0
source "$scratch/emsdk-4.0.23/emsdk_env.sh"
cd "$scratch"

# Elimina la opción del ensamblador x86 que Kvazaar añade al compilar para WASM.
sed -i '/-muse-unaligned-vector-move/d' kvazaar-2.3.1/CMakeLists.txt
emcmake cmake -S kvazaar-2.3.1 -B build-kvazaar -G Ninja \
  -DCMAKE_BUILD_TYPE=MinSizeRel -DBUILD_SHARED_LIBS=OFF -DBUILD_TESTS=OFF
cmake --build build-kvazaar --target kvazaar --parallel 8

emcmake cmake -S libheif-1.23.6 -B build-libheif -G Ninja \
  -DCMAKE_BUILD_TYPE=MinSizeRel -DBUILD_SHARED_LIBS=OFF \
  -DCMAKE_INSTALL_PREFIX="$scratch/install" -DCMAKE_INSTALL_LIBDIR=lib \
  -DENABLE_PLUGIN_LOADING=OFF -DENABLE_MULTITHREADING_SUPPORT=OFF \
  -DWITH_KVAZAAR=ON -DWITH_KVAZAAR_PLUGIN=OFF \
  -DKVAZAAR_INCLUDE_DIR="$scratch/kvazaar-2.3.1/src" \
  -DKVAZAAR_LIBRARY="$scratch/build-kvazaar/libkvazaar.a" \
  -DWITH_X265=OFF -DWITH_LIBDE265=OFF -DWITH_X264=OFF \
  -DWITH_OpenH264_DECODER=OFF -DWITH_AOM_DECODER=OFF -DWITH_AOM_ENCODER=OFF \
  -DWITH_LIBSHARPYUV=OFF -DWITH_GDK_PIXBUF=OFF -DWITH_EXAMPLES=OFF \
  -DBUILD_TESTING=OFF -DBUILD_DOCUMENTATION=OFF
cmake --build build-libheif --parallel 8
cmake --install build-libheif

mkdir -p "$scratch/output"
em++ -std=c++17 -Os --no-entry --bind \
  -I"$scratch/install/include" "$repo/lib/heic-enc.cc" \
  "$scratch/install/lib/libheif.a" "$scratch/build-kvazaar/libkvazaar.a" \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker \
  -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=1048576 -sFILESYSTEM=0 \
  -Wl,-Map,"$scratch/output/heic-enc.map" -o "$scratch/output/heic-enc.mjs"
install -m 0644 "$scratch/output/heic-enc.mjs" "$scratch/output/heic-enc.wasm" "$repo/lib/"
```

CMake debe mostrar HEIC con codificación habilitada y decodificación
deshabilitada. El mapa de enlace queda en `.build-heic/output/heic-enc.map`.

Comprobar los archivos distribuidos desde la raíz del repositorio.

```bash
sha256sum -c <<'SUMAS'
82176bac16ae76fc42e45640318efbe32becca00471566e698c82801863dface  lib/heic-enc.mjs
824322215d77625078c5ce0516d109a15847a085c567ae3e6051f0f6b2d8882f  lib/heic-enc.wasm
SUMAS
```
