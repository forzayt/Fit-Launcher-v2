'use strict';

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 FitLauncher/2.0';

const INVALID_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;
const RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

const jobs = new Map();
let jobCounter = 0;

function isFuckingFastUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      (url.hostname === 'fuckingfast.co' || url.hostname === 'www.fuckingfast.co')
    );
  } catch {
    return false;
  }
}

function sanitizeName(value, fallback) {
  let name = String(value || '')
    .replace(INVALID_NAME_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .slice(0, 150);

  if (!name) name = fallback;
  if (RESERVED_NAMES.test(name)) name = `_${name}`;
  return name || fallback;
}

function sanitizeFolderName(value) {
  return sanitizeName(value, 'Game');
}

function filenameFromHash(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!url.hash || url.hash.length < 2) return '';
    return decodeURIComponent(url.hash.slice(1)).trim();
  } catch {
    return '';
  }
}

function filenameFromDisposition(value) {
  if (!value) return '';

  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(value);
  if (encoded) {
    try {
      return decodeURIComponent(encoded[1].trim().replace(/^"|"$/g, ''));
    } catch {
      /* fall through to the plain filename */
    }
  }

  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(value);
  return plain ? plain[1].trim() : '';
}

function pickFilename(item, resolved, directUrl, disposition) {
  const candidates = [
    item?.name,
    filenameFromDisposition(disposition),
    filenameFromHash(item?.url),
    resolved?.filename,
  ];

  for (const candidate of candidates) {
    const name = String(candidate || '').trim();
    if (name && /\.[a-z0-9]{2,6}$/i.test(name)) return sanitizeName(name, 'download.bin');
  }

  try {
    const base = decodeURIComponent(path.basename(new URL(directUrl).pathname));
    if (base && /\.[a-z0-9]{2,6}$/i.test(base)) return sanitizeName(base, 'download.bin');
  } catch {
    /* ignore malformed direct URLs */
  }

  return 'download.bin';
}

function emit(job, payload) {
  if (!job.sender || job.sender.isDestroyed()) return;
  job.sender.send('downloads:event', { jobId: job.id, ...payload });
}

async function resolveDirectUrl(linkUrl, signal) {
  const url = new URL(linkUrl);
  const fileId = url.pathname.split('/').filter(Boolean).pop();
  if (!fileId) throw new Error('That FuckingFast link is not valid.');

  const endpoint = new URL(`/f/${encodeURIComponent(fileId)}/go`, 'https://fuckingfast.co/');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      Origin: 'https://fuckingfast.co',
      Referer: linkUrl,
      'HX-Request': 'true',
      'HX-Current-URL': linkUrl,
      'HX-Trigger': 'download-button',
    },
    redirect: 'manual',
    signal,
  });

  const redirect = response.headers.get('hx-redirect') || response.headers.get('location');
  if (redirect) {
    return {
      directUrl: new URL(redirect, 'https://fuckingfast.co/').href,
      filename: filenameFromHash(linkUrl),
    };
  }

  const text = await response.text().catch(() => '');
  const match = /https:\/\/dl\.fuckingfast\.co\/[^\s"'<>\\]+/i.exec(text);
  if (match) {
    return {
      directUrl: match[0].replace(/&amp;/gi, '&'),
      filename: filenameFromHash(linkUrl),
    };
  }

  if (response.status === 429 || response.status === 503) {
    throw new Error('FuckingFast is rate limiting requests. Try again in a minute.');
  }

  throw new Error(`FuckingFast did not return a download link (HTTP ${response.status}).`);
}

