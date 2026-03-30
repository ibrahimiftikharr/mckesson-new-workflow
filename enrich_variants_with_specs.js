/*
  Enrich variant-level JSON with productSpecifications from mms.mckesson.com.

  Input:  shopify_variants.json (JSON array)
  Output: shopify_variants_with_specs.jsonl (append-only JSON Lines)
  Log:    specs_enrichment.log (append-only, resumable)

  Why JSONL:
  - It supports true append-only writes for large processing jobs.
  - Each line is one complete JSON object.

  Optional env vars:
    INPUT_FILE=shopify_variants.json
    OUTPUT_FILE=shopify_variants_with_specs.jsonl
    LOG_FILE=specs_enrichment.log
    BATCH_SIZE=100
    REQUEST_TIMEOUT_MS=20000
    MAX_RETRIES=3
    RETRY_BASE_DELAY_MS=750
    START_INDEX=1
    END_INDEX=0
*/

const fs = require("fs");
const path = require("path");

const INPUT_FILE = process.env.INPUT_FILE || "shopify_variants.json";
const OUTPUT_FILE = process.env.OUTPUT_FILE || "shopify_variants_with_specs.jsonl";
const LOG_FILE = process.env.LOG_FILE || "specs_enrichment.log";
const BATCH_SIZE = Number(process.env.BATCH_SIZE || 100);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 20000);
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 3);
const RETRY_BASE_DELAY_MS = Number(process.env.RETRY_BASE_DELAY_MS || 750);
const START_INDEX = Number(process.env.START_INDEX || 1);
const END_INDEX = Number(process.env.END_INDEX || 0);

const EXCLUDED_KEYS = new Set([
  "McKesson #",
  "Manufacturer #",
  "Brand",
  "Manufacturer",
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(input) {
  if (!input) return "";

  const named = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    reg: "®",
    trade: "™",
  };

  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (full, entity) => {
    if (entity[0] === "#") {
      const isHex = entity[1] === "x" || entity[1] === "X";
      const codePoint = parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (!Number.isFinite(codePoint)) return full;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return full;
      }
    }

    const lower = entity.toLowerCase();
    return Object.prototype.hasOwnProperty.call(named, lower) ? named[lower] : full;
  });
}

function stripTags(html) {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, " "));
}

function extractSpecificationsSection(html) {
  const byId = html.match(/<div[^>]*id=["']specifications["'][^>]*>[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/i);
  if (byId) return byId[0];

  const byHeading = html.match(/Product Specifications[\s\S]*?<table[\s\S]*?<\/table>/i);
  if (byHeading) return byHeading[0];

  return html;
}

function parseProductSpecificationsFromHtml(html) {
  const section = extractSpecificationsSection(html);
  const specs = {};

  const trRegex = /<tr[^>]*>[\s\S]*?<\/tr>/gi;
  const rows = section.match(trRegex) || [];

  for (const rowHtml of rows) {
    const keyMatch = rowHtml.match(/<th[^>]*>([\s\S]*?)<\/th>/i);
    const valueMatch = rowHtml.match(/<td[^>]*>([\s\S]*?)<\/td>/i);
    if (!keyMatch || !valueMatch) continue;

    const rawKey = normalizeWhitespace(stripTags(keyMatch[1]));
    const rawValue = normalizeWhitespace(stripTags(valueMatch[1]));

    if (!rawKey || !rawValue) continue;
    if (EXCLUDED_KEYS.has(rawKey)) continue;

    specs[rawKey] = rawValue;
  }

  return specs;
}

async function fetchHtmlForSupplierId(supplierId) {
  const url = `https://mms.mckesson.com/product/${encodeURIComponent(supplierId)}`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; VariantSpecsEnricher/1.0)",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      const html = await res.text();
      return html;
    } catch (err) {
      if (attempt === MAX_RETRIES) {
        throw err;
      }
      const delay = RETRY_BASE_DELAY_MS * attempt;
      await sleep(delay);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error("Exhausted retries");
}

function appendLines(filePath, lines) {
  if (!lines.length) return;
  fs.appendFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function makeLogLine(index1Based, variantId, status, message) {
  const now = new Date().toISOString();
  const safeMessage = (message || "").replace(/[\r\n\t]+/g, " ").trim();
  return `${now}\t${index1Based}\t${variantId || ""}\t${status}\t${safeMessage}`;
}

function readLastSuccessfulIndex(logPath) {
  if (!fs.existsSync(logPath)) return 0;

  const text = fs.readFileSync(logPath, "utf8");
  if (!text.trim()) return 0;

  const lines = text.split(/\r?\n/);
  let last = 0;

  for (const line of lines) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 4) continue;

    const index = Number(parts[1]);
    const status = parts[3];

    if (Number.isFinite(index) && status === "SUCCESS") {
      if (index > last) last = index;
    }
  }

  return last;
}

