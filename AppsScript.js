/**
 * Google Apps Script — Deliveroo UAE Directory Sheet Writer
 *
 * Deploy as web app (Execute as: Me, Access: Anyone)
 * Set the deployed URL as APPS_SCRIPT_URL secret in the GitHub repo.
 *
 * Handles three sheets:
 *  Sheet 1 "Area Information"         — one row per neighbourhood
 *  Sheet 2 "List of Restaurants"      — one row per unique restaurant (with dedup)
 *  Sheet 3 "Restaurant Information"   — detailed info per restaurant
 *
 * Routes:
 *  POST action=areaInfo       → write to Sheet 1
 *  POST action=restaurants    → write/dedup to Sheet 2
 *  POST action=restaurantInfo → write to Sheet 3
 *  GET  action=getRestaurantUrls → read URLs from Sheet 2 (paginated)
 *  GET  action=getProcessedIds   → read Restaurant IDs from Sheet 3
 *  GET  (default)                → health check
 */

// ── Sheet names ──────────────────────────────────────────────────────────────────
var SHEET1_NAME = 'Area Information';
var SHEET2_NAME = 'List of Restaurants';
var SHEET3_NAME = 'Restaurant Information';

// ── Sheet 1 headers ──────────────────────────────────────────────────────────────
var SHEET1_HEADERS = [
  'Emirate/City',
  'Neighbourhood Name',
  'Neighbourhood ID',
  'Zone ID',
  'Deliveroo URL',
  'Geohash',
  'Neighbourhood Latitude',
  'Neighbourhood Longitude',
];

// ── Sheet 2 headers ──────────────────────────────────────────────────────────────
var SHEET2_HEADERS = [
  'Restaurant ID',        // col A (1) — dedup key
  'Partner DRN ID',       // col B (2)
  'Restaurant Name',      // col C (3)
  'Rating',               // col D (4) — update on dedup
  'Rating Count',         // col E (5) — update on dedup
  'Fulfilment Method',    // col F (6) — update on dedup
  'Neighbourhood ID',     // col G (7) — append on dedup
  'Restaurant Page URL',  // col H (8)
  'Image URL',            // col I (9) — update on dedup
];

// ── Sheet 3 headers ──────────────────────────────────────────────────────────────
var SHEET3_HEADERS = [
  'Brand DRN ID',
  'Restaurant ID',
  'Restaurant Name',
  'Restaurant Slug',
  'Branch Type',
  'Restaurant Neighbourhood',
  'Address',
  'Post Code',
  'City',
  'Country',
  'City ID',
  'Zone ID',
  'Menu ID',
  'Fulfilment Type',
  'Cuisines',
  'Total Menu Categories',
  'Total Menu Items',
  'Restaurant Page URL',
];

// ═════════════════════════════════════════════════════════════════════════════════
// POST handler
// ═════════════════════════════════════════════════════════════════════════════════
function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var action = data.action;

    if (action === 'areaInfo') {
      return handleAreaInfo(data);
    } else if (action === 'restaurants') {
      return handleRestaurants(data);
    } else if (action === 'restaurantInfo') {
      return handleRestaurantInfo(data);
    } else {
      return jsonResponse({ error: 'Unknown action: ' + action });
    }
  } catch (err) {
    console.error('doPost error: ' + err.toString());
    return jsonResponse({ error: err.toString() });
  }
}

// ═════════════════════════════════════════════════════════════════════════════════
// GET handler
// ═════════════════════════════════════════════════════════════════════════════════
function doGet(e) {
  try {
    var action = (e.parameter && e.parameter.action) || '';

    if (action === 'getRestaurantUrls') {
      return handleGetRestaurantUrls(e);
    } else if (action === 'getProcessedIds') {
      return handleGetProcessedIds();
    } else {
      return jsonResponse({
        status: 'ok',
        message: 'Deliveroo UAE Directory Sheet Writer is running',
        sheets: [SHEET1_NAME, SHEET2_NAME, SHEET3_NAME],
      });
    }
  } catch (err) {
    console.error('doGet error: ' + err.toString());
    return jsonResponse({ error: err.toString() });
  }
}

// ═════════════════════════════════════════════════════════════════════════════════
// Action handlers
// ═════════════════════════════════════════════════════════════════════════════════