async function downloadFile(job, link, index, count) {
  const item = {
    name: String(link?.name || '').trim(),
    url: String(link?.url || '').trim(),
  };

  emit(job, {
    type: 'file-start',
    index,
    count,
    file: item.name || 'Resolving link…',
    folder: job.folder,
  });

  const resolved = await resolveDirectUrl(item.url, job.controller.signal);
  const response = await fetch(resolved.directUrl, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      Origin: 'https://fuckingfast.co',
      Referer: item.url,
    },
    redirect: 'follow',
    signal: job.controller.signal,
  });

  if (!response.ok) {
    throw new Error(`Download failed with HTTP ${response.status}.`);
  }

  const contentType = response.headers.get('content-type') || '';
  if (/text\/html/i.test(contentType)) {
    throw new Error('FuckingFast returned a browser page instead of the file. Try again.');
  }

  const total = Math.max(0, Number(response.headers.get('content-length')) || 0);
  const filename = pickFilename(
    item,
    resolved,
    resolved.directUrl,
    response.headers.get('content-disposition'),
  );
  const target = path.join(job.folder, filename);

  const existing = await fsp.stat(target).catch(() => null);
  if (existing?.isFile() && total > 0 && existing.size === total) {
    await response.body?.cancel().catch(() => {});
    emit(job, {
      type: 'file-done',
      index,
      count,
      file: filename,
      path: target,
      size: existing.size,
      skipped: true,
    });
    return { file: filename, path: target, size: existing.size, skipped: true };
  }

  const temp = `${target}.part`;
  await fsp.mkdir(job.folder, { recursive: true });

  let received = 0;
  let lastEmit = 0;
  let lastPercent = -1;

  if (response.body) {
    const stream = Readable.fromWeb(response.body);
    stream.on('data', (chunk) => {
      received += chunk.length;
      const now = Date.now();
      if (now - lastEmit < 200) return;
      lastEmit = now;
      const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null;
      if (percent !== null && percent === lastPercent) return;
      lastPercent = percent ?? -1;
      emit(job, {
        type: 'file-progress',
        index,
        count,
        file: filename,
        received,
        total,
        percent,
      });
    });

    try {
      await pipeline(stream, fs.createWriteStream(temp), { signal: job.controller.signal });
    } catch (error) {
      await fsp.rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  } else {
    await fsp.writeFile(temp, Buffer.alloc(0));
  }

  await fsp.rm(target, { force: true });
  await fsp.rename(temp, target);

  emit(job, {
    type: 'file-done',
    index,
    count,
    file: filename,
    path: target,
    size: received,
    skipped: false,
  });

  return { file: filename, path: target, size: received, skipped: false };
}

async function runJob(job, links) {
  let downloaded = 0;
  let failed = 0;

  for (let index = 0; index < links.length; index += 1) {
    if (job.cancelled) break;

    try {
      await downloadFile(job, links[index], index + 1, links.length);
      downloaded += 1;
    } catch (error) {
      if (job.cancelled || error?.name === 'AbortError') break;
      failed += 1;
      emit(job, {
        type: 'file-error',
        index: index + 1,
        count: links.length,
        file: links[index]?.name || `File ${index + 1}`,
        error: error?.message || 'Download failed.',
      });
    }
  }

  emit(job, {
    type: 'job-done',
    folder: job.folder,
    total: links.length,
    downloaded,
    failed,
    cancelled: job.cancelled,
  });
}

async function startDownloads({ root, gameTitle, links }, sender) {
  const safeLinks = (Array.isArray(links) ? links : [])
    .map((link) => ({
      name: String(link?.name || '').trim(),
      url: String(link?.url || '').trim(),
    }))
    .filter((link) => isFuckingFastUrl(link.url));

  if (!safeLinks.length) {
    return { ok: false, error: 'No FuckingFast download links were provided.' };
  }
  if (!root || !sender) {
    return { ok: false, error: 'The download destination is unavailable.' };
  }

  const folder = path.join(root, sanitizeFolderName(gameTitle));
  await fsp.mkdir(folder, { recursive: true });

  jobCounter += 1;
  const job = {
    id: `ff-${Date.now()}-${jobCounter}`,
    sender,
    folder,
    controller: new AbortController(),
    cancelled: false,
  };

  jobs.set(job.id, job);
  emit(job, {
    type: 'job-start',
    folder,
    count: safeLinks.length,
    gameTitle: String(gameTitle || ''),
  });

  runJob(job, safeLinks)
    .catch((error) => {
      emit(job, {
        type: 'job-error',
        error: error?.message || 'The download job failed.',
        folder,
      });
    })
    .finally(() => {
      jobs.delete(job.id);
    });

  return { ok: true, jobId: job.id, folder, count: safeLinks.length };
}

function cancelDownloads(jobId) {
  const job = jobs.get(String(jobId || ''));
  if (!job) return { ok: false, error: 'That download is no longer running.' };

  job.cancelled = true;
  job.controller.abort();
  return { ok: true };
}

module.exports = { startDownloads, cancelDownloads };
