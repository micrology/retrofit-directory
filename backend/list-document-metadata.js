#!/usr/bin/env node
/**
 * Download Bedrock KB sidecar metadata from S3 and write a sorted index.
 *
 * Output lines (alphabetical by display_name):
 *   [display_name] [url]
 *
 * Usage:
 *   node list-document-metadata.js
 *   node list-document-metadata.js --out ./document-index.txt
 *   node list-document-metadata.js --bucket retrofit-directory-documents --region eu-west-2
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const DEFAULT_BUCKET = "retrofit-directory-documents";
const DEFAULT_REGION = "eu-west-2";
const DEFAULT_OUT = path.join(__dirname, "document-index.txt");

function parseArgs(argv) {
  const args = argv.slice(2);
  let bucket = DEFAULT_BUCKET;
  let region = DEFAULT_REGION;
  let out = DEFAULT_OUT;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node list-document-metadata.js [options]

Download *.metadata.json sidecars from S3 and write:
  [display_name] [url]
one entry per line, sorted alphabetically by display_name.

Options:
  --bucket <name>   S3 bucket (default: ${DEFAULT_BUCKET})
  --region <name>   AWS region (default: ${DEFAULT_REGION})
  -o, --out <path>  Output file (default: ${DEFAULT_OUT})
  -h, --help        Show this help`);
      process.exit(0);
    }
    if (arg === "--bucket") {
      bucket = requireValue(args, ++i, arg);
      continue;
    }
    if (arg.startsWith("--bucket=")) {
      bucket = arg.slice("--bucket=".length);
      continue;
    }
    if (arg === "--region") {
      region = requireValue(args, ++i, arg);
      continue;
    }
    if (arg.startsWith("--region=")) {
      region = arg.slice("--region=".length);
      continue;
    }
    if (arg === "--out" || arg === "-o") {
      out = requireValue(args, ++i, arg);
      continue;
    }
    if (arg.startsWith("--out=")) {
      out = arg.slice("--out=".length);
      continue;
    }
    console.error(`Unknown option: ${arg}`);
    process.exit(1);
  }

  if (!bucket) {
    console.error("Bucket name is required.");
    process.exit(1);
  }

  return { bucket, region, out: path.resolve(out) };
}

function requireValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("-")) {
    console.error(`Missing value for ${flag}`);
    process.exit(1);
  }
  return value;
}

function runAws(args, { encoding = "utf8", maxBuffer = 50 * 1024 * 1024 } = {}) {
  const result = spawnSync("aws", args, {
    encoding,
    maxBuffer,
  });

  if (result.error) {
    if (result.error.code === "ENOENT") {
      console.error("aws CLI not found on PATH.");
    } else {
      console.error(result.error.message);
    }
    process.exit(1);
  }

  if (result.status !== 0) {
    const err = (result.stderr || result.stdout || "").trim();
    console.error(
      `aws ${args.join(" ")} failed with exit code ${result.status}${
        err ? `:\n${err}` : ""
      }`
    );
    process.exit(1);
  }

  return result.stdout;
}

function listSidecarKeys(bucket, region) {
  const keys = [];
  let continuationToken = null;

  do {
    const args = [
      "s3api",
      "list-objects-v2",
      "--bucket",
      bucket,
      "--region",
      region,
      "--output",
      "json",
    ];
    if (continuationToken) {
      args.push("--continuation-token", continuationToken);
    }

    const stdout = runAws(args);
    let payload;
    try {
      payload = JSON.parse(stdout || "{}");
    } catch (err) {
      console.error(`Failed to parse S3 listing JSON: ${err.message}`);
      process.exit(1);
    }

    const contents = Array.isArray(payload.Contents) ? payload.Contents : [];
    for (const item of contents) {
      const key = item && item.Key;
      if (typeof key === "string" && key.endsWith(".metadata.json")) {
        keys.push(key);
      }
    }

    continuationToken = payload.IsTruncated
      ? payload.NextContinuationToken
      : null;
  } while (continuationToken);

  keys.sort((a, b) => a.localeCompare(b));
  return keys;
}

function downloadSidecar(bucket, region, key) {
  const stdout = runAws([
    "s3",
    "cp",
    `s3://${bucket}/${key}`,
    "-",
    "--region",
    region,
  ]);

  try {
    return JSON.parse(stdout);
  } catch (err) {
    throw new Error(`Invalid JSON in s3://${bucket}/${key}: ${err.message}`);
  }
}

function formatEntry(attrs) {
  const displayName = String(attrs.display_name || "").trim();
  const url = String(attrs.url || "").trim();
  if (!displayName && !url) return null;
  return `${displayName} ${url}`;
}

function main() {
  const { bucket, region, out } = parseArgs(process.argv);

  console.log(`Listing sidecars in s3://${bucket}/ (${region})...`);
  const keys = listSidecarKeys(bucket, region);
  console.log(`Found ${keys.length} sidecar file(s).`);

  const entries = [];
  const skipped = [];

  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    process.stdout.write(
      `\rDownloading ${i + 1}/${keys.length}: ${key.slice(0, 60)}...`
    );
    try {
      const sidecar = downloadSidecar(bucket, region, key);
      const attrs = (sidecar && sidecar.metadataAttributes) || {};
      const line = formatEntry(attrs);
      if (!line) {
        skipped.push({ key, reason: "missing display_name and url" });
        continue;
      }
      entries.push({
        line,
        sortKey: String(attrs.display_name || "").trim().toLocaleLowerCase(),
      });
    } catch (err) {
      skipped.push({ key, reason: err.message });
    }
  }

  process.stdout.write("\n");

  entries.sort((a, b) => {
    const byName = a.sortKey.localeCompare(b.sortKey, undefined, {
      sensitivity: "base",
      numeric: true,
    });
    if (byName !== 0) return byName;
    return a.line.localeCompare(b.line);
  });

  const body = `${entries.map((e) => e.line).join("\n")}${
    entries.length ? "\n" : ""
  }`;
  fs.writeFileSync(out, body, "utf8");

  console.log(`Wrote ${entries.length} line(s) to ${out}`);
  if (skipped.length) {
    console.warn(`Skipped ${skipped.length} sidecar(s):`);
    for (const item of skipped) {
      console.warn(`  - ${item.key}: ${item.reason}`);
    }
  }
}

main();
