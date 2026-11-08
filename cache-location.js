const path = require('node:path');
const os = require('node:os');
const { app } = require('electron');

// Chromium stores its own HTTP cache in `<userData>/Cache`. On Windows that is
// the same directory as `<userData>/cache`, so the app's cache must live
// elsewhere or clearing it fails with EBUSY on files Chromium keeps open.
const CACHE_DIRNAME = 'app-cache';

let baseDirectory = null;

function cacheBase() {
  if (baseDirectory) return baseDirectory;
  try {
    baseDirectory = app?.getPath
      ? app.getPath('userData')
      : path.join(os.tmpdir(), 'fit-launcher');
  } catch {
    baseDirectory = path.join(os.tmpdir(), 'fit-launcher');
  }
  return baseDirectory;
}

function cacheDirectory() {
  return path.join(cacheBase(), CACHE_DIRNAME);
}

// Older versions wrote their caches into `<userData>/cache`, which collides with
// Chromium's directory. Used only to clean up leftover app files.
function legacyCacheDirectory() {
  return path.join(cacheBase(), 'cache');
}

module.exports = { cacheDirectory, legacyCacheDirectory };
