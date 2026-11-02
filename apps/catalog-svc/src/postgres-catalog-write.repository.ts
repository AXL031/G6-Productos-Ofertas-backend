import { Injectable } from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { CatalogTransaction } from './database.js';
import {
  activationChecks,
  inbox,
  masterBarriers,
  outbox,
  productAttributes,
  productIdentifyingCharacteristics,
  productImages,
  products,
  skuIdentity,
  skuPhysicalProfiles,
  variantAttributes,
  variantImages,
  variants,
} from './catalog.schema.js';

/** SQL repository methods for use inside a CatalogTransactionManager boundary. */
@Injectable()
export class PostgresCatalogWriteRepository {
  async lockProduct(tx: CatalogTransaction, productId: string) {
    const [row] = await tx
      .select()
      .from(products)
      .where(sql`${products.id}::text = ${productId}`)
      .for('update');
    return row ?? null;
  }

  async aggregate(
    tx: CatalogTransaction,
    product: typeof products.$inferSelect,
  ) {
    const children = await tx
      .select()
      .from(variants)
      .where(eq(variants.product_id, product.id))
      .orderBy(asc(variants.id))
      .for('update');
    const attributes = await tx
      .select()
      .from(productAttributes)
      .where(eq(productAttributes.product_id, product.id));
    const images = await tx
      .select()
      .from(productImages)
      .where(eq(productImages.product_id, product.id))
      .orderBy(asc(productImages.posicion), asc(productImages.id));
    const profiles = async (
      column: 'product_id' | 'variant_id',
      id: string,
    ) => {
      const [profile] = await tx
        .select({
          pesoKg: skuPhysicalProfiles.peso_kg,
          largo: skuPhysicalProfiles.largo_cm,
          ancho: skuPhysicalProfiles.ancho_cm,
          alto: skuPhysicalProfiles.alto_cm,
          updatedAt: skuPhysicalProfiles.updated_at,
        })
        .from(skuIdentity)
        .innerJoin(
          skuPhysicalProfiles,
          eq(skuIdentity.id, skuPhysicalProfiles.sku_identity_id),
        )
        .where(eq(skuIdentity[column], id));
      return profile ?? null;
    };
    const checks = await tx
      .select()
      .from(activationChecks)
      .where(eq(activationChecks.product_id, product.id))
      .orderBy(asc(activationChecks.id))
      .for('update');
    const childData = [];
    for (const child of children)
      childData.push({
        ...child,
        attributes: await tx
          .select()
          .from(variantAttributes)
          .where(eq(variantAttributes.variant_id, child.id)),
        images: await tx
          .select()
          .from(variantImages)
          .where(eq(variantImages.variant_id, child.id))
          .orderBy(asc(variantImages.posicion), asc(variantImages.id)),
        profile: await profiles('variant_id', child.id),
      });
    return {
      ...product,
      attributes,
      images,
      profile: await profiles('product_id', product.id),
      checks,
      children: childData,
    };
  }

