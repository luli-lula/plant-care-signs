#!/usr/bin/env node
/**
 * fetch-main-photos.js
 *
 * Downloads one "large" cover photo per plant from iNaturalist (research-grade).
 * Saves to assets/photos/{plant-id}.jpg
 * Skips plants that already have a main photo.
 *
 * Usage:
 *   node tools/fetch-main-photos.js              # All plants missing a main photo
 *   node tools/fetch-main-photos.js columbine     # Single plant
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');

const ROOT      = path.resolve(__dirname, '..');
const DATA_FILE = path.join(ROOT, 'data', 'plants.json');
const PHOTOS_DIR = path.join(ROOT, 'assets', 'photos');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'WildOnes-CapitalNY-PlantCards/1.0' } }, res => {
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); res.resume(); return; }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'WildOnes-CapitalNY-PlantCards/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return downloadFile(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode}`)); return; }
      const ws = fs.createWriteStream(dest);
      res.pipe(ws);
      ws.on('finish', () => { ws.close(); resolve(); });
      ws.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function findExistingPhoto(plantId) {
  for (const ext of ['jpg','jpeg','png']) {
    const p = path.join(PHOTOS_DIR, `${plantId}.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function fetchMainPhoto(plant) {
  const species = encodeURIComponent(plant.species);
  const url = `https://api.inaturalist.org/v1/observations?taxon_name=${species}&quality_grade=research&photos=true&per_page=20&order_by=votes&locale=en`;

  let data;
  try { data = await fetchJSON(url); }
  catch(err) { console.log(`  ERROR: ${err.message}`); return false; }

  if (!data.results || data.results.length === 0) {
    console.log(`  No observations for "${plant.species}"`);
    return false;
  }

  // Find best photo — prefer "large" over "medium"
  for (const obs of data.results) {
    if (!obs.photos || obs.photos.length === 0) continue;
    for (const photo of obs.photos) {
      let photoUrl = photo.url;
      if (!photoUrl) continue;
      // Try large first, fallback to medium
      const largeUrl = photoUrl.replace('/square.', '/large.');
      const ext = largeUrl.match(/\.(jpe?g|png)/i)?.[1] || 'jpg';
      const dest = path.join(PHOTOS_DIR, `${plant.id}.${ext}`);

      try {
        console.log(`  Downloading ${plant.id}.${ext} (large)...`);
        await downloadFile(largeUrl, dest);
        const stat = fs.statSync(dest);
        if (stat.size < 5000) {
          fs.unlinkSync(dest);
          // Try medium
          const medUrl = photoUrl.replace('/square.', '/medium.');
          await downloadFile(medUrl, dest);
          const stat2 = fs.statSync(dest);
          if (stat2.size < 1000) { fs.unlinkSync(dest); continue; }
        }
        console.log(`  -> Saved (${Math.round(fs.statSync(dest).size/1024)}KB)`);
        return true;
      } catch(err) {
        console.log(`  FAILED: ${err.message}`);
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
      }
    }
  }
  return false;
}

async function main() {
  const plants = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const targetId = process.argv[2];

  const toProcess = targetId
    ? plants.filter(p => p.id === targetId)
    : plants.filter(p => !findExistingPhoto(p.id));

  if (targetId && toProcess.length === 0) {
    console.error(`Plant "${targetId}" not found`); process.exit(1);
  }

  console.log(`\n=== Downloading main photos for ${toProcess.length} plants ===\n`);

  let ok = 0, fail = 0;
  for (let i = 0; i < toProcess.length; i++) {
    const plant = toProcess[i];
    console.log(`[${i+1}/${toProcess.length}] ${plant.common} (${plant.species})`);
    const success = await fetchMainPhoto(plant);
    if (success) ok++; else fail++;
    if (i < toProcess.length - 1) await sleep(1200);
  }

  console.log(`\n=== Done ===`);
  console.log(`Downloaded: ${ok}  Failed: ${fail}`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
