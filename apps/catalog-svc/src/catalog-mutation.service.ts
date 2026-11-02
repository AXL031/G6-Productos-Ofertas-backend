import {
  Inject,
  Injectable,
  Optional,
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import {
  assertMasterReferences,
  masterReferences,
} from './catalog-master-barriers.js';
import { CatalogTransactionManager } from './catalog-transaction.js';
import { PostgresCatalogWriteRepository } from './postgres-catalog-write.repository.js';
import { CatalogMasterClient } from './catalog-master.client.js';
import {
  activationChecks,
  outbox,
  productIdentifyingCharacteristics,
  products,
  variants,
} from './catalog.schema.js';
import type { CatalogTransaction } from './database.js';
import { CatalogPersistenceError } from './database-errors.js';
import {
  attribute,
  domainProfile,
  presentProduct,
  presentVariant,
  type CatalogAggregate,
  type CatalogChild,
} from './catalog-aggregate.js';
import {
  canActivateProduct,
  canActivateVariant,
  parentStatusAfterVariantDeactivation,
  type PreparationStatus,
} from './catalog-domain.js';
import {
  activeAttempt,
  envelope,
  manualRetryAllowed,
  preparationTimeout,
  CATALOG_PREPARATION_CONFIG,
  type CatalogPreparationConfig,
  UnresolvedCatalogAttempt,
  type CatalogEnvelope,
} from './catalog-messages.js';
import {
  catalogError,
  isUri,
  parseMutation,
  type MutationInput,
  type MutationKind,
} from './catalog-mutation.input.js';

export const CATALOG_PRODUCT_CREATION_POLICY = Symbol(
  'CATALOG_PRODUCT_CREATION_POLICY',
);
/** Pending contract choices are supplied only by an approved adapter, never inferred from extra DTO fields. */
export interface CatalogProductCreationPolicy {
  resolve(
    input: MutationInput,
    productId: string,
  ): Promise<{ slug: string; moneda: string }>;
}
type Action = 'activate' | 'deactivate' | 'reactivate';
type Actor = { authorization: string; correlationId: string };
@Injectable()
export class CatalogMutationService {
  constructor(
    private readonly transactions: CatalogTransactionManager,
    private readonly repository: PostgresCatalogWriteRepository,
    private readonly masters: CatalogMasterClient,
    @Optional()
    @Inject(CATALOG_PRODUCT_CREATION_POLICY)
    private readonly creationPolicy?: CatalogProductCreationPolicy,
    @Inject(CATALOG_PREPARATION_CONFIG)
    private readonly preparation: CatalogPreparationConfig = {
      timeoutMs: preparationTimeout(),
    },
  ) {}

  private async run<T>(
    kind:
      | MutationKind
      | 'activateProduct'
      | 'activateVariant'
      | 'deactivateVariant',
    work: (tx: CatalogTransaction) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.transactions.run(work);
    } catch (error) {
      if (error instanceof UnresolvedCatalogAttempt)
        throw new ServiceUnavailableException();
      if (error instanceof CatalogPersistenceError) {
        if (error.sqlState === '23505') {
          if (error.constraintName === 'uq_variants_product_combination')
            catalogError(409, 'COMBINACION_DUPLICADA');
          if (
            [
              'uq_sku_identity_sku',
              'uq_products_sku_base',
              'uq_variants_sku',
            ].includes(error.constraintName ?? '')
          )
            catalogError(409, 'SKU_DUPLICADO');
        }
        if (error.failure === 'serialization' || error.failure === 'deadlock')
          catalogError(409, 'VERSION_CONFLICT');
        if (
          ['check', 'deferred_constraint', 'foreign_key', 'not_null'].includes(
            error.failure,
          )
        ) {
          if (kind === 'activateProduct' || kind === 'activateVariant')
            catalogError(422, 'DATOS_INCOMPLETOS');
          if (kind === 'deactivateVariant') throw error;
          catalogError(400, 'VALIDACION');
        }
      }
      if (error instanceof HttpException) {
        const body = error.getResponse();
        const code =
          typeof body === 'object' && 'code' in body ? String(body.code) : '';
        const isVariant = kind.toLowerCase().includes('variant');
        if (kind === 'retryProduct' || kind === 'retryVariant') {
          if (error.getStatus() === 422 || error.getStatus() === 400)
            catalogError(409, 'PREPARACION_NO_REINTENTABLE');
        } else if (
          isVariant &&
          [
            'TIPO_PRODUCTO_INVALIDO',
            'CATEGORIA_INVALIDA',
            'MARCA_INVALIDA',
          ].includes(code)
        ) {
          catalogError(
            kind === 'updateVariant' ? 400 : 422,
            kind === 'updateVariant'
              ? 'VALIDACION'
              : 'ATRIBUTO_IDENTIFICADOR_INVALIDO',
          );
        } else if (
          (kind === 'updateProduct' ||
            kind === 'createProduct' ||
            kind === 'updateVariant') &&
          [
            'DATOS_INCOMPLETOS',
            'ATRIBUTO_IDENTIFICADOR_INVALIDO',
            'TIPO_PRODUCTO_INVALIDO',
          ].includes(code)
        ) {
          if (!(kind !== 'updateVariant' && code === 'TIPO_PRODUCTO_INVALIDO'))
            catalogError(400, 'VALIDACION');
        }
      }
      throw error;
    }
  }
  private async locked(
    tx: CatalogTransaction,
    productId: string,
    variantId?: string,
  ): Promise<CatalogAggregate> {
    const product = await this.repository.lockProduct(tx, productId);
    if (!product)
      catalogError(
        404,
        variantId ? 'VARIANTE_NO_ENCONTRADA' : 'PRODUCTO_NO_ENCONTRADO',
      );
    const aggregate = await this.repository.aggregate(tx, product);
    if (variantId && !aggregate.children.some((v) => v.id === variantId))
      catalogError(404, 'VARIANTE_NO_ENCONTRADA');
    return aggregate;
  }
  private child(aggregate: CatalogAggregate, id: string): CatalogChild {
    return aggregate.children.find((v) => v.id === id)!;
  }
  private assertVersion(actual: bigint, input: MutationInput): void {
    if (
      input.catalogVersion !== undefined &&
      BigInt(input.catalogVersion) !== actual
    )
      catalogError(409, 'VERSION_CONFLICT');
  }
  private async references(
    tx: CatalogTransaction,
    aggregate: Pick<
      CatalogAggregate,
      'categoria_id' | 'marca_id' | 'tipo_producto_id'
    >,
    values: readonly { caracteristica_id: string; valor_id: string | null }[],
  ): Promise<void> {
    await assertMasterReferences(tx, masterReferences(aggregate, values));
  }
  private async emit(
    tx: CatalogTransaction,
    message: CatalogEnvelope,
  ): Promise<void> {
    await this.repository.insertOutboxMessage(tx, {
      message_id: message.message_id,
      event_name: message.name,
      kind: message.kind,
      schema_version: message.schema_version,
      correlation_id: message.correlation_id,
      causation_id: message.causation_id,
      operation_id: message.operation_id,
      occurred_at: new Date(message.occurred_at),
      payload: message.data,
    });
  }
  private async prepare(
    tx: CatalogTransaction,
    productId: string,
    variantId: string | null,
    sku: string,
    dependency: 'PRICING' | 'INVENTORY',
    data: Record<string, unknown>,
    actor: Actor,
  ): Promise<void> {
    const operationId = randomUUID();
    await this.repository.insertActivationCheck(tx, {
      product_id: productId,
      variant_id: variantId,
      sku,
      dependency,
      operation_id: operationId,
      correlation_id: actor.correlationId,
      request_payload: data,
      state: 'PENDING',
    });
    await this.emit(
      tx,
      envelope(
        dependency === 'PRICING'
          ? 'pricing.product.initialization.requested'
          : 'inventory.sku.initialization.requested',
        data,
        actor.correlationId,
        operationId,
      ),
    );
  }
  private status(
    aggregate: CatalogAggregate,
    dependency: 'PRICING' | 'INVENTORY',
    sku: string,
  ): PreparationStatus {
    return (aggregate.checks.find(
      (c) => c.dependency === dependency && c.sku === sku,
    )?.state ?? 'PENDING') as PreparationStatus;
  }
  private async validate(
    aggregate: CatalogAggregate,
    actor: Actor,
    onlyVariant?: string,
  ): Promise<void> {
    await this.masters.masters(
      aggregate,
      actor.authorization,
      actor.correlationId,
    );
    const validateChild = async (child: CatalogChild) => {
      await this.masters.attributes(
        aggregate.tipo_producto_id,
        [...aggregate.attributes, ...child.attributes].map(attribute),
        true,
        actor.authorization,
        actor.correlationId,
      );
      return canActivateVariant(aggregate.tiene_variantes, {
        skuAndCombinationValid: child.sku.length > 0,
        attributesAndImageValid:
          child.attributes.some((a) => a.es_identificador) &&
          child.images.length > 0 &&
          child.images.every((i) => isUri(i.url)),
        physicalProfile: domainProfile(child.profile),
        inventoryStatus: this.status(aggregate, 'INVENTORY', child.sku),
      });
    };
    if (onlyVariant) {
      if (!(await validateChild(this.child(aggregate, onlyVariant))))
        catalogError(422, 'DATOS_INCOMPLETOS');
      return;
    }
    const active = aggregate.children.filter((c) => c.estado === 'ACTIVA');
    for (const child of active)
      if (!(await validateChild(child))) catalogError(422, 'DATOS_INCOMPLETOS');
    if (!aggregate.tiene_variantes)
      await this.masters.attributes(
        aggregate.tipo_producto_id,
        aggregate.attributes.map(attribute),
        true,
        actor.authorization,
        actor.correlationId,
      );
    if (
      !canActivateProduct({
        minimumDataValid: !!aggregate.nombre && !!aggregate.descripcion,
        mastersValid: true,
        requiredAttributesComplete: true,
        imageValid:
          aggregate.images.length > 0 &&
          aggregate.images.every((i) => isUri(i.url)),
        pricingStatus: this.status(aggregate, 'PRICING', aggregate.sku_base),
        hasVariants: aggregate.tiene_variantes,
        ...(aggregate.tiene_variantes
          ? {
              variants: active.map((c) => ({
                status: c.estado,
                skuAndCombinationValid: true,
                attributesAndImageValid: true,
                physicalProfile: domainProfile(c.profile),
                inventoryStatus: this.status(aggregate, 'INVENTORY', c.sku),
              })),
            }
          : {
              physicalProfile: domainProfile(aggregate.profile),
              inventoryStatus: this.status(
                aggregate,
                'INVENTORY',
                aggregate.sku_base,
              ),
            }),
      })
    )
      catalogError(422, 'DATOS_INCOMPLETOS');
  }

  async createProduct(body: unknown, actor: Actor) {
    const input = parseMutation(body, 'createProduct');
    if (!this.creationPolicy) throw new ServiceUnavailableException();
    const id = randomUUID(),
      context = await this.creationPolicy.resolve(input, id);
    if (!context.slug || !/^.{3}$/.test(context.moneda))
      throw new ServiceUnavailableException();
    return this.run('createProduct', async (tx) => {
      const fields = {
        nombre: input.nombre!,
        descripcion: input.descripcion!,
        categoria_id: input.categoriaId!,
        marca_id: input.marcaId!,
        tipo_producto_id: input.tipoProductoId!,
      };
      if (
        input.tieneVariantes &&
        input.perfilFisico !== undefined &&
        input.perfilFisico !== null
      )
        catalogError(422, 'PERFIL_FISICO_INVALIDO');
      await this.references(tx, fields, input.atributos ?? []);
      await this.masters.masters(
        fields,
        actor.authorization,
        actor.correlationId,
      );
      const attrs = await this.masters.attributes(
        fields.tipo_producto_id,
        input.atributos ?? [],
        false,
        actor.authorization,
        actor.correlationId,
      );
      const product = await this.repository.insertProduct(tx, {
        id,
        ...fields,
        sku_base: input.skuBase!,
        slug: context.slug,
        tiene_variantes: input.tieneVariantes!,
        estado: 'BORRADOR',
        publicado_alguna_vez: false,
      });
      if (!product) throw new Error('PRODUCT_INSERT_FAILED');
      await this.repository.replaceProductCollections(tx, id, {
        ...input,
        atributos: attrs,
      });
      if (input.perfilFisico !== undefined && !input.tieneVariantes)
        await this.repository.replaceProfile(
          tx,
          'product_id',
          id,
          input.perfilFisico,
        );
      await this.prepare(
        tx,
        id,
        null,
        input.skuBase!,
        'PRICING',
        {
          product_id: id,
          sku_base: input.skuBase!,
          precio_regular: input.precioBaseInicial!,
          moneda: context.moneda,
          channel_id: null,
          motivo_cambio: 'ALTA_PRODUCTO',
        },
        actor,
      );
      if (!input.tieneVariantes)
        await this.prepare(
          tx,
          id,
          null,
          input.skuBase!,
          'INVENTORY',
          { sku: input.skuBase!, product_id: id, variant_id: null },
          actor,
        );
      return presentProduct(await this.repository.aggregate(tx, product));
    });
  }
  async createVariant(productId: string, body: unknown, actor: Actor) {
    const input = parseMutation(body, 'createVariant');
    return this.run('createVariant', async (tx) => {
      const aggregate = await this.locked(tx, productId);
      if (!aggregate.tiene_variantes)
        catalogError(409, 'PRODUCTO_NO_ADMITE_VARIANTES');
      const id = randomUUID();
      const sku = input.sku!;
      const identifying = input.atributosIdentificadores!;
      const other = input.atributosNoIdentificadores ?? [];
      if (
        other.some((a) =>
          identifying.some((i) => i.caracteristica_id === a.caracteristica_id),
        )
      )
        catalogError(422, 'ATRIBUTO_IDENTIFICADOR_INVALIDO');
      await this.references(tx, aggregate, [...identifying, ...other]);
      await this.masters.masters(
        aggregate,
        actor.authorization,
        actor.correlationId,
      );
      const attrs = await this.masters.attributes(
        aggregate.tipo_producto_id,
        [...identifying, ...other],
        false,
        actor.authorization,
        actor.correlationId,
      );
      const selected = await tx
        .select()
        .from(productIdentifyingCharacteristics)
        .where(eq(productIdentifyingCharacteristics.product_id, aggregate.id));
      if (
        selected.length &&
        (selected.length !== identifying.length ||
          selected.some(
            (s) =>
              !identifying.some(
                (a) => a.caracteristica_id === s.caracteristica_id,
              ),
          ))
      )
        catalogError(422, 'ATRIBUTO_IDENTIFICADOR_INVALIDO');
      if (
        aggregate.children.some((c) => {
          const keys = c.attributes
            .filter((a) => a.es_identificador)
            .map((a) => a.caracteristica_id);
          return (
            keys.length !== identifying.length ||
            keys.some(
              (k) => !identifying.some((a) => a.caracteristica_id === k),
            )
          );
        })
      )
        catalogError(422, 'ATRIBUTO_IDENTIFICADOR_INVALIDO');
      if (!selected.length)
        for (const a of identifying)
          await this.repository.insertIdentifyingCharacteristic(tx, {
            product_id: aggregate.id,
            caracteristica_id: a.caracteristica_id,
          });
      const key = Object.fromEntries(
        identifying.map((a) => [
          a.caracteristica_id,
          a.valor_id !== null ? { valor_id: a.valor_id } : { valor: a.valor },
        ]),
      );
      await this.repository.insertVariant(tx, {
        id,
        product_id: aggregate.id,
        sku,
        identifying_key: key,
        estado: 'BORRADOR',
      });
      for (const a of attrs)
        await this.repository.insertVariantAttribute(tx, {
          variant_id: id,
          caracteristica_id: a.caracteristica_id,
          nombre_snapshot: a.nombre,
          valor_id: a.valor_id,
          valor: a.valor,
          es_identificador: identifying.some(
            (i) => i.caracteristica_id === a.caracteristica_id,
          ),
        });
      await this.repository.replaceVariantCollections(tx, id, {
        imagenUrl: input.imagenUrl,
      });
      if (input.perfilFisico !== undefined)
        await this.repository.replaceProfile(
          tx,
          'variant_id',
          id,
          input.perfilFisico,
        );
      await this.prepare(
        tx,
        aggregate.id,
        id,
        sku,
        'INVENTORY',
        { sku, product_id: aggregate.id, variant_id: id },
        actor,
      );
      const [parent] = await tx
        .update(products)
        .set({ nombre: aggregate.nombre })
        .where(eq(products.id, aggregate.id))
        .returning();
      return presentVariant(
        this.child(await this.repository.aggregate(tx, parent!), id),
      );
    });
  }
  async update(
    productId: string,
    variantId: string | undefined,
    body: unknown,
    actor: Actor,
  ) {
    const kind = variantId ? 'updateVariant' : 'updateProduct',
      input = parseMutation(body, kind);
    return this.run(kind, async (tx) => {
      const aggregate = await this.locked(tx, productId, variantId),
        child = variantId ? this.child(aggregate, variantId) : undefined;
      this.assertVersion(
        child?.catalog_version ?? aggregate.catalog_version,
        input,
      );
      const changingType =
        !child &&
        input.tipoProductoId !== undefined &&
        input.tipoProductoId !== aggregate.tipo_producto_id;
      if (changingType) {
        if (
          aggregate.estado !== 'BORRADOR' ||
          aggregate.tiene_variantes ||
          aggregate.children.length !== 0 ||
          aggregate.publicado_alguna_vez !== false
        )
          catalogError(409, 'CAMBIO_ESTRUCTURAL_NO_PERMITIDO');
        if (input.catalogVersion === undefined) catalogError(400, 'VALIDACION');
      }
      const attributes =
        input.atributos ??
        input.atributosNoIdentificadores ??
        (changingType ? aggregate.attributes.map(attribute) : undefined);
      const refs = {
        ...aggregate,
        categoria_id: input.categoriaId ?? aggregate.categoria_id,
        marca_id: input.marcaId ?? aggregate.marca_id,
        tipo_producto_id: input.tipoProductoId ?? aggregate.tipo_producto_id,
      };
      const finalReferences = masterReferences(refs, [
        ...(attributes ?? aggregate.attributes),
        ...aggregate.children.flatMap((c) => c.attributes),
      ]);
      const previousReferences = masterReferences(aggregate, [
        ...aggregate.attributes,
        ...aggregate.children.flatMap((c) => c.attributes),
      ]);
      const introducedReferences = finalReferences.filter(
        (r) =>
          !previousReferences.some(
            (old) => old.type === r.type && old.id === r.id,
          ),
      );
      const oldAttributes = child?.attributes ?? aggregate.attributes;
      if (
        attributes?.some(
          (a) =>
            !oldAttributes.some(
              (old) => old.caracteristica_id === a.caracteristica_id,
            ),
        )
      )
        introducedReferences.push({
          type: 'PRODUCT_TYPE',
          id: refs.tipo_producto_id,
          characteristicIds: attributes
            .filter(
              (a) =>
                !oldAttributes.some(
                  (old) => old.caracteristica_id === a.caracteristica_id,
                ),
            )
            .map((a) => a.caracteristica_id),
        });
      await assertMasterReferences(tx, introducedReferences);
      const schema = await this.masters.masters(
        refs,
        actor.authorization,
        actor.correlationId,
      );
      const canonicalAttrs =
        attributes === undefined
          ? undefined
          : await this.masters.attributes(
              refs.tipo_producto_id,
              attributes,
              false,
              actor.authorization,
              actor.correlationId,
              changingType ? schema?.schemaVersion : undefined,
            );
      if (child) {
        if (
          canonicalAttrs?.some((a) =>
            child.attributes.some(
              (i) =>
                i.es_identificador &&
                i.caracteristica_id === a.caracteristica_id,
            ),
          )
        )
          catalogError(409, 'CAMBIO_ESTRUCTURAL_NO_PERMITIDO');
        await this.repository.replaceVariantCollections(tx, child.id, {
          ...input,
          atributosNoIdentificadores: canonicalAttrs,
        });
        if (input.perfilFisico !== undefined)
          await this.repository.replaceProfile(
            tx,
            'variant_id',
            child.id,
            input.perfilFisico,
          );
        await tx
          .update(variants)
          .set({ estado: child.estado })
          .where(eq(variants.id, child.id));
      } else {
        if (
          aggregate.tiene_variantes &&
          input.perfilFisico !== undefined &&
          input.perfilFisico !== null
        )
          catalogError(422, 'PERFIL_FISICO_INVALIDO');
        await this.repository.replaceProductCollections(tx, aggregate.id, {
          ...input,
          atributos: canonicalAttrs,
        });
        if (input.perfilFisico !== undefined && !aggregate.tiene_variantes)
          await this.repository.replaceProfile(
            tx,
            'product_id',
            aggregate.id,
            input.perfilFisico,
          );
      }
      const [parent] = await tx
        .update(products)
        .set({
          nombre: input.nombre ?? aggregate.nombre,
          descripcion: input.descripcion ?? aggregate.descripcion,
          categoria_id: refs.categoria_id,
          marca_id: refs.marca_id,
          tipo_producto_id: refs.tipo_producto_id,
        })
        .where(eq(products.id, aggregate.id))
        .returning();
      const final = await this.repository.aggregate(tx, parent!);
      if (child?.estado === 'ACTIVA')
        await this.validate(final, actor, child.id);
      if (final.estado === 'ACTIVO') await this.validate(final, actor);
      return variantId
        ? presentVariant(this.child(final, variantId))
        : presentProduct(final);
    });
  }
  async state(
    productId: string,
    variantId: string | undefined,
    action: Action,
    body: unknown,
    actor: Actor,
  ) {
    const input = parseMutation(variantId ? {} : body, 'state');
    return this.run(
      action === 'deactivate'
        ? variantId
          ? 'deactivateVariant'
          : 'state'
        : variantId
          ? 'activateVariant'
          : 'activateProduct',
      async (tx) => {
        const aggregate = await this.locked(tx, productId, variantId),
          child = variantId ? this.child(aggregate, variantId) : undefined;
        this.assertVersion(
          child?.catalog_version ?? aggregate.catalog_version,
          input,
        );
        const current = child?.estado ?? aggregate.estado;
        if (
          (action === 'deactivate' &&
            ['INACTIVO', 'INACTIVA'].includes(current)) ||
          (action !== 'deactivate' && ['ACTIVO', 'ACTIVA'].includes(current))
        ) {
          if (action !== 'deactivate') {
            await this.references(tx, aggregate, [
              ...aggregate.attributes,
              ...aggregate.children.flatMap((c) => c.attributes),
            ]);
            await this.validate(aggregate, actor, variantId);
          }
          return child ? presentVariant(child) : presentProduct(aggregate);
        }
        if (action !== 'deactivate') {
          if (
            (action === 'reactivate' && current === 'BORRADOR') ||
            (action === 'activate' &&
              ['INACTIVO', 'INACTIVA'].includes(current))
          )
            catalogError(422, 'DATOS_INCOMPLETOS');
          await this.references(tx, aggregate, [
            ...aggregate.attributes,
            ...aggregate.children.flatMap((c) => c.attributes),
          ]);
          await this.validate(aggregate, actor, variantId);
        }
        let parentState = aggregate.estado;
        if (child) {
          await tx
            .update(variants)
            .set({ estado: action === 'deactivate' ? 'INACTIVA' : 'ACTIVA' })
            .where(eq(variants.id, child.id));
          if (action === 'deactivate') {
            await this.emit(
              tx,
              envelope(
                'catalog.sku.deactivated',
                {
                  product_id: aggregate.id,
                  variant_id: child.id,
                  sku: child.sku,
                },
                actor.correlationId,
                randomUUID(),
              ),
            );
            parentState = parentStatusAfterVariantDeactivation(
              aggregate.estado,
              aggregate.children.filter(
                (c) => c.id !== child.id && c.estado === 'ACTIVA',
              ).length,
            );
            if (parentState !== aggregate.estado)
              await this.emit(
                tx,
                envelope(
                  'catalog.product.deactivated',
                  { product_id: aggregate.id },
                  actor.correlationId,
                  randomUUID(),
                ),
              );
          }
        } else {
          parentState = action === 'deactivate' ? 'INACTIVO' : 'ACTIVO';
          if (action === 'deactivate')
            await this.emit(
              tx,
              envelope(
                'catalog.product.deactivated',
                {
                  product_id: aggregate.id,
                  ...(input.motivo !== undefined
                    ? { motivo: input.motivo }
                    : {}),
                },
                actor.correlationId,
                randomUUID(),
              ),
            );
        }
        const [parent] = await tx
          .update(products)
          .set({ estado: parentState })
          .where(eq(products.id, aggregate.id))
          .returning();
        const final = await this.repository.aggregate(tx, parent!);
        return child
          ? presentVariant(this.child(final, child.id))
          : presentProduct(final);
      },
    );
  }
  async retry(
    productId: string,
    variantId: string | undefined,
    body: unknown,
    actor: Actor,
  ) {
    const kind = variantId ? 'retryVariant' : 'retryProduct',
      input = parseMutation(body, kind);
    return this.run(kind, async (tx) => {
      const aggregate = await this.locked(tx, productId, variantId),
        child = variantId ? this.child(aggregate, variantId) : undefined;
      const dependency =
        child || input.dependencia === 'INVENTARIO' ? 'INVENTORY' : 'PRICING';
      if (dependency === 'INVENTORY' && !child && aggregate.tiene_variantes)
        catalogError(409, 'PREPARACION_NO_REINTENTABLE');
      const check = aggregate.checks.find(
        (c) =>
          c.dependency === dependency &&
          c.sku === (child?.sku ?? aggregate.sku_base),
      );
      if (
        !check ||
        check.state !== 'PENDING' ||
        this.preparation.timeoutMs === undefined
      )
        catalogError(409, 'PREPARACION_NO_REINTENTABLE');
      const name =
        dependency === 'PRICING'
          ? 'pricing.product.initialization.requested'
          : 'inventory.sku.initialization.requested';
      const attempts = await tx
        .select()
        .from(outbox)
        .where(
          and(
            eq(outbox.operation_id, check.operation_id),
            eq(outbox.event_name, name),
          ),
        )
        .orderBy(asc(outbox.id));
      const active = activeAttempt(attempts);
      if (!manualRetryAllowed(check.state, active, this.preparation.timeoutMs))
        catalogError(409, 'PREPARACION_NO_REINTENTABLE');
      await this.references(tx, aggregate, [
        ...aggregate.attributes,
        ...(child?.attributes ?? []),
      ]);
      await this.masters.masters(
        aggregate,
        actor.authorization,
        actor.correlationId,
      );
      await this.masters.attributes(
        aggregate.tipo_producto_id,
        [...aggregate.attributes, ...(child?.attributes ?? [])].map(attribute),
        false,
        actor.authorization,
        actor.correlationId,
      );
      const data: Record<string, unknown> =
        dependency === 'PRICING'
          ? {
              product_id: aggregate.id,
              sku_base: aggregate.sku_base,
              precio_regular: check.request_payload.precio_regular,
              moneda: check.request_payload.moneda,
              channel_id: null,
              motivo_cambio: 'ALTA_PRODUCTO',
            }
          : {
              sku: child?.sku ?? aggregate.sku_base,
              product_id: aggregate.id,
              variant_id: child?.id ?? null,
              ...(check.request_payload.default_location_id !== undefined
                ? {
                    default_location_id:
                      check.request_payload.default_location_id,
                  }
                : {}),
            };
      // The immutable monetary/location intent is reused; mutable identity data comes from the locked aggregate.
      await tx
        .update(activationChecks)
        .set({
          state: 'PENDING',
          result_payload: null,
          result_message_id: null,
          correlation_id: actor.correlationId,
        })
        .where(eq(activationChecks.id, check.id));
      await this.emit(
        tx,
        envelope(
          name,
          data,
          actor.correlationId,
          check.operation_id,
          active!.message_id,
        ),
      );
      return {
        operation_id: check.operation_id,
        status: 'ACCEPTED' as const,
        correlation_id: actor.correlationId,
      };
    });
  }
}