function loadVariants(inputPath) {
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  const raw = fs.readFileSync(inputPath, "utf8");
  const parsed = JSON.parse(raw);

  if (!Array.isArray(parsed)) {
    throw new Error("Input must be a JSON array.");
  }

  return parsed;
}

async function main() {
  const cwd = process.cwd();
  const inputPath = path.join(cwd, INPUT_FILE);
  const outputPath = path.join(cwd, OUTPUT_FILE);
  const logPath = path.join(cwd, LOG_FILE);

  const variants = loadVariants(inputPath);

  const lastSuccess = readLastSuccessfulIndex(logPath);
  const computedStart = Math.max(START_INDEX, lastSuccess + 1);
  const computedEnd = END_INDEX > 0 ? Math.min(END_INDEX, variants.length) : variants.length;

  if (computedStart > computedEnd) {
    console.log("No work to do. Already processed requested range.");
    return;
  }

  const specsCache = new Map();
  let previousSupplierId = null;
  let previousSpecs = {};

  let outputBatch = [];
  let successLogBatch = [];

  let processed = 0;
  let failed = 0;

  for (let i = computedStart - 1; i < computedEnd; i += 1) {
    const item = variants[i];
    const index1Based = i + 1;
    const variantId = item.variantId || "";
    const supplierId = item.supplierId || "";

    try {
      let specs = {};

      if (supplierId) {
        if (supplierId === previousSupplierId) {
          specs = previousSpecs;
        } else if (specsCache.has(supplierId)) {
          specs = specsCache.get(supplierId);
        } else {
          const html = await fetchHtmlForSupplierId(supplierId);
          specs = parseProductSpecificationsFromHtml(html);
          specsCache.set(supplierId, specs);
        }
      }

      previousSupplierId = supplierId;
      previousSpecs = specs;

      const enriched = {
        ...item,
        productSpecifications: specs,
      };

      outputBatch.push(JSON.stringify(enriched));
      successLogBatch.push(makeLogLine(index1Based, variantId, "SUCCESS", ""));
      processed += 1;
    } catch (err) {
      failed += 1;
      appendLines(logPath, [
        makeLogLine(index1Based, variantId, "FAILED", err && err.message ? err.message : String(err)),
      ]);
    }

    if (outputBatch.length >= BATCH_SIZE) {
      appendLines(outputPath, outputBatch);
      appendLines(logPath, successLogBatch);
      outputBatch = [];
      successLogBatch = [];
    }
  }

  if (outputBatch.length) {
    appendLines(outputPath, outputBatch);
    appendLines(logPath, successLogBatch);
  }

  console.log(
    JSON.stringify(
      {
        inputFile: INPUT_FILE,
        outputFile: OUTPUT_FILE,
        logFile: LOG_FILE,
        startIndex: computedStart,
        endIndex: computedEnd,
        processed,
        failed,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error("Fatal error:", err && err.message ? err.message : err);
  process.exit(1);
});
