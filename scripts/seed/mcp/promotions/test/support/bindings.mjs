import { createHash } from 'node:crypto';

// Test references exist only in memory and in the disposable PostgreSQL suite.
// They are never published as Catalog/Pricing evidence or registered as seeds.
export function isolatedBindings() {
  const products = [
    'running-shoe',
    'training-shirt',
    'running-socks',
    'football',
    'training-cone',
  ].map((name) => ({
    product_id: `TEST_ONLY_${name}`,
    state: 'ACTIVO',
    has_variants: true,
    active: true,
  }));
  const skus = products.map((p) => ({
    sku: `${p.product_id}_SKU`,
    product_id: p.product_id,
    state: 'ACTIVA',
    active: true,
    channels: ['MARKETPLACE', 'CHATBOT', 'RETAIL'],
  }));
  const prices = skus.map((s, index) => ({
    sku: s.sku,
    channel_id: null,
    currency: 'PEN',
    amount: String(100 + index),
    valid_from: '2026-11-01T05:00:00Z',
    valid_until: '2026-12-01T05:00:00Z',
  }));
  const source = (name, rows) => ({
    reference: `test-only:${name}`,
    sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
  });
  return {
    version: 1,
    issue: 15,
    purpose: 'ISOLATED_TEST',
    catalog: { source: source('catalog', { products, skus }), products, skus },
    pricing: { source: source('pricing', prices), prices },
    review: {
      reviewer: 'isolated-test',
      evidence: 'test-only:synthetic-sports-scenario',
    },
    campaign_scopes: [
      {
        promotion_id: '6d86380f-5f55-4b9f-9bc4-5e3cf2bfc901',
        skus: [skus[0].sku],
      },
      {
        promotion_id: '6d86380f-5f55-4b9f-9bc4-5e3cf2bfc902',
        skus: [skus[1].sku],
      },
    ],
    recommendations: [
      {
        origin_product_id: products[0].product_id,
        candidate_product_ids: [products[2].product_id],
      },
      {
        origin_product_id: products[3].product_id,
        candidate_product_ids: [products[4].product_id],
      },
    ],
  };
}
