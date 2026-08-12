#!/usr/bin/env node
/*
 * Generate the 8 missing privacy policy pages for the REALESED EXT family,
 * matching the exact HTML style of https://mrfentmen.github.io/privacy-policies/
 * plus an updated index.html with the new entries added.
 */
import fs from 'node:fs';
import path from 'node:path';

const OUT = '/Users/del/Desktop/REALESED EXT/privacy-policies';

const STYLE = `body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;color:#1a1a1f;line-height:1.65}h1{font-size:26px}h2{font-size:19px;margin-top:28px}li{margin:6px 0}a{color:#065fd4}.back{display:inline-block;margin-bottom:20px;font-size:14px}`;

// name, slug, what it does, what's stored locally, network description
const PAGES = [
  {
    slug: 'random-fact-generator',
    name: 'Random Fact Generator',
    does: 'a popup that shows a random useless-but-true fact with one click, with copy, category tags, and a saved favorites list.',
    storage: 'Your saved favorites list is stored locally in your browser using the storage API. It never leaves your device and is cleared when you uninstall the extension.',
    network: 'When you click for a new fact, the extension requests the public Useless Facts API (uselessfacts.jsph.pl) for a random piece of trivia. The request carries no personal data, and nothing else is sent anywhere.',
  },
  {
    slug: 'image-to-pdf',
    name: 'Image to PDF',
    does: 'a toolbar popup that combines images you add into a PDF file, with page reordering, page size, orientation, and margin options, then downloads the result.',
    storage: 'Nothing is stored. Images you add are held in memory only for the current popup session.',
    network: 'This extension makes no network requests at all. Images are decoded and re-encoded locally on your device and never leave your computer.',
  },
  {
    slug: 'where-is-iss',
    name: 'Where Is the ISS?',
    does: 'a tracker that shows the live position of the International Space Station on a map in the toolbar popup, with a trail and the current crew count.',
    storage: 'The station\u2019s recent flight trail is stored locally in your browser using the storage API so the map can draw the path you have already seen. It never leaves your device and is cleared when you uninstall the extension.',
    network: 'The popup requests the public open-notify API (api.open-notify.org) for the station\u2019s current position and crew list. These requests include your IP address, as any web request does. The extension does not request your location and sends nothing else anywhere.',
  },
  {
    slug: 'wiki-instant',
    name: 'Wiki Instant',
    does: 'a toolbar popup that searches Wikipedia, shows live suggestions as you type, and displays a clean article summary with a thumbnail and a link to the full article.',
    storage: 'Your recent searches (up to eight) are stored locally in your browser using the storage API. They never leave your device and are cleared when you uninstall the extension.',
    network: 'When you search or open an article, the extension requests Wikipedia\u2019s public API (en.wikipedia.org) with your search terms, just like typing into the Wikipedia search box. The extension sends no data anywhere else.',
  },
  {
    slug: 'image-resize-compressor',
    name: 'Image Resize & Compress',
    does: 'a toolbar popup that resizes and compresses images you drop in, with aspect lock, PNG/JPEG/WebP output, and a quality slider, then downloads the result.',
    storage: 'Nothing is stored. Images you process are read into memory on your device, rendered on a local canvas, and never leave your computer.',
    network: 'This extension makes no network requests at all. Every pixel is processed locally in your browser.',
  },
  {
    slug: 'whiteboard',
    name: 'Whiteboard',
    does: 'a drawing board in the toolbar popup where you can sketch with pen, line, rectangle, ellipse, eraser, and text tools, and export the result as a PNG.',
    storage: 'Your current board is saved locally in your browser using the storage API so it survives closing the popup. It never leaves your device and is cleared when you uninstall the extension.',
    network: 'This extension makes no network requests at all. Nothing you draw is ever uploaded anywhere.',
  },
  {
    slug: 'internet-radio-player',
    name: 'Internet Radio Player',
    does: 'a toolbar popup that searches a public directory of internet radio stations, plays a station you pick, and remembers your favorites and last-played station.',
    storage: 'Your favorite stations and the last station you played are stored locally in your browser using the storage API. They never leave your device and are cleared when you uninstall the extension.',
    network: 'When you search for stations, the extension queries the public radio-browser directory (de1.api.radio-browser.info). When you play a station, your browser connects directly to that station\u2019s streaming server, just like visiting a website. The extension itself sends no personal data anywhere.',
  },
  {
    slug: 'hacker-news-reader',
    name: 'Hacker News Reader',
    does: 'a toolbar popup that shows the latest stories from Hacker News across the Top, Ask, Show, and Jobs feeds, with points, comments, author, and age, plus starred stories.',
    storage: 'Your starred stories are stored locally in your browser using the storage API. They never leave your device and are cleared when you uninstall the extension.',
    network: 'When you open the popup or switch feeds, the extension requests the public Hacker News API (hacker-news.firebaseio.com) for the current stories. These requests include your IP address, as any web request does. The extension sends nothing else anywhere.',
  },
];

