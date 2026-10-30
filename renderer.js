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
    detail: null,
    detailOrigin: null,
    detailRequest: 0,
    lightboxIndex: 0,
    searchIndex: -1,
    searchResults: [],
    searchTimer: null,
    searchRequest: 0,
    searchLoading: false,
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

  function compactNumber(value) {
    if (value === null || value === undefined) return '';
    try {
      return new Intl.NumberFormat('en-US', {
        notation: 'compact',
        maximumFractionDigits: 1,
      }).format(Number(value));
    } catch {
      return String(value);
    }
  }

  const RICH_ALLOWED_TAGS = new Set([
    'P',
    'BR',
    'UL',
    'OL',
    'LI',
    'STRONG',
    'EM',
    'B',
    'I',
    'U',
    'H1',
    'H2',
    'H3',
    'H4',
    'IMG',
    'A',
    'BLOCKQUOTE',
    'SPAN',
    'DIV',
    'TABLE',
    'THEAD',
    'TBODY',
    'TR',
    'TD',
    'TH',
    'HR',
    'CODE',
    'PRE',
    'SUB',
    'SUP',
    'SMALL',
  ]);

  const RICH_BLOCKED_TAGS = new Set([
    'SCRIPT',
    'STYLE',
    'IFRAME',
    'OBJECT',
    'EMBED',
    'FORM',
    'INPUT',
    'BUTTON',
    'SELECT',
    'TEXTAREA',
    'VIDEO',
    'AUDIO',
    'SOURCE',
    'LINK',
    'META',
    'BASE',
    'SVG',
    'MATH',
    'TEMPLATE',
    'NOSCRIPT',
    'FRAME',
    'FRAMESET',
    'APPLET',
  ]);

  function safeHttpUrl(value) {
    try {
      const url = new URL(value, 'https://store.steampowered.com');
      if (!['http:', 'https:'].includes(url.protocol)) return '';
      return url.toString();
    } catch {
      return '';
    }
  }

  function sanitizeRichHtml(html) {
    if (!html) return '';

    const documentFragment = new DOMParser().parseFromString(
      `<div id="steam-root">${html}</div>`,
      'text/html',
    );
    const root = documentFragment.getElementById('steam-root');
    if (!root) return '';

    const cleanNode = (node) => {
      for (const child of [...node.childNodes]) {
        if (child.nodeType === Node.TEXT_NODE) continue;
        if (child.nodeType !== Node.ELEMENT_NODE) {
          child.remove();
          continue;
        }

        const tag = child.tagName;
        if (RICH_BLOCKED_TAGS.has(tag)) {
          child.remove();
          continue;
        }

        cleanNode(child);

        if (!RICH_ALLOWED_TAGS.has(tag)) {
          const fragment = documentFragment.createDocumentFragment();
          while (child.firstChild) fragment.appendChild(child.firstChild);
          child.replaceWith(fragment);
          continue;
        }

        for (const attribute of [...child.attributes]) {
          const name = attribute.name.toLowerCase();

          if (tag === 'IMG' && name === 'src') {
            const src = safeHttpUrl(attribute.value);
            if (src) {
              child.setAttribute('src', src);
              child.setAttribute('loading', 'lazy');
              child.setAttribute('decoding', 'async');
            } else {
              child.removeAttribute(attribute.name);
            }
          } else if (tag === 'IMG' && name === 'alt') {
            child.setAttribute('alt', attribute.value);
          } else if (tag === 'A' && name === 'href') {
            const href = safeHttpUrl(attribute.value);
            if (href) {
              child.setAttribute('href', href);
              child.setAttribute('data-open-url', href);
              child.setAttribute('target', '_blank');
              child.setAttribute('rel', 'noreferrer');
            } else {
              child.removeAttribute(attribute.name);
            }
          } else if (tag === 'A' && name === 'title') {
            child.setAttribute('title', attribute.value);
          } else if (
            (tag === 'TD' || tag === 'TH') &&
            (name === 'colspan' || name === 'rowspan')
          ) {
            child.setAttribute(name, attribute.value);
          } else {
            child.removeAttribute(attribute.name);
          }
        }

        if (tag === 'IMG' && !child.getAttribute('src')) child.remove();
      }
    };

    cleanNode(root);
    return root.innerHTML;
  }

  function hostLabel(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url;
    }
  }

  function detailFact(label, value) {
    if (!value) return '';
    return `
      <div class="detail-fact">
        <dt>${escapeHtml(label)}</dt>
        <dd>${escapeHtml(value)}</dd>
      </div>
    `;
  }

  function pickRequirementTab(data) {
    for (const key of ['pc', 'mac', 'linux']) {
      const requirements = data[`${key}Requirements`];
      if (requirements?.minimum || requirements?.recommended) return key;
    }
    return 'pc';
  }

  function requirementsBody(data, tab) {
    const requirements = data[`${tab}Requirements`] || {};
    const trimHeading = (html) =>
      String(html || '')
        .replace(/^\s*<strong>\s*(Minimum|Recommended):?\s*<\/strong>/i, '')
        .replace(/^\s*<br\s*\/?>/i, '');
    const block = (title, html) =>
      html
        ? `<div class="req-block"><h4>${title}</h4><div class="rich-text">${sanitizeRichHtml(
            trimHeading(html),
          )}</div></div>`
        : '';

    return block('Minimum', requirements.minimum) + block('Recommended', requirements.recommended);
  }

  function requirementsMarkup(data) {
    const tabs = [
      ['pc', 'Windows'],
      ['mac', 'macOS'],
      ['linux', 'Linux'],
    ].filter(([key]) => {
      const requirements = data[`${key}Requirements`];
      return Boolean(requirements?.minimum || requirements?.recommended);
    });

    if (!tabs.length) return '';

    const active =
      tabs.find(([key]) => key === state.detail?.reqTab)?.[0] || tabs[0][0];
    if (state.detail) state.detail.reqTab = active;

    return `
      <section class="detail-section">
        <h2 class="detail-section-title">System Requirements</h2>
        <div class="req-tabs">
          ${tabs
            .map(
              ([key, label]) => `
                <button
                  class="req-tab${key === active ? ' is-active' : ''}"
                  type="button"
                  data-req-tab="${key}"
                >
                  ${label}
                </button>
              `,
            )
            .join('')}
        </div>
        <div class="req-body">${requirementsBody(data, active)}</div>
      </section>
    `;
  }

  function detailBuyLabel(data) {
    if (isFreeGame(data)) return 'Play for Free';
    if (data.releaseDate?.comingSoon) {
      return data.price ? 'Pre-purchase on Steam' : 'View on Steam';
    }
    return data.price ? 'Buy on Steam' : 'View on Steam';
  }

  function detailPurchaseCard(data) {
    const saved = state.wishlist.has(String(data.id));
    const priceView = {
      ...data,
      comingSoon: Boolean(data.releaseDate?.comingSoon && !data.price),
    };
    const kicker = data.releaseDate?.comingSoon
      ? 'Coming soon'
      : isFreeGame(data)
        ? 'Free to play'
        : 'Buy on Steam';

    return `
      <div class="detail-card buy-card">
        <p class="detail-card-kicker">${kicker}</p>
        <div class="detail-buy-price">${priceMarkup(priceView)}</div>
        <button class="btn primary full" type="button" data-open-url="${escapeAttr(data.url)}">
          ${detailBuyLabel(data)}
          ${icon('external')}
        </button>
        <button
          class="btn ghost full${saved ? ' is-saved' : ''}"
          type="button"
          data-heart="${escapeAttr(data.id)}"
          aria-pressed="${saved}"
        >
          ${icon('heart')}
          <span data-heart-label>${saved ? 'On Wishlist' : 'Add to Wishlist'}</span>
        </button>
        <p class="fine-print">Purchases and downloads are handled by Steam.</p>
      </div>
    `;
  }

  function detailStatsCard(data) {
    const stats = [];

    if (data.metacritic?.score) {
      stats.push({ value: data.metacritic.score, label: 'Metacritic' });
    }
    if (data.recommendations !== null && data.recommendations !== undefined) {
      stats.push({ value: compactNumber(data.recommendations), label: 'Player reviews' });
    }
    if (data.achievements?.total) {
      stats.push({ value: compactNumber(data.achievements.total), label: 'Achievements' });
    }
    if (data.dlc?.length) {
      stats.push({ value: compactNumber(data.dlc.length), label: 'DLC items' });
    }

    if (!stats.length) return '';

    return `
      <div class="detail-card">
        <h3 class="detail-card-title">At a glance</h3>
        <div class="stat-grid">
          ${stats
            .map(
              (stat) => `
                <div class="stat">
                  <strong>${escapeHtml(stat.value)}</strong>
                  <span>${escapeHtml(stat.label)}</span>
                </div>
              `,
            )
            .join('')}
        </div>
      </div>
    `;
  }

  function detailLinksCard(data) {
    const links = [];

    if (data.website) {
      links.push({
        label: 'Official website',
        sub: hostLabel(data.website),
        url: data.website,
      });
    }
    if (data.support?.url) {
      links.push({
        label: 'Support',
        sub: hostLabel(data.support.url),
        url: data.support.url,
      });
    }
    if (data.metacritic?.url) {
      links.push({
        label: 'Metacritic reviews',
        sub: hostLabel(data.metacritic.url),
        url: data.metacritic.url,
      });
    }
    links.push({
      label: 'Steam store page',
      sub: hostLabel(data.url),
      url: data.url,
    });

    return `
      <div class="detail-card">
        <h3 class="detail-card-title">Links</h3>
        <div class="detail-links">
          ${links
            .map(
              (link) => `
                <button class="detail-link" type="button" data-open-url="${escapeAttr(link.url)}">
                  <span class="detail-link-copy">
                    <span>${escapeHtml(link.label)}</span>
                    <small>${escapeHtml(link.sub)}</small>
                  </span>
                  ${icon('external')}
                </button>
              `,
            )
            .join('')}
          ${
            data.support?.email
              ? `<div class="detail-link static">
                  <span class="detail-link-copy">
                    <span>Support email</span>
                    <small>${escapeHtml(data.support.email)}</small>
                  </span>
                </div>`
              : ''
          }
        </div>
      </div>
    `;
  }

  function detailRatingsCard(data) {
    const labels = {
      esrb: 'ESRB',
      pegi: 'PEGI',
      usk: 'USK',
      bbfc: 'BBFC',
      cero: 'CERO',
      oflc: 'OFLC',
      acb: 'ACB',
      crl: 'CRL',
      dejus: 'DEJUS',
      nordic: 'Nordic',
    };

    const ratings = Object.entries(data.ratings || {}).filter(([, rating]) => {
      return rating && typeof rating === 'object' && (rating.rating || rating.descriptors);
    });

    const notes = data.contentDescriptors?.notes;
    const requiredAge = Number(data.requiredAge) || 0;
    if (!ratings.length && !notes && !requiredAge) return '';

    return `
      <div class="detail-card">
        <h3 class="detail-card-title">Age & content</h3>
        ${
          requiredAge
            ? `<div class="age-row"><span>Minimum age</span><strong>${requiredAge}+</strong></div>`
            : ''
        }
        <div class="ratings">
          ${ratings
            .map(([key, rating]) => {
              const descriptors = Array.isArray(rating.descriptors)
                ? rating.descriptors.join(', ')
                : rating.descriptors;
              return `
                <div class="rating-row">
                  <span class="rating-board">${escapeHtml(labels[key] || key.toUpperCase())}</span>
                  <div class="rating-copy">
                    <strong>${escapeHtml(rating.rating || 'Rated')}</strong>
                    ${
                      descriptors
                        ? `<small>${escapeHtml(String(descriptors))}</small>`
                        : ''
                    }
                  </div>
                </div>
              `;
            })
            .join('')}
        </div>
        ${notes ? `<p class="age-note">${escapeHtml(String(notes))}</p>` : ''}
      </div>
    `;
  }

  function gameDetailMarkup(data) {
    const saved = state.wishlist.has(String(data.id));
    const heroBackground =
      data.backgroundRaw ||
      data.background ||
      data.screenshots?.[0]?.full ||
      data.headerImage;
    const meta = [];
    if (data.genres?.length) meta.push(...data.genres.slice(0, 2));
    if (data.developers?.length) meta.push(data.developers[0]);
    if (data.releaseDate?.date) meta.push(data.releaseDate.date);

    const metaHtml = meta
      .map((entry) => `<span>${escapeHtml(entry)}</span>`)
      .join('<span class="meta-dot"></span>');

    const badges = [];
    if (data.releaseDate?.comingSoon) {
      badges.push('<span class="pill muted">Coming Soon</span>');
    }
    if (isFreeGame(data)) {
      badges.push('<span class="pill free">Free to Play</span>');
    } else if (data.discount > 0) {
      badges.push(`<span class="pill sale">-${data.discount}% off</span>`);
    }
    if (data.requiredAge >= 18) {
      badges.push('<span class="pill muted">18+</span>');
    }

    const aboutHtml =
      sanitizeRichHtml(data.aboutTheGame || data.detailedDescription) ||
      (data.shortDescription ? `<p>${escapeHtml(data.shortDescription)}</p>` : '');

    const screenshotsMarkup = data.screenshots?.length
      ? `
        <section class="detail-section">
          <div class="detail-section-head">
            <h2 class="detail-section-title">Screenshots</h2>
            <span class="detail-section-count">${data.screenshots.length}</span>
          </div>
          <div class="screenshot-grid">
            ${data.screenshots
              .map(
                (shot, index) => `
                  <button
                    class="screenshot"
                    type="button"
                    data-shot-index="${index}"
                    aria-label="View screenshot ${index + 1} of ${data.screenshots.length}"
                  >
                    <img src="${escapeAttr(shot.thumb)}" alt="" loading="lazy" />
                  </button>
                `,
              )
              .join('')}
          </div>
        </section>
      `
      : '';

    const moviesMarkup = data.movies?.length
      ? `
        <section class="detail-section">
          <h2 class="detail-section-title">Trailers & gameplay</h2>
          <div class="trailer-grid">
            ${data.movies
              .map((movie) => {
                const source = movie.mp4 || movie.webm;
                return `
                  <div class="trailer-card">
                    <video
                      controls
                      preload="none"
                      playsinline
                      poster="${escapeAttr(movie.thumbnail)}"
                      src="${escapeAttr(source)}"
                    ></video>
                    <p>${escapeHtml(movie.name)}</p>
                  </div>
                `;
              })
              .join('')}
          </div>
        </section>
      `
      : '';

    const achievementsMarkup = data.achievements?.total
      ? `
        <section class="detail-section">
          <div class="detail-section-head">
            <h2 class="detail-section-title">Achievements</h2>
            <span class="detail-section-count">${data.achievements.total}</span>
          </div>
          ${
            data.achievements.highlighted?.length
              ? `<div class="achievement-grid">
                  ${data.achievements.highlighted
                    .map((achievement) => {
                      const iconUrl = achievement.path
                        ? /^https?:/i.test(achievement.path)
                          ? achievement.path
                          : `https://cdn.akamai.steamstatic.com/steamcommunity/public/images/apps/${data.id}/${achievement.path}`
                        : '';
                      return `
                        <div class="achievement">
                          ${iconUrl ? `<img src="${escapeAttr(iconUrl)}" alt="" loading="lazy" />` : icon('gamepad')}
                          <span>${escapeHtml(achievement.name)}</span>
                        </div>
                      `;
                    })
                    .join('')}
                </div>`
              : `<p class="detail-copy">This game has ${data.achievements.total} achievements to unlock on Steam.</p>`
          }
        </section>
      `
      : '';

    const languagesMarkup = data.supportedLanguages
      ? `
        <section class="detail-section">
          <h2 class="detail-section-title">Supported languages</h2>
          <div class="rich-text language-table">${sanitizeRichHtml(
            data.supportedLanguages,
          )}</div>
        </section>
      `
      : '';

    const legalMarkup = data.legalNotice
      ? `
        <section class="detail-section">
          <h2 class="detail-section-title">Legal notice</h2>
          <div class="rich-text legal-copy">${sanitizeRichHtml(data.legalNotice)}</div>
        </section>
      `
      : '';

    const platforms = [
      data.platforms?.windows ? 'Windows' : '',
      data.platforms?.mac ? 'macOS' : '',
      data.platforms?.linux ? 'Linux' : '',
    ]
      .filter(Boolean)
      .join(', ');

    return `
      <div class="detail-topline">
        <button class="btn ghost small" type="button" data-action="close-detail">
          ${icon('chevron-left')}
          Back to store
        </button>
      </div>

      <section class="detail-hero">
        ${
          heroBackground
            ? `<div class="detail-hero-bg"><img src="${escapeAttr(heroBackground)}" data-fallback="${escapeAttr(
                data.headerImage || '',
              )}" alt="" draggable="false" /></div>`
            : ''
        }
        <div class="detail-hero-shade"></div>
        <div class="detail-intro">
          <div class="detail-badges">${badges.join('')}</div>
          <h1 class="detail-title">${escapeHtml(data.name)}</h1>
          <p class="detail-short">${escapeHtml(data.shortDescription)}</p>
          <div class="detail-meta">${metaHtml}</div>
          <div class="detail-actions">
            <button class="btn primary" type="button" data-open-url="${escapeAttr(data.url)}">
              ${detailBuyLabel(data)}
              ${icon('external')}
            </button>
            <button
              class="btn ghost${saved ? ' is-saved' : ''}"
              type="button"
              data-heart="${escapeAttr(data.id)}"
              aria-pressed="${saved}"
            >
              ${icon('heart')}
              <span data-heart-label>${saved ? 'On Wishlist' : 'Add to Wishlist'}</span>
            </button>
          </div>
        </div>
      </section>

      <div class="detail-layout">
        <div class="detail-main">
          ${
            aboutHtml
              ? `<section class="detail-section">
                  <h2 class="detail-section-title">About this game</h2>
                  <div class="rich-text about-copy">${aboutHtml}</div>
                </section>`
              : ''
          }
          ${fitgirlSectionMarkup()}
          ${screenshotsMarkup}
          ${moviesMarkup}
          ${requirementsMarkup(data)}
          ${languagesMarkup}
          ${achievementsMarkup}
          ${legalMarkup}
        </div>

        <aside class="detail-aside">
          ${detailPurchaseCard(data)}
          ${detailStatsCard(data)}

          <div class="detail-card">
            <h3 class="detail-card-title">Game details</h3>
            <dl class="detail-facts">
              ${detailFact('Release date', data.releaseDate?.date || 'TBA')}
              ${detailFact('Developer', data.developers?.join(', '))}
              ${detailFact('Publisher', data.publishers?.join(', '))}
              ${detailFact('Platforms', platforms)}
              ${detailFact('Type', data.type === 'dlc' ? 'Downloadable content' : 'Base game')}
              ${
                data.controllerSupport
                  ? detailFact(
                      'Controller',
                      data.controllerSupport === 'full' ? 'Full support' : 'Partial support',
                    )
                  : ''
              }
              ${
                data.dlc?.length
                  ? detailFact(
                      'DLC',
                      `${data.dlc.length} item${data.dlc.length === 1 ? '' : 's'}`,
                    )
                  : ''
              }
            </dl>
            ${
              data.genres?.length || data.categories?.length
                ? `<div class="detail-tags">
                    ${[...(data.genres || []), ...(data.categories || [])]
                      .slice(0, 14)
                      .map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`)
                      .join('')}
                  </div>`
                : ''
            }
          </div>

          ${detailLinksCard(data)}
          ${detailRatingsCard(data)}
        </aside>
      </div>
    `;
  }

  function fitgirlLoadingMarkup() {
    return `
      <div class="fitgirl-loading" role="status">
        <span>Searching FitGirl for this repack…</span>
      </div>
    `;
  }

  function fitgirlSectionMarkup() {
    return `
      <section class="detail-section fitgirl-section" id="fitgirlSection">
        <div class="detail-section-head">
          <h2 class="detail-section-title">Repack downloads</h2>
          <span class="detail-section-count">FitGirl</span>
        </div>
        <div id="fitgirlBody">${fitgirlLoadingMarkup()}</div>
      </section>
    `;
  }

  function fitgirlLinkMarkup(link) {
    const host = link.magnet ? 'magnet' : link.host || hostLabel(link.url);
    return `
      <button
        class="fitgirl-link"
        type="button"
        data-open-url="${escapeAttr(link.url)}"
        title="${escapeAttr(link.url)}"
      >
        <span class="fitgirl-link-name">${escapeHtml(link.name || host)}</span>
        <span class="fitgirl-link-host">${escapeHtml(host)}</span>
        ${icon('external')}
      </button>
    `;
  }

  function fitgirlGroupMarkup(group, index) {
    const kindLabel =
      group.kind === 'torrent' ? 'Torrent' : group.kind === 'update' ? 'Update' : 'Direct';
    return `
      <details class="fitgirl-group"${index === 0 ? ' open' : ''}>
        <summary class="fitgirl-group-head">
          <span class="fitgirl-host">${escapeHtml(group.label)}</span>
          <span class="fitgirl-meta">
            <span class="fitgirl-kind ${escapeAttr(group.kind)}">${kindLabel}</span>
            <span class="fitgirl-count">${group.links.length}</span>
            ${icon('chevron-right')}
          </span>
        </summary>
        <div class="fitgirl-links">
          ${group.links.map((link) => fitgirlLinkMarkup(link)).join('')}
        </div>
        <div class="fitgirl-group-actions">
          <button
            class="btn ghost small"
            type="button"
            data-fitgirl-copy="${escapeAttr(group.id)}"
          >
            Copy ${group.links.length} links
          </button>
        </div>
      </details>
    `;
  }

  function fitgirlDataMarkup(data) {
    const groups = data.groups || [];
    return `
      <div class="fitgirl-summary">
        <div class="fitgirl-summary-copy">
          <strong>${escapeHtml(data.matchedTitle || data.gameTitle || 'FitGirl repack')}</strong>
          <span>
            ${data.total} links · ${groups.length} ${groups.length === 1 ? 'host' : 'hosts'}
          </span>
        </div>
        <div class="fitgirl-summary-actions">
          <button class="btn ghost small" type="button" data-open-url="${escapeAttr(data.postUrl)}">
            Repack page ${icon('external')}
          </button>
          <button class="btn ghost small" type="button" data-action="refresh-fitgirl">
            ${icon('refresh')} Refresh
          </button>
        </div>
      </div>
      <p class="fitgirl-disclaimer">
        Unofficial links scraped from fitgirl-repacks.site. The launcher does not host or verify
        these files.
      </p>
      <div class="fitgirl-groups">
        ${groups.map((group, index) => fitgirlGroupMarkup(group, index)).join('')}
      </div>
    `;
  }

  function fitgirlErrorMarkup(message) {
    const name = state.detail?.data?.name || state.detail?.summary?.name || 'this game';
    const searchUrl =
      state.detail?.fitgirl?.searchUrl ||
      `https://fitgirl-repacks.site/?s=${encodeURIComponent(name)}`;
    return `
      <div class="fitgirl-state">
        <p>${escapeHtml(message || 'No repack downloads were found for this game.')}</p>
        <div class="fitgirl-state-actions">
          <button class="btn ghost small" type="button" data-action="refresh-fitgirl">
            ${icon('refresh')} Try again
          </button>
          <button class="btn ghost small" type="button" data-open-url="${escapeAttr(searchUrl)}">
            Search on FitGirl ${icon('external')}
          </button>
        </div>
      </div>
    `;
  }

  function renderFitGirlSection() {
    const body = $('#fitgirlBody');
    if (!body) return;

    const fitgirl = state.detail?.fitgirl;
    if (!fitgirl || fitgirl.loading) {
      body.innerHTML = fitgirlLoadingMarkup();
      return;
    }
    if (fitgirl.error) {
      body.innerHTML = fitgirlErrorMarkup(fitgirl.error);
      return;
    }
    if (!fitgirl.data?.groups?.length) {
      body.innerHTML = fitgirlErrorMarkup('No download links were found for this game.');
      return;
    }
    body.innerHTML = fitgirlDataMarkup(fitgirl.data);
  }

  async function loadFitGirl(id, requestId, force = false) {
    if (!state.detail) return;

    state.detail.fitgirl = { loading: true, data: null, error: null, searchUrl: null };
    renderFitGirlSection();

    try {
      if (!api?.getFitGirlDownloads) throw new Error('The desktop bridge is unavailable.');
      const result = await api.getFitGirlDownloads(id, force);
      if (requestId !== state.detailRequest) return;

      if (result?.ok === false) {
        state.detail.fitgirl = {
          loading: false,
          data: null,
          error: result.message,
          searchUrl: result.searchUrl || null,
        };
      } else {
        state.detail.fitgirl = {
          loading: false,
          data: result,
          error: null,
          searchUrl: result?.searchUrl || null,
        };
      }
    } catch (error) {
      if (requestId !== state.detailRequest) return;
      state.detail.fitgirl = {
        loading: false,
        data: null,
        error: error?.message || 'Could not fetch repack downloads.',
        searchUrl: null,
      };
    }

    renderFitGirlSection();
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through to the legacy clipboard path */
    }

    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const copied = document.execCommand('copy');
      area.remove();
      return copied;
    } catch {
      return false;
    }
  }

  async function copyFitGirlGroup(groupId) {
    const group = state.detail?.fitgirl?.data?.groups?.find((entry) => entry.id === groupId);
    if (!group) return;

    const copied = await copyText(group.links.map((link) => link.url).join('\n'));
    showToast(
      copied ? `Copied ${group.links.length} ${group.label} links` : 'Could not copy links.',
    );
  }

  function renderDetailLoading() {    const mount = $('#gameDetailMount');
    if (!mount) return;

    mount.innerHTML = `
      <div class="detail-topline">
        <button class="btn ghost small" type="button" data-action="close-detail">
          ${icon('chevron-left')}
          Back to store
        </button>
      </div>
      <div class="detail-hero detail-hero-skeleton skeleton"></div>
      <div class="detail-layout">
        <div class="detail-main">
          <div class="detail-card detail-block skeleton" style="height: 260px"></div>
          <div class="detail-card detail-block skeleton" style="height: 210px"></div>
        </div>
        <aside class="detail-aside">
          <div class="detail-card detail-block skeleton" style="height: 230px"></div>
          <div class="detail-card detail-block skeleton" style="height: 300px"></div>
        </aside>
      </div>
    `;
  }

  function renderDetailError(message) {
    const mount = $('#gameDetailMount');
    if (!mount) return;

    const name = state.detail?.summary?.name || 'this game';
    const url = state.detail?.summary?.url || '';

    mount.innerHTML = `
      <div class="detail-topline">
        <button class="btn ghost small" type="button" data-action="close-detail">
          ${icon('chevron-left')}
          Back to store
        </button>
      </div>
      <div class="error-state">
        <h2>Could not load ${escapeHtml(name)}</h2>
        <p>${escapeHtml(message || 'Steam did not return the game details.')}</p>
        <div class="empty-actions">
          <button class="btn primary" type="button" data-action="retry-game">
            ${icon('refresh')}
            Try Again
          </button>
          ${
            url
              ? `<button class="btn ghost" type="button" data-open-url="${escapeAttr(
                  url,
                )}">Open on Steam ${icon('external')}</button>`
              : ''
          }
        </div>
      </div>
    `;
  }

  function renderGameDetail() {
    const mount = $('#gameDetailMount');
    if (!mount || !state.detail?.data) return;
    mount.innerHTML = gameDetailMarkup(state.detail.data);
  }

  function updateRequirementsTab(tab) {
    const data = state.detail?.data;
    if (!data) return;
    if (!data[`${tab}Requirements`]) return;

    state.detail.reqTab = tab;
    $$('.req-tab', $('#gameDetailMount')).forEach((button) => {
      button.classList.toggle('is-active', button.dataset.reqTab === tab);
    });

    const body = $('.req-body', $('#gameDetailMount'));
    if (body) body.innerHTML = requirementsBody(data, tab);
  }

  function openLightbox(index) {
    const screenshots = state.detail?.data?.screenshots || [];
    if (!screenshots.length) return;

    state.lightboxIndex = (index + screenshots.length) % screenshots.length;
    const lightbox = $('#lightbox');
    const image = $('#lightboxImage');
    const caption = $('#lightboxCaption');
    if (!lightbox || !image) return;

    const shot = screenshots[state.lightboxIndex];
    image.src = shot.full;
    image.alt = `Screenshot ${state.lightboxIndex + 1}`;
    if (caption) {
      caption.textContent = `${state.lightboxIndex + 1} / ${screenshots.length}`;
    }
    lightbox.hidden = false;
    document.body.classList.add('lightbox-open');
  }

  function closeLightbox() {
    const lightbox = $('#lightbox');
    const image = $('#lightboxImage');
    if (!lightbox) return;
    lightbox.hidden = true;
    if (image) image.removeAttribute('src');
    document.body.classList.remove('lightbox-open');
  }

  function moveLightbox(direction) {
    const screenshots = state.detail?.data?.screenshots || [];
    if (!screenshots.length) return;
    openLightbox(state.lightboxIndex + direction);
  }

  async function openGame(id) {
    const key = String(id);
    if (state.view !== 'game') {
      state.detailOrigin = { view: state.view, scrollY: window.scrollY };
    } else if (!state.detailOrigin) {
      state.detailOrigin = { view: 'discover', scrollY: 0 };
    }

    const summary = state.catalog.get(key) || null;
    const requestId = ++state.detailRequest;

    state.detail = {
      id: key,
      summary,
      data: null,
      loading: true,
      error: null,
      reqTab: 'pc',
    };
    setView('game');
    renderDetailLoading();

    try {
      if (!api?.getGame) throw new Error('The desktop bridge is unavailable.');
      const data = await api.getGame(key);
      if (requestId !== state.detailRequest) return;
      if (!data) throw new Error('Steam did not return details for this game.');

      state.detail = {
        id: key,
        summary,
        data,
        loading: false,
        error: null,
        reqTab: pickRequirementTab(data),
        fitgirl: { loading: true, data: null, error: null },
      };
      renderGameDetail();
      updateWishlistUI();
      loadFitGirl(key, requestId);
    } catch (error) {
      if (requestId !== state.detailRequest) return;
      state.detail = {
        ...state.detail,
        loading: false,
        error: error?.message || 'Unable to load game details.',
      };
      renderDetailError(state.detail.error);
    }
  }

  function closeDetail() {
    const origin = state.detailOrigin || { view: 'discover', scrollY: 0 };
    state.detailRequest += 1;
    closeLightbox();
    setView(origin.view === 'game' ? 'discover' : origin.view);
    const target = Number(origin.scrollY) || 0;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => window.scrollTo(0, target));
    });
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
            aria-label="View details for ${escapeAttr(game.name)}"
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
                  ${icon('chevron-right')}
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
    const allowed = ['discover', 'browse', 'news', 'wishlist', 'library', 'game'];
    if (!allowed.includes(name)) return;

    state.view = name;
    $$('.view').forEach((view) => {
      view.hidden = view.id !== `view-${name}`;
    });

    const tabContext =
      name === 'game' ? state.detailOrigin?.view || 'discover' : name;

    $$('.top-tab').forEach((tab) => {
      const active = tab.dataset.tab === tabContext;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
    });

    $$('.rail-btn[data-nav]').forEach((button) => {
      const target = button.dataset.nav;
      const active =
        target === tabContext ||
        (target === 'discover' &&
          ['discover', 'browse', 'news'].includes(tabContext));
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
    state.searchRequest += 1;
    clearTimeout(state.searchTimer);
    state.searchTimer = null;
    state.searchLoading = false;
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

  function localSearchMatches(query, limit = 6) {
    const term = query.toLocaleLowerCase();
    const tokens = term.split(/\s+/).filter(Boolean);

    return [...state.catalog.values()]
      .map((game) => {
        const name = game.name.toLocaleLowerCase();
        return {
          game,
          starts: name.startsWith(term) ? 0 : 1,
          matchesAllTokens: tokens.every((token) => name.includes(token)),
        };
      })
      .filter((entry) => entry.matchesAllTokens)
      .sort((a, b) => a.starts - b.starts || a.game.name.localeCompare(b.game.name))
      .slice(0, limit)
      .map((entry) => entry.game);
  }

  function mergeSearchResults(local, remote) {
    const seen = new Set();
    const merged = [];

    for (const game of [...(local || []), ...(remote || [])]) {
      const id = String(game?.id || '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      merged.push(game);
      if (merged.length >= 8) break;
    }

    return merged;
  }

  function searchEmptyMarkup(query, loading) {
    if (loading) {
      return '<div class="search-empty is-loading">Searching Steam…</div>';
    }
    return `<div class="search-empty">No games match “${escapeHtml(query)}”.</div>`;
  }

  function renderSearchResults(rawQuery) {
    const popover = $('#searchPopover');
    const input = $('#searchInput');
    if (!popover || !input) return;

    const query = String(rawQuery || '').trim();
    state.searchIndex = -1;
    state.searchRequest += 1;
    const requestId = state.searchRequest;
    clearTimeout(state.searchTimer);
    state.searchTimer = null;

    if (query.length < 2) {
      closeSearch();
      return;
    }

    const local = localSearchMatches(query);
    state.searchResults = local;
    state.searchLoading = true;

    popover.innerHTML = local.length
      ? local.map((game) => searchResultMarkup(game)).join('')
      : searchEmptyMarkup(query, true);
    popover.hidden = false;
    input.setAttribute('aria-expanded', 'true');

    if (!api?.searchStore) {
      state.searchLoading = false;
      popover.innerHTML = local.length
        ? local.map((game) => searchResultMarkup(game)).join('')
        : searchEmptyMarkup(query, false);
      return;
    }

    state.searchTimer = setTimeout(async () => {
      try {
        const remote = await api.searchStore(query);
        if (requestId !== state.searchRequest) return;

        const merged = mergeSearchResults(local, remote);
        state.searchResults = merged;
        state.searchLoading = false;
        state.searchIndex = -1;

        popover.innerHTML = merged.length
          ? merged.map((game) => searchResultMarkup(game)).join('')
          : searchEmptyMarkup(query, false);
      } catch {
        if (requestId !== state.searchRequest) return;
        state.searchLoading = false;
        if (!local.length) {
          popover.innerHTML = searchEmptyMarkup(query, false);
        }
      }
    }, 220);
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

      const fitgirlCopy = target.closest('[data-fitgirl-copy]');
      if (fitgirlCopy) {
        event.preventDefault();
        copyFitGirlGroup(fitgirlCopy.dataset.fitgirlCopy);
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

      const shot = target.closest('[data-shot-index]');
      if (shot) {
        openLightbox(Number(shot.dataset.shotIndex) || 0);
        return;
      }

      const lightboxClose = target.closest('[data-lightbox-close]');
      if (lightboxClose) {
        closeLightbox();
        return;
      }

      const lightboxDirection = target.closest('[data-lightbox-dir]');
      if (lightboxDirection) {
        moveLightbox(Number(lightboxDirection.dataset.lightboxDir) || 1);
        return;
      }

      const requirementTab = target.closest('[data-req-tab]');
      if (requirementTab) {
        updateRequirementsTab(requirementTab.dataset.reqTab);
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

    const lightbox = $('#lightbox');
    lightbox?.addEventListener('click', (event) => {
      if (event.target === lightbox) closeLightbox();
    });

    window.addEventListener('keydown', (event) => {
      const lightboxEl = $('#lightbox');
      if (lightboxEl && !lightboxEl.hidden) {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeLightbox();
          return;
        }
        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          moveLightbox(-1);
          return;
        }
        if (event.key === 'ArrowRight') {
          event.preventDefault();
          moveLightbox(1);
          return;
        }
      }

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

      if (event.key === 'Escape') {
        const popover = $('#searchPopover');
        if (popover && !popover.hidden) {
          closeSearch();
          return;
        }
        if (state.view === 'game') {
          closeDetail();
          return;
        }
        closeSearch();
      }
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
      case 'close-detail':
        closeDetail();
        break;
      case 'retry-game':
        if (state.detail?.id) openGame(state.detail.id);
        break;
      case 'refresh-fitgirl':
        if (state.detail?.id) loadFitGirl(state.detail.id, state.detailRequest, true);
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
