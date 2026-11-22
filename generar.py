#!/usr/bin/env python3
"""Genera las páginas de la app: index.html y una carpeta por herramienta (unir-pdf/index.html…),
más sitemap.xml y robots.txt.

Todas las páginas traen la app completa (fuente/cuerpo.html + app.css + app.js); solo cambian el
título, la descripción, la dirección y el texto de ayuda, que es lo que Google lee. Así cada
herramienta aparece en los buscadores por separado y cambiar de herramienta no recarga la página.

Para cambiar algo de la app: editar fuente/cuerpo.html, app.css o app.js y correr
    python3 generar.py
Para cambiar el nombre o el dominio: NOMBRE y SITIO, abajo.
"""
import html
import json
import pathlib
import datetime

NOMBRE = "Navaja PDF"
SITIO = "https://convertidor.abner8963.workers.dev/"   # dirección principal (la que Google debe mostrar)
LEMA = "Herramientas de PDF e imágenes gratis, sin subir tus archivos"

RAIZ = pathlib.Path(__file__).parent

# Preguntas que van en todas las páginas
COMUNES = [
    ("¿Se suben mis archivos a algún servidor?",
     "No. Todo pasa dentro de tu navegador, en tu computadora o celular. Tus archivos nunca salen de tu dispositivo, "
     "por eso puedes usarlo con documentos privados."),
    ("¿Cuesta algo? ¿Hay que registrarse?",
     "Es gratis, sin registro, sin límite de archivos y sin marcas de agua."),
    ("¿Funciona sin internet?",
     "Sí. Después de abrir la página una vez queda guardada en tu navegador y funciona aunque no tengas conexión. "
     "También puedes instalarla como app desde el menú del navegador."),
]

