#!/usr/bin/env node
/**
 * Prompt for webpage metadata and write a Bedrock KB sidecar file.
 *
 * Output: ./Policies/<file name>.pdf.metadata.json
 *
 * Usage:
 *   node write-metadata.js
 */

const fs = require("fs");
const path = require("path");
const readline = require("readline");

const POLICIES_DIR = path.join(__dirname, "Policies");

function ask(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(String(answer).trim()));
  });
}

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const displayName = await ask(rl, "Display name: ");
    const year = await ask(rl, "Year: ");
    const title = await ask(rl, "Title: ");
    const url = await ask(rl, "URL: ");
    let fileName = await ask(rl, "File name (without .pdf.metadata.json): ");

    if (!fileName) {
      console.error("File name is required.");
      process.exitCode = 1;
      return;
    }

    // Allow pasting a bare name, name.pdf, or full sidecar name.
    fileName = fileName.replace(/\.pdf\.metadata\.json$/i, "");
    fileName = fileName.replace(/\.metadata\.json$/i, "");
    if (!fileName.toLowerCase().endsWith(".pdf")) {
      fileName = `${fileName}.pdf`;
    }

    const payload = {
      metadataAttributes: {
        display_name: displayName,
        year,
        title,
        url,
        doc_type: "webpage",
      },
    };

    if (!fs.existsSync(POLICIES_DIR)) {
      fs.mkdirSync(POLICIES_DIR, { recursive: true });
    }

    const outName = `${fileName}.metadata.json`;
    const outPath = path.join(POLICIES_DIR, outName);
    fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");

    console.log(`\nWrote ${outPath}`);
    console.log(JSON.stringify(payload, null, 2));
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
