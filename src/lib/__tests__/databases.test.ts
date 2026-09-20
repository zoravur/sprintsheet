import { describe, expect, test } from "bun:test";

import { allDataFiles, resolveDatabase, selectQuery, TEST_DATABASES } from "../databases";

describe("resolveDatabase", () => {
  test("finds databases by id", () => {
    expect(resolveDatabase("test").id).toBe("test");
    expect(resolveDatabase("shop").id).toBe("shop");
  });

  test("falls back to the default for missing or unknown ids", () => {
    expect(resolveDatabase(null).id).toBe("test");
    expect(resolveDatabase(undefined).id).toBe("test");
    expect(resolveDatabase("nope").id).toBe("test");
  });
});

describe("registry shape", () => {
  test("the current database is a single relation named 'test'", () => {
    const db = resolveDatabase("test");
    expect(db.relations.map((r) => r.name)).toEqual(["test"]);
  });

  test("the shop database has the two relations products + sales", () => {
    const db = resolveDatabase("shop");
    expect(db.relations.map((r) => r.name)).toEqual(["products", "sales"]);
  });

  test("every database id is unique", () => {
    const ids = TEST_DATABASES.map((db) => db.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every relation declares a primary key that is one of its columns", () => {
    for (const db of TEST_DATABASES) {
      for (const relation of db.relations) {
        expect(relation.primaryKey).toBe("id");
      }
    }
  });
});

describe("selectQuery", () => {
  test("builds a bare FROM <relation> statement with a quoted identifier", () => {
    expect(selectQuery("test")).toBe('FROM "test"');
    expect(selectQuery("products")).toBe('FROM "products"');
  });
});

describe("data files", () => {
  test("every registered relation file exists under src/data", async () => {
    const files = allDataFiles();
    expect(files).toContain("test.csv");
    expect(files).toContain("products.csv");
    expect(files).toContain("sales.csv");
    for (const file of files) {
      const exists = await Bun.file(new URL(`../../data/${file}`, import.meta.url)).exists();
      expect(exists).toBe(true);
    }
  });
});
