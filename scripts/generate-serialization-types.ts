/**
 * Generate TypeScript types from DuckDB's serialization schemas.
 *
 * `scripts/fetch-serialization-schemas.ts` mirrors the JSON schema files that
 * describe DuckDB's serialization. Each file is an array of class definitions:
 *
 *     { "class": "SelectStatement", "members": [
 *         { "id": 100, "name": "node", "type": "QueryNode*" }, … ] }
 *
 * This script folds every file into one class registry and emits a single
 * TypeScript module: one `interface` per class (members typed from their C++
 * types, subclassing expressed with `extends` and narrowed discriminators),
 * plus `Any<Base>` unions for polymorphic hierarchies. An indirect reference
 * (`T*`, `unique_ptr<T>`, …) to a class that has subclasses is typed as that
 * class' `Any<T>` union, because it holds one of the concrete subclasses.
 * Indirect references are also nullable (`| null`), matching the `null` the
 * serializer writes for a nil pointer; container elements are never null.
 *
 * The output is deterministic: classes, union members and source files are
 * sorted, and nothing time- or environment-dependent is written.
 *
 * Usage:
 *     bun run scripts/generate-serialization-types.ts [branch] [options]
 *
 * Options:
 *     -b, --branch <ref>   Revision to read (default: v1.5-variegata)
 *         --in <dir>       Schema root that holds `<branch>/` (default: schemas/duckdb)
 *         --out <file>     TypeScript file to write
 *                          (default: src/lib/duckdb-serialization.gen.ts)
 *     -h, --help           Print this message
 */

import { mkdir, stat } from "node:fs/promises";
import path from "node:path";

const DEFAULT_BRANCH = "v1.5-variegata";
const SOURCE_REPO = "duckdb/duckdb";
const SOURCE_PATH = "src/include/duckdb/storage/serialization";

// ---- schema shape ----------------------------------------------------------

interface MemberDef {
  id?: number;
  name: string;
  type: string;
  /** C++ property path when it differs from the serialized member name. */
  property?: string;
  /** Version the member was introduced in, e.g. `v1.4.0`. */
  version?: string;
  /** `deleted` members are gone from current schemas and are skipped. */
  status?: string;
}

interface ClassDef {
  class: string;
  base?: string;
  /** Discriminator value(s) written for this (sub)class. */
  enum?: string | string[];
  /** Name of the member that carries the discriminator (on an abstract base). */
  class_type?: string;
  members?: MemberDef[];
}

// ---- C++ -> TypeScript mapping ---------------------------------------------

/** Primitive C++ types and small value wrappers. */
const SCALARS: Record<string, string> = {
  string: "string",
  char: "string",
  bool: "boolean",
  float: "number",
  double: "number",
  int: "number",
  size_t: "number",
  idx_t: "number",
  block_id_t: "number",
  column_t: "number",
  transaction_t: "number",
  hash_t: "number",
  sel_t: "number",
  int8_t: "number",
  int16_t: "number",
  int32_t: "number",
  int64_t: "number",
  uint8_t: "number",
  uint16_t: "number",
  uint32_t: "number",
  uint64_t: "number",
  LogicalIndex: "number",
  PhysicalIndex: "number",
  optional_idx: "number",
};

/**
 * Types that are serialized by these schemas but *defined* elsewhere in DuckDB
 * (so they have no class definition here). Refine the aliases if needed.
 */
const EXTERNALS: Record<string, string> = {
  Value: "DuckDBValue",
  LogicalType: "DuckDBLogicalType",
  BaseStatistics: "unknown",
  ColumnDataCollection: "unknown",
  ColumnSegmentState: "unknown",
  CoordinateReferenceSystem: "unknown",
  GroupingSet: "unknown",
  HyperLogLog: "unknown",
  ReservoirChunk: "unknown",
  T: "unknown",
};

interface Ctx {
  byName: Map<string, ClassDef>;
  typeParams: Set<string>;
  /** Class names that have subclasses, i.e. that get an `Any<Name>` union. */
  unions: Set<string>;
}

function listOf(inner: string): string {
  return inner.includes("|") ? `Array<${inner}>` : `${inner}[]`;
}

