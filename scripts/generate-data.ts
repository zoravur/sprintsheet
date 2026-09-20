/**
 * Generates the CSVs that back the demo "test databases" (see
 * `src/lib/databases.ts`). Everything is seeded, so re-running is a no-op diff.
 *
 *   test.csv      -> relation `test`     (single-relation database)
 *   products.csv  -> relation `products` ┐
 *   sales.csv     -> relation `sales`    ┘ two-relation database
 *
 * Run with: `bun run scripts/generate-data.ts`
 */

import path from "node:path";

import { createOrders } from "../src/components/datagrid/sample";

const dataDir = path.join(import.meta.dir, "..", "src", "data");

/** Mulberry32 — tiny, fast, deterministic. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function toCell(value: unknown): string {
  const text = value instanceof Date ? value.toISOString() : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function toCsv(headers: readonly string[], rows: readonly unknown[][]): string {
  const lines = [headers.join(",")];
  for (const row of rows) lines.push(row.map(toCell).join(","));
  return `${lines.join("\n")}\n`;
}

async function write(file: string, contents: string): Promise<void> {
  await Bun.write(path.join(dataDir, file), contents);
  console.log(`Wrote ${file} (${contents.length.toLocaleString()} bytes)`);
}

// ---- relation `test`: the original spread of order rows --------------------
const orderHeaders = [
  "id",
  "customer",
  "region",
  "rep",
  "channel",
  "units",
  "unitPrice",
  "cost",
  "status",
  "rush",
  "orderedAt",
] as const;

const orderRows = createOrders(5_000).map((row) => orderHeaders.map((header) => row[header]));

// ---- two-relation database: `products` 1───* `sales` -----------------------
const PRODUCT_WORDS = ["Aurora", "Cobalt", "Ember", "Harbor", "Lumen", "Nimbus", "Onyx", "Pebble", "Quartz", "Verde"];
const PRODUCT_NOUNS = ["Lamp", "Mug", "Kettle", "Chair", "Desk", "Rug", "Vase", "Clock", "Planter", "Stool"];
const CATEGORIES = ["Electronics", "Home", "Garden", "Toys", "Grocery", "Apparel"];
const REGIONS = ["North", "South", "East", "West", "Central"];

function shopData(): { products: unknown[][]; sales: unknown[][] } {
  const random = mulberry32(0x51a7);
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;

  const products: unknown[][] = [];
  const ids: string[] = [];
  for (let i = 0; i < 240; i++) {
    const id = `P-${1000 + i}`;
    ids.push(id);
    products.push([
      id,
      `${pick(PRODUCT_WORDS)} ${pick(PRODUCT_NOUNS)}`,
      pick(CATEGORIES),
      Math.round((3 + random() * 297) * 100) / 100,
    ]);
  }

  const base = Date.UTC(2024, 0, 1);
  const sales: unknown[][] = [];
  for (let i = 0; i < 4_000; i++) {
    sales.push([
      `S-${100000 + i}`,
      pick(ids),
      pick(REGIONS),
      1 + Math.floor(random() * 80),
      new Date(base + Math.floor(random() * 365) * 86_400_000),
    ]);
  }
  return { products, sales };
}

const { products, sales } = shopData();

await write("test.csv", toCsv(orderHeaders, orderRows));
await write("products.csv", toCsv(["id", "name", "category", "unitPrice"], products));
await write("sales.csv", toCsv(["id", "productId", "region", "units", "soldAt"], sales));
