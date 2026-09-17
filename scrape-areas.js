/**
 * Deliveroo UAE Area Scraper (Phase 1)
 *
 * For each area in the directory:
 *  1. Fetches the area listing page HTML
 *  2. Extracts __NEXT_DATA__ JSON embedded in the page
 *  3. Parses area metadata (geohash, lat, lon) → Sheet 1 (Area Information)
 *  4. Parses restaurant listing blocks → Sheet 2 (List of Restaurants)
 *  5. POSTs both to a Google Apps Script web app
 *
 * Designed to run as a GitHub Action (workflow_dispatch).
 */

const AREAS = require('./areas.js');

// Config from environment
const APPS_SCRIPT_URL = process.env.APPS_SCRIPT_URL;
const START_INDEX = parseInt(process.env.START_INDEX || '0', 10);
const END_INDEX = parseInt(process.env.END_INDEX || '0', 10); // 0 = all
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '25', 10);

// Timing config
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;
const AREA_DELAY_MS = 2000;
const POST_DELAY_MS = 500;
const BATCH_PAUSE_MS = 15000;
const RESTAURANT_POST_BATCH = 200; // restaurants per POST to Apps Script

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function timestamp() {
  return new Date().toISOString().slice(11, 19);
}

/**
 * Parse rating count string into clean format
 * "(500+)" → "500+"
 * "(-123)" → "123"
 * "(35)"   → "35"
 */
function parseRatingCount(raw) {
  if (!raw) return '';
  // Remove parentheses
  let cleaned = raw.replace(/[()]/g, '').trim();
  // Handle negative prefix: "-123" → "123"
  if (cleaned.startsWith('-') && /^-\d+/.test(cleaned)) {
    cleaned = cleaned.substring(1);
  }
  return cleaned;
}

/**
 * Extract __NEXT_DATA__ JSON from HTML string.
 * Uses a targeted regex to avoid parsing the entire 20+ MB HTML as DOM.
 */
function extractNextData(html) {
  const marker = '<script id="__NEXT_DATA__" type="application/json">';
  const startIdx = html.indexOf(marker);
  if (startIdx === -1) return null;

  const jsonStart = startIdx + marker.length;
  const endMarker = '</script>';
  const endIdx = html.indexOf(endMarker, jsonStart);
  if (endIdx === -1) return null;

  const jsonStr = html.substring(jsonStart, endIdx);
  return JSON.parse(jsonStr);
}

/**
 * Extract area info from __NEXT_DATA__
 */
function extractAreaInfo(nextData, area) {
  const meta = nextData?.props?.initialState?.home?.feed?.meta;
  const location = meta?.location;

  if (!location) return null;

  return {
    emirate: area.emirate,
    neighbourhoodName: location.neighborhoodName || area.name,
    neighbourhoodId: area.neighbourhoodId,
    zoneId: area.zoneId,
    deliverooUrl: area.url,
    geohash: location.geohash || '',
    latitude: location.lat || '',
    longitude: location.lon || '',
  };
}

/**
 * Extract restaurant listing from __NEXT_DATA__
 */
function extractRestaurants(nextData, area) {
  const results = nextData?.props?.initialState?.home?.feed?.results;
  if (!results || !results.data) return [];

  const data = results.data;
  const restaurants = [];

  for (const item of data) {
    if (item.typeName !== 'UILayoutList') continue;
    const blocks = item.blocks || [];

    for (const block of blocks) {
      try {
        const d = block.data || {};
        const onTap = d['partner-card.on-tap'];
        const params = onTap?.action?.parameters || {};

        const restaurantId = params.restaurant_id;
        if (!restaurantId) continue;

        // Build restaurant page URL
        let pageUrl = '';
        const href = params.restaurant_href || '';
        if (href) {
          // Clean query params and build full URL
          const cleanHref = href.split('?')[0];
          pageUrl = cleanHref.startsWith('http')
            ? cleanHref
            : `https://deliveroo.ae${cleanHref}`;
        }

        restaurants.push({
          restaurantId: String(restaurantId),
          partnerDrnId: block.entityDrnId || params.partner_drn_id || '',
          restaurantName: d['partner-name.content'] || '',
          rating: d['partner-rating.content'] || '',
          ratingCount: parseRatingCount(d['partner-rating-count.content']),
          fulfilmentMethod: params.fulfillment_method || '',
          neighbourhoodId: String(area.neighbourhoodId),
          restaurantPageUrl: pageUrl,
          imageUrl: d['card-image.url'] || '',
        });
      } catch (err) {
        // Skip malformed blocks
      }
    }
  }

  return restaurants;
}

/**
 * Fetch a single area page and extract data
 */
async function fetchArea(area, index) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(area.url, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${area.name}`);
      }

      const html = await response.text();
      const nextData = extractNextData(html);

      if (!nextData) {
        throw new Error(`No __NEXT_DATA__ found for ${area.name}`);
      }

      const areaInfo = extractAreaInfo(nextData, area);
      const restaurants = extractRestaurants(nextData, area);

      return { areaInfo, restaurants };
    } catch (err) {
      console.error(
        `  [${timestamp()}] Attempt ${attempt}/${MAX_RETRIES} failed for area #${index} (${area.name}): ${err.message}`
      );
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      } else {
        throw err;
      }
    }
  }
}