# (dirección, vista, título corto, descripción, pasos, preguntas propias)
# La primera dirección de cada vista es la principal (la de la portada).
PAGINAS = [
    ("office-a-pdf", "office", "Office a PDF",
     "Convierte Word, Excel y PowerPoint a PDF gratis en tu navegador, sin subir tus archivos. También ODT, ODS, ODP, RTF, TXT y CSV.",
     ["Elige o arrastra tus documentos de Word, Excel o PowerPoint.",
      "Espera a que se conviertan; puedes poner varios a la vez.",
      "Descarga cada PDF."],
     [("¿Por qué tarda la primera vez?",
       "La conversión la hace LibreOffice dentro de tu navegador. La primera vez se baja (unos 77 MB, conviene con Wi-Fi) "
       "y se queda guardado; después cada documento tarda unos segundos, incluso sin internet."),
      ("¿Respeta las fuentes y el diseño?",
       "Sí, en la gran mayoría de los casos. Si el documento trae fuentes incrustadas, se usan esas.")]),
    ("word-a-pdf", "office", "Word a PDF",
     "Convierte documentos de Word (.docx y .doc) a PDF gratis, en tu navegador y sin subirlos a internet.",
     ["Elige o arrastra tus archivos .docx o .doc.",
      "Espera unos segundos a que se convierta cada uno.",
      "Descarga el PDF."],
     [("¿Sirve con documentos viejos .doc?",
       "Sí, también con .doc, .odt y .rtf.")]),
    ("excel-a-pdf", "office", "Excel a PDF",
     "Convierte hojas de cálculo de Excel (.xlsx y .xls) a PDF gratis, en tu navegador y sin subirlas a internet.",
     ["Elige o arrastra tus archivos .xlsx, .xls, .ods o .csv.",
      "Espera a que se conviertan.",
      "Descarga el PDF."],
     [("¿Cómo salen las hojas?",
       "Cada hoja sale con el área de impresión y la configuración de página que tenga guardada el archivo.")]),
    ("powerpoint-a-pdf", "office", "PowerPoint a PDF",
     "Convierte presentaciones de PowerPoint (.pptx y .ppt) a PDF gratis, en tu navegador y sin subirlas a internet.",
     ["Elige o arrastra tus archivos .pptx, .ppt u .odp.",
      "Espera a que se conviertan.",
      "Descarga el PDF, una diapositiva por hoja."],
     [("¿Funciona con plantillas de Canva?",
       "Sí. Si la presentación trae sus fuentes incrustadas, se usan para que el texto quede igual.")]),
    ("unir-pdf", "unir", "Unir PDF",
     "Une varios PDF en uno solo, en el orden que quieras. Gratis, en tu navegador y sin subir tus archivos.",
     ["Elige o arrastra los PDF que quieres juntar.",
      "Acomódalos con las flechas en el orden que necesitas.",
      "Pulsa «Unir» y descarga el PDF."],
     [("¿Hay límite de archivos o de páginas?",
       "No hay un límite fijo; solo depende de la memoria de tu dispositivo.")]),
    ("dividir-pdf", "dividir", "Dividir PDF",
     "Separa un PDF en varias partes o saca solo las páginas que necesitas. Gratis, en tu navegador y sin subirlo.",
     ["Elige el PDF.",
      "Escribe las páginas o rangos, por ejemplo «1-3, 5, 8-».",
      "Elige si quieres un solo PDF, uno por rango o uno por página, y descarga."],
     [("¿Qué significa «8-»?",
       "De la página 8 hasta la última.")]),
    ("organizar-pdf", "organizar", "Organizar páginas de PDF",
     "Gira, quita y reordena las páginas de uno o varios PDF viendo sus miniaturas, y agrega hojas en blanco. Gratis y sin subir tus archivos.",
     ["Elige uno o varios PDF.",
      "Gira, quita o arrastra las miniaturas de las páginas.",
      "Guarda el PDF nuevo."],
     [("¿Se pierde calidad?",
       "No. Las páginas se copian tal cual; solo cambia su orden o su giro.")]),
    ("girar-pdf", "organizar", "Girar PDF",
     "Gira las páginas de un PDF que salieron de lado o de cabeza, una por una o todas juntas. Gratis y sin subirlo.",
     ["Elige el PDF.",
      "Gira las páginas que lo necesiten, o pulsa «Girar todas».",
      "Guarda el PDF."],
     [("¿Puedo girar solo algunas páginas?",
       "Sí, cada miniatura tiene su propio botón para girarla.")]),
    ("eliminar-paginas-pdf", "organizar", "Eliminar páginas de un PDF",
     "Quita las páginas que sobran de un PDF viendo sus miniaturas. Gratis, en tu navegador y sin subir el archivo.",
     ["Elige el PDF.",
      "Pulsa ✕ en las páginas que quieres quitar.",
      "Guarda el PDF."],
     []),
    ("recortar-pdf", "recortarpdf", "Recortar PDF",
     "Quita los márgenes blancos de un PDF o deja solo la zona que necesitas, en una página o en todas. Gratis y sin subir el archivo.",
     ["Elige el PDF.",
      "Elige «Quitar los márgenes blancos» o marca a mano la zona que quieres dejar.",
      "Descarga el PDF recortado."],
     [("¿Se borra lo que queda afuera?",
       "No: se esconde, como al recortar en Acrobat. Sirve para presentar mejor el documento, no para borrar datos delicados."),
      ("¿Puedo recortar solo algunas páginas?",
       "Sí: escribe las páginas, por ejemplo «1-3, 5».")]),
    ("jpg-a-pdf", "imagenes", "Imágenes a PDF",
     "Convierte fotos JPG, PNG y WebP en un PDF, con hoja carta, A4 u oficio y márgenes. Gratis y sin subir tus fotos.",
     ["Elige o arrastra tus imágenes.",
      "Acomódalas, gíralas y elige el tamaño de hoja y el margen.",
      "Crea el PDF y descárgalo."],
     [("¿Pierden calidad las fotos?",
       "No. Las fotos JPG se meten al PDF tal cual, sin volver a comprimirlas.")]),
    ("imagen-a-pdf", "imagenes", "Imagen a PDF",
     "Convierte una o varias imágenes (JPG, PNG o WebP) en un PDF. Gratis, en tu navegador y sin subirlas.",
     ["Elige tus imágenes.",
      "Elige el tamaño de hoja, la orientación y el margen.",
      "Descarga el PDF."],
     []),
    ("pdf-a-jpg", "aimagenes", "PDF a imágenes",
     "Convierte cada página de un PDF en una imagen JPG o PNG, a 100, 150 o 300 ppp. Gratis y sin subir el archivo.",
     ["Elige el PDF.",
      "Elige JPG o PNG, la resolución y las páginas.",
      "Descarga las imágenes (varias se bajan juntas en un .zip)."],
     []),
    ("pdf-a-png", "aimagenes", "PDF a PNG",
     "Convierte las páginas de un PDF en imágenes PNG de alta calidad. Gratis, en tu navegador y sin subirlo.",
     ["Elige el PDF.",
      "Elige PNG y la resolución.",
      "Descarga las imágenes."],
     []),
    ("comparar-pdf", "compararpdf", "Comparar dos PDF",
     "Encuentra palabras añadidas, palabras quitadas y cambios visuales entre dos PDF, dentro del navegador.",
     ["Elige la versión anterior y la nueva, en ese orden.", "Compara el texto o la imagen y pasa de una diferencia a otra.",
      "Genera el reporte PDF para guardar los cambios."],
     [("¿Sirve con escaneos?", "Sí, el modo visual compara las imágenes. Para comparar palabras, primero usa «Reconocer texto».")]),
    ("pdf-a-markdown", "pdfamarkdown", "PDF a Markdown",
     "Convierte texto de PDF a Markdown con títulos, listas, estilos y tablas simples. Copia el resultado o descarga el .md.",
     ["Elige el PDF.", "Marca la opción de imágenes si quieres un ZIP.", "Descarga el archivo o copia el Markdown."],
     [("¿Qué pasa si el PDF es un escaneo?", "Pásalo primero por «Reconocer texto» para extraer sus palabras.")]),
    ("pdf-a-powerpoint", "pdfapowerpoint", "PDF a PowerPoint",
     "Convierte cada hoja del PDF en una diapositiva .pptx. Conserva su apariencia como imagen y permite recuperar texto editable.",
     ["Elige el PDF.", "Activa el texto editable si lo necesitas.", "Descarga el .pptx."],
     [("¿Se pueden editar los dibujos?", "Los gráficos y dibujos quedan en la imagen de la diapositiva."),
      ("¿Qué pasa con tamaños de página mezclados?", "PowerPoint usa un tamaño por archivo. Las páginas se ajustan proporcionalmente al tamaño de la primera.")]),
    ("pdf-a-excel", "pdfaexcel", "PDF a Excel",
     "Extrae tablas de PDF por la posición del texto y genera un libro .xlsx con celdas numéricas.",
     ["Elige el PDF.", "Selecciona una hoja por página o una sola hoja.", "Descarga el .xlsx."],
     [("¿Qué tablas se detectan?", "Tablas con filas y columnas alineadas. Los escaneos requieren OCR y las tablas complejas pueden requerir ajustes.")]),
    ("pdf-a-pdfa", "pdfa", "PDF a PDF/A",
     "Convierte un PDF a PDF/A-2b, PDF/A-1b o PDF/A-3b en el navegador.",
     ["Elige un PDF sin contraseña.", "Selecciona el formato y convierte.", "Descarga el PDF para archivo."],
     [("¿Se certifica el PDF?", "La app revisa que la salida incluya el perfil de color y los metadatos pedidos. Para certificar conformidad usa un validador PDF/A independiente.")]),
    ("quitar-fondo", "quitar-fondo", "Quitar fondo",
     "Separa a la persona del fondo con MODNet y guarda un PNG transparente, blanco o de color.",
     ["Elige una o más fotos.", "Quita el fondo y revisa las vistas de antes y después.", "Prepara las descargas."],
     [("¿En qué fotos funciona mejor?", "En retratos. Los objetos, fondos parecidos a la ropa y los bordes finos pueden requerir ajustes con otro editor.")]),
    ("mejorar-foto", "mejorar-foto", "Mejorar y ampliar foto",
     "Amplía fotos ×2 o ×4 con Real-ESRGAN, por mosaicos y dentro del navegador.",
     ["Selecciona una o más fotos.", "Elige ×2 o ×4 e inicia la ampliación.", "Descarga los PNG."],
     [("¿Cuál es el límite?", "Hasta 1 megapíxel y 1600 px por lado. El modelo reconstruye detalles estimados y puede modificar texturas.")]),
    ("difuminar-caras", "difuminar-caras", "Difuminar caras",
     "Detecta rostros con YuNet y permite corregir los recuadros antes de difuminar o pixelar.",
     ["Elige tus fotos y detecta las caras.", "Revisa cada foto y agrega o quita recuadros.", "Ajusta el efecto y guarda los PNG."],
     [("¿Cuándo revisar los recuadros?", "En todas las imágenes, en especial cuando hay caras pequeñas, de perfil o parcialmente cubiertas.")]),
    ("marca-de-agua-imagen", "marcaimagen", "Marca de agua en imágenes",
     "Agrega un texto o logo a tus fotos JPG, PNG, WebP o HEIC en el navegador y conserva el formato de salida.",
     ["Elige las imágenes.", "Ajusta la marca en la vista previa.", "Descarga las fotos marcadas."],
     [("¿Puedo usar un logo transparente?", "Sí. Elige un PNG con transparencia para que solo se vea el logo.")]),
    ("pdf-a-word", "pdfaword", "PDF a Word",
     "Convierte un PDF en un documento de Word (.docx) editable, con sus párrafos, negritas, títulos e imágenes. Gratis y sin subir el archivo.",
     ["Elige el PDF.",
      "Elige las páginas y si quieres las imágenes.",
      "Descarga el .docx y ábrelo en Word, WPS o Google Docs."],
     [("¿Funciona con PDF escaneados?",
       "Primero pásalo por «Reconocer texto» para que tenga texto; luego conviértelo a Word."),
      ("¿Queda igual que el PDF?",
       "Se conservan el texto, los párrafos, el formato de las letras y las imágenes. Las tablas y las columnas salen como "
       "párrafos normales, y puede hacer falta acomodar algunas cosas.")]),
    ("extraer-imagenes-pdf", "sacarimagenes", "Sacar imágenes de un PDF",
     "Extrae las fotos y dibujos que trae un PDF en su calidad original (JPG tal cual, lo demás en PNG). Gratis y sin subir el archivo.",
     ["Elige el PDF.",
      "Elige las páginas (o déjalo en todas).",
      "Descarga las imágenes; si son varias, van juntas en un .zip."],
     [("¿Pierden calidad?",
       "No. Las fotos JPG se sacan tal cual estaban guardadas dentro del PDF."),
      ("¿Y si quiero la página completa como imagen?",
       "Para eso usa «PDF a imágenes».")]),
    ("escanear-documento", "escanear", "Escanear documento",
     "Convierte fotos de hojas en un PDF que parece escaneado: encuentra la hoja, la endereza y deja el papel blanco. Gratis y sin subir tus fotos.",
     ["Toma o elige las fotos de tus hojas.",
      "Revisa las cuatro esquinas que encontró en cada foto y ajústalas si hace falta.",
      "Elige color, gris o blanco y negro. Activa «Hacer buscable (OCR)» si quieres buscar o copiar el texto y crea el PDF."],
     [("¿Sirve desde el celular?",
       "Sí. Toma la foto con la hoja completa a la vista y sobre un fondo más oscuro que el papel.")]),
    ("comprimir-pdf", "comprimir", "Comprimir PDF",
     "Reduce el tamaño de tus PDF para enviarlos por correo o WhatsApp, con tres niveles de compresión. Gratis y sin subirlos.",
     ["Elige uno o varios PDF.",
      "Elige cuánto comprimir: poco, recomendado o mucho.",
      "Descarga el PDF más ligero."],
     [("¿Se ve peor el texto?",
       "No. Solo se recomprimen las imágenes; el texto queda igual de nítido."),
      ("¿Por qué algunos PDF casi no bajan?",
       "Los que son solo texto, o los escaneos en blanco y negro, ya vienen muy comprimidos.")]),
    ("numerar-pdf", "numeros", "Números de página",
     "Agrega números de página a un PDF: «1», «Página 1 de 12» y más, en la posición que quieras. Gratis y sin subirlo.",
     ["Elige el PDF.",
      "Elige la posición, el formato y desde qué página empezar.",
      "Descarga el PDF numerado."],
     [("¿Puedo saltarme la portada?",
       "Sí: en páginas escribe «2-» para numerar desde la segunda hoja.")]),
    ("marca-de-agua-pdf", "marca", "Marca de agua en PDF",
     "Pon un texto, un sello o tu logotipo encima de las páginas de un PDF, con la transparencia que quieras. Gratis y sin subirlo.",
     ["Elige el PDF.",
      "Escribe el texto o elige una imagen, y su posición, color y transparencia.",
      "Revisa la vista previa y descarga."],
     []),
    ("proteger-pdf", "proteger", "Proteger PDF con contraseña",
     "Ponle contraseña a un PDF para que nadie lo abra sin ella. Cifrado AES de 256 bits, gratis y sin subir el archivo.",
     ["Elige el PDF.",
      "Escribe la contraseña dos veces.",
      "Descarga el PDF protegido."],
     [("¿Es seguro?",
       "Sí: usa cifrado AES de 256 bits, y la contraseña nunca sale de tu dispositivo.")]),
    ("desbloquear-pdf", "desbloquear", "Quitar contraseña a un PDF",
     "Quita la contraseña o las restricciones de un PDF del que conoces la clave. Gratis, en tu navegador y sin subirlo.",
     ["Elige el PDF protegido.",
      "Escribe su contraseña (si solo tiene restricciones, no hace falta).",
      "Descarga el PDF sin contraseña."],
     [("¿Puede adivinar una contraseña que no sé?",
       "No. Necesitas conocer la contraseña para abrir el archivo.")]),
    ("reparar-pdf", "reparar", "Reparar PDF",
     "Arregla un PDF dañado que no abre, sale incompleto o da error, y recupera lo que se pueda. Gratis y sin subir el archivo.",
     ["Elige o arrastra el PDF dañado.",
      "Espera a que se revise y se repare.",
      "Descarga la copia reparada."],
     [("¿Siempre se puede reparar?",
       "Casi siempre se recupera algo. Si el archivo está muy dañado, se rescatan las páginas como imágenes: se ven igual, "
       "pero el texto ya no se puede copiar."),
      ("¿Sirve con un PDF que se descargó a medias?",
       "Sí: se recuperan las páginas que alcanzaron a bajar.")]),
    ("ocr-pdf", "ocr", "Reconocer texto (OCR)",
     "Convierte un PDF escaneado o fotos en un PDF donde puedes buscar y copiar el texto. OCR en español e inglés, gratis y sin subir tus archivos.",
     ["Elige el PDF escaneado o las fotos.",
      "Elige el idioma y las páginas.",
      "Descarga el PDF con texto y, si quieres, el .txt."],
     [("¿Cambia cómo se ve el documento?",
       "No. Se queda igual y se le agrega una capa de texto invisible, para buscar y copiar."),
      ("¿Arregla los PDF que al copiar dan letras raras?",
       "Sí, en muchos casos: detecta el texto dañado y lo vuelve a leer.")]),
    ("firmar-pdf", "firmar", "Firmar PDF",
     "Dibuja tu firma o sácala de una foto y ponla en tu PDF, en el lugar y tamaño que quieras. Gratis y sin subir el documento.",
     ["Elige el PDF.",
      "Dibuja tu firma con el dedo o el ratón, o sácala de una foto.",
      "Toca la hoja para ponerla, acomódala y descarga."],
     [("¿Es una firma electrónica oficial?",
       "No, es una firma dibujada, como la que pondrías a mano. No sustituye a la e.firma del SAT.")]),
    ("llenar-formulario-pdf", "formulario", "Llenar formulario PDF",
     "Escribe en los campos y marca las casillas de un formulario PDF directamente sobre la hoja, y guárdalo. Gratis y sin subir el archivo.",
     ["Elige el formulario PDF.",
      "Escribe en los recuadros y marca las casillas sobre la hoja.",
      "Guarda el PDF lleno (si quieres, fijo para que ya no se cambie)."],
     [("¿Y si mi PDF no tiene campos?",
       "Entonces usa «Editar PDF»: ahí puedes escribir encima de cualquier hoja."),
      ("¿Qué es «dejarlo fijo»?",
       "Que lo escrito pasa a ser parte de la hoja y los campos desaparecen, para que nadie lo cambie.")]),
    ("editar-pdf", "editar", "Editar PDF",
     "Escribe texto, dibuja a mano, tapa o borra de verdad datos delicados, resalta, pon palomitas, formas o imágenes encima de un PDF. Gratis y sin subirlo.",
     ["Elige el PDF.",
      "Elige una herramienta (texto, tapar, resaltar, forma o imagen) y toca la hoja.",
      "Descarga el PDF editado."],
     [("¿Puedo cambiar el texto que ya trae el PDF?",
       "No directamente: puedes taparlo y escribir encima. Ojo: con «Tapar» lo de abajo sigue dentro del archivo."),
      ("¿Cómo borro de verdad un dato delicado (CURP, cuenta, firma)?",
       "Con «■ Borrar de verdad»: esa hoja se vuelve imagen con el recuadro negro, así lo de abajo desaparece del archivo. "
       "El resto del texto de la hoja se puede seguir buscando y copiando.")]),
    ("comprimir-imagen", "comprimir-imagen", "Comprimir imagen",
     "Reduce el peso de tus fotos JPG, PNG y WebP sin cambiar su formato. Gratis, en tu navegador y sin subirlas.",
     ["Elige tus imágenes.",
      "Elige cuánto comprimir.",
      "Descarga las imágenes más ligeras."],
     []),
    ("cambiar-tamano-imagen", "cambiar-tamano", "Cambiar tamaño de imagen",
     "Cambia el tamaño de tus imágenes en píxeles o por porcentaje, con o sin mantener la proporción. Gratis y sin subirlas.",
     ["Elige tus imágenes.",
      "Escribe el ancho y alto en píxeles, o un porcentaje.",
      "Descarga las imágenes."],
     []),
    ("recortar-imagen", "recortar", "Recortar imagen",
     "Recorta tus imágenes libremente o en formas 1:1, 4:3, 16:9 y más. Gratis, en tu navegador y sin subirlas.",
     ["Elige la imagen.",
      "Mueve el recuadro o elige una forma.",
      "Descarga la imagen recortada."],
     []),
    ("convertir-imagen", "convertir-imagen", "Convertir imagen",
     "Convierte imágenes entre JPG, PNG y WebP, y fotos HEIC del iPhone a JPG. Gratis, en tu navegador y sin subirlas.",
     ["Elige tus imágenes.",
      "Elige el formato: JPG, PNG o WebP.",
      "Descarga las imágenes convertidas."],
     []),
    ("png-a-jpg", "convertir-imagen", "PNG a JPG",
     "Convierte imágenes PNG a JPG para que pesen menos. Lo transparente queda en blanco. Gratis y sin subirlas.",
     ["Elige tus PNG.",
      "Elige JPG.",
      "Descarga las imágenes."],
     []),
    ("webp-a-jpg", "convertir-imagen", "WebP a JPG",
     "Convierte imágenes WebP a JPG o PNG para abrirlas en cualquier programa. Gratis y sin subirlas.",
     ["Elige tus WebP.",
      "Elige JPG o PNG.",
      "Descarga las imágenes."],
     []),
    ("heic-a-jpg", "convertir-imagen", "HEIC a JPG",
     "Convierte las fotos HEIC del iPhone a JPG o PNG para abrirlas en cualquier computadora o programa. Gratis y sin subirlas.",
     ["Elige tus fotos HEIC.",
      "Elige JPG o PNG.",
      "Descarga las imágenes convertidas."],
     [("¿Por qué mi iPhone guarda en HEIC?",
       "Es el formato que usa para que las fotos pesen la mitad. Muchos programas de Windows y páginas web no lo abren; por eso conviene pasarlas a JPG."),
      ("¿Puedo usar fotos HEIC en las demás herramientas?",
       "Sí: todas las herramientas de esta página aceptan fotos HEIC y las pasan a JPG solas.")]),
    ("girar-imagen", "girar-imagen", "Girar imagen",
     "Endereza fotos que salieron de lado o de cabeza, una por una o todas juntas. Gratis y sin subirlas.",
     ["Elige tus imágenes.",
      "Gíralas con ↺ y ↻.",
      "Descarga las imágenes."],
     []),
]

