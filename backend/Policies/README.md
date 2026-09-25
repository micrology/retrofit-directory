# Policy corpus (local prep only)

Place policy PDFs, Markdown extracts, Zotero RDF exports, and Bedrock Knowledge
Base sidecar files (`*.metadata.json`) here while preparing the corpus.

Runtime query answering does **not** read this folder — production uses the
Bedrock Knowledge Base / S3 bucket. Prefer not to commit bulk documents; they
are gitignored except this README.

Generate sidecars with scripts under `../gen-metadata/` (run from `backend/`):

```bash
node gen-metadata/fetch-policy-page.js <url>
node gen-metadata/generate-policy-metadata.js
node gen-metadata/write-metadata.js
```
