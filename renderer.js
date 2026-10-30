(() => {
  'use strict';

  const api = window.fitLauncher;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const FILTERS = [
    { id: 'all', label: 'All Games' },
    { id: 'free', label: 'Free to Play' },
    { id: 'specials', label: 'Special Offers' },
    { id: 'top-sellers', label: 'Top Sellers' },
    { id: 'new-releases', label: 'New Releases' },
    { id: 'coming-soon', label: 'Coming Soon' },
  ];

  const WISHLIST_KEY = 'fit-launcher.wishlist.v1';
  const HERO_INTERVAL = 8000;

  const state = {
    view: 'discover',
    home: null,
    catalog: new Map(),
    loading: false,
    error: null,
    wishlist: new Set(),
    browseFilter: 'all',
    heroIndex: 0,
    heroTimer: null,
    news: null,
    newsLoading: false,
    searchIndex: -1,
    searchResults: [],
  };

  const toast = $('#toast');
  let toastTimer = null;

  function showToast(message) {
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('is-visible'), 2600);
  }

  const HTML_ESCAPES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
  }

  const escapeAttr = escapeHtml;

  function icon(name) {
    return `<svg class="icon" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
  }

  function money(cents, currency) {
    if (typeof cents !== 'number' || Number.isNaN(cents)) return null;
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: currency || 'USD',
      }).format(cents / 100);
    } catch {
      return `$${(cents / 100).toFixed(2)}`;
    }
  }

  function isComingSoon(game) {
    return Boolean(game?.comingSoon);
  }

  function isFreeGame(game) {
    if (!game || isComingSoon(game)) return false;
    if (game.isFree) return true;
    return Number(game.originalPrice) === 0 && Number(game.finalPrice) === 0;
  }

  function priceMarkup(game) {
    if (isComingSoon(game)) {
      return '<span class="price-soon">Coming Soon</span>';
    }

    if (isFreeGame(game)) {
      return '<span class="price-free">Free to Play</span>';
    }

    const current = money(game.finalPrice, game.currency);
    const original = money(game.originalPrice, game.currency);

    if (game.discount > 0 && current && original && current !== original) {
      return [
        `<span class="price-current">${current}</span>`,
        `<span class="price-original">${original}</span>`,
        `<span class="price-off">-${game.discount}%</span>`,
      ].join('');
    }

    if (current) return `<span class="price-current">${current}</span>`;
    return '<span class="price-soon">See on Steam</span>';
  }

  function priceText(game) {
    if (isComingSoon(game)) return 'Coming soon';
    if (isFreeGame(game)) return 'Free to Play';
    return money(game.finalPrice, game.currency) || 'On Steam';
  }

  function heroBadge(game) {
    if (isComingSoon(game)) return '<span class="pill muted">Coming Soon</span>';
    if (isFreeGame(game)) return '<span class="pill free">Free to Play</span>';
    if (game.discount > 0) {
      return `<span class="pill sale">-${game.discount}% off</span>`;
    }
    return '<span class="pill muted">Featured</span>';
  }

  function cardFlag(game) {
    if (isComingSoon(game)) return '<span class="card-flag soon">Soon</span>';
    if (game.discount > 0) {
      return `<span class="card-flag sale">-${game.discount}%</span>`;
    }
    return '';
  }

  function formatDate(ms) {
    if (!ms) return '';
    try {
      return new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }).format(new Date(ms));
    } catch {
      return '';
    }
  }

  function gameCard(game) {
    const saved = state.wishlist.has(String(game.id));
    const media = game.image
      ? `<img class="card-img" src="${escapeAttr(game.image)}" data-fallback="${escapeAttr(
          game.headerImage || '',
        )}" alt="" loading="lazy" draggable="false" />`
      : '<div class="card-img card-img-empty"></div>';

    return `
      <article class="game-card">
        <div class="card-media">
          ${media}
          <button
            class="card-open"
            type="button"
            data-open-app="${escapeAttr(game.id)}"
            aria-label="Open ${escapeAttr(game.name)} on Steam"
          ></button>
          ${cardFlag(game)}
          <button
            class="card-heart${saved ? ' is-saved' : ''}"
            type="button"
            data-heart="${escapeAttr(game.id)}"
            aria-pressed="${saved}"
            aria-label="${saved ? 'Remove' : 'Add'} ${escapeAttr(game.name)} ${saved ? 'from' : 'to'} wishlist"
          >
            ${icon('heart')}
          </button>
        </div>
        <div class="card-body">
          <h3 class="card-title" title="${escapeAttr(game.name)}">${escapeHtml(game.name)}</h3>
          <div class="card-price">${priceMarkup(game)}</div>
        </div>
      </article>
    `;
  }

  function heroMarkup() {
    const hero = state.home?.hero || [];
    if (!hero.length) return '';

    const slides = hero
      .map((game, index) => {
        const saved = state.wishlist.has(String(game.id));
        const meta = [];
        if (game.genres?.[0]) meta.push(escapeHtml(game.genres[0]));
        if (game.developer) meta.push(escapeHtml(game.developer));
        if (game.releaseDate) meta.push(escapeHtml(game.releaseDate));

        const metaHtml = meta
          .map((entry) => `<span>${entry}</span>`)
          .join('<span class="meta-dot"></span>');

        const primaryLabel = isComingSoon(game)
          ? 'View on Steam'
          : isFreeGame(game)
            ? 'Play for Free'
            : 'Buy Now';

        const background = game.background || game.image;
        const media = background
          ? `<img src="${escapeAttr(background)}" data-fallback="${escapeAttr(
              game.headerImage || '',
            )}" alt="" loading="${index === 0 ? 'eager' : 'lazy'}" draggable="false" />`
          : '';

        return `
          <article
            class="hero-slide${index === 0 ? ' is-active' : ''}"
            aria-hidden="${index === 0 ? 'false' : 'true'}"
          >
            <div class="hero-bg">${media}</div>
            <div class="hero-shade"></div>
            <div class="hero-content">
              <div class="hero-eyebrow">
                ${heroBadge(game)}
                <span class="hero-kicker">Featured on Steam</span>
              </div>
              <h1 class="hero-title">${escapeHtml(game.name)}</h1>
              <p class="hero-desc">${escapeHtml(game.description || '')}</p>
              <div class="hero-meta">${metaHtml}</div>
              <div class="hero-price">${priceMarkup(game)}</div>
              <div class="hero-actions">
                <button class="btn primary" type="button" data-open-app="${escapeAttr(game.id)}">
                  ${primaryLabel}
                  ${icon('external')}
                </button>
                <button
                  class="btn ghost${saved ? ' is-saved' : ''}"
                  type="button"
                  data-heart="${escapeAttr(game.id)}"
                  aria-pressed="${saved}"
                >
                  ${icon('heart')}
                  <span data-heart-label>${saved ? 'On Wishlist' : 'Add to Wishlist'}</span>
                </button>
              </div>
            </div>
          </article>
        `;
      })
      .join('');

    const controls =
      hero.length > 1
        ? `
          <div class="hero-controls">
            <div class="hero-dots" role="tablist" aria-label="Featured games">
              ${hero
                .map(
                  (_, index) =>
                    `<button class="hero-dot${index === 0 ? ' is-active' : ''}" type="button" data-hero-dot="${index}" aria-label="Show featured game ${index + 1}"></button>`,
                )
                .join('')}
            </div>
            <button class="hero-arrow" type="button" data-hero="prev" aria-label="Previous featured game">
              ${icon('chevron-left')}
            </button>
            <button class="hero-arrow" type="button" data-hero="next" aria-label="Next featured game">
              ${icon('chevron-right')}
            </button>
          </div>
        `
        : '';

    return `
      <section
        class="hero"
        id="hero"
        aria-roledescription="carousel"
        aria-label="Featured games"
      >
        <div class="hero-stage">${slides}</div>
        ${controls}
      </section>
    `;
  }

  function shelfMarkup(row) {
    return `
      <section class="shelf" aria-label="${escapeAttr(row.title)}">
        <div class="shelf-head">
          <div>
            <h2 class="shelf-title">${escapeHtml(row.title)}</h2>
            <p class="shelf-sub">${escapeHtml(row.subtitle || '')}</p>
          </div>
          <div class="shelf-actions">
            <button class="link-btn" type="button" data-browse-filter="${escapeAttr(row.id)}">
              View All
            </button>
            <div class="shelf-nav">
              <button
                class="shelf-arrow"
                type="button"
                data-scroll="${escapeAttr(row.id)}"
                data-dir="-1"
                aria-label="Scroll ${escapeAttr(row.title)} left"
              >
                ${icon('chevron-left')}
              </button>
              <button
                class="shelf-arrow"
                type="button"
                data-scroll="${escapeAttr(row.id)}"
                data-dir="1"
                aria-label="Scroll ${escapeAttr(row.title)} right"
              >
                ${icon('chevron-right')}
              </button>
            </div>
          </div>
        </div>
        <div class="shelf-track" id="shelf-${escapeAttr(row.id)}">
          ${row.items.map((game) => gameCard(game)).join('')}
        </div>
      </section>
    `;
  }

  function renderSkeleton() {
    const heroMount = $('#heroMount');
    const rowsMount = $('#rowsMount');
    if (!heroMount || !rowsMount) return;

    heroMount.innerHTML = `
      <div class="hero hero-skeleton skeleton">
        <div class="hero-content">
          <div class="sk-line sk-eyebrow"></div>
          <div class="sk-line sk-title"></div>
          <div class="sk-line sk-desc"></div>
          <div class="sk-line sk-desc short"></div>
          <div class="sk-line sk-price"></div>
          <div class="sk-actions">
            <div class="sk-line sk-btn"></div>
            <div class="sk-line sk-btn"></div>
          </div>
        </div>
      </div>
    `;

    rowsMount.innerHTML = Array.from({ length: 3 })
      .map(
        () => `
          <section class="skeleton-shelf">
            <div class="shelf-head">
              <div>
                <div class="sk-line" style="width: 190px; height: 20px"></div>
                <div class="sk-line" style="width: 250px; height: 10px"></div>
              </div>
            </div>
            <div class="skeleton-cards">
              ${'<div class="sk-card skeleton"></div>'.repeat(4)}
            </div>
          </section>
        `,
      )
      .join('');
  }

  function renderError(message) {
    const heroMount = $('#heroMount');
    const rowsMount = $('#rowsMount');
    if (!heroMount || !rowsMount) return;

    heroMount.innerHTML = `
      <div class="error-state">
        <h2>The Steam store is out of reach</h2>
        <p>${escapeHtml(
          message || 'Something went wrong while loading the store. Please try again.',
        )}</p>
        <button class="btn primary" type="button" data-action="retry-home">
          ${icon('refresh')}
          Try Again
        </button>
      </div>
    `;
    rowsMount.innerHTML = '';
  }

  function addGame(game, category, rank) {
    if (!game?.id || !game?.name) return;
    const id = String(game.id);
    let entry = state.catalog.get(id);

    if (!entry) {
      entry = {
        ...game,
        id,
        categories: new Set(),
        ranks: {},
      };
      state.catalog.set(id, entry);
    } else {
      for (const key of Object.keys(game)) {
        if (
          (entry[key] === undefined || entry[key] === null || entry[key] === '') &&
          game[key] !== undefined &&
          game[key] !== null &&
          game[key] !== ''
        ) {
          entry[key] = game[key];
        }
      }
    }

    if (category) {
      entry.categories.add(category);
      if (typeof rank === 'number' && entry.ranks[category] === undefined) {
        entry.ranks[category] = rank;
      }
    }
    if (category === 'coming-soon') entry.comingSoon = true;
  }

  function buildCatalog(home) {
    state.catalog = new Map();
    (home.hero || []).forEach((game) => addGame(game, 'featured'));

    (home.rows || []).forEach((row) => {
      row.items.forEach((game, index) => addGame(game, row.id, index));
    });
  }

  function renderDiscover() {
    if (!state.home) return;
    const heroMount = $('#heroMount');
    const rowsMount = $('#rowsMount');
    if (!heroMount || !rowsMount) return;

    stopHeroAuto();
    heroMount.innerHTML = heroMarkup();
    rowsMount.innerHTML = (state.home.rows || []).map((row) => shelfMarkup(row)).join('');

    state.heroIndex = 0;
    const hero = $('#hero');
    if (hero) {
      hero.addEventListener('mouseenter', stopHeroAuto);
      hero.addEventListener('mouseleave', () => {
        if (state.view === 'discover') startHeroAuto();
      });
      hero.addEventListener('focusin', stopHeroAuto);
      hero.addEventListener('focusout', () => {
        if (state.view === 'discover') startHeroAuto();
      });
    }
    startHeroAuto();
  }

  function applyHero(index) {
    const slides = $$('.hero-slide', $('#heroMount'));
    if (!slides.length) return;

    state.heroIndex = (index + slides.length) % slides.length;
    slides.forEach((slide, slideIndex) => {
      const active = slideIndex === state.heroIndex;
      slide.classList.toggle('is-active', active);
      slide.setAttribute('aria-hidden', String(!active));
    });

    $$('.hero-dot', $('#heroMount')).forEach((dot, dotIndex) => {
      dot.classList.toggle('is-active', dotIndex === state.heroIndex);
    });
  }

  function startHeroAuto() {
    stopHeroAuto();
    if (state.view !== 'discover' || document.hidden) return;
    const count = state.home?.hero?.length || 0;
    if (count < 2) return;

    state.heroTimer = setInterval(() => applyHero(state.heroIndex + 1), HERO_INTERVAL);
  }

  function stopHeroAuto() {
    if (state.heroTimer) {
      clearInterval(state.heroTimer);
      state.heroTimer = null;
    }
  }

  function scrollShelf(rowId, direction) {
    const track = document.getElementById(`shelf-${rowId}`);
    if (!track) return;
    const amount = Math.max(320, track.clientWidth * 0.85);
    track.scrollBy({ left: amount * direction, behavior: 'smooth' });
  }

  function renderBrowse() {
    const filtersEl = $('#browseFilters');
    const grid = $('#browseGrid');
    const empty = $('#browseEmpty');
    const countEl = $('#browseCount');
    if (!filtersEl || !grid || !empty) return;

    const games = [...state.catalog.values()];
    const countFor = (filterId) =>
      filterId === 'all'
        ? games.length
        : games.filter((game) => game.categories.has(filterId)).length;

    filtersEl.innerHTML = FILTERS.map(
      (filter) => `
        <button
          class="chip${state.browseFilter === filter.id ? ' is-active' : ''}"
          type="button"
          data-filter="${filter.id}"
        >
          ${filter.label}
          <span class="chip-count">${countFor(filter.id)}</span>
        </button>
      `,
    ).join('');

    let items;
    if (state.browseFilter === 'all') {
      items = games.slice().sort((a, b) => a.name.localeCompare(b.name));
    } else {
      items = games
        .filter((game) => game.categories.has(state.browseFilter))
        .sort(
          (a, b) =>
            (a.ranks?.[state.browseFilter] ?? 999) -
              (b.ranks?.[state.browseFilter] ?? 999) || a.name.localeCompare(b.name),
        );
    }

    grid.innerHTML = items.map((game) => gameCard(game)).join('');
    grid.hidden = items.length === 0;
    empty.hidden = items.length > 0;

    if (countEl) {
      const activeFilter = FILTERS.find((filter) => filter.id === state.browseFilter);
      countEl.textContent = `${items.length} ${items.length === 1 ? 'game' : 'games'}${
        state.browseFilter === 'all' ? '' : ` · ${activeFilter?.label || ''}`
      }`;
    }
  }

  function renderWishlist() {
    const grid = $('#wishlistGrid');
    const empty = $('#wishlistEmpty');
    const count = $('#wishlistCount');
    if (!grid || !empty) return;

    const items = [...state.catalog.values()]
      .filter((game) => state.wishlist.has(String(game.id)))
      .sort((a, b) => a.name.localeCompare(b.name));

    grid.innerHTML = items.map((game) => gameCard(game)).join('');
    grid.hidden = items.length === 0;
    empty.hidden = items.length > 0;
    if (count) count.textContent = String(items.length);
  }

  function updateWishlistBadges() {
    const count = state.wishlist.size;
    ['#wishlistRailBadge', '#wishlistTopBadge'].forEach((selector) => {
      const badge = $(selector);
      if (!badge) return;
      badge.textContent = String(count);
      badge.hidden = count === 0;
    });
  }

  function updateWishlistUI() {
    $$('[data-heart]').forEach((element) => {
      const id = String(element.dataset.heart);
      const saved = state.wishlist.has(id);
      const gameName = state.catalog.get(id)?.name || 'game';

      element.classList.toggle('is-saved', saved);
      element.setAttribute('aria-pressed', String(saved));
      element.setAttribute(
        'aria-label',
        `${saved ? 'Remove' : 'Add'} ${gameName} ${saved ? 'from' : 'to'} wishlist`,
      );

      if (element.classList.contains('btn')) {
        const label = element.querySelector('[data-heart-label]');
        if (label) label.textContent = saved ? 'On Wishlist' : 'Add to Wishlist';
      }
    });

    updateWishlistBadges();
  }

  function saveWishlist() {
    try {
      localStorage.setItem(WISHLIST_KEY, JSON.stringify([...state.wishlist]));
    } catch {
      /* storage can be unavailable; the session still works */
    }
  }

  function toggleWishlist(id) {
    const key = String(id);
    const saved = !state.wishlist.has(key);

    if (saved) state.wishlist.add(key);
    else state.wishlist.delete(key);

    saveWishlist();
    updateWishlistUI();
    showToast(saved ? 'Added to wishlist' : 'Removed from wishlist');

    if (state.view === 'wishlist') renderWishlist();
  }

  async function openGame(id) {
    const game = state.catalog.get(String(id));
    if (!game) {
      showToast('This game is still loading.');
      return;
    }
    await openUrl(game.url);
  }

  async function openUrl(url) {
    if (!api?.openExternal) {
      showToast('Desktop bridge unavailable.');
      return;
    }
    try {
      const opened = await api.openExternal(url);
      if (!opened) showToast('Could not open that link.');
    } catch {
      showToast('Could not open that link.');
    }
  }

  function newsCard(article) {
    const game = state.catalog.get(String(article.appid));
    const image = game?.headerImage || game?.image || '';
    const source = [game?.name, article.source].filter(Boolean).join(' · ');

    return `
      <button class="news-card" type="button" data-open-url="${escapeAttr(article.url)}">
        ${
          image
            ? `<span class="news-media"><img src="${escapeAttr(image)}" alt="" loading="lazy" /></span>`
            : ''
        }
        <span class="news-body">
          <span class="news-source">${escapeHtml(source || 'Steam News')}</span>
          <span class="news-title">${escapeHtml(article.title)}</span>
          <span class="news-excerpt">${escapeHtml(article.contents)}</span>
          <span class="news-footer">
            <span>${escapeHtml(formatDate(article.date))}</span>
            <span class="news-cta">Read more ${icon('arrow-right')}</span>
          </span>
        </span>
      </button>
    `;
  }

  function renderNewsSkeleton() {
    const grid = $('#newsGrid');
    if (!grid) return;
    grid.innerHTML = Array.from({ length: 6 })
      .map(
        () =>
          `<div class="news-card news-skeleton skeleton" style="height: ${290 + Math.round(
            Math.random() * 30,
          )}px"></div>`,
      )
      .join('');
  }

  function renderNews() {
    const grid = $('#newsGrid');
    if (!grid) return;

    if (!state.news?.length) {
      grid.innerHTML = `
        <div class="empty-state" style="grid-column: 1 / -1">
          <div class="empty-icon">${icon('refresh')}</div>
          <h2>No announcements right now</h2>
          <p>Steam did not return any recent developer news for the featured games.</p>
          <button class="btn ghost" type="button" data-action="refresh-news">
            ${icon('refresh')} Try Again
          </button>
        </div>
      `;
      return;
    }

    grid.innerHTML = state.news.map((article) => newsCard(article)).join('');
  }

  function renderNewsError(message) {
    const grid = $('#newsGrid');
    if (!grid) return;
    grid.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / -1">
        <div class="empty-icon">${icon('refresh')}</div>
        <h2>News is taking a break</h2>
        <p>${escapeHtml(message || 'Steam news is unavailable right now.')}</p>
        <button class="btn ghost" type="button" data-action="refresh-news">
          ${icon('refresh')} Retry
        </button>
      </div>
    `;
  }

  async function loadNews(force = false) {
    if (!api?.getNews) {
      renderNewsError('The desktop bridge is unavailable.');
      return;
    }
    if (state.newsLoading) return;
    if (state.news && !force) {
      renderNews();
      return;
    }

    const ids =
      state.home?.newsAppIds?.length > 0
        ? state.home.newsAppIds
        : ['730', '570', '1172470', '1085660', '230410'];

    state.newsLoading = true;
    renderNewsSkeleton();

    try {
      state.news = await api.getNews(ids, force);
      if (!Array.isArray(state.news)) state.news = [];
      renderNews();
    } catch (error) {
      state.news = [];
      renderNewsError(error?.message);
    } finally {
      state.newsLoading = false;
    }
  }

  async function loadHome(force = false) {
    if (state.loading) return;
    state.loading = true;
    state.error = null;

    if (!state.home) renderSkeleton();

    try {
      if (!api?.getHome) throw new Error('The desktop bridge is unavailable.');
      const home = await api.getHome(force);
      if (!home?.hero?.length) throw new Error('The Steam store returned no featured games.');

      state.home = home;
      buildCatalog(home);
      renderDiscover();
      updateWishlistBadges();
      if (state.view === 'browse') renderBrowse();
      if (state.view === 'wishlist') renderWishlist();
      if (home.stale) {
        showToast('Offline mode — showing cached Steam data.');
      }
    } catch (error) {
      state.error = error?.message || 'Unable to load the store.';
      renderError(state.error);
    } finally {
      state.loading = false;
    }
  }

  function setView(name) {
    const allowed = ['discover', 'browse', 'news', 'wishlist', 'library'];
    if (!allowed.includes(name)) return;

    state.view = name;
    $$('.view').forEach((view) => {
      view.hidden = view.id !== `view-${name}`;
    });

    $$('.top-tab').forEach((tab) => {
      const active = tab.dataset.tab === name;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
    });

    $$('.rail-btn[data-nav]').forEach((button) => {
      const target = button.dataset.nav;
      const active =
        target === name ||
        (target === 'discover' && ['discover', 'browse', 'news'].includes(name));
      button.classList.toggle('is-active', active);
    });

    if (name === 'browse') renderBrowse();
    if (name === 'wishlist') renderWishlist();
    if (name === 'news') loadNews();
    if (name === 'discover') startHeroAuto();
    else stopHeroAuto();

    window.scrollTo(0, 0);
  }

  function closeSearch() {
    const popover = $('#searchPopover');
    const input = $('#searchInput');
    if (popover) {
      popover.hidden = true;
      popover.innerHTML = '';
    }
    if (input) input.setAttribute('aria-expanded', 'false');
    state.searchIndex = -1;
    state.searchResults = [];
  }

  function searchResultMarkup(game) {
    const image = game.image
      ? `<img class="search-thumb" src="${escapeAttr(game.image)}" alt="" loading="lazy" />`
      : '<span class="search-thumb"></span>';

    return `
      <button class="search-result" type="button" role="option" data-open-app="${escapeAttr(
        game.id,
      )}">
        ${image}
        <span class="search-info">
          <span class="search-name">${escapeHtml(game.name)}</span>
          <span class="search-meta">${escapeHtml(priceText(game))}</span>
        </span>
      </button>
    `;
  }

  function renderSearchResults(rawQuery) {
    const popover = $('#searchPopover');
    const input = $('#searchInput');
    if (!popover || !input) return;

    const query = String(rawQuery || '').trim();
    state.searchIndex = -1;

    if (query.length < 2) {
      closeSearch();
      return;
    }

    const term = query.toLocaleLowerCase();
    const matches = [...state.catalog.values()]
      .filter((game) => game.name.toLocaleLowerCase().includes(term))
      .sort((a, b) => {
        const aStarts = a.name.toLocaleLowerCase().startsWith(term) ? 0 : 1;
        const bStarts = b.name.toLocaleLowerCase().startsWith(term) ? 0 : 1;
        return aStarts - bStarts || a.name.localeCompare(b.name);
      })
      .slice(0, 7);

    state.searchResults = matches;

    popover.innerHTML = matches.length
      ? matches.map((game) => searchResultMarkup(game)).join('')
      : `<div class="search-empty">No games match “${escapeHtml(query)}”.</div>`;
    popover.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  function applySearchFocus() {
    const items = $$('.search-result', $('#searchPopover'));
    items.forEach((item, index) => {
      item.classList.toggle('is-focused', index === state.searchIndex);
    });
    items[state.searchIndex]?.scrollIntoView({ block: 'nearest' });
  }

  function focusSearch() {
    const input = $('#searchInput');
    if (!input) return;
    input.focus();
    input.select();
    renderSearchResults(input.value);
  }

  function bindStaticEvents() {
    document.addEventListener('click', (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const toastTrigger = target.closest('[data-toast]');
      if (toastTrigger) {
        showToast(toastTrigger.dataset.toast);
        return;
      }

      const heart = target.closest('[data-heart]');
      if (heart) {
        event.preventDefault();
        toggleWishlist(heart.dataset.heart);
        return;
      }

      const openApp = target.closest('[data-open-app]');
      if (openApp) {
        event.preventDefault();
        closeSearch();
        openGame(openApp.dataset.openApp);
        return;
      }

      const openUrlButton = target.closest('[data-open-url]');
      if (openUrlButton) {
        event.preventDefault();
        openUrl(openUrlButton.dataset.openUrl);
        return;
      }

      const browseFilter = target.closest('[data-browse-filter]');
      if (browseFilter) {
        state.browseFilter = browseFilter.dataset.browseFilter;
        setView('browse');
        return;
      }

      const filter = target.closest('[data-filter]');
      if (filter) {
        state.browseFilter = filter.dataset.filter;
        renderBrowse();
        return;
      }

      const scrollButton = target.closest('[data-scroll]');
      if (scrollButton) {
        scrollShelf(scrollButton.dataset.scroll, Number(scrollButton.dataset.dir) || 1);
        return;
      }

      const heroControl = target.closest('[data-hero]');
      if (heroControl) {
        const direction = heroControl.dataset.hero === 'prev' ? -1 : 1;
        applyHero(state.heroIndex + direction);
        startHeroAuto();
        return;
      }

      const heroDot = target.closest('[data-hero-dot]');
      if (heroDot) {
        applyHero(Number(heroDot.dataset.heroDot) || 0);
        startHeroAuto();
        return;
      }

      const action = target.closest('[data-action]');
      if (action) {
        handleAction(action.dataset.action);
        return;
      }

      const tab = target.closest('[data-tab]');
      if (tab) {
        setView(tab.dataset.tab);
        return;
      }

      const nav = target.closest('[data-nav]');
      if (nav && nav.dataset.nav) {
        setView(nav.dataset.nav);
      }
    });

    document.addEventListener('click', (event) => {
      const wrap = $('#searchWrap');
      if (wrap && !wrap.contains(event.target)) closeSearch();
    });

    const searchInput = $('#searchInput');
    const searchPopover = $('#searchPopover');

    searchInput?.addEventListener('input', (event) => {
      renderSearchResults(event.target.value);
    });

    searchInput?.addEventListener('focus', () => {
      renderSearchResults(searchInput.value);
    });

    searchInput?.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (!state.searchResults.length) return;
        state.searchIndex = (state.searchIndex + 1) % state.searchResults.length;
        applySearchFocus();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (!state.searchResults.length) return;
        state.searchIndex =
          (state.searchIndex - 1 + state.searchResults.length) % state.searchResults.length;
        applySearchFocus();
      } else if (event.key === 'Enter') {
        if (!state.searchResults.length) return;
        event.preventDefault();
        const index = state.searchIndex >= 0 ? state.searchIndex : 0;
        const game = state.searchResults[index];
        closeSearch();
        searchInput.blur();
        openGame(game.id);
      } else if (event.key === 'Escape') {
        closeSearch();
        searchInput.blur();
      }
    });

    searchPopover?.addEventListener('click', (event) => {
      if (event.target.closest('[data-open-app]')) closeSearch();
    });

    window.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        focusSearch();
        return;
      }

      if (event.key === '/' && !event.ctrlKey && !event.metaKey) {
        const active = document.activeElement;
        const typing =
          active instanceof HTMLInputElement ||
          active instanceof HTMLTextAreaElement ||
          active?.isContentEditable;
        if (!typing) {
          event.preventDefault();
          focusSearch();
        }
      }

      if (event.key === 'Escape') closeSearch();
    });

    document.addEventListener(
      'error',
      (event) => {
        if (!(event.target instanceof HTMLImageElement)) return;
        const image = event.target;
        const fallback = image.dataset.fallback;
        if (fallback && image.src !== fallback) {
          image.dataset.fallback = '';
          image.classList.remove('img-broken');
          image.src = fallback;
          return;
        }
        image.classList.add('img-broken');
      },
      true,
    );

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopHeroAuto();
      else if (state.view === 'discover') startHeroAuto();
    });
  }

  function handleAction(action) {
    switch (action) {
      case 'retry-home':
        loadHome(true);
        break;
      case 'refresh-news':
        loadNews(true);
        break;
      case 'go-discover':
        setView('discover');
        break;
      case 'open-steam':
        openUrl('https://store.steampowered.com/');
        break;
      default:
        break;
    }
  }

  function loadWishlist() {
    try {
      const raw = localStorage.getItem(WISHLIST_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      state.wishlist = new Set(Array.isArray(parsed) ? parsed.map(String) : []);
    } catch {
      state.wishlist = new Set();
    }
  }

  function init() {
    loadWishlist();
    updateWishlistBadges();
    bindStaticEvents();
    setView('discover');
    loadHome();
  }

  init();
})();