/**
 * Write one area row to Sheet 1
 */
function handleAreaInfo(data) {
  var area = data.area;
  if (!area) return jsonResponse({ error: 'No area data provided' });

  var sheet = getOrCreateSheet(SHEET1_NAME, SHEET1_HEADERS);
  var row = [
    area.emirate || '',
    area.neighbourhoodName || '',
    area.neighbourhoodId || '',
    area.zoneId || '',
    area.deliverooUrl || '',
    area.geohash || '',
    area.latitude || '',
    area.longitude || '',
  ];

  var lastRow = sheet.getLastRow();
  sheet.getRange(lastRow + 1, 1, 1, row.length).setValues([row]);

  return jsonResponse({
    success: true,
    action: 'areaInfo',
    row: lastRow + 1,
  });
}

/**
 * Write/dedup restaurants to Sheet 2
 *
 * Dedup logic:
 *  - Key: Restaurant ID
 *  - If restaurant already exists:
 *    → Update Rating, Rating Count, Image URL, Fulfilment Method (latest wins)
 *    → Append Neighbourhood ID (comma-separated, no duplicates)
 *  - If new: append as new row
 */
function handleRestaurants(data) {
  var restaurants = data.restaurants;
  if (!restaurants || !restaurants.length) {
    return jsonResponse({ error: 'No restaurant data provided' });
  }

  var sheet = getOrCreateSheet(SHEET2_NAME, SHEET2_HEADERS);
  var lastRow = sheet.getLastRow();

  // Build lookup map: restaurantId → row number
  var idToRow = {};
  if (lastRow > 1) {
    var ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues(); // Column A: Restaurant ID
    for (var i = 0; i < ids.length; i++) {
      var id = String(ids[i][0]);
      if (id) {
        idToRow[id] = i + 2; // 1-indexed, skip header
      }
    }
  }

  var newRows = [];
  var updated = 0;

  for (var j = 0; j < restaurants.length; j++) {
    var r = restaurants[j];
    var restId = String(r.restaurantId || '');
    if (!restId) continue;

    var existingRow = idToRow[restId];

    if (existingRow) {
      // ── UPDATE existing row ──
      // Update Rating (col D=4), Rating Count (col E=5), Fulfilment Method (col F=6), Image URL (col I=9)
      var updateValues = [
        [r.rating || ''],
        [r.ratingCount || ''],
        [r.fulfilmentMethod || ''],
      ];
      sheet.getRange(existingRow, 4, 1, 3).setValues([
        [r.rating || '', r.ratingCount || '', r.fulfilmentMethod || '']
      ]);
      sheet.getRange(existingRow, 9, 1, 1).setValues([[r.imageUrl || '']]);

      // Append Neighbourhood ID (col G=7), avoid duplicates
      var currentNIds = String(sheet.getRange(existingRow, 7).getValue() || '');
      var newNId = String(r.neighbourhoodId || '');
      if (newNId && currentNIds.indexOf(newNId) === -1) {
        var updatedNIds = currentNIds ? currentNIds + ', ' + newNId : newNId;
        sheet.getRange(existingRow, 7).setValue(updatedNIds);
      }

      updated++;
    } else {
      // ── NEW row ──
      newRows.push([
        restId,
        r.partnerDrnId || '',
        r.restaurantName || '',
        r.rating || '',
        r.ratingCount || '',
        r.fulfilmentMethod || '',
        String(r.neighbourhoodId || ''),
        r.restaurantPageUrl || '',
        r.imageUrl || '',
      ]);
      // Track for within-batch dedup
      idToRow[restId] = lastRow + newRows.length; // Predict future row number
    }
  }

  // Append all new rows at once
  if (newRows.length > 0) {
    var appendStart = sheet.getLastRow() + 1;
    sheet
      .getRange(appendStart, 1, newRows.length, SHEET2_HEADERS.length)
      .setValues(newRows);
  }

  return jsonResponse({
    success: true,
    action: 'restaurants',
    newRows: newRows.length,
    updated: updated,
    totalInSheet: sheet.getLastRow() - 1,
  });
}

/**
 * Write restaurant detail rows to Sheet 3
 */