INICIO = ("", "inicio", None,
          "Convierte Word, Excel y PowerPoint a PDF; une, divide, recorta, comprime, edita, firma, repara y protege tus PDF; llena formularios; "
          "y comprime, recorta y convierte imágenes. Gratis, sin registro y sin subir tus archivos.",
          None, None)

e = lambda t: html.escape(t, quote=True)


def titulo(p):
    corto = p[2]
    return f"{NOMBRE} — {LEMA}" if corto is None else f"{corto} gratis y sin subir archivos | {NOMBRE}"


def ayuda(p):
    ruta, vista, corto, desc, pasos, preguntas = p
    if corto is None:
        cuerpo = (f"<h2>¿Por qué {e(NOMBRE)}?</h2>\n"
                  "<p>Las páginas de este tipo suben tus archivos a sus servidores. Aquí no: todo se hace dentro de tu "
                  "navegador, así que tus documentos nunca salen de tu computadora o celular.</p>\n")
        preguntas = []
    else:
        cuerpo = (f"<h2>Cómo usar {e(corto)}</h2>\n<p>{e(desc)}</p>\n<ol>\n"
                  + "".join(f"<li>{e(x)}</li>\n" for x in pasos) + "</ol>\n")
    cuerpo += "<h3>Preguntas frecuentes</h3>\n" + "".join(
        f"<details><summary>{e(q)}</summary><p>{e(r)}</p></details>\n" for q, r in preguntas + COMUNES)
    return f'<section class="tarjeta ayuda" id="ayuda" data-ruta="{ruta}">\n{cuerpo}</section>\n'


