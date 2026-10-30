'use strict';

/**
 * Local FitGirl scraper.
 *
 * This ports the useful part of https://github.com/forzayt/FitgirlAPI into the
 * launcher itself, so game details can show repack download links without
 * depending on the remote Render-hosted API.
 *
 * Flow:
 *   1. Search fitgirl-repacks.site for the Steam game title.
 *   2. Pick the best matching post (slug/title scoring, skips update digests).
 *   3. Fetch the post and collect links from the download sections only.
 *   4. Group links by hoster (direct / torrent / game updates) for the UI.
 */

const { app } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');

const SITE = 'https://fitgirl-repacks.site';
const CACHE_TTL = 6 * 60 * 60 * 1000;
const REQUEST_TIMEOUT = 20000;
const MAX_VARIANTS = 2;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 FitLauncher/2.0';

const memoryCache = new Map();

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '\u2013',
  mdash: '\u2014',
  hellip: '\u2026',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201c',
  rdquo: '\u201d',
};

const HOST_LABELS = {
  'fuckingfast.co': 'FuckingFast',
  'datanodes.to': 'DataNodes',
  'filekeeper.net': 'FileKeeper',
  'multiupload.io': 'MultiUpload',
  'filecrypt.cc': 'FileCrypt',
  '1fichier.com': '1Fichier',
  'rapidgator.net': 'RapidGator',
  'ddownload.com': 'DDownload',
  'krakenfiles.com': 'KrakenFiles',
  'gofile.io': 'GoFile',
  'buzzheavier.com': 'BuzzHeavier',
  'pixeldrain.com': 'PixelDrain',
  'mediafire.com': 'MediaFire',
  'mega.nz': 'MEGA',
  'nitroflare.com': 'NitroFlare',
  'turbobit.net': 'TurboBit',
  'hitfile.net': 'HitFile',
  'uploaded.net': 'Uploaded',
  'uptobox.com': 'Uptobox',
  'send.cm': 'Send',
  '1cloudfile.com': '1CloudFile',
  'bowfile.com': 'BowFile',
  'rootz.so': 'Rootz',
  'hexload.com': 'HexLoad',
  'filerice.com': 'FileRice',
  'filespayouts.com': 'FilesPayouts',
  '1337x.to': '1337x',
  'rutor.info': 'RuTor',
  'tapochek.net': 'Tapochek',
};

// Hosts that are allowed even when the anchor text has no file name
// (containers, mirrors, torrent indexes).
const KNOWN_HOSTS = new Set([
  ...Object.keys(HOST_LABELS),
  'multiup.io',
  'multiup.org',
  'megaup.net',
  'anonfiles.com',
  'bayfiles.com',
  'solidfiles.com',
  'workupload.com',
  'transfer.sh',
  'we.tl',
  'dropbox.com',
  'drive.google.com',
]);

const NOISE_HOSTS = new Set([
  'fitgirl-repacks.site',
  'paste.fitgirl-repacks.site',
  'internetdownloadmanager.com',
  'riotpixels.com',
  'en.riotpixels.com',
  'wordpress.org',
  'gmpg.org',
  'store.steampowered.com',
  'steamcommunity.com',
  'youtube.com',
  'youtu.be',
  'twitter.com',
  'x.com',
  'facebook.com',
  'instagram.com',
  'discord.com',
  'discord.gg',
  'reddit.com',
  'patreon.com',
  'paypal.com',
  'paypal.me',
  'cs.rin.ru',
  'elamigos.site',
]);

const TORRENT_HOSTS = new Set(['1337x.to', 'rutor.info', 'tapochek.net', 'filecrypt.cc']);

