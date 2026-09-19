/**
 * Demo dataset + column definitions for the grid.
 *
 * A deterministic seeded PRNG keeps the data stable across reloads so the
 * report looks the same every time. 50k rows is enough to show that render
 * cost tracks the viewport, not the row count.
 */

import type { CellValue, ColumnDef } from "./types";

export interface OrderRow {
  id: string;
  customer: string;
  region: string;
  rep: string;
  channel: string;
  units: number;
  unitPrice: number;
  cost: number;
  status: string;
  rush: boolean;
  orderedAt: Date;
}

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

const REGIONS = ["North", "South", "East", "West", "Central"];
const CHANNELS = ["Web", "Retail", "Partner", "Wholesale"];
const STATUSES = ["Paid", "Pending", "Shipped", "Refunded", "Cancelled"];
const REP_FIRST = ["Ava", "Liam", "Noah", "Mia", "Ethan", "Zoe", "Kai", "Ines", "Ravi", "Priya", "Diego", "Lena"];
const REP_LAST = ["Okafor", "Nguyen", "Silva", "Haddad", "Kim", "Petrov", "Rossi", "Chen", "Adeyemi", "Novak"];
const COMPANY_A = ["Northwind", "Acme", "Globex", "Initech", "Umbrella", "Vertex", "Lumen", "Cobalt", "Nimbus", "Quanta"];
const COMPANY_B = ["Logistics", "Traders", "Industries", "Supply", "Systems", "Labs", "Holdings", "Partners", "Group", "Works"];

export function createOrders(count: number): OrderRow[] {
  const random = mulberry32(0x5eed);
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(random() * list.length)] as T;
  const rows: OrderRow[] = new Array(count);

  const base = Date.UTC(2023, 0, 1);

  for (let i = 0; i < count; i++) {
    const units = 1 + Math.floor(random() * 240);
    const unitPrice = Math.round((4 + random() * 496) * 100) / 100;
    const gross = units * unitPrice;
    const cost = Math.round(gross * (0.38 + random() * 0.42) * 100) / 100;
    rows[i] = {
      id: `SO-${(100000 + i).toString()}`,
      customer: `${pick(COMPANY_A)} ${pick(COMPANY_B)}`,
      region: pick(REGIONS),
      rep: `${pick(REP_FIRST)} ${pick(REP_LAST)}`,
      channel: pick(CHANNELS),
      units,
      unitPrice,
      cost,
      status: pick(STATUSES),
      rush: random() > 0.82,
      orderedAt: new Date(base + Math.floor(random() * 730) * 86400000),
    };
  }
  return rows;
}

const revenue = (row: OrderRow): number => Math.round(row.units * row.unitPrice * 100) / 100;
const profit = (row: OrderRow): number => Math.round((revenue(row) - row.cost) * 100) / 100;
const margin = (row: OrderRow): number => {
  const rev = revenue(row);
  return rev === 0 ? 0 : (rev - row.cost) / rev;
};

/** 1-based row numbers are drawn by the grid; these are the data columns. */
export const orderColumns: ColumnDef<OrderRow>[] = [
  { id: "id", header: "Order", field: "id", width: 104, type: "text" },
  { id: "customer", header: "Customer", field: "customer", width: 208, type: "text", maxWidth: 420 },
  { id: "region", header: "Region", field: "region", width: 118, type: "badge", sortable: true },
  { id: "rep", header: "Sales Rep", field: "rep", width: 168, type: "text" },
  { id: "channel", header: "Channel", field: "channel", width: 116, type: "badge" },
  { id: "units", header: "Units", field: "units", width: 92, type: "integer" },
  { id: "unitPrice", header: "Unit Price", field: "unitPrice", width: 118, type: "currency" },
  {
    id: "revenue",
    header: "Revenue",
    width: 132,
    type: "currency",
    getValue: (row): CellValue => revenue(row),
  },
  { id: "cost", header: "Cost", field: "cost", width: 122, type: "currency" },
  {
    id: "profit",
    header: "Profit",
    width: 128,
    type: "currency",
    getValue: (row): CellValue => profit(row),
  },
  {
    id: "margin",
    header: "Margin",
    width: 104,
    type: "percent",
    getValue: (row): CellValue => margin(row),
  },
  { id: "status", header: "Status", field: "status", width: 120, type: "badge" },
  { id: "rush", header: "Rush", field: "rush", width: 88, type: "boolean", align: "center" },
  { id: "orderedAt", header: "Ordered", field: "orderedAt", width: 138, type: "date" },
];

/** Fields searched by the demo's filter box. */
export const searchableFields: (keyof OrderRow)[] = [
  "id",
  "customer",
  "region",
  "rep",
  "channel",
  "status",
];