def main():
    cuerpo = (RAIZ / "fuente/cuerpo.html").read_text(encoding="utf-8")
    todas = [INICIO] + PAGINAS
    rutas = {p[0]: {"v": p[1], "t": titulo(p), "n": p[2]} for p in todas}
    principal = {}
    for p in PAGINAS:
        principal.setdefault(p[1], p[0])
    # Enlaces de la portada y «← Todas las herramientas»
    for vista, ruta in principal.items():
        cuerpo = cuerpo.replace(f'href="#{vista}"', f'href="{ruta}/"')
    cuerpo = cuerpo.replace('href="#"', 'href="./"').replace("{{NOMBRE}}", e(NOMBRE))
    assert 'href="#' not in cuerpo, "quedó un enlace viejo con #"
    rutas_json = json.dumps(rutas, ensure_ascii=False).replace("</", "<\\/")

    hoy = datetime.date.today().isoformat()
    urls = []
    for p in todas:
        ruta = p[0]
        url = SITIO + (ruta + "/" if ruta else "")
        urls.append(url)
        t, d = titulo(p), p[3]
        ld = {"@context": "https://schema.org", "@type": "WebApplication", "name": NOMBRE if not p[2] else f"{p[2]} — {NOMBRE}",
              "url": url, "description": d, "applicationCategory": "UtilitiesApplication", "operatingSystem": "Cualquiera (navegador)",
              "inLanguage": "es", "offers": {"@type": "Offer", "price": "0", "priceCurrency": "MXN"}}
        pagina = f"""<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<base href="{'../' if ruta else './'}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{e(t)}</title>
<meta name="description" content="{e(d)}">
<link rel="canonical" href="{url}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="{e(NOMBRE)}">
<meta property="og:title" content="{e(t)}">
<meta property="og:description" content="{e(d)}">
<meta property="og:url" content="{url}">
<meta property="og:image" content="{SITIO}compartir.png">
<meta property="og:locale" content="es_MX">
<meta name="twitter:card" content="summary_large_image">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="icono.svg" type="image/svg+xml">
<meta name="theme-color" content="#2A6478">
<link rel="stylesheet" href="app.css">
<script type="application/ld+json">{json.dumps(ld, ensure_ascii=False)}</script>
<script type="application/json" id="rutas">{rutas_json}</script>
<script type="module" src="app.js"></script>
</head>
"""
        html_final = pagina + cuerpo.replace("{{AYUDA}}", ayuda(p)) + "</html>\n"
        destino = RAIZ / (ruta + "/index.html" if ruta else "index.html")
        destino.parent.mkdir(exist_ok=True)
        destino.write_text(html_final, encoding="utf-8")

    (RAIZ / "sitemap.xml").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
        + "".join(f"  <url><loc>{u}</loc><lastmod>{hoy}</lastmod></url>\n" for u in urls) + "</urlset>\n", encoding="utf-8")
    (RAIZ / "robots.txt").write_text(f"User-agent: *\nAllow: /\nSitemap: {SITIO}sitemap.xml\n", encoding="utf-8")
    print(f"{len(todas)} páginas, sitemap y robots listos")


if __name__ == "__main__":
    main()
