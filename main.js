const { app, BrowserWindow, ipcMain, shell, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');

const STEAM_API = {
  categories: 'https://store.steampowered.com/api/featuredcategories?cc=us&l=english',
  featured: 'https://store.steampowered.com/api/featured?cc=us&l=english',
  appDetails: (id) =>
    `https://store.steampowered.com/api/appdetails?appids=${id}&cc=us&l=english`,
  news: (id) =>
    `https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=${id}&count=4&maxlength=420&format=json&l=english&feeds=steam_community_announcements`,
};

const FREE_TO_PLAY_IDS = [
  730, 570, 1172470, 230410, 1085660, 578080, 440, 2767030, 2073850, 238960,
];

const CACHE_TTL = 30 * 60 * 1000;
const NEWS_TTL = 15 * 60 * 1000;

let homeCache = null;
let homeRequest = null;
const newsCache = new Map();

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cachePath(name) {
  return path.join(app.getPath('userData'), 'cache', name);
}

async function readCache(name) {
  try {
    return JSON.parse(await fs.readFile(cachePath(name), 'utf8'));
  } catch {
    return null;
  }
}

async function writeCache(name, data) {
  try {
    await fs.mkdir(path.dirname(cachePath(name)), { recursive: true });
    await fs.writeFile(cachePath(name), JSON.stringify(data));
  } catch (error) {
    console.warn('Could not write cache:', error.message);
  }
}

async function fetchJson(url, { timeout = 15000, retries = 1 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'FitLauncher/2.0 (+Electron)',
        },
        signal: AbortSignal.timeout(timeout),
      });

      if (!response.ok) throw new Error(`Steam returned HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      if (attempt === retries) throw error;
      await delay(700);
    }
  }
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

function decodeEntities(value) {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'");
}

function cleanText(value, maxLength = 0) {
  if (!value) return '';
  const text = decodeEntities(
    String(value)
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );

  if (maxLength && text.length > maxLength) {
    return `${text.slice(0, maxLength).trimEnd()}…`;
  }
  return text;
}

function appUrl(id) {
  return `https://store.steampowered.com/app/${id}/`;
}

function normalizeItem(item) {
  const image = item.large_capsule_image || item.header_image || item.small_capsule_image || '';

  return {
    id: String(item.id),
    name: item.name,
    image,
    headerImage: item.header_image || image,
    capsule: item.small_capsule_image || '',
    discount: Number(item.discount_percent) || 0,
    originalPrice: typeof item.original_price === 'number' ? item.original_price : null,
    finalPrice: typeof item.final_price === 'number' ? item.final_price : null,
    currency: item.currency || 'USD',
    discountExpires: item.discount_expiration || null,
    url: appUrl(item.id),
  };
}

async function getAppDetails(appid) {
  try {
    const payload = await fetchJson(STEAM_API.appDetails(appid), { retries: 2 });
    const entry = payload?.[String(appid)];
    return entry?.success ? entry.data : null;
  } catch (error) {
    console.warn(`App details failed for ${appid}:`, error.message);
    return null;
  }
}

function buildHero(item, details, index) {
  const base = normalizeItem(item);
  const screenshots = Array.isArray(details?.screenshots) ? details.screenshots : [];
  const background =
    screenshots.find((shot) => shot.path_full)?.path_full ||
    details?.background_raw ||
    `https://cdn.akamai.steamstatic.com/steam/apps/${base.id}/library_hero.jpg` ||
    base.headerImage;

  return {
    ...base,
    background: background || base.headerImage,
    description:
      cleanText(details?.short_description) ||
      `Featured on Steam this week. Explore ${base.name} and more in the store.`,
    genres: (details?.genres || []).map((genre) => genre.description).filter(Boolean).slice(0, 3),
    developer: details?.developers?.[0] || details?.publishers?.[0] || '',
    releaseDate: details?.release_date?.date || '',
    isFree: Boolean(details?.is_free) || (base.originalPrice === 0 && base.finalPrice === 0),
    heroPosition: index,
  };
}

function buildFreeToPlay(details, fallback) {
  if (!details) return fallback ? normalizeItem(fallback) : null;

  const appid = details.steam_appid;
  const capsule = `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/capsule_616x353.jpg`;

  return {
    id: String(appid),
    name: details.name,
    image: capsule,
    headerImage: details.header_image || capsule,
    capsule,
    discount: 0,
    originalPrice: 0,
    finalPrice: 0,
    currency: 'USD',
    discountExpires: null,
    url: appUrl(appid),
    description: cleanText(details.short_description),
    background: details.screenshots?.[0]?.path_full || details.header_image || capsule,
    genres: (details.genres || []).map((genre) => genre.description).filter(Boolean).slice(0, 3),
    developer: details.developers?.[0] || '',
    releaseDate: details.release_date?.date || '',
    isFree: true,
  };
}

