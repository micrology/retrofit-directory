# Policy corpus (local prep only)

Place policy PDFs, Markdown extracts, Zotero RDF exports, and Bedrock Knowledge
Base sidecar files (`*.metadata.json`) here while preparing the corpus.

Runtime query answering does **not** read this folder — production uses the
Bedrock Knowledge Base / S3 bucket. Prefer not to commit bulk documents; they
are gitignored except this README and small curated notes such as
`homeowner-retrofit-starter.md` (upload that pair to S3 so homeowner “how do I
start?” answers can cite a dedicated starter pack).

Generate sidecars with scripts under `../gen-metadata/` (run from `backend/`):

```bash
node gen-metadata/fetch-policy-page.js <url>
node gen-metadata/generate-policy-metadata.js
node gen-metadata/write-metadata.js
```

After preparing new Markdown/PDF + `*.metadata.json` sidecars, upload them to the
S3 bucket that backs the Bedrock Knowledge Base (see `gen-metadata/list-document-metadata`)
and re-sync/ingest the KB so RetrieveAndGenerate can use them.