function handleRestaurantInfo(data) {
  var restaurants = data.restaurants;
  if (!restaurants || !restaurants.length) {
    return jsonResponse({ error: 'No restaurant info data provided' });
  }

  var sheet = getOrCreateSheet(SHEET3_NAME, SHEET3_HEADERS);

  var rows = restaurants.map(function (r) {
    return [
      r.brandDrnId || '',
      r.restaurantId || '',
      r.restaurantName || '',
      r.restaurantSlug || '',
      r.branchType || '',
      r.restaurantNeighbourhood || '',
      r.address || '',
      r.postCode || '',
      r.city || '',
      r.country || '',
      r.cityId || '',
      r.zoneId || '',
      r.menuId || '',
      r.fulfilmentType || '',
      r.cuisines || '',
      r.totalMenuCategories || 0,
      r.totalMenuItems || 0,
      r.restaurantPageUrl || '',
    ];
  });

  var lastRow = sheet.getLastRow();
  sheet
    .getRange(lastRow + 1, 1, rows.length, SHEET3_HEADERS.length)
    .setValues(rows);

  return jsonResponse({
    success: true,
    action: 'restaurantInfo',
    rowsWritten: rows.length,
    startRow: lastRow + 1,
  });
}

/**
 * GET: Return restaurant URLs from Sheet 2 (paginated)
 */
function handleGetRestaurantUrls(e) {
  var offset = parseInt(e.parameter.offset || '0', 10);
  var limit = parseInt(e.parameter.limit || '5000', 10);

  var sheet = getSheet(SHEET2_NAME);
  if (!sheet) {
    return jsonResponse({ error: 'Sheet "' + SHEET2_NAME + '" not found' });
  }

  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    return jsonResponse({
      restaurants: [],
      total: 0,
      hasMore: false,
    });
  }

  var totalData = lastRow - 1;
  var startRow = 2 + offset;
  var rowsToFetch = Math.min(limit, totalData - offset);

  if (rowsToFetch <= 0) {
    return jsonResponse({
      restaurants: [],
      total: totalData,
      hasMore: false,
    });
  }

  // Read columns A (Restaurant ID) and H (Restaurant Page URL)
  var data = sheet.getRange(startRow, 1, rowsToFetch, 8).getValues();

  var restaurants = [];
  for (var i = 0; i < data.length; i++) {
    var id = String(data[i][0] || '');
    var url = String(data[i][7] || '');
    if (id && url) {
      restaurants.push({ id: id, url: url });
    }
  }

  return jsonResponse({
    restaurants: restaurants,
    total: totalData,
    hasMore: offset + rowsToFetch < totalData,
  });
}

/**
 * GET: Return processed Restaurant IDs from Sheet 3
 */
function handleGetProcessedIds() {
  var sheet = getSheet(SHEET3_NAME);
  if (!sheet) {
    return jsonResponse({ ids: [] });
  }

  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    return jsonResponse({ ids: [] });
  }

  // Read column B (Restaurant ID) from Sheet 3
  var data = sheet.getRange(2, 2, lastRow - 1, 1).getValues();
  var ids = [];
  for (var i = 0; i < data.length; i++) {
    var id = String(data[i][0] || '');
    if (id) ids.push(id);
  }

  return jsonResponse({ ids: ids });
}

// ═════════════════════════════════════════════════════════════════════════════════
// Utilities
// ═════════════════════════════════════════════════════════════════════════════════

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}

function getSheet(name) {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
}

function getOrCreateSheet(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);

  if (!sheet) {
    sheet = ss.insertSheet(name);
  }

  // Ensure headers exist
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet
      .getRange(1, 1, 1, headers.length)
      .setFontWeight('bold')
      .setBackground('#f3f3f3');
    sheet.setFrozenRows(1);
  }

  return sheet;
}

/**
 * Utility: Clear all data rows (keep headers) from a specified sheet
 * Run manually from Apps Script editor if needed.
 */
function clearSheet1() { clearData(SHEET1_NAME); }
function clearSheet2() { clearData(SHEET2_NAME); }
function clearSheet3() { clearData(SHEET3_NAME); }

function clearData(sheetName) {
  var sheet = getSheet(sheetName);
  if (!sheet) return;
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).clearContent();
    console.log('Cleared ' + (lastRow - 1) + ' rows from ' + sheetName);
  }
}
