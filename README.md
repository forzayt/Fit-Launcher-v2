# Fit Launcher v2

An Electron storefront prototype for browsing Steam games and finding FitGirl repack downloads.

## Features

- Steam store discovery: featured carousel, specials, top sellers, new releases, coming soon, and free-to-play rows.
- Real store search: instant matches from the loaded catalog plus live results from Steam's Store Search API.
- Game details: screenshots, trailers, requirements, languages, achievements, ratings, and links.
- FitGirl repack downloads: fetched directly from `fitgirl-repacks.site` inside the launcher, grouped by hoster (direct links, torrents, and game updates).
- Wishlist saved locally in `localStorage`.

## Run

```bash
npm install
npm start
```

## How the FitGirl fetching works

`fitgirl.js` runs in the Electron main process:

1. Searches `fitgirl-repacks.site` using the Steam game title.
2. Picks the best matching repack post (edition suffixes, spin-offs, and update digests are handled).
3. Parses only the post's download sections and groups links by hoster.
4. Caches results in memory and in the app's `cache` folder for 6 hours.

The renderer requests the data through the `fitgirl:getDownloads` IPC channel exposed by `preload.js`. No remote FitgirlAPI server is required.

## Notes

- Download and magnet links open in the default browser or torrent client.
- Games without a FitGirl repack show a friendly message and a link to search FitGirl manually.
- Repack links are unofficial; the launcher does not host or verify any files.
