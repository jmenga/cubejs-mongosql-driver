// Cube model for the `product_catalog` collection — the filter-operator
// matrix harness (Gap 4). See `tests/integration/fixtures/seed-data.js`
// for the seed.
//
// **Model-directory scope.** This file lives in `examples/docker/cube/model/`
// (used by the cube-e2e atlas-local setup). The atlas-sql variant under
// `examples/docker/cube/model-atlas-sql/` is a separate, smaller catalog
// pointing at the live Atlas SQL endpoint — do not edit there without
// updating this one too.
//
// The cube-e2e test (tests/cube-e2e/cube-e2e.test.ts → "Standard filter-
// operator matrix") exercises every documented Cube filter operator
// (`contains`, `notContains`, `startsWith`, `notStartsWith`, `endsWith`,
// `notEndsWith`, `equals` multi-value) plus special-character payloads
// (`%`, `_`, regex metachars) against `product_catalog.name`. Pinned row
// counts in the test rely on the seed being stable: 8 products with
// distinct prefixes/suffixes.
//
// Why a dedicated collection: orders/revenue_events fields have only
// 2-3 distinct values (paid/pending/refunded; subscription/usage) which
// can't pin every operator's wildcard semantics without ambiguity (e.g.
// `startsWith('p')` would tie 'paid' vs 'pending'). product_catalog has
// 8 distinct values across 3 categories — enough to express each
// operator's positive AND negative cases unambiguously.
cube('product_catalog', {
  sql_table: 'product_catalog',

  measures: {
    count: { type: 'count' },
  },

  dimensions: {
    id: {
      sql: 'id',
      type: 'string',
      primary_key: true,
    },
    name: {
      sql: 'name',
      type: 'string',
    },
    category: {
      sql: 'category',
      type: 'string',
    },
  },
});
