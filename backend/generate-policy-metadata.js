#!/usr/bin/env node
/**
 * Generate Amazon Bedrock Knowledge Base metadata sidecar files for PDFs
 * in ./Policies, using metadata from Policy documents_v3.rdf (Zotero RDF/XML).
 *
 * Output files: ./Policies/<pdf-filename>.metadata.json
 *
 * Usage:
 *   node generate-policy-metadata.js
 *   node generate-policy-metadata.js --dry-run
 */

const fs = require("fs");
const path = require("path");

const POLICIES_DIR = path.join(__dirname, "Policies");
const RDF_PATH = path.join(POLICIES_DIR, "Policy documents_v3.rdf");
const DRY_RUN = process.argv.includes("--dry-run");

function decodeXmlEntities(value) {
  if (!value) return "";
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

function textContent(xml, tagName) {
  // Match simple text-only elements, including optional attributes on the open tag.
  const re = new RegExp(
    `<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagName}>`,
    "i"
  );
  const match = xml.match(re);
  if (!match) return "";
  // Strip any nested tags (e.g. nested wrappers) and decode entities.
  const inner = match[1].replace(/<[^>]+>/g, " ");
  return decodeXmlEntities(inner.replace(/\s+/g, " "));
}

/**
 * Remove common nested containers so field extraction stays on the parent item.
 * Zotero puts website/journal titles inside dcterms:isPartOf, which would otherwise
 * be picked up before the item's own dc:title.
 */
function stripNestedContainers(xml) {
  return xml
    .replace(/<dcterms:isPartOf\b[^>]*>[\s\S]*?<\/dcterms:isPartOf>/gi, "")
    .replace(/<dc:publisher\b[^>]*>[\s\S]*?<\/dc:publisher>/gi, "")
    .replace(/<bib:authors\b[^>]*>[\s\S]*?<\/bib:authors>/gi, "");
}

function allTextContents(xml, tagName) {
  const re = new RegExp(
    `<${tagName}(?:\\s[^>]*)?>([\\s\\S]*?)</${tagName}>`,
    "gi"
  );
  const values = [];
  let match;
  while ((match = re.exec(xml)) !== null) {
    const inner = match[1].replace(/<[^>]+>/g, " ");
    const value = decodeXmlEntities(inner.replace(/\s+/g, " "));
    if (value) values.push(value);
  }
  return values;
}

function attrValue(openTag, attrName) {
  const re = new RegExp(`${attrName}="([^"]*)"`, "i");
  const match = openTag.match(re);
  return match ? decodeXmlEntities(match[1]) : "";
}

/**
 * Split RDF into top-level item blocks (Document, Book, Article, Attachment, Description).
 */
function parseTopLevelBlocks(rdfXml) {
  const blocks = [];
  const re =
    /<(bib:Document|bib:Book|bib:Article|z:Attachment|rdf:Description)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = re.exec(rdfXml)) !== null) {
    const tag = match[1];
    const openAttrs = match[2] || "";
    const body = match[3] || "";
    const about = attrValue(`x ${openAttrs}`, "rdf:about");
    blocks.push({ tag, about, body, full: match[0] });
  }
  return blocks;
}

function extractAuthors(itemBody) {
  // Authors live under bib:authors > rdf:Seq > rdf:li > foaf:Person
  const authorsBlockMatch = itemBody.match(
    /<bib:authors\b[^>]*>([\s\S]*?)<\/bib:authors>/i
  );
  if (!authorsBlockMatch) return [];

  const people = [];
  const personRe = /<foaf:Person\b[^>]*>([\s\S]*?)<\/foaf:Person>/gi;
  let personMatch;
  while ((personMatch = personRe.exec(authorsBlockMatch[1])) !== null) {
    const personXml = personMatch[1];
    const surname = textContent(personXml, "foaf:surname");
    const givenName = textContent(personXml, "foaf:givenName");
    if (!surname && !givenName) continue;
    people.push({ surname, givenName });
  }
  return people;
}

