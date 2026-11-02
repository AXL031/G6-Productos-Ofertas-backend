# Candidata de locking seed — revisión Axel/López/BD/Marco

## Revisión de López recibida el 01/11/2026

Axel aportó aceptación técnica **condicionada** de López: guard invoker antes de
ACL UPDATE(id), auditoría por columna y retirada en orden inverso. No equivale a
aprobación de BD/Marco ni levanta `SEED_TRIGGER_LOCK_PRIVILEGE_UNRESOLVED`.

La candidata se reforzó con `to_regrole` y rechazo si el rol esperado no existe;
evalúa además membresía transitiva MEMBER del `session_user`, para impedir que un
login seed NOINHERIT eluda el guard mediante SET ROLE a otro rol. La auditoría
mantiene `has_any_column_privilege`/`has_column_privilege`. Se prueba un login
runtime separado, sin membresía seed, que conserva escritura y contención real
de locks por PK; los límites transaccionales siguen acotados.

Una sesión superuser también puede satisfacer MEMBER: no se usa como sustituto
del runtime en el ensayo de coexistencia. El primer ensayo con la protección
nueva rechazó correctamente ese uso del fixture; se reemplazó por un login runtime
autenticado, sin relajar el guard. Nueve grupos PASS en PostgreSQL 17.11.
La evidencia nueva se conserva en
[seed-locking-proposal-2026-11-01.json](test/evidence/seed-locking-proposal-2026-11-01.json);
el archivo del 26/10 conserva intacta la evidencia anterior.

BD debe revisar roles/membresías y ventanas de lock reales; Marco debe autorizar
una entrega BD versionada separada de DATA-005 y cada carga/destino. Ningún SQL
de esta propuesta se ha aplicado en un sistema compartido.

## Antecedente del 26/10 (implementación anterior al refuerzo)

Issue #15, rama cueva. **Propuesta local validada, PENDIENTE DE REVISIÓN Y
APROBACIÓN ESPECÍFICA.** Marco aceptó la preparación interna y autorizó proponer
y validar una solución; no aprobó grants, triggers ni cargas compartidas.
Su decisión se registra en
[DECISIONES-MARCO-2026-10-26.md](../../../../apps/promotions-svc/DECISIONES-MARCO-2026-10-26.md).

## Problema y alternativa mínima

