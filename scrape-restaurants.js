/**
 * Deliveroo UAE Restaurant Page Scraper (Phase 2)
 *
 * Fetches detailed restaurant information from individual restaurant pages.
 *
 * Flow:
 *  1. GET restaurant page URLs from Apps Script (reads Sheet 2)
 *  2. GET already-processed Restaurant IDs from Apps Script (reads Sheet 3)
 *  3. For each unprocessed restaurant, fetch its page and extract __NEXT_DATA__
 *  4. POST restaurant details to Apps Script in batches
 *
 * Supports resumption: re-running picks up where the previous run left off.
 * Designed to run as a GitHub Action (workflow_dispatch).
 */

// -- Configuration ----------------------------------------------------------------
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '3', 10);
const BATCH_SIZE = 10; // restaurants per POST to Apps Script
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;
const MAX_APPS_SCRIPT_RETRIES = 8;     // More retries for Apps Script (intermittent HTML responses)
const APPS_SCRIPT_RETRY_DELAY_MS = 8000; // 8s between Apps Script retries
const FETCH_DELAY_MS = 1500; // 1.5s between concurrent chunks
const POST_DELAY_MS = 300;
const BATCH_PAUSE_MS = 10000; // 10s pause every BATCH_PAUSE_EVERY restaurants
const BATCH_PAUSE_EVERY = 200;

// Rate-limit (429) specific config
const RATE_LIMIT_INITIAL_BACKOFF_MS = 60000; // 60s first 429 backoff
const MAX_RATE_LIMIT_RETRIES = 5;            // more retries for 429
const RATE_LIMIT_COOLDOWN_MS = 90000;        // 90s cooldown after 429 streak

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

// -- Helpers ----------------------------------------------------------------------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timestamp() {
  return new Date().toISOString().slice(11, 19);
}

/**
 * Extract __NEXT_DATA__ JSON from HTML string
 */
function extractNextData(html) {
  const marker = '<script id="__NEXT_DATA__" type="application/json">';
  const startIdx = html.indexOf(marker);
  if (startIdx === -1) return null;

  const jsonStart = startIdx + marker.length;
  const endMarker = '</script>';
  const endIdx = html.indexOf(endMarker, jsonStart);
  if (endIdx === -1) return null;

  return JSON.parse(html.substring(jsonStart, endIdx));
}

/**
 * Extract cuisine texts from header tags.
 * Filters out non-cuisine spans (ratings, distances, prices, times, separators).
 */
