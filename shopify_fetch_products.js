/*
  Fetch ACTIVE Shopify products that contain tag "7775",
  then return variant IDs and supplier info for each product.

  Usage (PowerShell):
    $env:SHOP = "behope-ca"
    $env:ACCESS_TOKEN = "<your_admin_api_access_token>"
    node .\shopify_fetch_products.js

  Optional env vars:
    API_VERSION=2025-10
    TAG=7775
    PRODUCT_SUPPLIER_METAFIELD_NAMESPACE=custom
    PRODUCT_SUPPLIER_METAFIELD_KEY=supplier_id
    VARIANT_SUPPLIER_METAFIELD_NAMESPACE=custom
    VARIANT_SUPPLIER_METAFIELD_KEY=supplierid
    OUTPUT_FILE=shopify_products.json
*/

const fs = require("fs");
const path = require("path");

function loadDotEnv() {
  const envPath = path.join(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;

  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIndex = trimmed.indexOf("=");
    if (eqIndex < 1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadDotEnv();

const SHOP = process.env.SHOP || "behope-ca";
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const API_VERSION = process.env.API_VERSION || "2025-10";
const TAG = process.env.TAG || "7775";
const PRODUCT_SUPPLIER_METAFIELD_NAMESPACE =
  process.env.PRODUCT_SUPPLIER_METAFIELD_NAMESPACE || "custom";
const PRODUCT_SUPPLIER_METAFIELD_KEY =
  process.env.PRODUCT_SUPPLIER_METAFIELD_KEY || "supplier_id";
const VARIANT_SUPPLIER_METAFIELD_NAMESPACE =
  process.env.VARIANT_SUPPLIER_METAFIELD_NAMESPACE || "custom";
const VARIANT_SUPPLIER_METAFIELD_KEY =
  process.env.VARIANT_SUPPLIER_METAFIELD_KEY || "supplierid";
const OUTPUT_FILE = process.env.OUTPUT_FILE || "shopify_products.json";

if (!ACCESS_TOKEN) {
  console.error("Missing ACCESS_TOKEN environment variable.");
  process.exit(1);
}

const endpoint = `https://${SHOP}.myshopify.com/admin/api/${API_VERSION}/graphql.json`;

const query = `
  query GetProducts(
    $first: Int!,
    $after: String,
    $searchQuery: String!,
    $productSupplierNs: String!,
    $productSupplierKey: String!,
    $variantSupplierNs: String!,
    $variantSupplierKey: String!
  ) {
    products(first: $first, after: $after, query: $searchQuery) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        node {
          id
          title
          status
          tags
          vendor
          metafield(namespace: $productSupplierNs, key: $productSupplierKey) {
            value
          }
          variants(first: 250) {
            edges {
              node {
                id
                price
                metafield(namespace: $variantSupplierNs, key: $variantSupplierKey) {
                  value
                }
              }
            }
          }
        }
      }
    }
  }
`;

async function shopifyGraphQL(variables) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }

  const payload = await res.json();

  if (payload.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(payload.errors, null, 2)}`);
  }

  return payload.data;
}

async function fetchAllMatchingProducts() {
  const results = [];

  let hasNextPage = true;
  let after = null;

  // Shopify query syntax: filter to ACTIVE products containing exact tag value.
  const searchQuery = `status:active tag:${TAG}`;

  while (hasNextPage) {
    const data = await shopifyGraphQL({
      first: 100,
      after,
      searchQuery,
      productSupplierNs: PRODUCT_SUPPLIER_METAFIELD_NAMESPACE,
      productSupplierKey: PRODUCT_SUPPLIER_METAFIELD_KEY,
      variantSupplierNs: VARIANT_SUPPLIER_METAFIELD_NAMESPACE,
      variantSupplierKey: VARIANT_SUPPLIER_METAFIELD_KEY,
    });

    const products = data.products;

    for (const edge of products.edges) {
      const product = edge.node;

      // Safety check in case search syntax behavior changes.
      const hasTag = Array.isArray(product.tags) && product.tags.includes(TAG);
      const isActive = product.status === "ACTIVE";
      if (!hasTag || !isActive) continue;

      const variants = product.variants.edges.map((v) => ({
        id: v.node.id,
        price: v.node.price,
        supplierId: v.node.metafield?.value || null,
      }));
      const variantIds = variants.map((v) => v.id);
      const supplierIds = [...new Set(variants.map((v) => v.supplierId).filter(Boolean))];
      const fallbackProductSupplierId = product.metafield?.value || null;
      const supplierId = supplierIds[0] || fallbackProductSupplierId;

      results.push({
        productId: product.id,
        title: product.title,
        supplierId,
        supplierIds,
        vendor: product.vendor || null,
        variants,
        variantIds,
      });
    }

    hasNextPage = products.pageInfo.hasNextPage;
    after = products.pageInfo.endCursor;
  }

  return results;
}

(async () => {
  try {
    const products = await fetchAllMatchingProducts();
    const outputPath = path.join(process.cwd(), OUTPUT_FILE);

    // Write only the JSON list (array of product objects) as requested.
    fs.writeFileSync(outputPath, JSON.stringify(products, null, 2), "utf8");

    console.log(`Saved ${products.length} products to ${outputPath}`);
  } catch (err) {
    console.error("Failed to fetch products:", err.message || err);
    process.exit(1);
  }
})();