  async replaceProductCollections(
    tx: CatalogTransaction,
    id: string,
    input: import('./catalog-mutation.input.js').MutationInput,
  ) {
    if (input.atributos !== undefined) {
      await tx
        .delete(productAttributes)
        .where(eq(productAttributes.product_id, id));
      for (const a of input.atributos)
        await this.insertProductAttribute(tx, {
          product_id: id,
          caracteristica_id: a.caracteristica_id,
          nombre_snapshot: a.nombre,
          valor_id: a.valor_id,
          valor: a.valor,
        });
    }
    if (input.imagenes !== undefined) {
      await tx.delete(productImages).where(eq(productImages.product_id, id));
      for (const [posicion, image] of input.imagenes.entries())
        await this.insertProductImage(tx, {
          product_id: id,
          posicion,
          ...image,
        });
    }
  }
  async replaceVariantCollections(
    tx: CatalogTransaction,
    id: string,
    input: import('./catalog-mutation.input.js').MutationInput,
  ) {
    if (input.atributosNoIdentificadores !== undefined) {
      await tx
        .delete(variantAttributes)
        .where(
          and(
            eq(variantAttributes.variant_id, id),
            eq(variantAttributes.es_identificador, false),
          ),
        );
      for (const a of input.atributosNoIdentificadores)
        await this.insertVariantAttribute(tx, {
          variant_id: id,
          caracteristica_id: a.caracteristica_id,
          nombre_snapshot: a.nombre,
          valor_id: a.valor_id,
          valor: a.valor,
          es_identificador: false,
        });
    }
    if (input.imagenUrl !== undefined) {
      await tx.delete(variantImages).where(eq(variantImages.variant_id, id));
      await this.insertVariantImage(tx, {
        variant_id: id,
        url: input.imagenUrl,
        posicion: 0,
      });
    }
  }
  async replaceProfile(
    tx: CatalogTransaction,
    column: 'product_id' | 'variant_id',
    id: string,
    profile: import('./catalog-domain.js').PhysicalProfile | null,
  ) {
    const [identity] = await tx
      .select()
      .from(skuIdentity)
      .where(eq(skuIdentity[column], id));
    if (!identity) throw new Error('MISSING_SKU_IDENTITY');
    await tx
      .delete(skuPhysicalProfiles)
      .where(eq(skuPhysicalProfiles.sku_identity_id, identity.id));
    if (profile !== null)
      await this.insertPhysicalProfile(tx, {
        sku_identity_id: identity.id,
        peso_kg: profile.pesoKg == null ? null : String(profile.pesoKg),
        largo_cm:
          profile.dimensionesCm?.largo == null
            ? null
            : String(profile.dimensionesCm.largo),
        ancho_cm:
          profile.dimensionesCm?.ancho == null
            ? null
            : String(profile.dimensionesCm.ancho),
        alto_cm:
          profile.dimensionesCm?.alto == null
            ? null
            : String(profile.dimensionesCm.alto),
      });
  }

  async insertProduct(
    tx: CatalogTransaction,
    values: typeof products.$inferInsert,
  ) {
    const [row] = await tx.insert(products).values(values).returning();
    return row;
  }

  async insertVariant(
    tx: CatalogTransaction,
    values: typeof variants.$inferInsert,
  ) {
    const [row] = await tx.insert(variants).values(values).returning();
    return row;
  }

  async findSkuIdentity(tx: CatalogTransaction, sku: string) {
    const [row] = await tx
      .select()
      .from(skuIdentity)
      .where(eq(skuIdentity.sku, sku))
      .limit(1);
    return row ?? null;
  }

  async insertProductImage(
    tx: CatalogTransaction,
    values: typeof productImages.$inferInsert,
  ) {
    const [row] = await tx.insert(productImages).values(values).returning();
    return row;
  }

  async insertVariantImage(
    tx: CatalogTransaction,
    values: typeof variantImages.$inferInsert,
  ) {
    const [row] = await tx.insert(variantImages).values(values).returning();
    return row;
  }

  async insertProductAttribute(
    tx: CatalogTransaction,
    values: typeof productAttributes.$inferInsert,
  ) {
    const [row] = await tx.insert(productAttributes).values(values).returning();
    return row;
  }

  async insertVariantAttribute(
    tx: CatalogTransaction,
    values: typeof variantAttributes.$inferInsert,
  ) {
    const [row] = await tx.insert(variantAttributes).values(values).returning();
    return row;
  }

  async insertIdentifyingCharacteristic(
    tx: CatalogTransaction,
    values: typeof productIdentifyingCharacteristics.$inferInsert,
  ) {
    const [row] = await tx
      .insert(productIdentifyingCharacteristics)
      .values(values)
      .returning();
    return row;
  }

  async insertPhysicalProfile(
    tx: CatalogTransaction,
    values: typeof skuPhysicalProfiles.$inferInsert,
  ) {
    const [row] = await tx
      .insert(skuPhysicalProfiles)
      .values(values)
      .returning();
    return row;
  }

  async insertActivationCheck(
    tx: CatalogTransaction,
    values: typeof activationChecks.$inferInsert,
  ) {
    const [row] = await tx.insert(activationChecks).values(values).returning();
    return row;
  }

  async insertMasterBarrier(
    tx: CatalogTransaction,
    values: typeof masterBarriers.$inferInsert,
  ) {
    const [row] = await tx.insert(masterBarriers).values(values).returning();
    return row;
  }

  async insertOutboxMessage(
    tx: CatalogTransaction,
    values: typeof outbox.$inferInsert,
  ) {
    const [row] = await tx.insert(outbox).values(values).returning();
    return row;
  }

  async insertInboxMessage(
    tx: CatalogTransaction,
    values: typeof inbox.$inferInsert,
  ) {
    const [row] = await tx.insert(inbox).values(values).returning();
    return row;
  }
}