function extractCuisines(headerTags) {
  if (!headerTags?.lines) return '';

  const cuisines = [];
  const firstLine = headerTags.lines[0]; // Cuisines are always on the first line
  if (!firstLine?.spans) return '';

  for (const span of firstLine.spans) {
    if (span.typeName !== 'UISpanText') continue;
    const text = (span.text || '').trim();
    if (!text || text === '·') continue;
    // Skip non-cuisine spans (ratings, distances, times, prices)
    if (/^\d+\.\d/.test(text)) continue; // "4.8", "3.44 km away"
    if (/km\s*(away)?/i.test(text)) continue;
    if (/close/i.test(text)) continue;
    if (/AED/i.test(text)) continue;
    if (/minimum/i.test(text)) continue;
    if (/delivery/i.test(text)) continue;
    if (/excellent|good|okay|new on/i.test(text)) continue;
    if (/^\(\d/.test(text)) continue; // "(35)", "(500+)"
    cuisines.push(text);
  }

  return cuisines.join(', ');
}

// -- Step 1: Fetch restaurant URLs from Sheet 2 via Apps Script -------------------
async function getRestaurantUrls() {
  const allRestaurants = [];
  let offset = 0;
  const limit = 5000;

  while (true) {
    const url = `${APPS_SCRIPT_URL}?action=getRestaurantUrls&offset=${offset}&limit=${limit}`;

    for (let attempt = 1; attempt <= MAX_APPS_SCRIPT_RETRIES; attempt++) {
      try {
        const resp = await fetch(url, { redirect: 'follow' });
        const text = await resp.text();

        // Apps Script intermittently returns HTML instead of JSON (cold starts, Google infra)
        if (text.trimStart().startsWith('<!DOCTYPE') || text.trimStart().startsWith('<html')) {
          throw new Error('Apps Script returned HTML instead of JSON (intermittent Google issue)');
        }

        const data = JSON.parse(text);
        if (data.error) throw new Error(data.error);

        allRestaurants.push(...data.restaurants);
        console.log(
          `  [${timestamp()}] offset=${offset}  got=${data.restaurants.length}  cumulative=${allRestaurants.length}  total=${data.total}`
        );

        if (!data.hasMore) return allRestaurants;
        offset += limit;
        break;
      } catch (err) {
        console.error(
          `  Attempt ${attempt}/${MAX_APPS_SCRIPT_RETRIES} to fetch URLs failed: ${err.message}`
        );
        if (attempt === MAX_APPS_SCRIPT_RETRIES) throw err;
        await sleep(APPS_SCRIPT_RETRY_DELAY_MS * attempt);
      }
    }
  }
}

// -- Step 2: Fetch already-processed IDs from Sheet 3 -----------------------------
async function getProcessedIds() {
  for (let attempt = 1; attempt <= MAX_APPS_SCRIPT_RETRIES; attempt++) {
    try {
      const url = `${APPS_SCRIPT_URL}?action=getProcessedIds`;
      const resp = await fetch(url, { redirect: 'follow' });
      const text = await resp.text();

      // Handle intermittent HTML responses from Apps Script
      if (text.trimStart().startsWith('<!DOCTYPE') || text.trimStart().startsWith('<html')) {
        throw new Error('Apps Script returned HTML instead of JSON (intermittent Google issue)');
      }

      const data = JSON.parse(text);
      if (data.error) throw new Error(data.error);
      return new Set(data.ids.map((id) => String(id)));
    } catch (err) {
      console.error(
        `  Attempt ${attempt}/${MAX_APPS_SCRIPT_RETRIES} to fetch processed IDs: ${err.message}`
      );
      if (attempt === MAX_APPS_SCRIPT_RETRIES) throw err;
      await sleep(APPS_SCRIPT_RETRY_DELAY_MS * attempt);
    }
  }
}

// -- Step 3: Fetch a single restaurant page and extract data ----------------------
async function fetchRestaurantPage(restaurant) {
  // Append geohash query param so Deliveroo serves the page (otherwise 403)
  let url = restaurant.url;
  if (restaurant.geohash) {
    const separator = url.includes('?') ? '&' : '?';
    url = `${url}${separator}geohash=${restaurant.geohash}`;
  }
  let retries = MAX_RETRIES;
  let isRateLimited = false;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
      });

      // Handle 404 — restaurant page no longer exists
      if (resp.status === 404) {
        console.log(
          `  [${timestamp()}] ${restaurant.id}: HTTP 404 — skipping (dead page)`
        );
        return null; // Signal to caller: skip, not an error
      }

      // Handle 429 — rate limited
      if (resp.status === 429) {
        if (!isRateLimited) {
          isRateLimited = true;
          retries = MAX_RATE_LIMIT_RETRIES;
        }
        const backoff = RATE_LIMIT_INITIAL_BACKOFF_MS * attempt;
        console.warn(
          `  [${timestamp()}] Attempt ${attempt}/${retries} — HTTP 429 for ${restaurant.id}. Backing off ${(backoff / 1000).toFixed(0)}s...`
        );
        await sleep(backoff);
        continue;
      }

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const html = await resp.text();
      const nextData = extractNextData(html);

      if (!nextData) throw new Error('No __NEXT_DATA__');

      const root = nextData?.props?.initialState?.menuPage?.menu?.metas?.root;
      if (!root) throw new Error('No menu root data');

      const r = root.restaurant;
      if (!r) throw new Error('No restaurant object');

      const header = nextData?.props?.initialState?.menuPage?.menu?.header;
      const cuisines = extractCuisines(header?.headerTags);

      // Count categories and items
      const totalCategories = root.categories
        ? Object.keys(root.categories).length
        : 0;
      const totalItems = root.items ? Object.keys(root.items).length : 0;

      // Build the canonical restaurant page URL from self link
      const selfHref = r.links?.self?.href || '';
      const restaurantPageUrl = selfHref
        ? `https://deliveroo.ae/en${selfHref}`
        : url;

      return {
        brandDrnId: r.brandDrnId || '',
        restaurantId: String(r.id || ''),
        restaurantName: r.name || '',
        restaurantSlug: r.uname || '',
        branchType: r.branchType || '',
        restaurantNeighbourhood: r.location?.address?.neighborhood || '',
        address: r.location?.address?.address1 || '',
        postCode: r.location?.address?.postCode || '',
        city: r.location?.address?.city || '',
        country: r.location?.address?.country || '',
        cityId: r.location?.cityId || '',
        zoneId: r.location?.zoneId || '',
        menuId: r.menuId || '',
        fulfilmentType: r.fulfillmentType || '',
        cuisines: cuisines,
        totalMenuCategories: totalCategories,
        totalMenuItems: totalItems,
        restaurantPageUrl: restaurantPageUrl,
      };
    } catch (err) {
      if (!isRateLimited || !err.message?.includes('429')) {
        console.error(
          `  [${timestamp()}] Attempt ${attempt}/${retries} failed for ${restaurant.id}: ${err.message}`
        );
      }
      if (attempt < retries) {
        const delay = isRateLimited
          ? RATE_LIMIT_INITIAL_BACKOFF_MS * attempt
          : RETRY_DELAY_MS * attempt;
        await sleep(delay);
      } else {
        throw new Error(`${restaurant.id}: ${err.message}`);
      }
    }
  }
}