function recordOf(value: string): string {
  return `Record<string, ${value}>`;
}

/** A pointer can hold `null`; the JS/JSON null is written for a nil pointer. */
function withNull(type: string, nullable: boolean): string {
  return nullable ? `${type} | null` : type;
}

function genericArg(args: readonly string[], index: number, generic: string): string {
  const value = args[index];
  if (value === undefined) fail(`generic "${generic}" is missing argument ${index}`);
  return value;
}

/** Split a `Name<A, B>` string into its base name and top-level arguments. */
function splitType(input: string): { name: string; args: string[] } {
  const open = input.indexOf("<");
  if (open === -1) return { name: input, args: [] };
  const close = input.lastIndexOf(">");
  return { name: input.slice(0, open).trim(), args: splitArgs(input.slice(open + 1, close)) };
}

/** Split template arguments on commas that aren't nested inside `<…>`. */
function splitArgs(input: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (ch === "<") depth++;
    else if (ch === ">") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(input.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(input.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/**
 * Map one C++ member type to a TypeScript type.
 *
 * `nullable` tracks whether the type sits in a value position (a member value)
 * versus an element position (inside a list/set/map/pair). Only value-position
 * pointers become `| null`, because containers serialize their elements
 * directly (never `null`).
 */
function mapType(rawType: string, ctx: Ctx, nullable = true): string {
  let type = rawType.trim();
  if (type.startsWith("const ")) type = type.slice("const ".length).trim();

  let indirect = false;
  while (type.endsWith("*") || type.endsWith("&")) {
    indirect = true;
    type = type.slice(0, -1).trim();
  }

  const { name, args } = splitType(type);

  switch (name) {
    case "vector":
    case "unsafe_vector":
    case "unordered_set":
      return listOf(mapType(genericArg(args, 0, name), ctx, false));
    case "unique_ptr":
    case "shared_ptr":
    case "optionally_owned_ptr":
      return withNull(mapPointee(genericArg(args, 0, name), ctx), nullable);
    case "unordered_map":
    case "map":
      return recordOf(mapType(genericArg(args, 1, name), ctx, false));
    case "case_insensitive_map_t":
    case "qualified_column_map_t":
    case "InsertionOrderPreservingMap":
    case "child_list_t":
      return recordOf(mapType(genericArg(args, 0, name), ctx, false));
    case "std::priority_queue":
      return listOf(mapType(genericArg(args, 0, name), ctx, false));
    case "std::pair":
      return `[${args.map((arg) => mapType(arg, ctx, false)).join(", ")}]`;
    case "IndexVector":
      return `Array<[${mapType(genericArg(args, 0, name), ctx, false)}, ${mapType(genericArg(args, 1, name), ctx, false)}]>`;
  }

  // Parameterless collections whose element type is fixed.
  if (name === "case_insensitive_set_t" || name === "qualified_column_set_t") return "string[]";
  if (name === "create_info_set_t") return "unknown[]";

  if (ctx.typeParams.has(name)) return name;
  // A class with subclasses is abstract: an indirect reference holds one of its
  // concrete subclasses, so use the generated `Any<Name>` union.
  if (indirect && ctx.unions.has(name)) return withNull(`Any${name}`, nullable);
  if (name in SCALARS) return withNull(SCALARS[name]!, nullable && indirect);
  if (ctx.byName.has(name)) {
    const ref = args.length === 0 ? name : `${name}<${args.map((arg) => mapType(arg, ctx, false)).join(", ")}>`;
    return withNull(ref, nullable && indirect);
  }
  if (name in EXTERNALS) return withNull(EXTERNALS[name]!, nullable && indirect);
  if (name === "void") return "void";

  // Everything else is a C++ enum, which DuckDB serializes as its value name.
  return withNull("string", nullable && indirect);
}

/**
 * Map the target of a smart pointer, widening a polymorphic base to its union.
 * The pointer's own nullability is applied by the caller.
 */
function mapPointee(target: string, ctx: Ctx): string {
  const type = target.trim().replace(/^const /, "");
  const { name, args } = splitType(type);
  return args.length === 0 && ctx.unions.has(name) ? `Any${name}` : mapType(target, ctx, false);
}

// ---- generation ------------------------------------------------------------

interface ClassName {
  name: string;
  typeParams: string[];
}

/** Split `CSVOption<T>` into `{ name: "CSVOption", typeParams: ["T"] }`. */
function parseClassName(raw: string): ClassName {
  const open = raw.indexOf("<");
  if (open === -1) return { name: raw.trim(), typeParams: [] };
  return { name: raw.slice(0, open).trim(), typeParams: splitArgs(raw.slice(open + 1, raw.lastIndexOf(">"))) };
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function propertyName(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

/** The member that carries a class' discriminator, if it declares one. */
function discriminatorMember(def: ClassDef): string | null {
  if (!def.class_type) return null;
  const member = (def.members ?? []).find((m) => (m.property ?? m.name) === def.class_type);
  return member?.name ?? def.class_type;
}

/** The discriminator inherited from the nearest ancestor that declares one. */
function inheritedDiscriminator(def: ClassDef, byName: Map<string, ClassDef>): string | null {
  let current = def.base ? byName.get(def.base) : undefined;
  while (current) {
    const member = discriminatorMember(current);
    if (member) return member;
    current = current.base ? byName.get(current.base) : undefined;
  }
  return null;
}

function memberDoc(member: MemberDef): string | null {
  return member.version && /^v\d/.test(member.version) ? `@since ${member.version}` : null;
}

function renderInterface(def: ClassDef, byName: Map<string, ClassDef>, unions: Set<string>): string {
  const { name, typeParams } = parseClassName(def.class);
  const generics = typeParams.length > 0 ? `<${typeParams.join(", ")}>` : "";
  const heritage = def.base ? ` extends ${def.base}` : "";
  const ctx: Ctx = { byName, typeParams: new Set(typeParams), unions };

  const declared = new Set<string>();
  const body: string[] = [];
  for (const member of def.members ?? []) {
    if (member.status === "deleted") continue;
    declared.add(member.name);
    const doc = memberDoc(member);
    if (doc) body.push(`  /** ${doc} */`);
    body.push(`  ${propertyName(member.name)}: ${mapType(member.type, ctx)};`);
  }

  // Narrow the inherited discriminator to this subclass' enum value.
  if (def.enum) {
    const discriminator = inheritedDiscriminator(def, byName);
    if (discriminator && !declared.has(discriminator)) {
      const values = Array.isArray(def.enum) ? def.enum : [def.enum];
      body.push(`  ${propertyName(discriminator)}: ${values.map((value) => JSON.stringify(value)).join(" | ")};`);
    }
  }

  const head = `export interface ${name}${generics}${heritage}`;
  return body.length === 0 ? `${head} {}` : `${head} {\n${body.join("\n")}\n}`;
}

function generate(defs: ClassDef[]): string {
  const byName = new Map<string, ClassDef>();
  for (const def of defs) {
    const { name } = parseClassName(def.class);
    if (byName.has(name)) fail(`duplicate class "${name}"`);
    byName.set(name, def);
  }

  // Subclass index, keyed by the simple base name.
  const children = new Map<string, string[]>();
  for (const def of defs) {
    if (!def.base) continue;
    const kids = children.get(def.base) ?? [];
    kids.push(parseClassName(def.class).name);
    children.set(def.base, kids);
  }

  const leavesOf = (name: string): string[] => {
    const kids = children.get(name);
    if (!kids || kids.length === 0) return [name];
    const leaves = new Set<string>();
    for (const kid of kids) for (const leaf of leavesOf(kid)) leaves.add(leaf);
    return [...leaves];
  };

  const sorted = [...byName.keys()].sort();
  const unionNames = new Set(children.keys());
  const interfaces = sorted.map((name) => renderInterface(byName.get(name)!, byName, unionNames));

  const unions = [...children.keys()]
    .sort()
    .map((name) => {
      if (byName.has(`Any${name}`)) fail(`union name "Any${name}" collides with a class`);
      return `export type Any${name} = ${leavesOf(name).sort().join(" | ")};`;
    });

  return [
    "/**",
    " * AUTO-GENERATED FILE — do not edit by hand.",
    " *",
    " * TypeScript types for DuckDB's serialization schemas, generated by",
    " * `scripts/generate-serialization-types.ts`. Regenerate with:",
    " *",
    " *     bun run scripts/generate-serialization-types.ts",
    " */",
    "",
    "/** Types defined outside these schemas; refine as needed. */",
    "export type DuckDBValue = unknown;",
    "export type DuckDBLogicalType = unknown;",
    "",
    ...interfaces,
    "",
    ...unions,
    "",
  ].join("\n");
}

// ---- CLI -------------------------------------------------------------------

interface CliOptions {
  branch: string;
  inputDir: string;
  outputFile: string;
}

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined) fail(`missing value for ${flag}`);
  return value;
}

const USAGE = `Generate TypeScript types from DuckDB's serialization schemas.

Usage:
  bun run scripts/generate-serialization-types.ts [branch] [options]

Options:
  -b, --branch <ref>   Revision to read (default: ${DEFAULT_BRANCH})
      --in <dir>       Schema root holding <branch>/ (default: schemas/duckdb)
      --out <file>     TypeScript file to write
                       (default: src/lib/duckdb-serialization.gen.ts)
  -h, --help           Show this message`;

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    branch: DEFAULT_BRANCH,
    inputDir: path.join("schemas", "duckdb"),
    outputFile: path.join("src", "lib", "duckdb-serialization.gen.ts"),
  };
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    switch (arg) {
      case "-h":
      case "--help":
        console.log(USAGE);
        process.exit(0);
        break;
      case "-b":
      case "--branch":
        options.branch = requireValue(argv, ++i, arg);
        break;
      case "--in":
        options.inputDir = requireValue(argv, ++i, arg);
        break;
      case "--out":
        options.outputFile = requireValue(argv, ++i, arg);
        break;
      default:
        if (arg.startsWith("-")) fail(`unknown option "${arg}"\n\n${USAGE}`);
        positionals.push(arg);
    }
  }

  if (positionals.length > 1) fail(`expected at most one branch argument, got: ${positionals.join(", ")}`);
  if (positionals.length === 1) options.branch = positionals[0]!;

  return options;
}

