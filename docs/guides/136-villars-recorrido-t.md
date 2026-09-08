# Línea 136 Villars: representación del recorrido en T

## Alcance

Este documento describe el corredor local de la línea 136 que vincula Marcos Paz,
Zamudio, Villars, Plomer, General Hornos y Las Heras. No corresponde al
**136 Rápido**: ese servicio no pasa por Villars y no debe mezclarse con estas
grillas, trazas ni estimaciones.

## Por qué no es un recorrido lineal

Un mismo bloque operativo puede volver a pasar por Zamudio y Villars. Por eso la
grilla representa **eventos ordenados de paso**, no una lista sin duplicados de
lugares físicos:

1. Marcos Paz.
2. Zamudio en el sentido de ida.
3. Villars: ingreso al pueblo.
4. Zamudio en el sentido hacia Las Heras.
5. General Hornos.
6. Las Heras.
7. General Hornos en el regreso.
8. Zamudio en el regreso.
9. Villars: segundo ingreso.
10. Zamudio en el sentido hacia Marcos Paz.
11. Marcos Paz.

En determinados servicios la rama occidental se extiende desde Villars hasta
Plomer y vuelve a Villars antes de continuar por el tronco.

## Convención para Excel

Cada columna es un evento del itinerario y cada fila es una formación. Cuando
una calle o parada se repite, el encabezado debe conservar un sufijo humano que
lo vuelva inequívoco, por ejemplo:

- Entrada A Villars (desde Plomer)
- Entrada A Villars (hacia Zamudio)
- Rp 40 Y Rp 6 (hacia Las Heras)
- Rp 40 Y Rp 6 (hacia Marcos Paz)

No se debe eliminar la segunda aparición ni combinar sus horarios. La metadata
Sentido debe coincidir exactamente con uno de los encabezados de estación.

La planilla
Horarios/Colectivos/136-Villars/LaboralMarcosPazViaLasHeras.xlsx implementa
esta convención para el servicio G publicado: 62 eventos desde Estación Plomer
hasta Estación Marcos Paz, pasando por Villars y Las Heras. La misma carpeta
incluye las variantes E, F, H e I para días laborales, sábados y domingos.
Sus salidas y duraciones son las publicadas; los pasos intermedios reconstruidos
por el recorrido llevan `Metodo = Estimado` en `A24`.

## Mapa y posiciones

En el mapa, los lugares físicos y los eventos horarios se modelan por separado:

- un punto geográfico puede ser visitado más de una vez;
- la ruta es una secuencia de segmentos reutilizables y reversibles;
- la extensión a Plomer es una rama, no una línea distinta;
- una unidad del 136 se mueve por interpolación del horario publicado y siempre
  se rotula como **posición estimada**, nunca como GPS observado.

Las esperas aproximadas de diez minutos informadas localmente en Villars y Las
Heras son conocimiento operativo pendiente de una planilla verificable. No
deben sumarse artificialmente a los horarios publicados.

## Zamudio

Los puntos de detención de Zamudio pueden cambiar según el sentido. Hasta contar
con coordenadas o nomenclatura verificables para ambos, el mapa usa el empalme
RP 40 / RP 6 como referencia de corredor. La grilla, en cambio, debe conservar
el sentido de cada paso mediante el sufijo del evento.

## Fuentes

- Horario y 62 paradas del servicio G:
  https://moovitapp.com/index/es-419/transporte_p%C3%BAblico-time-136-Buenos_Aires-1602-853157-115624289-6679793-0
- Mapa y variantes publicadas de la línea:
  https://moovitapp.com/index/es-419/transporte_p%C3%BAblico-line-136-Buenos_Aires-1602-853157-115624289-10
- Geometría vial: OpenStreetMap, calculada por OSRM.

Moovit es una fuente secundaria de consulta. Los horarios deben volver a
contrastarse cuando aparezca una publicación primaria del operador o de la
autoridad de transporte.
