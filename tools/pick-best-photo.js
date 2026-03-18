#!/usr/bin/env node
/**
 * pick-best-photo.js — Download multiple candidate main photos for review
 *
 * For each plant specified, downloads up to N candidate photos from different
 * iNaturalist observations, skipping duplicates and very small images.
 * Saves to assets/photos/candidates/{plant-id}/01.jpg, 02.jpg, etc.
 *
 * Usage:
 *   node tools/pick-best-photo.js fireweed pale-purple-coneflower
 *   node tools/pick-best-photo.js --all           # All plants
 *   node tools/pick-best-photo.js --review         # Open candidates folder
 *
 * After reviewing, run:
 *   node tools/pick-best-photo.js --apply fireweed 03
 *   (copies candidates/fireweed/03.jpg → assets/photos/fireweed.jpg)
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');

const ROOT           = path.resolve(__dirname, '..');
const DATA_FILE      = path.join(ROOT, 'data', 'plants.json');
const PHOTOS_DIR     = path.join(ROOT, 'assets', 'photos');
const CANDIDATES_DIR = path.join(ROOT, 'assets', 'photos', 'candidates');
const CANDIDATES_PER_PLANT = 10;

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

// ── Apply mode: copy chosen candidate to main photo ──
function applyChoice(plantId, choice) {
  const candidateDir = path.join(CANDIDATES_DIR, plantId);
  const src = path.join(candidateDir, `${choice.padStart(2,'0')}.jpg`);
  const dest = path.join(PHOTOS_DIR, `${plantId}.jpg`);

  if (!fs.existsSync(src)) {
    console.error(`File not found: ${src}`);
    console.log(`Available:`, fs.readdirSync(candidateDir).join(', '));
    process.exit(1);
  }

  fs.copyFileSync(src, dest);
  console.log(`✅ Copied ${src} → ${dest} (${Math.round(fs.statSync(dest).size/1024)}KB)`);
}

// ── Fetch candidates ──
async function fetchCandidates(plant) {
  const dir = path.join(CANDIDATES_DIR, plant.id);
  fs.mkdirSync(dir, { recursive: true });

  // Try multiple search strategies for variety
  const strategies = [
    // Strategy 1: highest voted, first photo per observation
    `taxon_name=${encodeURIComponent(plant.species)}&quality_grade=research&photos=true&per_page=30&order_by=votes`,
    // Strategy 2: recent observations (often better photo quality)
    `taxon_name=${encodeURIComponent(plant.species)}&quality_grade=research&photos=true&per_page=20&order_by=created_at&order=desc`,
  ];

  // Also try base species name if subspecies
  const baseSpecies = plant.species.replace(/\s+(ssp\.|var\.|subsp\.)\s+\S+/, '');
  if (baseSpecies !== plant.species) {
    strategies.push(
      `taxon_name=${encodeURIComponent(baseSpecies)}&quality_grade=research&photos=true&per_page=20&order_by=votes`
    );
  }

  const photoURLs = [];
  const seenPhotoIds = new Set();

  for (const params of strategies) {
    if (photoURLs.length >= CANDIDATES_PER_PLANT) break;

    const url = `https://api.inaturalist.org/v1/observations?${params}&locale=en`;
    let data;
    try { data = await fetchJSON(url); } catch(e) { continue; }
    if (!data.results) continue;

    for (const obs of data.results) {
      if (photoURLs.length >= CANDIDATES_PER_PLANT) break;
      if (!obs.photos || !obs.photos.length) continue;

      // Take the first photo from each observation (the "best" one)
      const photo = obs.photos[0];
      if (!photo.url || seenPhotoIds.has(photo.id)) continue;
      seenPhotoIds.add(photo.id);

      photoURLs.push({
        url: photo.url.replace('/square.', '/large.'),
        attribution: photo.attribution || '',
        obsId: obs.id,
      });
    }

    await sleep(500);
  }

  // Download all candidates
  let saved = 0;
  for (let i = 0; i < photoURLs.length; i++) {
    const info = photoURLs[i];
    const num = String(i + 1).padStart(2, '0');
    const dest = path.join(dir, `${num}.jpg`);

    // Skip if already exists
    if (fs.existsSync(dest) && fs.statSync(dest).size > 5000) {
      saved++;
      continue;
    }

    try {
      await downloadFile(info.url, dest);
      const size = fs.statSync(dest).size;
      if (size < 5000) {
        fs.unlinkSync(dest);
        continue;
      }
      saved++;
      console.log(`    ${num}.jpg (${Math.round(size/1024)}KB) obs:${info.obsId}`);
    } catch(e) {
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
    }
    await sleep(200);
  }

  return saved;
}

async function main() {
  const args = process.argv.slice(2);

  // ── Apply mode ──
  if (args[0] === '--apply' && args.length === 3) {
    applyChoice(args[1], args[2]);
    return;
  }

  // ── Batch apply from stdin ──
  if (args[0] === '--batch-apply') {
    // Read from file: each line is "plant-id number"
    const file = args[1] || path.join(CANDIDATES_DIR, 'picks.txt');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    for (const line of lines) {
      const [id, num] = line.trim().split(/\s+/);
      if (id && num) applyChoice(id, num);
    }
    return;
  }

  // ── Fetch candidates ──
  const plants = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  fs.mkdirSync(CANDIDATES_DIR, { recursive: true });

  let toProcess;
  if (args[0] === '--all') {
    toProcess = plants;
  } else if (args.length > 0) {
    toProcess = plants.filter(p => args.includes(p.id));
    if (toProcess.length === 0) {
      console.error('No plants found for:', args.join(', '));
      process.exit(1);
    }
  } else {
    console.log('Usage:');
    console.log('  node tools/pick-best-photo.js fireweed eastern-blazing-star');
    console.log('  node tools/pick-best-photo.js --all');
    console.log('  node tools/pick-best-photo.js --apply fireweed 03');
    console.log('  node tools/pick-best-photo.js --batch-apply picks.txt');
    return;
  }

  console.log(`\n=== Downloading ${CANDIDATES_PER_PLANT} candidates for ${toProcess.length} plants ===\n`);

  for (let i = 0; i < toProcess.length; i++) {
    const plant = toProcess[i];
    console.log(`[${i+1}/${toProcess.length}] ${plant.common} (${plant.species})`);
    const count = await fetchCandidates(plant);
    console.log(`  → ${count} candidates saved to candidates/${plant.id}/\n`);
    if (i < toProcess.length - 1) await sleep(1000);
  }

  console.log('\n=== Done ===');
  console.log(`Review candidates in: ${CANDIDATES_DIR}`);
  console.log(`Then apply: node tools/pick-best-photo.js --apply <plant-id> <number>`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
