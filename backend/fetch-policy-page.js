#!/usr/bin/env node
/**
 * Fetch a web page with trafilatura (markdown + metadata), save it under
 * ./Policies, and write a Bedrock Knowledge Base sidecar file.
 *
 * Sidecar format matches write-metadata.js / generate-policy-metadata.js:
 *   ./Policies/<name>.md
 *   ./Policies/<name>.md.metadata.json
 *
 * Usage:
 *   node fetch-policy-page.js <url>
 *   node fetch-policy-page.js --url <url>
 *   node fetch-policy-page.js --dry-run <url>
 *   node fetch-policy-page.js --name custom-slug <url>
 */

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const POLICIES_DIR = path.join(__dirname, "Policies");

function parseArgs(argv) {
  const args = argv.slice(2);
  let dryRun = false;
  let url = null;
  let name = null;
  const positionals = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--url" || arg === "-u") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) {
        console.error(`Missing value for ${arg}`);
        process.exit(1);
      }
      url = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--url=")) {
      url = arg.slice("--url=".length);
      if (!url) {
        console.error("Missing value for --url");
        process.exit(1);
      }
      continue;
    }
    if (arg === "--name" || arg === "-n") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) {
        console.error(`Missing value for ${arg}`);
        process.exit(1);
      }
      name = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--name=")) {
      name = arg.slice("--name=".length);
      if (!name) {
        console.error("Missing value for --name");
        process.exit(1);
      }
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(`Usage: node fetch-policy-page.js [options] <url>

Fetch a page with trafilatura (--markdown --with-metadata), write Markdown
to ./Policies, and create a matching Bedrock KB sidecar JSON file.

Options:
  -u, --url <url>     Page URL (alternative to positional argument)
  -n, --name <slug>   Output basename without extension (default: from title/URL)
  --dry-run           Print extracted content and metadata without writing files
  -h, --help          Show this help

Requires \`trafilatura\` on PATH.`);
      process.exit(0);
    }
    if (arg.startsWith("-")) {
      console.error(`Unknown option: ${arg}`);
      process.exit(1);
    }
    positionals.push(arg);
  }

  if (!url && positionals.length === 1) {
    url = positionals[0];
  } else if (url && positionals.length === 1) {
    console.error("URL provided both as a flag and as a positional argument");
    process.exit(1);
  } else if (positionals.length > 1) {
    console.error(`Too many positional arguments: ${positionals.join(", ")}`);
    process.exit(1);
  }

  if (!url) {
    console.error("A URL is required. See --help.");
    process.exit(1);
  }

  try {
    // Validate early so errors are clear before spawning trafilatura.
    // eslint-disable-next-line no-new
    new URL(url);
  } catch {
    console.error(`Invalid URL: ${url}`);
    process.exit(1);
  }

  return { dryRun, url, name };
}

/**
 * Parse YAML-ish front matter emitted by trafilatura --with-metadata.
 * Keys are simple; values may be bare or double-quoted.
 */
function parseFrontMatter(markdown) {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return { meta: {}, body: markdown };
  }

  const meta = {};
  const lines = match[1].split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    meta[key] = value;
  }

  return {
    meta,
    body: markdown.slice(match[0].length),
    frontMatterRaw: match[0],
  };
}

function extractYear(dateStr) {
  if (!dateStr) return "";
  const match = String(dateStr).match(/\b(19|20)\d{2}\b/);
  return match ? match[0] : "";
}

function slugify(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 120);
}

function basenameFromUrl(urlString) {
  try {
    const { pathname } = new URL(urlString);
    const parts = pathname.split("/").filter(Boolean);
    if (parts.length === 0) return "";
    let last = parts[parts.length - 1];
    // Drop common index-like endings and try previous segment.
    if (/^(index|home)(\.[a-z0-9]+)?$/i.test(last) && parts.length > 1) {
      last = parts[parts.length - 2];
    }
    last = last.replace(/\.(html?|php|aspx?)$/i, "");
    return slugify(decodeURIComponent(last));
  } catch {
    return "";
  }
}

function stripTitleSuffix(title, sitename) {
  let cleaned = String(title || "").trim();
  if (!cleaned) return "";
  if (sitename) {
    const escaped = sitename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    cleaned = cleaned
      .replace(new RegExp(`\\s*[|–—-]\\s*${escaped}\\s*$`, "i"), "")
      .trim();
  }
  // Common "Title | Site" without relying on sitename match.
  cleaned = cleaned.replace(/\s*[|]\s*[^|]+$/, "").trim() || cleaned;
  return cleaned;
}