Los triggers invoker oficiales `fn_lock_parent` y `fn_guard_coupon` usan
`SELECT ... FOR UPDATE` sobre `promotions.promotions` y
`promotions.recommendation_rules`. PostgreSQL exige UPDATE al menos sobre una
columna del padre para esos locks; SELECT/INSERT solos fallan con 42501.
Cambiar a FOR SHARE/KEY SHARE tampoco elimina ese requisito.
Fuente: [PostgreSQL 17 SELECT](https://www.postgresql.org/docs/17/sql-select.html).

La candidata preserva las funciones, locks y constraints oficiales:

1. Instalar primero un guard `SECURITY INVOKER`, search_path fijo pg_catalog,
   sin SQL dinámico ni permisos EXECUTE de PUBLIC. Dos triggers BEFORE STATEMENT
   rechazan UPDATE/DELETE/TRUNCATE si el actor tiene acceso al rol seed mediante
   `pg_has_role(current_user,'po_promotions_seed','USAGE')`. Incluye identidad
   directa y logins que heredan el rol; no depende de un GUC suplantable.
2. Solo después, conceder **UPDATE(id) sobre los dos padres**, nunca UPDATE de
   tabla ni de columnas comerciales. Ese privilegio satisface el chequeo de
   locks; los triggers prohíben toda mutación seed, incluso UPDATE sin filas,
   CTE, MERGE y ON CONFLICT DO UPDATE. INSERT/ON CONFLICT DO NOTHING permanece.
3. Retirar en orden inverso: revocar primero UPDATE(id), luego quitar los
   guards. El orden impide dejar privilegios de mutación sin el guard.

Los triggers por sentencia se ejecutan también con cero filas afectadas;
los FOR UPDATE usados para leer/bloquear no son sentencias UPDATE.
Fuente: [PostgreSQL 17 CREATE TRIGGER](https://www.postgresql.org/docs/17/sql-createtrigger.html).

El SQL es exclusivamente
[fixture descartable](test/support/seed-locking-proposal.sql), no una migración
ni un script aprobado de instalación. No se altera el generador, el preview,
el gate `SEED_TRIGGER_LOCK_PRIVILEGE_UNRESOLVED` ni ninguna migración histórica.
No se introduce SECURITY DEFINER, acceso owner para el seed ni otro protocolo
de locks que pueda divergir de los escritores runtime.

## Prueba reproducible y resultados

```powershell
node scripts/seed/mcp/promotions/test/seed-locking-proposal.mjs
```

El runner solo acepta ejecutarse sin parámetros, rechaza DOCKER_HOST remoto,
comprueba contexto Docker local y crea un único PostgreSQL 17 ligado a loopback,
con contraseña efímera. Verifica los blobs de cuatro migraciones oficiales antes
de aplicarlas a su base nueva. No lee .env ni acepta una conexión del usuario.

Resultado: **PASS con PostgreSQL 17.11**, siete grupos:

- Reproduce el 42501 original con login autenticado no-superuser y rol seed.
- Con la candidata, el preview original de seis maestros pasa como seed y
  hace rollback completo; UPDATE de tabla sigue denegado y solo id tiene ACL
  UPDATE en los dos padres.
- Inserta 11 filas sintéticas solo en la base descartable; un segundo lote
  idéntico en otra transacción conserva valores y timestamps.
- Rechaza mutación directa, cero filas, CTE, MERGE, UPSERT UPDATE y acceso
  heredado. Rechaza DELETE, TRUNCATE, DDL, deshabilitar triggers, cambiar
  session_replication_role, asumir owner y leer Outbox.
- El trigger original de hijo conserva el lock del padre: otro escritor owner
  recibe 55P03 en ese padre mientras puede actualizar otro agregado; rollback
  conserva íntegros los datos de prueba.
- FK y definiciones de funciones históricas intactas; el guard nuevo es invoker
  con search_path fijo.
- Revoca ACL y retira guards en local; reaparece el rechazo seed original.
  Finalmente elimina el contenedor y toda su base.

[Evidencia con hashes](test/evidence/seed-locking-proposal-2026-10-26.json).
Los primeros dos intentos detectaron problemas del fixture, no del modelo:
faltaba crear el rol runtime exigido por la migración; la consulta de privilegios
asumía id en combination_policy, cuya clave es promotion_id. Ambos se corrigieron
en el runner; no se cambiaron migraciones ni se quitaron aserciones.

## Condiciones antes de cualquier uso compartido

López/BD deben revisar expresamente el compromiso de permitir ACL UPDATE(id)
para locks y prohibir mutaciones por trigger, los roles/membresías reales,
la interacción con escritores runtime y la protección de triggers. La función
bloquea cualquier actor con USAGE del rol seed, incluidos administradores que
lo tengan efectivo; el escritor runtime/owner debe tener una identidad separada
sin ese acceso efectivo. No se atribuye a López revisión ya realizada.
La ACL también permite locks directos sobre filas legibles de esos padres;
BD debe revisar ventana transaccional, timeouts y operación de ese acceso.

Si se exige que incluso la ACL por columna sea inexistente, **esta candidata
no satisface esa política** y no debe instalarse. Se requerirá otra decisión BD;
no se cambia FOR UPDATE por un lock más débil ni se eleva a definer por inferencia.

Marco debe aprobar una entrega BD separada, con instalación transaccional
(guard antes de grant), reversión, revisión de privilegios/identidades y prueba
autenticada en el destino. Esta propuesta no crea esa migración ni modifica
schemas/grants reales. El preview no verifica por sí solo la presencia de los
guards; antes de autorizarlo en un entorno con ACL nuevas se debe acreditar la
configuración efectiva. No habilitarlo solo porque su chequeo de ACL pase.

Independientemente siguen pendientes referencias/precios/canales/contenido
aprobados por Poma/Vera, disponibilidad aplicable de Taco y autorización final
de Marco del manifiesto/hash, SQL, tablas, destino, transacción y postcheck.
Estado de #15: IMPLEMENTAR_PARCIAL; carga compartida BLOQUEADO_ESPECÍFICO.