/**
 * POST data to the Apps Script web app
 */
async function postToAppsScript(payload) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(APPS_SCRIPT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        redirect: 'follow',
      });

      const text = await response.text();
      let result;
      try {
        result = JSON.parse(text);
      } catch {
        result = { raw: text };
      }

      if (result.error) {
        throw new Error(`Apps Script error: ${result.error}`);
      }

      return result;
    } catch (err) {
      console.error(
        `  POST attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`
      );
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_DELAY_MS * attempt);
      } else {
        throw err;
      }
    }
  }
}

/**
 * Main scraping loop
 */
async function main() {
  if (!APPS_SCRIPT_URL) {
    console.error('ERROR: APPS_SCRIPT_URL environment variable is not set.');
    console.error(
      'Add it as a repository secret in GitHub Settings > Secrets > Actions.'
    );
    process.exit(1);
  }

  const startTime = Date.now();
  const endIndex =
    END_INDEX > 0 ? Math.min(END_INDEX, AREAS.length) : AREAS.length;
  const areasToProcess = AREAS.slice(START_INDEX, endIndex);

  console.log('=== Deliveroo UAE Area Scraper (Phase 1) ===');
  console.log(`Total areas in directory: ${AREAS.length}`);
  console.log(`Processing: index ${START_INDEX} to ${endIndex - 1} (${areasToProcess.length} areas)`);
  console.log(`Batch size: ${BATCH_SIZE} areas`);
  console.log('');

  let processedAreas = 0;
  let totalRestaurants = 0;
  let errors = 0;
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 10;
  const errorLog = [];

  for (let i = 0; i < areasToProcess.length; i++) {
    const area = areasToProcess[i];
    const globalIndex = START_INDEX + i;

    try {
      console.log(
        `[${timestamp()}] Area #${globalIndex}: ${area.name} (${area.emirate})...`
      );

      const { areaInfo, restaurants } = await fetchArea(area, globalIndex);

      // POST area info to Sheet 1
      if (areaInfo) {
        await postToAppsScript({ action: 'areaInfo', area: areaInfo });
        console.log(`  Sheet 1: area info written`);
      }

      // POST restaurants to Sheet 2 in batches
      if (restaurants.length > 0) {
        let posted = 0;
        for (let j = 0; j < restaurants.length; j += RESTAURANT_POST_BATCH) {
          const batch = restaurants.slice(j, j + RESTAURANT_POST_BATCH);
          const result = await postToAppsScript({
            action: 'restaurants',
            restaurants: batch,
            neighbourhoodId: String(area.neighbourhoodId),
          });
          posted += batch.length;
          if (j + RESTAURANT_POST_BATCH < restaurants.length) {
            await sleep(POST_DELAY_MS);
          }
        }
        console.log(
          `  Sheet 2: ${restaurants.length} restaurants sent (${posted} posted)`
        );
        totalRestaurants += restaurants.length;
      } else {
        console.log(`  No restaurants found`);
      }

      processedAreas++;
      consecutiveErrors = 0;

      // Progress heartbeat
      if ((i + 1) % 10 === 0 || i === areasToProcess.length - 1) {
        const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
        const pct = (((i + 1) / areasToProcess.length) * 100).toFixed(1);
        console.log(
          `\n  -- Progress: ${i + 1}/${areasToProcess.length} (${pct}%) | ${elapsed} min | ${totalRestaurants} total restaurant entries | ${errors} errors --\n`
        );
      }

      // Batch pause
      if ((i + 1) % BATCH_SIZE === 0 && i < areasToProcess.length - 1) {
        console.log(
          `\n--- Batch pause after ${i + 1} areas (${totalRestaurants} restaurant entries so far) ---\n`
        );
        await sleep(BATCH_PAUSE_MS);
      } else {
        await sleep(AREA_DELAY_MS);
      }
    } catch (err) {
      errors++;
      consecutiveErrors++;
      errorLog.push({ index: globalIndex, area: area.name, error: err.message });
      console.error(
        `  ERROR on area #${globalIndex} (${area.name}): ${err.message}`
      );

      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        console.error(
          `\n${MAX_CONSECUTIVE_ERRORS} consecutive errors. Aborting.`
        );
        console.error(`Last successful area index: ${globalIndex - 1}`);
        console.error(`To resume, set START_INDEX=${globalIndex}`);
        break;
      }

      await sleep(RETRY_DELAY_MS);
    }
  }

  const elapsed = ((Date.now() - startTime) / 60000).toFixed(1);
  console.log('\n=== Phase 1 Complete ===');
  console.log(`Areas processed: ${processedAreas}`);
  console.log(`Total restaurant entries sent: ${totalRestaurants}`);
  console.log(`Errors: ${errors}`);
  console.log(`Wall time: ${elapsed} minutes`);

  if (errorLog.length > 0) {
    console.log('\nError log:');
    errorLog.forEach((e) =>
      console.log(`  Area #${e.index} (${e.area}): ${e.error}`)
    );
    console.log(
      `\nTo retry failed areas, re-run the workflow. The dedup logic handles re-processing.`
    );
  }

  if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
