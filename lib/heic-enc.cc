#include <emscripten/bind.h>
#include <libheif/heif.h>

#include <limits>
#include <memory>
#include <vector>

using emscripten::typed_memory_view;
using emscripten::val;

namespace {
heif_error escribir(heif_context*, const void* datos, size_t tamano, void* destino)
{
  auto& salida = *static_cast<std::vector<uint8_t>*>(destino);
  const auto* bytes = static_cast<const uint8_t*>(datos);
  salida.insert(salida.end(), bytes, bytes + tamano);
  return {heif_error_Ok, heif_suberror_Unspecified, nullptr};
}

val codificar(val rgba, int ancho, int alto, int calidad)
{
  if (ancho <= 0 || alto <= 0 || size_t(ancho) > std::numeric_limits<size_t>::max() / 4 / alto)
    return val::null();

  const size_t fila = size_t(ancho) * 4;
  if (rgba["byteLength"].as<size_t>() != fila * alto)
    return val::null();

  const std::unique_ptr<heif_context, decltype(&heif_context_free)> contexto(
      heif_context_alloc(), heif_context_free);
  if (!contexto)
    return val::null();

  heif_encoder* codificador_raw = nullptr;
  if (heif_context_get_encoder_for_format(contexto.get(), heif_compression_HEVC, &codificador_raw).code)
    return val::null();
  const std::unique_ptr<heif_encoder, decltype(&heif_encoder_release)> codificador(
      codificador_raw, heif_encoder_release);
  if (heif_encoder_set_lossy_quality(codificador.get(), calidad).code)
    return val::null();

  heif_image* imagen_raw = nullptr;
  if (heif_image_create(ancho, alto, heif_colorspace_RGB, heif_chroma_interleaved_RGBA, &imagen_raw).code)
    return val::null();
  const std::unique_ptr<heif_image, decltype(&heif_image_release)> imagen(imagen_raw, heif_image_release);
  if (heif_image_add_plane(imagen.get(), heif_channel_interleaved, ancho, alto, 8).code)
    return val::null();

  size_t paso = 0;
  auto* pixeles = heif_image_get_plane2(imagen.get(), heif_channel_interleaved, &paso);
  for (int y = 0; y < alto; ++y) {
    const size_t inicio = y * fila;
    val(typed_memory_view(fila, pixeles + y * paso)).call<void>(
        "set", rgba.call<val>("subarray", inicio, inicio + fila));
  }

  if (heif_context_encode_image(contexto.get(), imagen.get(), codificador.get(), nullptr, nullptr).code)
    return val::null();

  heif_writer escritor{1, escribir};
  std::vector<uint8_t> salida;
  if (heif_context_write(contexto.get(), &escritor, &salida).code || salida.empty())
    return val::null();

  return val::global("Uint8Array").new_(typed_memory_view(salida.size(), salida.data()));
}
}

EMSCRIPTEN_BINDINGS(heic_enc)
{
  emscripten::function("encode", &codificar);
}
