# Deliveroo UAE Directory Scraper

Scrapes restaurant data from Deliveroo UAE directory pages and writes it to a Google Sheet via Apps Script.

## Architecture

GitHub Actions (Node.js) -> POST batches -> Apps Script (web app) -> Google Sheet

**Phase 1** (scrape-areas.js): Scrapes ~390 area/neighbourhood pages, writes area metadata (Sheet 1) and restaurant listings (Sheet 2) with dedup.

**Phase 2** (scrape-restaurants.js): Reads restaurant URLs from Sheet 2, fetches each restaurant page, writes detailed info (Sheet 3). Supports resumption.

## Setup

### 1. Apps Script
1. Open your Google Sheet
2. Go to Extensions > Apps Script
3. Paste the contents of AppsScript.js
4. Deploy as web app (Execute as: Me, Access: Anyone)
5. Copy the deployed web app URL

### 2. GitHub Repository
1. Fork or clone this repo (must be public for unlimited Actions minutes)
2. Go to Settings > Secrets and variables > Actions
3. Add secret: APPS_SCRIPT_URL = your deployed web app URL

### 3. Run
1. Go to Actions tab
2. Run "Scrape Areas (Phase 1)" first
3. After Phase 1 completes, run "Scrape Restaurants (Phase 2)"