function formatAuthorName({ surname, givenName }) {
  if (surname && givenName) {
    // "Barbrook-Johnson, P." style when a given name is present
    const initial = givenName
      .split(/\s+/)
      .filter(Boolean)
      .map((part) => `${part.charAt(0)}.`)
      .join(" ");
    return `${surname}, ${initial}`;
  }
  // Organisations / corporate authors are stored as surname only in this export
  return surname || givenName;
}

function formatAuthorList(authors) {
  const names = authors.map(formatAuthorName).filter(Boolean);
  if (names.length === 0) return "";
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} & ${names[1]}`;
  return `${names.slice(0, -1).join(", ")}, & ${names[names.length - 1]}`;
}

function extractYear(dateStr) {
  if (!dateStr) return "";
  const match = String(dateStr).match(/\b(19|20)\d{2}\b/);
  return match ? match[0] : String(dateStr).trim();
}

function extractHttpUrls(itemBody, about) {
  const urls = [];
  if (/^https?:\/\//i.test(about || "")) {
    urls.push(about);
  }

  // dc:identifier > dcterms:URI > rdf:value
  const uriRe =
    /<dcterms:URI\b[^>]*>\s*<rdf:value>([\s\S]*?)<\/rdf:value>\s*<\/dcterms:URI>/gi;
  let match;
  while ((match = uriRe.exec(itemBody)) !== null) {
    const value = decodeXmlEntities(match[1]);
    if (/^https?:\/\//i.test(value)) urls.push(value);
  }

  // Bare dc:identifier text that happens to be a URL
  for (const id of allTextContents(itemBody, "dc:identifier")) {
    if (/^https?:\/\//i.test(id)) urls.push(id);
  }

  return [...new Set(urls)];
}

function extractLinkedAttachmentIds(itemBody) {
  const ids = [];
  const re = /<link:link\b[^>]*\brdf:resource="([^"]+)"[^>]*\/?>/gi;
  let match;
  while ((match = re.exec(itemBody)) !== null) {
    ids.push(decodeXmlEntities(match[1]));
  }
  return ids;
}

function attachmentFilename(attachmentBody) {
  // <z:path rdf:resource="files/5657/Some File.pdf"/>
  const pathMatch = attachmentBody.match(
    /<z:path\b[^>]*\brdf:resource="([^"]+)"[^>]*\/?>/i
  );
  if (!pathMatch) return "";
  const resourcePath = decodeXmlEntities(pathMatch[1]);
  return path.basename(resourcePath);
}

function buildDisplayName({ authors, year, title }) {
  const authorPart = formatAuthorList(authors);
  const yearPart = year ? `(${year})` : "";
  const titlePart = title || "";

  if (authorPart && yearPart && titlePart) {
    return `${authorPart} ${yearPart}. ${titlePart}`;
  }
  if (authorPart && titlePart) {
    return `${authorPart}. ${titlePart}`;
  }
  if (yearPart && titlePart) {
    return `${yearPart}. ${titlePart}`;
  }
  return titlePart || authorPart || "Untitled";
}

function buildMetadataIndex(rdfXml) {
  const blocks = parseTopLevelBlocks(rdfXml);

  /** @type {Map<string, object>} attachmentAbout -> attachment info */
  const attachmentsByAbout = new Map();
  /** @type {Array<object>} */
  const parentItems = [];

  for (const block of blocks) {
    if (block.tag === "z:Attachment") {
      const filename = attachmentFilename(block.body);
      const linkType = textContent(block.body, "link:type");
      const title = textContent(block.body, "dc:title");
      const urls = extractHttpUrls(block.body, block.about);
      attachmentsByAbout.set(block.about, {
        about: block.about,
        filename,
        title,
        urls,
        linkType,
        body: block.body,
      });
      continue;
    }

    // Parent bibliographic items
    const itemType = textContent(block.body, "z:itemType");
    if (!itemType || itemType === "attachment") continue;

    // Authors need the raw body; title/date/url should ignore nested containers.
    const flatBody = stripNestedContainers(block.body);

    parentItems.push({
      about: block.about,
      itemType,
      title: textContent(flatBody, "dc:title"),
      date: textContent(flatBody, "dc:date"),
      authors: extractAuthors(block.body),
      urls: extractHttpUrls(flatBody, block.about),
      attachmentIds: extractLinkedAttachmentIds(block.body),
    });
  }

  /** @type {Map<string, object>} filename -> metadataAttributes */
  const byFilename = new Map();

  for (const parent of parentItems) {
    for (const attachmentId of parent.attachmentIds) {
      const attachment = attachmentsByAbout.get(attachmentId);
      if (!attachment || !attachment.filename) continue;

      const year = extractYear(parent.date);
      const title = parent.title || attachment.title || "";
      const url =
        parent.urls[0] ||
        attachment.urls[0] ||
        (/^https?:\/\//i.test(parent.about || "") ? parent.about : "") ||
        "";

      const metadataAttributes = {
        display_name: buildDisplayName({
          authors: parent.authors,
          year,
          title,
        }),
        year,
        title,
        url,
        doc_type: parent.itemType,
      };

      byFilename.set(attachment.filename, metadataAttributes);
    }
  }

  return {
    byFilename,
    attachmentCount: attachmentsByAbout.size,
    parentCount: parentItems.length,
  };
}

function main() {
  if (!fs.existsSync(RDF_PATH)) {
    console.error(`RDF file not found: ${RDF_PATH}`);
    process.exit(1);
  }
  if (!fs.existsSync(POLICIES_DIR)) {
    console.error(`Policies directory not found: ${POLICIES_DIR}`);
    process.exit(1);
  }

  const rdfXml = fs.readFileSync(RDF_PATH, "utf8");
  const { byFilename, attachmentCount, parentCount } =
    buildMetadataIndex(rdfXml);

  const pdfFiles = fs
    .readdirSync(POLICIES_DIR)
    .filter((name) => name.toLowerCase().endsWith(".pdf"))
    .sort();

  console.log(
    `Parsed RDF: ${parentCount} parent items, ${attachmentCount} attachments, ${byFilename.size} PDF path mappings`
  );
  console.log(`Local PDFs: ${pdfFiles.length}`);
  if (DRY_RUN) console.log("Dry run — no files will be written.\n");

  let written = 0;
  const missing = [];

  for (const pdfName of pdfFiles) {
    const meta = byFilename.get(pdfName);
    if (!meta) {
      missing.push(pdfName);
      continue;
    }

    const payload = { metadataAttributes: meta };
    const outName = `${pdfName}.metadata.json`;
    const outPath = path.join(POLICIES_DIR, outName);

    if (DRY_RUN) {
      console.log(`Would write ${outName}`);
      console.log(JSON.stringify(payload, null, 2));
      console.log("---");
    } else {
      fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      console.log(`Wrote ${outName}`);
    }
    written += 1;
  }

  console.log(
    `\nDone. ${DRY_RUN ? "Would write" : "Wrote"} ${written} metadata file(s).`
  );

  if (missing.length) {
    console.warn(
      `\nWarning: no RDF match for ${missing.length} local PDF(s):`
    );
    for (const name of missing) console.warn(`  - ${name}`);
    process.exitCode = 1;
  }

  // Helpful: RDF attachments with no local PDF
  const localSet = new Set(pdfFiles);
  const orphanRdf = [...byFilename.keys()].filter((name) => !localSet.has(name));
  if (orphanRdf.length) {
    console.warn(
      `\nNote: ${orphanRdf.length} RDF attachment PDF(s) have no matching local file:`
    );
    for (const name of orphanRdf) console.warn(`  - ${name}`);
  }
}

main();
