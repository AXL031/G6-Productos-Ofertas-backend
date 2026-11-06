# Azure — cinco lecturas públicas activadas

Base HTTPS real:
https://g6-po-axl031-167090a.chilecentral.cloudapp.azure.com

Se activó PUBLIC_READ_ONLY tras la instrucción explícita del usuario en este chat
para las cinco consultas enumeradas previamente. El usuario también aceptó que el
catálogo permanezca vacío hasta que se publiquen productos por el flujo de negocio.
Este registro acredita esa autorización de operación; no atribuye una aprobación
nueva a Marco, ni modifica la matriz normativa central, ni declara homologación
G7 o aceptación externa de Marketplace.

## Endpoints públicos sin JWT

Todos se consumen con GET, sin cabecera Authorization:

| Servicio | Ruta | Respuesta actual |
|---|---|---|
| Gateway | `/health` | 200, `status=ok` |
| Taxonomy | `/api/v1/categorias` | 200, 8 categorías |
| Taxonomy | `/api/v1/marcas` | 200, 6 marcas |
| Catalog | `/api/v1/productos?canal=MARKETPLACE` | 200, `items=[]`, `total=0` |
| Catalog | `/api/v1/productos/{productoId}?canal=MARKETPLACE` | Público; 404 para borrador o inexistente |
| Catalog | `/api/v1/productos/por-slug/{slug}?canal=MARKETPLACE` | Público; 404 para borrador o inexistente |

`{productoId}` y `{slug}` son parámetros; requieren un producto publicado y
elegible para obtener 200 con datos. La base actual contiene 20 productos, todos
BORRADOR. No se alteró ningún estado, se cargaron seeds ni se abrió preview para
hacerlos visibles. El usuario confirmó que se mantengan así por ahora.

Los otros módulos pueden usar estas lecturas sin G7. Si suministran Authorization,
el token se valida y no se convierte en acceso anónimo. G7 todavía no está
configurado: una solicitud con token suministrado puede devolver 503. No enviar
tokens simulados ni atribuir grants G7 a estas consultas públicas.

## Configuración exacta, sin cambios de aplicación

SHA oficial activo: `167090af6d4ae93adbde54b6741dd994d91bf70b`.
Se conservaron [los tres digests oficiales](ARTEFACTOS_OFICIALES_167090a.md).
No se construyó ni modificó código de Gateway, Catalog o Taxonomy.

```dotenv
# En los tres servicios
G6_SECURITY_MODE=PUBLIC_READ_ONLY

# Solo Gateway
GATEWAY_PUBLIC_OPERATION_IDS=listarCategorias,listarMarcas,listarProductos,obtenerProducto,obtenerProductoPorSlug
# Solo Catalog
CATALOG_PUBLIC_OPERATION_IDS=listarProductos,obtenerProducto,obtenerProductoPorSlug
# Solo Taxonomy
TAXONOMY_PUBLIC_OPERATION_IDS=listarCategorias,listarMarcas
```

Flags legacy y preview permanecen false. Las demás operaciones conservan los
guards JWT. Los puertos de aplicación siguen en loopback; no se amplió el NSG.
Se mantuvieron los secretos, la CA y verify-full. El emisor simulado sigue local.

El cambio afectó exclusivamente al selector y la lista por servicio en sus
runtime privados. Se verificó que el resto de variables permaneciera idéntico.
Backup root-only en `/var/lib/g6-productos-ofertas/public-phase-167090a/`, nunca
en Git. Se tomaron los locks de despliegue y se recrearon los tres servicios con
Docker Compose, `--pull never` e imágenes fijadas a sus digests aprobados.

## Pruebas reales por HTTPS

En la verificación final se ejecutaron 15 casos HTTP:

- Health, categorías, marcas y listado Marketplace: 200.
- ID/slug inexistentes: 404.
- Producto BORRADOR existente por ID y por slug: 404, sin datos privados.
- Filtros `estado=BORRADOR` y `estado=INACTIVO`: 403, sin ampliar visibilidad.
- Escritura anónima, detalles privados de categorías/marcas y variantes privadas:
  401. No se ejecutó ninguna mutación autenticada de negocio.
- JWT inválido suministrado: 503 por G7 sin configurar; se acreditó solo que no
  hubo fallback anónimo, no un rechazo JWT 401 contractual ni G7 funcional.

No hubo un producto INACTIVO existente para probar por ID/slug; queda registrado
como NO EJECUTADO. El positivo con producto activo real por ID y slug también está
pendiente de que Catalog/Poma publique un producto mediante el flujo autorizado.
No se creó un fixture en la base compartida ni se cambiaron reglas comerciales.

Los conteos seleccionados de products/variants/categories/brands e Inbox/Outbox
se mantuvieron iguales antes/después de la batería. La comprobación se hizo con
transacciones SQL READ ONLY; no constituye un snapshot completo ni descarta
actualizaciones concurrentes que no afecten conteos en una base compartida.

## Reversión de fase probada y estado final

Se restauró realmente la configuración anterior G7_AUTHENTICATED con listas
vacías, se reiniciaron los tres servicios y se verificó 401 anónimo en las cinco
rutas. Después se reactivó PUBLIC_READ_ONLY y se repitieron las pruebas finales.
**Estado final: PUBLIC_READ_ONLY, exactamente las cinco lecturas acordadas.**
Los tres contenedores están running/healthy; Caddy conserva HTTPS. La reversión
de fase es independiente del rollback a una imagen anterior, que no se ensayó.
Tampoco se declaró autenticación G7 real por restaurar la configuración cerrada.

Evidencia no secreta:
[PUBLIC_READ_ONLY_AZURE_167090a.json](PUBLIC_READ_ONLY_AZURE_167090a.json).
Los identificadores/slug de borradores usados en negativos están redactados.
El [informe de despliegue previo](DESPLIEGUE_AZURE_167090a.md) conserva el corte
histórico con listas vacías; esta activación es su actualización posterior.

Backend #144 permanece abierto. Pendientes independientes: G7 real, producto
activo de prueba, caso INACTIVO real, pruebas de carga y aceptación del consumidor.
