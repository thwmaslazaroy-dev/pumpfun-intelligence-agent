/**
 * Read-only probe: investigates what https://pump.fun/?tab=created_timestamp
 * returns via plain HTTP GET (no browser automation).
 *
 * Findings logged to stdout only — no writes to DB, Discord, or RPC.
 */

import { logger } from "../utils/logger";

const TARGET_URL = "https://pump.fun/?tab=created_timestamp";
const API_URL =
  "https://frontend-api-v3.pump.fun/coins?sort=created_timestamp&order=DESC&limit=10";
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_MINTS_SHOWN = 10;

const COIN_FIELDS = [
  "mint",
  "creator",
  "name",
  "symbol",
  "created_timestamp",
  "market_cap",
  "reply_count",
  "nsfw",
] as const;
type CoinField = (typeof COIN_FIELDS)[number];

// Solana base58 mint addresses: 32–44 chars, base58 alphabet
const MINT_RE = /\/coin\/([1-9A-HJ-NP-Za-km-z]{32,44})/g;

// API-like keywords to hunt for in the raw HTML/script content
const API_KEYWORDS = [
  "created_timestamp",
  "frontend-api",
  "graphql",
  "/api/",
  "coins",
  "pump.fun/api",
  "pumpfun",
];

// Generic URL pattern — grabs anything that looks like https?://... up to a quote/space
const URL_RE = /https?:\/\/[^\s"'`<>)]+/g;

function out(line: string): void {
  process.stdout.write(line + "\n");
}

function section(title: string): void {
  out("");
  out(`=== ${title} ===`);
}

async function main(): Promise<void> {
  out("probe-pumpfun-created-feed starting");
  out(`target: ${TARGET_URL}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let status = 0;
  let contentType = "(unknown)";
  let html = "";

  try {
    const res = await fetch(TARGET_URL, {
      method: "GET",
      headers: {
        // Minimal browser-like UA so Cloudflare/CDN doesn't block outright
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
      signal: controller.signal,
      // Node's fetch follows redirects by default (redirect: "follow")
    });

    clearTimeout(timer);
    status = res.status;
    contentType = res.headers.get("content-type") ?? "(none)";
    html = await res.text();
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("fetch failed", { error: msg });
    out(`\nFATAL: fetch failed — ${msg}`);
    process.exit(1);
  }

  // ── 1. Basic response info ───────────────────────────────────────────────
  section("HTTP response");
  out(`  status:        ${status}`);
  out(`  content-type:  ${contentType}`);
  out(`  html length:   ${html.length} bytes`);

  // ── 2. Coin links (/coin/<mint>) ─────────────────────────────────────────
  section("coin links found in HTML");
  const mintMatches = Array.from(html.matchAll(MINT_RE));
  const uniqueMints = Array.from(new Set(mintMatches.map((m) => m[1])));
  out(`  total /coin/<mint> occurrences: ${mintMatches.length}`);
  out(`  unique mints:                   ${uniqueMints.length}`);
  if (uniqueMints.length > 0) {
    out(`  first ${Math.min(MAX_MINTS_SHOWN, uniqueMints.length)} mints:`);
    uniqueMints.slice(0, MAX_MINTS_SHOWN).forEach((mint, i) => {
      out(`    [${i + 1}] ${mint}  →  https://pump.fun/coin/${mint}`);
    });
  } else {
    out("  (none found — page likely rendered client-side)");
  }

  // ── 3. API keyword scan ──────────────────────────────────────────────────
  section("API keyword hits in raw HTML");
  for (const kw of API_KEYWORDS) {
    const idx = html.indexOf(kw);
    if (idx === -1) {
      out(`  [miss]  "${kw}"`);
      continue;
    }
    // Show a short snippet around the hit
    const start = Math.max(0, idx - 40);
    const end = Math.min(html.length, idx + kw.length + 80);
    const snippet = html.slice(start, end).replace(/\s+/g, " ").trim();
    out(`  [HIT]   "${kw}"`);
    out(`          …${snippet}…`);
  }

  // ── 4. All https?:// URLs embedded in HTML ───────────────────────────────
  section("external URLs embedded in HTML (first 40 unique)");
  const allUrls = Array.from(html.matchAll(URL_RE)).map((m) =>
    m[0].replace(/[,;'")\]>]+$/, ""),
  );
  const uniqueUrls = Array.from(new Set(allUrls));
  out(`  total URL occurrences: ${allUrls.length}`);
  out(`  unique URLs:           ${uniqueUrls.length}`);

  // Filter to API-looking ones first
  const apiLike = uniqueUrls.filter((u) =>
    /api|graphql|created_timestamp|coins|pump\.fun\/_next\/data|pump\.fun\/api/i.test(u),
  );
  if (apiLike.length > 0) {
    out(`\n  API-like URLs (${apiLike.length}):`);
    apiLike.slice(0, 40).forEach((u, i) => out(`    [${i + 1}] ${u}`));
  } else {
    out("  (no API-like URLs detected)");
  }

  // Show first 40 unique URLs regardless
  out(`\n  all unique URLs (up to 40):`);
  uniqueUrls.slice(0, 40).forEach((u, i) => out(`    [${i + 1}] ${u}`));

  // ── 5. __NEXT_DATA__ inspection ──────────────────────────────────────────
  section("__NEXT_DATA__ (Next.js initial props)");
  const ndStart = html.indexOf('id="__NEXT_DATA__"');
  if (ndStart === -1) {
    out("  __NEXT_DATA__ script tag not found");
    out("  (page may use a different framework or be fully client-rendered)");
  } else {
    const jsonStart = html.indexOf(">", ndStart) + 1;
    const jsonEnd = html.indexOf("</script>", jsonStart);
    if (jsonStart > 0 && jsonEnd > jsonStart) {
      const raw = html.slice(jsonStart, jsonEnd).trim();
      out(`  __NEXT_DATA__ JSON length: ${raw.length} bytes`);
      try {
        const nd = JSON.parse(raw) as Record<string, unknown>;
        // Log top-level keys only — avoid dumping the full blob
        out(`  top-level keys: ${Object.keys(nd).join(", ")}`);
        // Check props for any coin/token data
        const props = nd["props"];
        if (typeof props === "object" && props !== null) {
          out(`  props keys: ${Object.keys(props as object).join(", ")}`);
        }
        const page = nd["page"];
        out(`  page route: ${String(page ?? "(missing)")}`);
        out(`  query: ${JSON.stringify(nd["query"] ?? {})}`);
      } catch (err) {
        out(`  JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
        out(`  raw snippet (first 200 chars): ${raw.slice(0, 200)}`);
      }
    } else {
      out("  could not extract JSON from __NEXT_DATA__ tag");
    }
  }

  // ── 6. Script src tags (may point to chunk bundles with embedded API URLs) ─
  section("script src tags (first 20)");
  const scriptSrcRe = /<script[^>]+src=["']([^"']+)["'][^>]*>/g;
  const scriptSrcs = Array.from(html.matchAll(scriptSrcRe)).map((m) => m[1]);
  out(`  total <script src> tags: ${scriptSrcs.length}`);
  scriptSrcs.slice(0, 20).forEach((s, i) => out(`    [${i + 1}] ${s}`));

  // ── 7. Summary verdict ───────────────────────────────────────────────────
  section("verdict");
  if (status !== 200) {
    out(`  Non-200 response (${status}) — cannot draw firm conclusions.`);
  } else if (uniqueMints.length > 0) {
    out(
      `  Server-rendered HTML contains ${uniqueMints.length} coin links — ` +
        "data is available without a browser.",
    );
  } else {
    out("  No coin links found in server HTML.");
    if (apiLike.length > 0) {
      out(`  ${apiLike.length} API-like URL(s) found — may be callable directly.`);
    } else {
      out(
        "  Page appears to be fully client-rendered (SPA). " +
          "Browser automation or network traffic capture is likely required " +
          "to discover the underlying JSON/API endpoint.",
      );
    }
  }

  out("");

  // ── 8. Direct API probe ──────────────────────────────────────────────────
  await probeApi();

  logger.info("probe-pumpfun-created-feed finished", {
    status,
    contentType,
    htmlLength: html.length,
    uniqueMints: uniqueMints.length,
    uniqueUrls: uniqueUrls.length,
    apiLikeUrls: apiLike.length,
  });
}

async function probeApi(): Promise<void> {
  section(`frontend-api-v3 direct probe`);
  out(`  url: ${API_URL}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let apiStatus = 0;
  let apiContentType = "(unknown)";
  let body = "";

  try {
    const res = await fetch(API_URL, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "application/json, */*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        Referer: "https://pump.fun/",
        Origin: "https://pump.fun",
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    apiStatus = res.status;
    apiContentType = res.headers.get("content-type") ?? "(none)";
    body = await res.text();
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    out(`  fetch error: ${msg}`);
    return;
  }

  out(`  status:        ${apiStatus}`);
  out(`  content-type:  ${apiContentType}`);
  out(`  body length:   ${body.length} bytes`);

  if (apiStatus !== 200) {
    out(`  body snippet:  ${body.slice(0, 300)}`);
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    out(`  JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
    out(`  raw snippet: ${body.slice(0, 300)}`);
    return;
  }

  // Top-level shape
  if (Array.isArray(parsed)) {
    out(`  top-level shape: Array  (length ${parsed.length})`);
    printCoins(parsed);
  } else if (typeof parsed === "object" && parsed !== null) {
    const keys = Object.keys(parsed as object);
    out(`  top-level shape: Object  keys=[${keys.join(", ")}]`);
    // Unwrap common envelope patterns
    const rec = parsed as Record<string, unknown>;
    const candidate =
      rec["coins"] ?? rec["data"] ?? rec["results"] ?? rec["items"] ?? rec["tokens"];
    if (Array.isArray(candidate)) {
      out(`  coin array found under key "${Object.keys(rec).find((k) => rec[k] === candidate)!}"  (length ${candidate.length})`);
      printCoins(candidate);
    } else {
      out("  no recognisable coin array found in object");
      out(`  raw snippet: ${body.slice(0, 500)}`);
    }
  } else {
    out(`  unexpected top-level type: ${typeof parsed}`);
    out(`  raw snippet: ${body.slice(0, 300)}`);
  }
}

function printCoins(coins: unknown[]): void {
  out(`\n  first ${Math.min(10, coins.length)} coin(s):`);
  coins.slice(0, 10).forEach((coin, i) => {
    if (typeof coin !== "object" || coin === null) {
      out(`    [${i + 1}] (non-object entry: ${String(coin)})`);
      return;
    }
    const c = coin as Record<string, unknown>;
    out(`    [${i + 1}]`);
    for (const field of COIN_FIELDS) {
      const val = c[field as CoinField];
      if (val === undefined) {
        out(`      ${field.padEnd(20)} (missing)`);
      } else if (field === "created_timestamp" && typeof val === "number") {
        const iso = new Date(val).toISOString();
        out(`      ${field.padEnd(20)} ${val}  (${iso})`);
      } else {
        out(`      ${field.padEnd(20)} ${JSON.stringify(val)}`);
      }
    }
  });
}

void main().catch((err) => {
  logger.error("probe unhandled error", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