function asClassDef(value: unknown, file: string): ClassDef {
  if (typeof value !== "object" || value === null) {
    fail(`${file}: expected an object class definition, got ${typeof value}`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.class !== "string") fail(`${file}: class definition is missing a string "class"`);
  if (record.members !== undefined && !Array.isArray(record.members)) {
    fail(`${file}: "members" for ${record.class} must be an array`);
  }
  return record as unknown as ClassDef;
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const schemaDir = path.join(options.inputDir, options.branch);

  if (!(await isDirectory(schemaDir))) {
    fail(
      `no schemas at ${schemaDir}\n` +
        `hint: fetch them first, e.g. \`bun run scripts/fetch-serialization-schemas.ts ${options.branch}\``,
    );
  }

  const files: string[] = [];
  for await (const file of new Bun.Glob("**/*.json").scan(schemaDir)) files.push(file);
  files.sort();
  if (files.length === 0) fail(`no JSON schemas found under ${schemaDir}`);

  const defs: ClassDef[] = [];
  for (const file of files) {
    const full = path.join(schemaDir, file);
    const raw: unknown = await Bun.file(full).json();
    if (!Array.isArray(raw)) fail(`${full}: expected a top-level JSON array`);
    for (const entry of raw) defs.push(asClassDef(entry, file));
  }

  const output = generate(defs);
  await mkdir(path.dirname(options.outputFile), { recursive: true });
  await Bun.write(options.outputFile, output);

  const interfaceCount = (output.match(/^export interface /gm) ?? []).length;
  const unionCount = (output.match(/^export type Any/gm) ?? []).length;
  console.log(
    `Generated ${interfaceCount} interface(s) and ${unionCount} union(s) from ` +
      `${files.length} schema file(s) (${SOURCE_REPO}@${options.branch}).\n  -> ${options.outputFile}`,
  );
}

await main();
