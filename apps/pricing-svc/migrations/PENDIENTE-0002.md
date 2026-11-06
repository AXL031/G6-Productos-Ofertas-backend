# Pricing 0002 — pendiente de homologación y despliegue

`0002_schedule_effective_events.sql` agrega contexto opcional (`product_id` y
`correlation_id`) a `pricing.scheduled_prices`. Es requisito del código que
reconcilia programaciones vencidas y genera el hecho efectivo. El servicio debe
mantener readiness en falso si cualquiera de esas columnas falta; una instancia
con solo el esquema 0001 no es compatible con este código.

Esta migración no está autorizada para aplicarse en Supabase compartido. La
validación debe ejecutarse primero en una base descartable partiendo de 0001;
aplicarla más de una vez debe ser inocuo.

## Orden de corte requerido

1. Homologar el cambio y registrar 0002 en el historial normativo de Docs.
2. Respaldar/verificar la versión del esquema de Pricing en el entorno destino.
3. Detener el despliegue de nuevas instancias y pausar el reconciliador.
4. Aplicar 0002 con el usuario propietario y verificar ambas columnas.
5. Desplegar el binario cuyo SHA incluye el reconciliador compatible.
6. Comprobar readiness, reanudar reconciliación y revisar Outbox y programaciones.

No marcar `READY_FOR_DEPLOY` ni ejecutar el corte hasta que la homologación,
la evidencia de migración y las verificaciones de despliegue estén asociadas al
SHA que se desplegará.