const FILE_PATTERN = /\.(rar|zip|7z|iso|tar|gz|bin|exe|torrent|part\d+)(?:$|[?#])/i;

const ANCHOR_RE = /<a\b[^>]*?href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
const HEADING_RE = /<h([23])[^>]*>([\s\S]*?)<\/h\1>/gi;
const SEARCH_RESULT_RE =
  /<h[12][^>]*class\s*=\s*["'][^"']*entry-title[^"']*["'][^>]*>[\s\S]*?<a\b[^>]*?href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function safeCodePoint(code) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

function decodeEntities(value) {
  return String(value ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

function stripTags(html) {
  return decodeEntities(
    String(html ?? '')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeTitle(value) {
  return decodeEntities(value)
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function slugify(value) {
  return normalizeTitle(value).replace(/\s+/g, '-') || 'links';
}

function hostOf(rawUrl) {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

function hostLabel(host) {
  if (!host) return 'Links';
  if (HOST_LABELS[host]) return HOST_LABELS[host];
  return host
    .split('.')
    .slice(0, -1)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function cacheFile(key) {
  const hash = crypto.createHash('sha1').update(key).digest('hex');
  return path.join(cacheDir(), `fitgirl-${hash}.json`);
}

let resolvedCacheDir = null;
function cacheDir() {
  if (resolvedCacheDir) return resolvedCacheDir;
  try {
    const base = app?.getPath ? app.getPath('userData') : path.join(os.tmpdir(), 'fit-launcher');
    resolvedCacheDir = path.join(base, 'cache');
  } catch {
    resolvedCacheDir = path.join(os.tmpdir(), 'fit-launcher', 'cache');
  }
  return resolvedCacheDir;
}

async function readDiskCache(key) {
  try {
    return JSON.parse(await fs.readFile(cacheFile(key), 'utf8'));
  } catch {
    return null;
  }
}

async function writeDiskCache(key, payload) {
  try {
    await fs.mkdir(path.dirname(cacheFile(key)), { recursive: true });
    await fs.writeFile(cacheFile(key), JSON.stringify(payload));
  } catch (error) {
    console.warn('Could not write FitGirl cache:', error.message);
  }
}

async function fetchText(url, { retries = 1 } = {}) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'User-Agent': USER_AGENT,
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      });

      if (!response.ok) {
        throw new Error(`FitGirl returned HTTP ${response.status}`);
      }
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < retries) await delay(800);
    }
  }

  throw lastError;
}

function searchUrl(query) {
  return `${SITE}/?s=${encodeURIComponent(query)}`;
}

function isPostUrl(url) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    if (host !== 'fitgirl-repacks.site') return false;
    if (parsed.pathname === '/' || parsed.pathname === '') return false;
    if (/^\/(tag|category|author|page|feed|wp-|comments|updates-digest)/i.test(parsed.pathname)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function extractSearchResults(html) {
  const results = [];
  const seen = new Set();

  for (const match of html.matchAll(SEARCH_RESULT_RE)) {
    const url = decodeEntities(match[2]).trim();
    const title = stripTags(match[3]);

    if (!url || !title || seen.has(url) || !isPostUrl(url)) continue;
    if (/updates?\s+digest/i.test(title)) continue;

    seen.add(url);
    results.push({ url, title });
  }

  return results;
}

function scoreCandidate(candidate, gameTitle) {
  const target = normalizeTitle(gameTitle);
  if (!target) return 0;

  let slug = '';
  try {
    slug = normalizeTitle(new URL(candidate.url).pathname.replace(/\/+$/, '').split('/').pop());
  } catch {
    slug = '';
  }

  const title = normalizeTitle(candidate.title);
  let score = 0;

  if (slug === target || title === target) score += 100;
  if (slug.startsWith(`${target} `)) score += 60;
  if (title.startsWith(`${target} `)) score += 50;
  else if (title.includes(target)) score += 15;
  else if (slug.includes(target)) score += 10;
  else return 0;

  const extraTokens = Math.max(0, title.split(' ').length - target.split(' ').length);
  score -= Math.min(20, extraTokens);

  // A repack post for a game with a colon in its own name (e.g. Batman: Arkham
  // Knight) should still win over a spin-off that merely shares the prefix.
  const colonBase = normalizeTitle(candidate.title.split(/[:|\u2013\u2014]/)[0]);
  if (colonBase === target) score += 30;

  return score;
}

function pickBestPost(results, gameTitle) {
  let best = null;
  let bestScore = 0;

  for (const result of results) {
    const score = scoreCandidate(result, gameTitle);
    if (score > bestScore) {
      best = result;
      bestScore = score;
    }
  }

  return bestScore > 0 ? best : null;
}

function titleVariants(gameTitle) {
  const variants = [];
  const add = (value) => {
    const trimmed = String(value || '').trim();
    if (trimmed.length >= 2 && !variants.includes(trimmed)) variants.push(trimmed);
  };

  add(gameTitle);
  add(String(gameTitle || '').split(/[:|\u2013\u2014]/)[0]);
  add(
    String(gameTitle || '')
      .replace(
        /\b(deluxe|ultimate|definitive|premium|gold|complete|enhanced|legendary|standard|special|game of the year|goty)\s+edition\b/gi,
        '',
      )
      .replace(/\s+/g, ' ')
      .trim(),
  );

  return variants.slice(0, MAX_VARIANTS);
}

function extractEntryContent(html) {
  const open = html.search(/<div\b[^>]*class\s*=\s*["'][^"']*\bentry-content\b[^"']*["'][^>]*>/i);
  if (open === -1) return '';

  const start = html.indexOf('>', open) + 1;
  const endCandidates = [
    html.indexOf('<footer class="entry-meta"', start),
    html.indexOf('<div class="sharedaddy', start),
    html.indexOf('<div id="comments"', start),
    html.indexOf('</article>', start),
  ].filter((index) => index > start);

  const end = endCandidates.length ? Math.min(...endCandidates) : html.length;
  return html.slice(start, end);
}

function sectionKind(heading) {
  if (/game\s+updates?/i.test(heading)) return 'update';
  if (/torrent/i.test(heading)) return 'torrent';
  if (/download\s+mirrors?/i.test(heading)) return 'direct';
  return null;
}

function splitSections(content) {
  const headings = [...content.matchAll(HEADING_RE)];
  if (!headings.length) return [{ heading: '', html: content }];

  const sections = [];
  const intro = content.slice(0, headings[0].index);
  if (intro.trim()) sections.push({ heading: '', html: intro });

  headings.forEach((heading, index) => {
    const start = heading.index + heading[0].length;
    const end = index + 1 < headings.length ? headings[index + 1].index : content.length;
    sections.push({
      heading: stripTags(heading[2]),
      html: content.slice(start, end),
    });
  });

  return sections;
}

function cleanLinkName(text, url) {
  let name = stripTags(text);

  if (!name || /^https?:\/\//i.test(name) || name.length > 200) name = '';

  if (!name) {
    try {
      const parsed = new URL(url);
      const last = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '');
      name = last || parsed.hostname;
    } catch {
      name = '';
    }
  }

  if (/^magnet:/i.test(url) && /^magnet$/i.test(name)) name = 'Magnet link';

  return name
    .replace(/[-_\u2013\u2014]*fitgirl-repacks\.site[-_\u2013\u2014]*/gi, '_')
    .replace(/_{2,}/g, '_')
    .replace(/_+\./g, '.')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

function isDownloadLink(url, text) {
  if (/^magnet:/i.test(url)) return true;

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) return false;

  const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
  if (!host || NOISE_HOSTS.has(host) || host.endsWith('.fitgirl-repacks.site')) return false;
  if (KNOWN_HOSTS.has(host)) return true;
  if (FILE_PATTERN.test(text) || FILE_PATTERN.test(parsed.pathname)) return true;

  return false;
}

function extractLinks(html) {
  const links = [];

  for (const match of html.matchAll(ANCHOR_RE)) {
    const url = decodeEntities(match[2]).trim();
    if (!url || url === '#') continue;

    const text = stripTags(match[3]);
    if (!isDownloadLink(url, text)) continue;

    links.push({ url, text });
  }

  return links;
}

function parseDownloads(content) {
  const groups = new Map();
  const seenUrls = new Set();

  for (const section of splitSections(content)) {
    const kind = sectionKind(section.heading);
    if (!kind) continue;

    for (const link of extractLinks(section.html)) {
      if (seenUrls.has(link.url)) continue;
      seenUrls.add(link.url);

      const isMagnet = /^magnet:/i.test(link.url);
      const host = isMagnet ? 'magnet' : hostOf(link.url);
      if (!isMagnet && !host) continue;

      const linkKind =
        kind === 'update' ? 'update' : isMagnet || TORRENT_HOSTS.has(host) ? 'torrent' : 'direct';

      const label =
        linkKind === 'update'
          ? `Game updates \u00b7 ${isMagnet ? 'Magnet' : hostLabel(host)}`
          : isMagnet
            ? 'Magnet links'
            : hostLabel(host);

      const key = `${linkKind}:${isMagnet ? 'magnet' : host}`;
      let group = groups.get(key);

      if (!group) {
        group = {
          id: slugify(`${linkKind} ${isMagnet ? 'magnet' : host}`),
          label,
          kind: linkKind,
          host: isMagnet ? 'magnet' : host,
          links: [],
        };
        groups.set(key, group);
      }

      group.links.push({
        url: link.url,
        name: cleanLinkName(link.text, link.url),
        host: isMagnet ? 'magnet' : host,
        magnet: isMagnet,
      });
    }
  }

  const order = { direct: 0, torrent: 1, update: 2 };
  return [...groups.values()]
    .filter((group) => group.links.length > 0)
    .sort(
      (a, b) =>
        order[a.kind] - order[b.kind] ||
        b.links.length - a.links.length ||
        a.label.localeCompare(b.label),
    );
}

async function searchPosts(query) {
  const html = await fetchText(searchUrl(query));
  return extractSearchResults(html);
}

async function findPost(gameTitle) {
  for (const variant of titleVariants(gameTitle)) {
    const results = await searchPosts(variant);
    const best = pickBestPost(results, gameTitle) || pickBestPost(results, variant);
    if (best) return best;
  }

  return null;
}

async function getRepackDownloads(gameTitle, { force = false } = {}) {
  const title = String(gameTitle || '').trim();
  if (!title) throw new Error('A game title is required to search FitGirl.');

  const cacheKey = normalizeTitle(title);

  if (!force) {
    const cached = memoryCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) return cached.data;

    const disk = await readDiskCache(cacheKey);
    if (disk && Date.now() - disk.fetchedAt < CACHE_TTL && disk.data) {
      memoryCache.set(cacheKey, disk);
      return disk.data;
    }
  }

  const post = await findPost(title);
  if (!post) {
    const error = new Error(`No FitGirl repack was found for "${title}".`);
    error.code = 'FITGIRL_NOT_FOUND';
    throw error;
  }

  const html = await fetchText(post.url);
  const content = extractEntryContent(html);
  const groups = content ? parseDownloads(content) : [];
  const total = groups.reduce((sum, group) => sum + group.links.length, 0);

  if (!total) {
    const error = new Error(`The FitGirl post for "${post.title}" has no download links.`);
    error.code = 'FITGIRL_NO_LINKS';
    throw error;
  }

  const data = {
    gameTitle: title,
    matchedTitle: post.title,
    postUrl: post.url,
    searchUrl: searchUrl(title),
    fetchedAt: Date.now(),
    total,
    groups,
  };

  const payload = { fetchedAt: Date.now(), data };
  memoryCache.set(cacheKey, payload);
  await writeDiskCache(cacheKey, payload);

  return data;
}

module.exports = {
  getRepackDownloads,
  searchPosts,
  pickBestPost,
  parseDownloads,
  extractEntryContent,
  searchUrl,
  normalizeTitle,
};