function buildDisplayName({ authors, year, title, sitename }) {
  const titlePart = title || "Untitled";
  const yearPart = year ? `(${year})` : "";
  const authorOrSite = authors || sitename || "";

  if (authorOrSite && yearPart) {
    return `${authorOrSite} ${yearPart}. ${titlePart}`;
  }
  if (authorOrSite) {
    return `${authorOrSite}. ${titlePart}`;
  }
  if (yearPart) {
    return `${yearPart}. ${titlePart}`;
  }
  return titlePart;
}

function buildOutputBasename({ explicitName, title, url }) {
  if (explicitName) {
    const cleaned = explicitName
      .replace(/\.md\.metadata\.json$/i, "")
      .replace(/\.metadata\.json$/i, "")
      .replace(/\.md$/i, "");
    const slug = slugify(cleaned);
    if (!slug) {
      console.error("Could not derive a valid name from --name");
      process.exit(1);
    }
    return slug;
  }

  const fromTitle = slugify(title);
  if (fromTitle) return fromTitle;

  const fromUrl = basenameFromUrl(url);
  if (fromUrl) return fromUrl;

  console.error("Could not derive a descriptive filename from title or URL");
  process.exit(1);
}

function runTrafilatura(url) {
  const result = spawnSync(
    "trafilatura",
    ["-u", url, "--markdown", "--with-metadata"],
    {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
    }
  );

  if (result.error) {
    if (result.error.code === "ENOENT") {
      console.error(
        "trafilatura not found on PATH. Install it (e.g. `pip install trafilatura` or Homebrew)."
      );
    } else {
      console.error(result.error.message);
    }
    process.exit(1);
  }

  if (result.status !== 0) {
    const err = (result.stderr || result.stdout || "").trim();
    console.error(
      `trafilatura failed with exit code ${result.status}${err ? `:\n${err}` : ""}`
    );
    process.exit(1);
  }

  const stdout = (result.stdout || "").trim();
  if (!stdout) {
    const err = (result.stderr || "").trim();
    console.error(
      `trafilatura returned no content for ${url}${err ? `:\n${err}` : ""}`
    );
    process.exit(1);
  }

  // Prefer a trailing newline in saved files.
  return `${stdout}\n`;
}

function main() {
  const { dryRun, url, name } = parseArgs(process.argv);

  console.log(`Fetching ${url} with trafilatura...`);
  const markdown = runTrafilatura(url);
  const { meta } = parseFrontMatter(markdown);

  const rawTitle = meta.title || "";
  const sitename = meta.sitename || meta.hostname || "";
  const title = stripTitleSuffix(rawTitle, sitename) || rawTitle || "";
  const pageUrl = meta.url || url;
  const year = extractYear(meta.date || meta.filedate || "");
  const authors = meta.author || meta.authors || "";

  const basename = buildOutputBasename({
    explicitName: name,
    title: title || rawTitle,
    url: pageUrl,
  });

  const mdName = `${basename}.md`;
  const sidecarName = `${mdName}.metadata.json`;
  const mdPath = path.join(POLICIES_DIR, mdName);
  const sidecarPath = path.join(POLICIES_DIR, sidecarName);

  const metadataAttributes = {
    display_name: buildDisplayName({
      authors,
      year,
      title: title || rawTitle || basename,
      sitename,
    }),
    year,
    title: title || rawTitle || basename,
    url: pageUrl,
    doc_type: "webpage",
  };

  const sidecarPayload = { metadataAttributes };

  if (dryRun) {
    console.log("Dry run — no files will be written.\n");
    console.log(`Would write ${mdPath}`);
    console.log(`Would write ${sidecarPath}`);
    console.log(JSON.stringify(sidecarPayload, null, 2));
    console.log("--- markdown preview (first 40 lines) ---");
    console.log(markdown.split(/\r?\n/).slice(0, 40).join("\n"));
    return;
  }

  if (!fs.existsSync(POLICIES_DIR)) {
    fs.mkdirSync(POLICIES_DIR, { recursive: true });
  }

  if (fs.existsSync(mdPath)) {
    console.warn(`Warning: overwriting existing file ${mdName}`);
  }
  if (fs.existsSync(sidecarPath)) {
    console.warn(`Warning: overwriting existing file ${sidecarName}`);
  }

  fs.writeFileSync(mdPath, markdown, "utf8");
  fs.writeFileSync(
    sidecarPath,
    `${JSON.stringify(sidecarPayload, null, 2)}\n`,
    "utf8"
  );

  console.log(`Wrote ${mdPath}`);
  console.log(`Wrote ${sidecarPath}`);
  console.log(JSON.stringify(sidecarPayload, null, 2));
}

main();
