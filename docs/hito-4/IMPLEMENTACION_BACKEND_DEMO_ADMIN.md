# Implementación backend de demo administrativa H4

Base `b061ef86ec63a06ba626c3f7a66c94cd7fc270db`. Este corte integra lecturas administrativas, recuperación de escritura, almacenamiento de logos, autorización local de traslados y validación de identidad de mutaciones. Los estados de pruebas están en la [matriz](MATRIZ_VERIFICACION_HITO4.md).

| Componente | Implementación o hallazgo | Pendiente |
| --- | --- | --- |
| API Gateway | Generación aditiva de ocho rutas administrativas. CORS por lista explícita, preflight y headers de descarga. Comparación de 135 rutas anteriores. | Validar el origen HTTPS y la sesión G7 reales. Traslados requiere habilitación explícita y el mapa local autorizado. |
| Catálogo | Listado de todos los estados y detalle por UUID. Lectura consistente desde PostgreSQL, versiones seguras, perfil parcial, imágenes y selección de características identificadoras por producto. | Ejecutar el recorrido de preparación y activación con Pricing, Inventory y broker descartable. |
| Taxonomía | CRUD y seguimiento de baja existentes. El multipart guarda bytes validados en el volumen configurado y registra su URL por hash. | Publicar el volumen en la base de assets aprobada y validar la barrera AMQP real. El rol identificador se lee del producto en Catálogo. |
| Pricing | Definiciones editables exactas por producto/SKU y canal. Lecturas comerciales, programación e introspección vigentes. | Ejecutar persistencia del fixture completo y validar introspección y read-back con G7 real. |
| Inventario | Listado físico paginado y nombre real de ubicación. Estado filtrable antes de paginar y ciclo de vida nullable. Autorización local de traslados por sub con cierre por defecto. | Aplicar el mapa de operadores autorizado y probar recepción en el ambiente G7 real. |
| Combos | Creación administrativa recuperable con recibo PostgreSQL por actor y clave. Repetición concurrente, conflicto y CRUD probados con PostgreSQL TLS. | Aplicar la migración candidata y validar grants de Catálogo/Pricing. La disponibilidad cuantitativa requiere fuente autorizada. |
| Promociones | Mutaciones de promoción, cupón y regla verifican identidad dentro de la transacción. | Validar JWT y proveedores G7 reales para composición y evaluación. |
| Bulk | Importación v2, admisión recuperable y reportes cubiertos por pruebas focalizadas. | El flujo con broker queda pendiente. La reanudación está condicionada a la aprobación del protocolo. |
| Price Audit | Lista y detalle administrativos preservan SKU y canal global nulos con precisión decimal. | Homologar el contrato aditivo y ejecutar exportación con almacenamiento aislado. |

Catálogo conserva la identidad comercial de DEC-F-001. Las nuevas consultas operan sobre la identidad de producto y su estado de edición. La lectura administrativa no evalúa elegibilidad comercial. El detalle conserva el valor nulo de `publicadoAlgunaVez` para datos históricos, conforme a Q-06 de SPEC-003. La vista administrativa reutiliza las tablas existentes. Las pruebas nuevas no requieren migración.

La seguridad de las nuevas rutas sigue la política de Backend #144. Se reutilizan la verificación de JWT y los roles existentes en cada frontera. El preflight del navegador funciona sin tocar la autorización del GET.