function pageHtml(p) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Privacy Policy</title>
<style>${STYLE}</style>
</head><body>
<a class="back" href="/privacy-policies/">Back to all policies</a>
<h1>Privacy Policy for ${p.name}</h1>
<p>Last updated: August 11, 2026</p>
<h2>What this extension does</h2>
<p>${p.does}</p>
<h2>Data collection</h2>
<p>This extension does not collect any personal data. It has no accounts, no login, and no server. Everything it does happens locally on your device, and nothing is sold or shared.</p>
<h2>Local storage</h2>
<p>${p.storage}</p>
<h2>Network</h2>
<p>${p.network}</p>
<h2>Contact</h2>
<p>Questions about this policy can be sent to contactae2000@gmail.com.</p>
</body></html>
`;
}

// Existing index links (parsed from the live site).
const EXISTING = [
  'aim-away-bar.html|Aim Away Bar', 'api-tester.html|Api Tester', 'auto-tab-suspender.html|Auto Tab Suspender',
  'baby-tracker.html|Baby Tracker', 'block-watch.html|Block Watch', 'bookmark-tagger.html|Bookmark Tagger',
  'budget-tracker.html|Budget Tracker', 'calorie-tracker.html|Calorie Tracker', 'chiptune-midi-player.html|Chiptune Midi Player',
  'chrome-skin-pack.html|Chrome Skin Pack', 'color-palette-extractor.html|Color Palette Extractor', 'coupon-finder.html|Coupon Finder',
  'crt-tv-frame.html|CRT TV Frame', 'css-debugger.html|CSS Debugger', 'desktop-pet.html|Desktop Pet',
  'weather-wallpaper.html|Living Weather Wallpaper', 'focus-blocker.html|Focus Blocker', 'frutiger-aero-aquarium.html|Frutiger Aero Aquarium',
  'geocities-revival.html|Geocities Revival', 'gif-maker.html|GIF Maker', 'goals-newtab.html|Goals New Tab',
  'hacker-typer.html|Hacker Typer', 'kaomoji-keyboard.html|Kaomoji Keyboard', 'mbti-quiz.html|MBTI Quiz',
  'meal-planner.html|Meal Planner', 'medication-reminders.html|Medication Reminders', 'page-notes.html|Page Notes',
  'plant-doctor.html|Plant Doctor', 'pomodoro-ambient.html|Pomodoro Ambient', 'price-drop-alert.html|Price Drop Alert',
  'screen-recorder.html|Screen Recorder', 'screenshot-annotate.html|Screenshot Annotate', 'seo-inspector.html|SEO Inspector',
  'smart-tab-manager.html|Smart Tab Manager', 'soundcloud-downloader.html|SoundCloud Downloader', 'time-capsule.html|Time Capsule',
  'video-speed-pip.html|Video Speed PiP', 'winamp-player.html|Winamp Player', 'wine-pairer.html|Wine Pairer',
  'xp-bliss-newtab.html|XP Bliss New Tab', 'y2k-cursor-pack.html|Y2K Cursor Pack', 'y2k-new-tab.html|Y2K New Tab',
  'youtube-downloader.html|YouTube Downloader', "youve-got-mail.html|You've Got Mail", 'zodiac-day-card.html|Zodiac Day Card',
];

const NEW_LINKS = PAGES.map((p) => `${p.slug}.html|${p.name}`);

// Add new entries into alphabetical order (case-insensitive by display name).
const all = EXISTING.concat(NEW_LINKS).sort((a, b) =>
  a.split('|')[1].toLowerCase().localeCompare(b.split('|')[1].toLowerCase()));

const indexHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Privacy Policies</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;color:#1a1a1f;line-height:1.65}h1{font-size:26px}ul{columns:2;column-gap:40px;list-style:none;padding:0}li{margin:6px 0}a{color:#065fd4;text-decoration:none}a:hover{text-decoration:underline}</style>
</head><body>
<h1>Extension Privacy Policies</h1>
<p>Each extension below has its own policy page. The short version for all of them: no personal data is collected, everything you save stays in your browser's local storage on your device, and nothing is sold or shared.</p>
<ul>
${all.map((e) => `<a href="${e.split('|')[0]}">${e.split('|')[1]}</a><br>`).join('\n')}
</ul>
</body></html>
`;

fs.mkdirSync(OUT, { recursive: true });
for (const p of PAGES) {
  fs.writeFileSync(path.join(OUT, `${p.slug}.html`), pageHtml(p));
}
fs.writeFileSync(path.join(OUT, 'index.html'), indexHtml);
console.log('Wrote', PAGES.length, 'policy pages + index.html to', OUT);
for (const p of PAGES) console.log(' -', p.slug + '.html');
