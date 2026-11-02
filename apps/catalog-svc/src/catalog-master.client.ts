import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  CATALOG_TAXONOMY_CONFIG,
  type TaxonomyConfig,
} from './taxonomy-config.js';
import type { Attribute } from './commercial.types.js';
import { catalogError, object } from './catalog-mutation.input.js';

@Injectable()
export class CatalogMasterClient {
  constructor(
    @Inject(CATALOG_TAXONOMY_CONFIG) private readonly config: TaxonomyConfig,
  ) {}
  private async get(
    path: string,
    authorization: string,
    correlationId: string,
  ): Promise<unknown> {
    try {
      if (!this.config.origin) throw new Error();
      const response = await fetch(new URL(path, this.config.origin), {
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
        headers: {
          ...(authorization ? { authorization } : {}),
          'x-correlation-id': correlationId,
          accept: 'application/json',
        },
      });
      if (response.status === 404) {
        await response.body?.cancel();
        return null;
      }
      if (
        response.status !== 200 ||
        response.headers.get('content-type')?.split(';')[0] !==
          'application/json'
      ) {
        await response.body?.cancel();
        throw new Error();
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 1024 * 1024) throw new Error();
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      throw new ServiceUnavailableException();
    }
  }
  async masters(
    product: {
      categoria_id: string;
      marca_id: string;
      tipo_producto_id: string;
    },
    authorization: string,
    correlationId: string,
  ): Promise<{ schemaVersion: number }> {
    for (const master of [
      {
        id: product.categoria_id,
        path: 'categorias',
        key: 'categoriaId',
        code: 'CATEGORIA_INVALIDA',
      },
      {
        id: product.marca_id,
        path: 'marcas',
        key: 'marcaId',
        code: 'MARCA_INVALIDA',
      },
    ]) {
      const value = await this.get(
        '/api/v1/' + master.path + '/' + encodeURIComponent(master.id),
        authorization,
        correlationId,
      );
      if (value === null || (object(value) && value.estado === 'INACTIVO'))
        catalogError(422, master.code);
      if (
        !object(value) ||
        value[master.key] !== master.id ||
        value.estado !== 'ACTIVO' ||
        typeof value.nombre !== 'string' ||
        !Number.isSafeInteger(value.version) ||
        (value.version as number) < 0
      )
        throw new ServiceUnavailableException();
    }
    const type = await this.get(
      '/api/v1/tipos-producto/' + encodeURIComponent(product.tipo_producto_id),
      authorization,
      correlationId,
    );
    if (type === null || (object(type) && type.estado === 'INACTIVO'))
      catalogError(422, 'TIPO_PRODUCTO_INVALIDO');
    if (
      !object(type) ||
      type.tipoProductoId !== product.tipo_producto_id ||
      type.estado !== 'ACTIVO' ||
      typeof type.nombre !== 'string' ||
      !Number.isSafeInteger(type.schemaVersion) ||
      (type.schemaVersion as number) < 0
    )
      throw new ServiceUnavailableException();
    return { schemaVersion: type.schemaVersion as number };
  }
  async attributes(
    typeId: string,
    values: readonly Attribute[],
    required: boolean,
    authorization: string,
    correlationId: string,
    expectedSchemaVersion?: number,
  ): Promise<Attribute[]> {
    const schema = await this.get(
      '/api/v1/tipos-producto/' +
        encodeURIComponent(typeId) +
        '/caracteristicas',
      authorization,
      correlationId,
    );
    if (schema === null) catalogError(422, 'TIPO_PRODUCTO_INVALIDO');
    if (
      !object(schema) ||
      !object(schema.tipoProducto) ||
      schema.tipoProducto.tipoProductoId !== typeId ||
      schema.tipoProducto.estado !== 'ACTIVO' ||
      !Number.isSafeInteger(schema.schemaVersion) ||
      (schema.schemaVersion as number) < 0 ||
      (expectedSchemaVersion !== undefined &&
        schema.schemaVersion !== expectedSchemaVersion) ||
      !Array.isArray(schema.caracteristicas) ||
      !schema.caracteristicas.every(object)
    )
      throw new ServiceUnavailableException();
    const associations = schema.caracteristicas;
    if (
      associations.some(
        (a) =>
          typeof a.caracteristicaId !== 'string' ||
          typeof a.obligatoria !== 'boolean' ||
          !Number.isSafeInteger(a.schemaVersion) ||
          (a.schemaVersion as number) < 0 ||
          !['ACTIVO', 'INACTIVO'].includes(String(a.estado)),
      )
    )
      throw new ServiceUnavailableException();
    if (
      new Set(associations.map((a) => a.caracteristicaId)).size !==
      associations.length
    )
      throw new ServiceUnavailableException();
    if (
      required &&
      associations.some(
        (a) =>
          a.estado === 'ACTIVO' &&
          a.obligatoria &&
          !values.some((v) => v.caracteristica_id === a.caracteristicaId),
      )
    )
      catalogError(422, 'DATOS_INCOMPLETOS');
    const result: Attribute[] = [];
    for (const value of values) {
      const association = associations.find(
        (a) =>
          a.caracteristicaId === value.caracteristica_id &&
          a.estado === 'ACTIVO',
      );
      if (!association) catalogError(422, 'ATRIBUTO_IDENTIFICADOR_INVALIDO');
      const characteristic =
        association.caracteristica ??
        (await this.get(
          '/api/v1/caracteristicas/' +
            encodeURIComponent(value.caracteristica_id),
          authorization,
          correlationId,
        ));
      if (
        !object(characteristic) ||
        characteristic.caracteristicaId !== value.caracteristica_id ||
        typeof characteristic.nombre !== 'string' ||
        characteristic.estado !== 'ACTIVO' ||
        !Number.isSafeInteger(characteristic.version) ||
        (characteristic.version as number) < 0 ||
        !['TEXTO', 'NUMERO', 'LISTA'].includes(String(characteristic.tipo))
      )
        throw new ServiceUnavailableException();
      if (
        (characteristic.tipo === 'NUMERO' &&
          (typeof value.valor !== 'number' || !Number.isFinite(value.valor))) ||
        (characteristic.tipo === 'TEXTO' && typeof value.valor !== 'string')
      )
        catalogError(422, 'ATRIBUTO_IDENTIFICADOR_INVALIDO');
      if (characteristic.tipo === 'LISTA') {
        const options =
          characteristic.valores ??
          (await this.get(
            '/api/v1/caracteristicas/' +
              encodeURIComponent(value.caracteristica_id) +
              '/valores',
            authorization,
            correlationId,
          ));
        if (
          !Array.isArray(options) ||
          !options.every(object) ||
          options.some(
            (o) =>
              typeof o.valorId !== 'string' ||
              typeof o.nombre !== 'string' ||
              !['ACTIVO', 'INACTIVO'].includes(String(o.estado)) ||
              !Number.isSafeInteger(o.version) ||
              (o.version as number) < 0,
          )
        )
          throw new ServiceUnavailableException();
        if (
          !value.valor_id ||
          !options.some(
            (o) => o.valorId === value.valor_id && o.estado === 'ACTIVO',
          )
        )
          catalogError(422, 'ATRIBUTO_IDENTIFICADOR_INVALIDO');
      } else if (value.valor_id !== null)
        catalogError(422, 'ATRIBUTO_IDENTIFICADOR_INVALIDO');
      result.push({ ...value, nombre: characteristic.nombre });
    }
    return result;
  }
}
