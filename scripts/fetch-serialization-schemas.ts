/**
 * Mirror DuckDB's serialization schema directory from GitHub.
 *
 * DuckDB describes how its parse tree is serialized in a handful of JSON files
 * under `src/include/duckdb/storage/serialization`. This script copies one
 * revision of that directory onto disk so
 * `scripts/generate-serialization-types.ts` can turn it into TypeScript.
 *
 * The revision (branch, tag or commit — anything GitHub accepts as a ref) is
 * part of the output path, so several revisions can be kept side by side:
 *
 *     schemas/duckdb/<branch>/statement.json
 *     schemas/duckdb/<branch>/nodes.json
 *     …
 *
 * Usage:
 *     bun run scripts/fetch-serialization-schemas.ts [branch] [options]
 *
 * Options:
 *     -b, --branch <ref>   Revision to download (default: v1.5-variegata)
 *         --owner <name>   GitHub owner/org (default: duckdb)
 *         --repo <name>    GitHub repository (default: duckdb)
 *         --path <dir>     Directory to mirror
 *                          (default: src/include/duckdb/storage/serialization)
 *         --out <dir>      Local output root (default: schemas/duckdb)
 *     -h, --help           Print this message
 *
 * A `GITHUB_TOKEN` (or `GH_TOKEN`) environment variable is used when present,
 * which raises the GitHub API rate limit and allows private repositories.
 *
 * The download is a full mirror: the destination directory is removed first, so
 * re-running never leaves a stale file behind.
 */

import { rm } from "node:fs/promises";
import path from "node:path";

const DEFAULT_BRANCH = "v1.5-variegata";

interface CliOptions {
  branch: string;
  owner: string;
  repo: string;
  path: string;
  out: string;
}

const USAGE = `Mirror DuckDB's serialization schemas from GitHub.

Usage:
  bun run scripts/fetch-serialization-schemas.ts [branch] [options]

Options:
  -b, --branch <ref>   Revision to download (default: ${DEFAULT_BRANCH})
      --owner <name>   GitHub owner/org (default: duckdb)
      --repo <name>    GitHub repository (default: duckdb)
      --path <dir>     Directory to mirror
                       (default: src/include/duckdb/storage/serialization)
      --out <dir>      Local output root (default: schemas/duckdb)
  -h, --help           Show this message`;

function fail(message: string): never {
  console.error(`error: ${message}`);
  process.exit(1);
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined) fail(`missing value for ${flag}`);
  return value;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    branch: DEFAULT_BRANCH,
    owner: "duckdb",
    repo: "duckdb",
    path: "src/include/duckdb/storage/serialization",
    out: path.join("schemas", "duckdb"),
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
      case "--owner":
        options.owner = requireValue(argv, ++i, arg);
        break;
      case "--repo":
        options.repo = requireValue(argv, ++i, arg);
        break;
      case "--path":
        options.path = requireValue(argv, ++i, arg);
        break;
      case "--out":
        options.out = requireValue(argv, ++i, arg);
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

/** A single entry from GitHub's "list directory contents" endpoint. */
interface GithubEntry {
  name: string;
  path: string;
  type: "file" | "dir" | "symlink" | "submodule";
  download_url: string | null;
}

function githubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "duckdb-serialization-fetch",
  };
  const token = Bun.env.GITHUB_TOKEN ?? Bun.env.GH_TOKEN;
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

/** List one directory of a repository at a given ref. */
async function listDirectory(options: CliOptions, directory: string): Promise<GithubEntry[]> {
  const segments = directory.split("/").map(encodeURIComponent).join("/");
  const url =
    `https://api.github.com/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}` +
    `/contents/${segments}?ref=${encodeURIComponent(options.branch)}`;

  const response = await fetch(url, { headers: githubHeaders() });
  if (!response.ok) {
    fail(`GitHub request failed (${response.status} ${response.statusText}) for ${url}`);
  }
  const payload: unknown = await response.json();
  if (!Array.isArray(payload)) {
    fail(`expected a directory listing at ${directory}, got ${typeof payload}`);
  }
  return payload as GithubEntry[];
}

/** Recursively copy `entry` (and its children) into `destination`. */
async function download(options: CliOptions, entry: GithubEntry, destination: string, relative: string): Promise<number> {
  if (entry.type === "dir") {
    const children = await listDirectory(options, entry.path);
    let count = 0;
    for (const child of [...children].sort((a, b) => a.name.localeCompare(b.name))) {
      count += await download(options, child, path.join(destination, child.name), path.join(relative, child.name));
    }
    return count;
  }

  if (entry.type !== "file" || !entry.download_url) {
    console.warn(`  skipping ${relative} (${entry.type})`);
    return 0;
  }

  const response = await fetch(entry.download_url);
  if (!response.ok) {
    fail(`download failed (${response.status} ${response.statusText}) for ${entry.download_url}`);
  }
  await Bun.write(destination, new Uint8Array(await response.arrayBuffer()));
  console.log(`  ${relative}`);
  return 1;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const destination = path.join(options.out, options.branch);

  console.log(
    `Fetching ${options.owner}/${options.repo}@${options.branch}:${options.path}\n` +
      `  -> ${destination}`,
  );

  // Full mirror: start from a clean directory so removed files don't linger.
  await rm(destination, { recursive: true, force: true });

  const entries = await listDirectory(options, options.path);
  let count = 0;
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    count += await download(options, entry, path.join(destination, entry.name), entry.name);
  }

  console.log(`\nDone. Mirrored ${count} file(s) to ${destination}`);
}

await main();