// -- Step 4: POST a batch to Apps Script ------------------------------------------
async function postRestaurantInfo(restaurants) {
  for (let attempt = 1; attempt <= MAX_APPS_SCRIPT_RETRIES; attempt++) {
    try {
      const resp = await fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'restaurantInfo', restaurants }),
        redirect: 'follow',
      });

      const text = await resp.text();

      // Handle intermittent HTML responses from Apps Script
      if (text.trimStart().startsWith('<!DOCTYPE') || text.trimStart().startsWith('<html')) {
        throw new Error('Apps Script returned HTML instead of JSON (intermittent Google issue)');
      }

      let result;
      try {
        result = JSON.parse(text);
      } catch {
        result = { raw: text };
      }
      if (result.error) throw new Error(result.error);
      return result;
    } catch (err) {
      if (attempt < MAX_APPS_SCRIPT_RETRIES) {
        console.error(`  POST attempt ${attempt}: ${err.message}`);
        await sleep(APPS_SCRIPT_RETRY_DELAY_MS * attempt);
      } else {
        throw err;
      }
    }
  }
}

// -- Main processing loop ---------------------------------------------------------
async function processRestaurants(restaurants) {
  let completed = 0;
  let skipped = 0;
  let errors = 0;
  let posted = 0;
  let batch = [];
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 10;
  let totalProcessed = 0;

  for (let i = 0; i < restaurants.length; i += CONCURRENCY) {
    const chunk = restaurants.slice(i, i + CONCURRENCY);

    // Fetch pages (sequentially when CONCURRENCY=1, or concurrently)
    const results = await Promise.allSettled(
      chunk.map((r, idx) =>
        sleep(idx * 500).then(() => fetchRestaurantPage(r))
      )
    );

    for (const r of results) {
      totalProcessed++;

      if (r.status === 'fulfilled') {
        if (r.value === null) {
          // 404 — skipped dead page
          skipped++;
          consecutiveErrors = 0;
        } else {
          batch.push(r.value);
          completed++;
          consecutiveErrors = 0;

          // Flush when batch is full
          if (batch.length >= BATCH_SIZE) {
            posted++;
            try {
              await postRestaurantInfo(batch);
              console.log(
                `  [${timestamp()}] Batch #${posted}: sent ${batch.length} restaurants  (${completed}/${restaurants.length} fetched, ${skipped} skipped, ${errors} errors)`
              );
            } catch (err) {
              console.error(`  Batch #${posted} FAILED: ${err.message}`);
            }
            batch = [];
            await sleep(POST_DELAY_MS);
          }
        }
      } else {
        errors++;
        consecutiveErrors++;
        const errMsg = r.reason?.message || 'Unknown error';
        console.error(`  SKIP: ${errMsg}`);

        // If rate-limited, add cooldown
        if (errMsg.includes('429')) {
          console.log(
            `  [${timestamp()}] Rate-limit cooldown: waiting ${(RATE_LIMIT_COOLDOWN_MS / 1000).toFixed(0)}s before next restaurant...`
          );
          await sleep(RATE_LIMIT_COOLDOWN_MS);
          consecutiveErrors = Math.max(0, consecutiveErrors - 1);
        }

        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          console.error(
            `\n${MAX_CONSECUTIVE_ERRORS} consecutive errors. Aborting.`
          );
          console.error(
            `Processed ${totalProcessed} restaurants. Re-run to resume (auto-resumes from Sheet 3).`
          );
          // Flush remaining batch before aborting
          if (batch.length > 0) {
            try {
              await postRestaurantInfo(batch);
              console.log(`  Flushed ${batch.length} restaurants before abort`);
            } catch (err) {
              console.error(`  Flush failed: ${err.message}`);
            }
          }
          return { completed, skipped, errors, batches: posted, aborted: true };
        }
      }
    }

    // Progress heartbeat every 100 restaurants
    if (totalProcessed % 100 < CONCURRENCY) {
      const pct = ((totalProcessed / restaurants.length) * 100).toFixed(1);
      const elapsed = ((Date.now() - globalStart) / 60000).toFixed(1);
      const rate = (totalProcessed / (Date.now() - globalStart) * 60000).toFixed(0);
      console.log(
        `\n  -- Progress: ${totalProcessed}/${restaurants.length} (${pct}%) | ${elapsed} min | ~${rate}/min | ${completed} ok, ${skipped} skipped, ${errors} errors --\n`
      );
    }

    // Batch pause every N restaurants to avoid sustained rate limiting
    if (totalProcessed > 0 && totalProcessed % BATCH_PAUSE_EVERY === 0 && i < restaurants.length - 1) {
      console.log(
        `\n--- Batch pause after ${totalProcessed} restaurants (${completed} fetched so far) ---\n`
      );
      await sleep(BATCH_PAUSE_MS);
    } else {
      await sleep(FETCH_DELAY_MS);
    }
  }

  // Flush remaining
  if (batch.length > 0) {
    posted++;
    try {
      await postRestaurantInfo(batch);
      console.log(
        `  [${timestamp()}] Final batch #${posted}: sent ${batch.length} restaurants`
      );
    } catch (err) {
      console.error(`  Final batch FAILED: ${err.message}`);
    }
  }

  return { completed, skipped, errors, batches: posted, aborted: false };
}

