# Deliveroo UAE Directory Scraper

Scrapes restaurant data from Deliveroo UAE's directory pages and writes it to a Google Sheet via Apps Script.

## Architecture

```
GitHub Actions (Node.js) --> POST batches --> Apps Script (web app) --> Google Sheet
```

**Phase 1** (`scrape-areas.js`): Scrapes ~390 area/neighbourhood pages. Writes area metadata (Sheet 1) and restaurant listings (Sheet 2) with dedup.

**Phase 2** (`scrape-restaurants.js`): Reads restaurant URLs from Sheet 2, fetches each restaurant page, writes detailed info (Sheet 3). Supports resumption -- re-running picks up where it left off.

## Google Sheet Structure

| Sheet | Name | Purpose |
|-------|------|---------|
| 1 | Area Information | One row per neighbourhood (emirate, coords, geohash) |
| 2 | List of Restaurants | One row per unique restaurant (deduped across areas) |
| 3 | Restaurant Information | Detailed info per restaurant (address, menu stats, cuisines) |

## Setup

### 1. Apps Script

1. Open your Google Sheet
2. Go to **Extensions > Apps Script**
3. Paste the contents of `AppsScript.js`
4. Deploy as web app:
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Copy the deployed web app URL

### 2. GitHub Repository

1. Fork or clone this repo (must be **public** for unlimited Actions minutes)
2. Go to **Settings > Secrets and variables > Actions**
3. Add secret: `APPS_SCRIPT_URL` = your deployed web app URL

### 3. Run

1. Go to **Actions** tab
2. Run **"Scrape Areas (Phase 1)"** first
3. After Phase 1 completes, run **"Scrape Restaurants (Phase 2)"**

## Workflow Inputs

### Phase 1 -- Scrape Areas

| Input | Default | Description |
|-------|---------|-------------|
| `start_index` | `0` | Start from this area index (for resuming) |
| `end_index` | `0` | Stop at this index (0 = all 390 areas) |
| `batch_size` | `25` | Areas per batch before a 15s pause |

### Phase 2 -- Scrape Restaurants

| Input | Default | Description |
|-------|---------|-------------|
| `concurrency` | `3` | Parallel page fetches |

## Dedup Logic (Sheet 2)

Restaurants appear in multiple neighbourhoods. When a duplicate Restaurant ID is found:
- **Updated**: Rating, Rating Count, Fulfilment Method, Image URL (latest wins)
- **Appended**: Neighbourhood ID (comma-separated, no duplicates)

## Files

| File | Purpose |
|------|---------|
| `areas.js` | Directory of 390 UAE areas (emirate, slug, IDs, URL) |
| `scrape-areas.js` | Phase 1: area pages --> Sheet 1 + Sheet 2 |
| `scrape-restaurants.js` | Phase 2: restaurant pages --> Sheet 3 |
| `AppsScript.js` | Google Apps Script web app (paste into Sheet) |

## Rate Limiting

- Phase 1: 2s between areas, 15s pause every batch
- Phase 2: 1.5s between concurrency groups, 300ms stagger within group
- Both: 3 retries with exponential backoff on failures
- 10 consecutive errors trigger abort (Phase 1)

## Estimated Runtime

- Phase 1: ~20-30 minutes for all 390 areas
- Phase 2: Depends on restaurant count (~10,000-20,000); may need multiple runs
