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
const FETCH_DELAY_MS = 1500; // ms between concurrency groups
const POST_DELAY_MS = 500;

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

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const resp = await fetch(url, { redirect: 'follow' });
        const data = await resp.json();
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
          `  Attempt ${attempt}/${MAX_RETRIES} to fetch URLs failed: ${err.message}`
        );
        if (attempt === MAX_RETRIES) throw err;
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }
}

// -- Step 2: Fetch already-processed IDs from Sheet 3 -----------------------------
async function getProcessedIds() {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const url = `${APPS_SCRIPT_URL}?action=getProcessedIds`;
      const resp = await fetch(url, { redirect: 'follow' });
      const data = await resp.json();
      if (data.error) throw new Error(data.error);
      return new Set(data.ids.map((id) => String(id)));
    } catch (err) {
      console.error(
        `  Attempt ${attempt}/${MAX_RETRIES} to fetch processed IDs: ${err.message}`
      );
      if (attempt === MAX_RETRIES) throw err;
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }
}

// -- Step 3: Fetch a single restaurant page and extract data ----------------------
async function fetchRestaurantPage(restaurant) {
  const url = restaurant.url;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
      });

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
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      } else {
        throw new Error(`${restaurant.id}: ${err.message}`);
      }
    }
  }
}

// -- Step 4: POST a batch to Apps Script ------------------------------------------
async function postRestaurantInfo(restaurants) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'restaurantInfo', restaurants }),
        redirect: 'follow',
      });

      const text = await resp.text();
      let result;
      try {
        result = JSON.parse(text);
      } catch {
        result = { raw: text };
      }
      if (result.error) throw new Error(result.error);
      return result;
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        console.error(`  POST attempt ${attempt}: ${err.message}`);
        await sleep(RETRY_DELAY_MS * attempt);
      } else {
        throw err;
      }
    }
  }
}

// -- Main processing loop ---------------------------------------------------------
async function processRestaurants(restaurants) {
  let completed = 0;
  let errors = 0;
  let posted = 0;
  let batch = [];

  for (let i = 0; i < restaurants.length; i += CONCURRENCY) {
    const chunk = restaurants.slice(i, i + CONCURRENCY);

    // Fetch pages concurrently (staggered slightly)
    const results = await Promise.allSettled(
      chunk.map((r, idx) =>
        sleep(idx * 300).then(() => fetchRestaurantPage(r))
      )
    );

    for (const r of results) {
      if (r.status === 'fulfilled') {
        batch.push(r.value);
        completed++;

        // Flush when batch is full
        if (batch.length >= BATCH_SIZE) {
          posted++;
          try {
            await postRestaurantInfo(batch);
            console.log(
              `  [${timestamp()}] Batch #${posted}: sent ${batch.length} restaurants  (${completed}/${restaurants.length} fetched, ${errors} errors)`
            );
          } catch (err) {
            console.error(`  Batch #${posted} FAILED: ${err.message}`);
          }
          batch = [];
          await sleep(POST_DELAY_MS);
        }
      } else {
        errors++;
        console.error(`  SKIP: ${r.reason?.message}`);
      }
    }

    // Progress heartbeat every 100 restaurants
    if ((completed + errors) % 100 < CONCURRENCY) {
      const pct = (((completed + errors) / restaurants.length) * 100).toFixed(
        1
      );
      const elapsed = ((Date.now() - globalStart) / 60000).toFixed(1);
      const rate = (
        ((completed + errors) / (Date.now() - globalStart)) *
        60000
      ).toFixed(0);
      console.log(
        `\n  -- Progress: ${completed + errors}/${restaurants.length} (${pct}%) | ${elapsed} min | ~${rate}/min | ${errors} errors --\n`
      );
    }

    await sleep(FETCH_DELAY_MS);
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

  return { completed, errors, batches: posted };
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
  const { completed, errors, batches } = await processRestaurants(remaining);

  const elapsed = ((Date.now() - globalStart) / 60000).toFixed(1);
  console.log('\n=== Phase 2 Complete ===');
  console.log(`Restaurants fetched : ${completed}`);
  console.log(`Errors / skips      : ${errors}`);
  console.log(`Batches posted      : ${batches}`);
  console.log(`Wall time           : ${elapsed} minutes`);

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
