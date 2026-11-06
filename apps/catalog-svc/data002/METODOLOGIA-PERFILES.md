# Metodología de los 55 perfiles académicos

Fuente metodológica: explicación expresa del usuario en la revisión de DATA-002
#12. Los valores originales del Excel se conservan, con SHA-256
`ed169cef1538cf01cc665c43ebc8bde05e2e584514bb07ac51e4fc254bac2a6e`.
No se realizaron 55 mediciones individuales ni un muestreo estadístico.

Se aplicó una estimación heurística por categoría, talla, modelo y presentación
logística. Se investigaron referencias comerciales, priorizando modelo y talla;
se aprovecharon datos publicados comparables y se completaron los restantes con
valores físicamente plausibles. Los ajustes por talla fueron aproximados, sin
fórmula experimental o estadística. Cuando varios SKU tenían presentación
equivalente se reutilizó una plantilla, sin inventar diferencias entre colores
o marcas para producir tuplas únicas.

| Categoría | Unidad considerada | Ejemplo de plantilla, no especificación certificada |
|---|---|---|
| Camisetas | Prenda doblada y preparada para despacho | M: 0,185 kg; 32 × 23 × 3 cm |
| Shorts | Prenda doblada y embolsada | M genérico: 0,165 kg; 29 × 21 × 3,5 cm |
| Medias | Un par doblado, no paquete de tres pares | Rango pequeño: 0,080 kg; 20 × 12 × 3 cm |
| Zapatillas | Par completo dentro de caja | Runfalcon 38: 0,850 kg; 32 × 20 × 12 cm |
| Chimpunes | Par completo dentro de caja | Predator 42: 0,930 kg; 35 × 23 × 13 cm |
| Balones | Un balón talla 5 inflado sin embalaje | 0,420–0,430 kg; 22 × 22 × 22 cm |

La reconciliación reproducible en `evidence/physical-quality-review.json` y
`template-reuse.csv` confirma 55 SKU, 220 valores positivos/completos,
27 combinaciones y 39 SKU que comparten combinación con al menos otro.
Se conservan 213 etiquetas ESTIMACION_ACADEMICA y siete
PUBLICADO_NO_HOMOLOGADO. Cada SKU mantiene un registro técnico propio; compartir
medidas no equivale a duplicar SKU, UUID ni perfil.

Las siete referencias publicadas declaradas en el Excel son tres dimensiones
del paquete de Entrada 22 Shorts M (33,7 × 24,2 × 4,5 cm), y peso/dimensiones
del paquete Under Armour Tech 2.0 L (0,149 kg; 31 × 20,5 × 1,7 cm). El peso del
short M se estimó en 0,165 kg porque la fuente publicada contenía pesos
contradictorios de artículo y paquete. Los límites y enlaces originales están
en la hoja FUENTES y en la extracción preservada. No se trasladó automáticamente
un peso de zapatilla individual al peso de un par o de una caja.

Estas son referencias de presentación logística, no mediciones certificadas
ni especificaciones oficiales para cada SKU. La autorización académica permite
las estimaciones; no resuelve por sí sola la diferencia entre artículo y embalaje.
La decisión semántica y la aprobación de ejecución compartida se exigen por
separado, como se detalla en `RESPUESTA-AUDITORIA.md`.