// -- Entry point ------------------------------------------------------------------
let globalStart;

async function main() {
  if (!APPS_SCRIPT_URL) {
    console.error('ERROR: APPS_SCRIPT_URL environment variable is not set.');
    process.exit(1);
  }

  globalStart = Date.now();
  console.log('=== Deliveroo UAE Restaurant Scraper - Phase 2 ===');
  console.log(`Concurrency : ${CONCURRENCY}`);
  console.log(`Batch size  : ${BATCH_SIZE} restaurants per POST`);
  console.log(`Fetch delay : ${FETCH_DELAY_MS}ms | Batch pause: ${BATCH_PAUSE_MS}ms every ${BATCH_PAUSE_EVERY}`);
  console.log(`429 backoff : ${RATE_LIMIT_INITIAL_BACKOFF_MS}ms x attempt (max ${MAX_RATE_LIMIT_RETRIES} retries)`);
  console.log(`Started at  : ${new Date().toISOString()}`);
  console.log('');

  // 1 - Get restaurant URLs from Sheet 2
  console.log('Step 1 - Fetching restaurant URLs from Sheet 2 ...');
  const allRestaurants = await getRestaurantUrls();
  console.log(`  Done: ${allRestaurants.length} restaurants with URLs\n`);

  // 2 - Get already-processed IDs (for resumption)
  console.log('Step 2 - Checking already-processed restaurants in Sheet 3 ...');
  const processedIds = await getProcessedIds();
  console.log(`  Done: ${processedIds.size} restaurants already processed\n`);

  // 3 - Filter to unprocessed
  const remaining = allRestaurants.filter(
    (r) => !processedIds.has(String(r.id))
  );
  console.log(`  -> ${remaining.length} restaurants remaining to process\n`);

  if (remaining.length === 0) {
    console.log('All restaurants already processed. Nothing to do.');
    return;
  }

  // 4 - Scrape & post
  console.log(`Step 3 - Scraping ${remaining.length} restaurant pages ...\n`);
  const { completed, skipped, errors, batches, aborted } =
    await processRestaurants(remaining);

  const elapsed = ((Date.now() - globalStart) / 60000).toFixed(1);
  console.log('\n=== Phase 2 Complete ===');
  console.log(`Restaurants fetched : ${completed}`);
  console.log(`Restaurants skipped : ${skipped} (404 dead pages)`);
  console.log(`Errors / failures   : ${errors}`);
  console.log(`Batches posted      : ${batches}`);
  console.log(`Wall time           : ${elapsed} minutes`);

  if (aborted) {
    console.log('\nRun was aborted due to consecutive errors.');
    console.log('Re-run the workflow to resume — it picks up from Sheet 3 automatically.');
    process.exit(1);
  }

  if (errors > 0) {
    console.log(`\nNote: ${errors} restaurants were skipped due to errors.`);
    console.log(
      'Re-run this workflow to retry them (resumption is automatic).'
    );
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
