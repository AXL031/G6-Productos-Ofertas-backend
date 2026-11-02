export type Canal = 'MARKETPLACE' | 'CHATBOT' | 'RETAIL' | 'VENTAS';

export type CanalComercial = 'MARKETPLACE' | 'CHATBOT' | 'RETAIL';

export type EstadoStock = 'AGOTADO' | 'STOCK_BAJO' | 'DISPONIBLE';

export type EstadoComercial =
  'DISPONIBLE' | 'STOCK_BAJO' | 'AGOTADO' | 'INDETERMINADO';

export type OperacionInventarioTipo =
  | 'RESERVAR'
  | 'CONFIRMAR_CONSUMO'
  | 'LIBERAR'
  | 'REINTEGRAR'
  | 'CONCILIAR_OFFLINE';

export type OperacionInventarioEstado =
  'ACCEPTED' | 'PROCESSING' | 'COMPLETED' | 'REJECTED' | 'REQUIRES_REVIEW';

export type MotivoLiberacion =
  'PAGO_NO_COMPLETADO' | 'ANULACION' | 'EXPIRACION_FORZADA' | 'OTRO';

export class LineaInventario {
  sku!: string;
  quantity!: number;
  location_id?: string | null;
}

export class CrearReservaRequest {
  order_id!: string;
  operation_id!: string;
  channel_id!: Canal;
  lines!: LineaInventario[];
}

export class OperacionReservaRequest {
  order_id!: string;
  operation_id!: string;
}

export class LiberarReservaRequest {
  order_id!: string;
  operation_id!: string;
  reason!: MotivoLiberacion;
}

export interface OperacionInventarioAceptada {
  operation_id: string;
  order_id: string;
  operation_type: OperacionInventarioTipo;
  status: 'ACCEPTED';
  correlation_id: string | null;
}

export interface ConsultaOperacionInventario {
  operation_id: string;
  order_id: string;
  operation_type: OperacionInventarioTipo;
  status: OperacionInventarioEstado;
  reservation_id?: string | null;
  expires_at?: string | null;
  result_code?: string | null;
  accepted_at: string;
  completed_at?: string | null;
}

export interface DisponibilidadStock {
  sku: string;
  location_id?: string | null;
  on_hand: number;
  reserved: number;
  blocked: number;
  available: number;
  status: EstadoStock;
  threshold?: number | null;
}

export interface ConsultaDisponibilidadResponse {
  items: DisponibilidadStock[];
}

export interface DisponibilidadComercial {
  sku: string;
  status: EstadoComercial;
}

export interface ConsultaDisponibilidadComercialResponse {
  items: DisponibilidadComercial[];
}

export class VerificarCantidadComercialLinea {
  sku!: string;
  quantity!: number;
}

export class VerificarCantidadComercialFulfillment {
  mode!: 'ENVIO_DOMICILIO' | 'RETIRO_TIENDA' | 'VENTA_TIENDA';
  fulfillment_ref?: string;
}

export class VerificarCantidadComercialRequest {
  channel_id!: Canal;
  fulfillment?: VerificarCantidadComercialFulfillment;
  lines!: VerificarCantidadComercialLinea[];
}

export interface VerificarCantidadComercialItem {
  sku: string;
  requested_quantity: number;
  result: 'SUFICIENTE' | 'INSUFICIENTE' | 'INDETERMINADO';
  reason_code?: string | null;
}

export interface VerificarCantidadComercialResponse {
  evaluated_at: string;
  binding: false;
  items: VerificarCantidadComercialItem[];
}

export type MotivoReintegroInventario =
  'DEVOLUCION_ACEPTADA' | 'ANULACION_POST_CONSUMO' | 'RETORNO_LOGISTICO';

export interface LineaInventarioUbicada {
  sku: string;
  quantity: number;
  location_id: string;
}

export class ReintegroInventarioRequest {
  operation_id!: string;
  order_id!: string;
  source_ref!: string;
  reason!: MotivoReintegroInventario;
  lines!: LineaInventarioUbicada[];
}

export interface ReintegroLineaResultado {
  sku: string;
  location_id: string;
  quantity: number;
  on_hand: number;
  reserved: number;
  blocked: number;
  available: number;
  stock_version: number;
}

export interface ReintegroInventarioResponse {
  operation_id: string;
  order_id: string;
  source_ref: string;
  status: 'COMPLETED';
  lines: ReintegroLineaResultado[];
  completed_at: string;
}

// ---------------------------------------------------------------------------
// Umbrales de stock (SPEC-015 §6, OpenAPI UmbralInventario)
// ---------------------------------------------------------------------------

export interface UmbralInventario {
  umbralGlobal: number;
  overrides: Array<{ sku: string; umbral: number }>;
}

export class UmbralGlobalRequest {
  umbral!: number;
}

export class UmbralSkuRequest {
  umbral!: number;
}