async function buildHomeData(force = false) {
  if (force) homeCache = null;
  if (homeCache && Date.now() - homeCache.fetchedAt < CACHE_TTL) return homeCache;

  const diskCache = await readCache('home.json');
  if (!force && diskCache && Date.now() - diskCache.fetchedAt < CACHE_TTL) {
    homeCache = diskCache;
    return homeCache;
  }

  try {
    const [categories, featured] = await Promise.all([
      fetchJson(STEAM_API.categories, { retries: 2 }),
      fetchJson(STEAM_API.featured, { retries: 1 }).catch(() => null),
    ]);

    if (!categories) throw new Error('The Steam store returned no data.');

    const featuredItems =
      (featured?.featured_win?.length ? featured.featured_win : categories.specials?.items) || [];
    const heroSource = featuredItems
      .filter((item) => item && item.id && item.name)
      .slice(0, 5);

    const heroDetails = await mapLimit(heroSource, 3, (item) => getAppDetails(item.id));
    const hero = heroSource.map((item, index) => buildHero(item, heroDetails[index], index));

    const f2pFallbacks = new Map(
      (categories.specials?.items || []).map((item) => [String(item.id), item]),
    );
    const freeDetails = await mapLimit(FREE_TO_PLAY_IDS, 3, (id) => getAppDetails(id));
    const freeToPlay = freeDetails
      .map((details, index) =>
        buildFreeToPlay(details, f2pFallbacks.get(String(FREE_TO_PLAY_IDS[index]))),
      )
      .filter(Boolean);

    const categoriesToRows = [
      {
        id: 'free',
        title: 'Free To Play',
        subtitle: 'Jump into these titles at no cost',
        items: freeToPlay,
      },
      {
        id: 'specials',
        title: 'Special Offers',
        subtitle: 'Limited-time deals from the Steam store',
        items: (categories.specials?.items || [])
          .filter((item) => Number(item.discount_percent) > 0)
          .map(normalizeItem),
      },
      {
        id: 'top-sellers',
        title: 'Top Sellers',
        subtitle: 'What players are buying right now',
        items: (categories.top_sellers?.items || []).map(normalizeItem),
      },
      {
        id: 'new-releases',
        title: 'New Releases',
        subtitle: 'Freshly launched on Steam',
        items: (categories.new_releases?.items || []).map(normalizeItem),
      },
      {
        id: 'coming-soon',
        title: 'Coming Soon',
        subtitle: 'Wishlist these upcoming releases',
        items: (categories.coming_soon?.items || []).map(normalizeItem),
      },
    ];

    const rows = categoriesToRows
      .map((row) => ({ ...row, items: row.items.slice(0, 12) }))
      .filter((row) => row.items.length > 0);

    const data = {
      fetchedAt: Date.now(),
      hero,
      rows,
      newsAppIds: [
        ...new Set([
          ...heroSource.map((item) => String(item.id)),
          ...freeToPlay.slice(0, 3).map((game) => String(game.id)),
        ]),
      ].slice(0, 5),
    };

    homeCache = data;
    await writeCache('home.json', data);
    return data;
  } catch (error) {
    const stale = homeCache || diskCache;
    if (stale) {
      homeCache = { ...stale, stale: true };
      return homeCache;
    }
    throw new Error(
      'The Steam store could not be reached. Check your internet connection and try again.',
    );
  }
}

async function getHomeData(force = false) {
  if (!force && homeCache && Date.now() - homeCache.fetchedAt < CACHE_TTL) {
    return homeCache;
  }
  if (homeRequest) return homeRequest;

  homeRequest = buildHomeData(force);
  try {
    return await homeRequest;
  } finally {
    homeRequest = null;
  }
}

function buildNewsItem(article, appid) {
  return {
    id: `${appid}-${article.gid}`,
    appid: String(appid),
    title: cleanText(article.title, 180),
    url: article.url,
    source: cleanText(article.feedlabel || 'Steam News', 80),
    date: (article.date || 0) * 1000,
    contents: cleanText(article.contents, 460),
  };
}

async function getNewsData(appIds, force = false) {
  const ids = [
    ...new Set(
      (Array.isArray(appIds) ? appIds : [])
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0),
    ),
  ].slice(0, 5);

  const safeIds = ids.length ? ids : [730, 570, 1172470];
  const articles = [];
  let failures = 0;

  await mapLimit(safeIds, 3, async (appid) => {
    const cached = newsCache.get(appid);
    if (!force && cached && Date.now() - cached.fetchedAt < NEWS_TTL) {
      articles.push(...cached.items);
      return;
    }

    try {
      const payload = await fetchJson(STEAM_API.news(appid), { retries: 1 });
      const items = (payload?.appnews?.newsitems || [])
        .filter((article) => article?.title && article?.url)
        .map((article) => buildNewsItem(article, appid));
      newsCache.set(appid, { fetchedAt: Date.now(), items });
      articles.push(...items);
    } catch (error) {
      failures += 1;
      console.warn(`News failed for ${appid}:`, error.message);
      if (cached) articles.push(...cached.items);
    }
  });

  if (!articles.length && failures === safeIds.length) {
    throw new Error('Steam news is unavailable right now. Try again in a moment.');
  }

  const seen = new Set();
  return articles
    .filter((article) => {
      if (seen.has(article.id)) return false;
      seen.add(article.id);
      return true;
    })
    .sort((a, b) => b.date - a.date)
    .slice(0, 12);
}

function createWindow() {
  const workArea = screen.getPrimaryDisplay().workAreaSize;

  const win = new BrowserWindow({
    width: Math.min(1440, workArea.width),
    height: Math.min(900, workArea.height),
    minWidth: 1024,
    minHeight: 680,
    show: false,
    title: 'Fit Launcher',
    backgroundColor: '#0f0f13',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.once('ready-to-show', () => win.show());
  win.loadFile('index.html');
  win.setMenuBarVisibility(false);

  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) {
      event.preventDefault();
      openExternal(url);
    }
  });
}

async function openExternal(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!['https:', 'http:'].includes(url.protocol)) return false;
    await shell.openExternal(url.toString());
    return true;
  } catch {
    return false;
  }
}

app.setAppUserModelId('com.fitlauncher.v2');

app.whenReady().then(() => {
  ipcMain.handle('store:getHome', (_event, force) => getHomeData(Boolean(force)));
  ipcMain.handle('store:getNews', (_event, appIds, force) =>
    getNewsData(appIds, Boolean(force)),
  );
  ipcMain.handle('shell:openExternal', (_event, url) => openExternal(url));

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