// ---------------------------------------------------------------------------
// Dashboard de inventario (SPEC-016, OpenAPI DashboardInventario)
// ---------------------------------------------------------------------------

export interface DashboardUbicacion {
  location_id: string;
  on_hand: number;
  reserved: number;
  available: number;
  skusDisponibles: number;
  skusStockBajo: number;
  skusAgotados: number;
}

export interface DashboardInventario {
  generatedAt: string;
  totalSkus: number;
  totalOnHand: number;
  totalReserved: number;
  totalAvailable: number;
  skusDisponibles: number;
  skusStockBajo: number;
  skusAgotados: number;
  porUbicacion: DashboardUbicacion[];
}

// ---------------------------------------------------------------------------
// Incidencias físicas de inventario (SPEC-015, OpenAPI IncidenciaInventario)
// ---------------------------------------------------------------------------

export type TipoIncidenciaInventario = 'DANIO' | 'NO_UBICADA' | 'OTRO_FISICO';

export type EstadoIncidenciaInventario =
  'ABIERTA' | 'RESUELTA' | 'TRASLADO_PENDIENTE';

export type ResolucionIncidenciaInventario =
  'REHABILITADO' | 'MERMA' | 'FALTANTE_CONFIRMADO' | 'TRASLADO_ALMACEN_CENTRAL';

export class CrearIncidenciaInventarioRequest {
  operation_id!: string;
  external_incident_id!: string;
  sku!: string;
  quantity!: number;
  location_id!: string;
  type!: TipoIncidenciaInventario;
  occurred_at!: string;
  actor_ref?: string | null;
}

export class ResolverIncidenciaInventarioRequest {
  operation_id!: string;
  resolution!: ResolucionIncidenciaInventario;
  act_ref!: string;
  target_location_id?: string | null;
  reason?: string | null;
}

export interface IncidenciaInventarioResponse {
  incidencia_id: string;
  operation_id: string;
  external_incident_id: string;
  sku: string;
  quantity: number;
  location_id: string;
  type: TipoIncidenciaInventario;
  estado: EstadoIncidenciaInventario;
  resolution?: ResolucionIncidenciaInventario | null;
  on_hand: number;
  reserved: number;
  blocked: number;
  available: number;
  stock_version: number;
  transfer_ref?: string | null;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Conciliación offline (SPEC-015, OpenAPI ConciliacionOffline)
// ---------------------------------------------------------------------------

export class ConciliacionOfflineRequest {
  operation_id!: string;
  order_id!: string;
  offline_sale_id!: string;
  channel_id!: 'RETAIL';
  occurred_at!: string;
  lines!: LineaInventarioUbicada[];
}

export interface ConciliacionOfflineLineaResultado {
  sku: string;
  location_id: string;
  requested_quantity: number;
  applied_quantity: number;
  unresolved_quantity: number;
  on_hand: number;
  reserved: number;
  blocked: number;
  available: number;
  stock_version: number;
}

export interface ConciliacionOfflineResponse {
  operation_id: string;
  order_id: string;
  offline_sale_id: string;
  status: 'COMPLETED' | 'REQUIRES_REVIEW';
  lines: ConciliacionOfflineLineaResultado[];
  completed_at: string;
}

// ---------------------------------------------------------------------------
// Traslados internos de inventario (SPEC-015, OpenAPI TrasladoInventario)
// ---------------------------------------------------------------------------

export type EstadoTrasladoInventario =
  | 'EN_TRANSITO'
  | 'RECIBIDO_PARCIAL'
  | 'COMPLETADO'
  | 'COMPLETADO_CON_DISCREPANCIA';

export type DisposicionRecepcionTraslado =
  'REINGRESAR_DISPONIBLE' | 'REINGRESAR_BLOQUEADO' | 'CONFIRMAR_MERMA';

export interface TrasladoInventario {
  traslado_id: string;
  source_incident_id?: string | null;
  sku: string;
  quantity_shipped: number;
  quantity_received: number;
  missing_quantity: number;
  source_location_id: string;
  target_location_id: string;
  estado: EstadoTrasladoInventario;
  created_at: string;
  updated_at: string;
}

export class RecepcionTrasladoInventarioRequest {
  operation_id!: string;
  received_quantity!: number;
  disposition!: DisposicionRecepcionTraslado;
  final_receipt!: boolean;
  received_at!: string;
  note?: string | null;
}

export interface RecepcionTrasladoInventarioResponse {
  receipt_id: string;
  operation_id: string;
  traslado: TrasladoInventario;
  disposition: DisposicionRecepcionTraslado;
  received_quantity: number;
  destination_balance?: DisponibilidadStock | null;
  completed_at: string;
}

export interface ListadoTrasladosInventario {
  items: TrasladoInventario[];
  pagina: number;
  tamanio: number;
  total: number;
}
