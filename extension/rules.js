// Static baseline. These are the patterns that are the same on every site, so
// they never need to reach the model — they are applied as CSS at document_start,
// before the first paint.
//
// Kept deliberately conservative: a false positive here breaks a page on every
// site at once, while a miss just falls through to the heuristics and then to
// the AI pass.

const OMARCHY_STATIC_SELECTORS = [
  // Ad slot containers by convention
  '[id^="google_ads_"]',
  '[id^="div-gpt-ad"]',
  '[id^="ad-slot"]',
  '[id^="adslot"]',
  'ins.adsbygoogle',
  '[class*="taboola"]',
  '[class*="outbrain"]',
  '[data-ad-slot]',
  '[data-adunit]',
  '[aria-label="advertisement" i]',

  // Iframes that only ever carry ads
  'iframe[src*="doubleclick.net"]',
  'iframe[src*="googlesyndication.com"]',
  'iframe[src*="adservice."]',
  'iframe[src*="/ads/"]',
  'iframe[id^="google_ads_iframe"]',

  // Sticky rails and interstitial scaffolding
  '.ad-container', '.ad-wrapper', '.ad-banner', '.adsbox', '.ad-placeholder',
  '#sticky-ad', '.sticky-ad', '.leaderboard-ad',
];

// Elements the blocker must never touch, whatever anything else concludes.
// Checked before every hide, including hides that came back from the model.
const OMARCHY_PROTECTED = [
  'html', 'body', 'head', 'main', 'article',
  '[role="main"]', 'nav', 'header > nav',
  'form', 'input', 'textarea', 'select', 'button',
  'video', 'audio',
];

// Hosts where an overlay is usually the app itself, not an interruption.
const OMARCHY_HEURISTIC_SKIP = [
  'docs.google.com', 'drive.google.com', 'mail.google.com', 'calendar.google.com',
  'figma.com', 'notion.so', 'linear.app', 'slack.com', 'discord.com',
  'app.slack.com', 'meet.google.com', 'zoom.us', 'github.com', 'gitlab.com',
  'youtube.com', 'netflix.com', 'web.whatsapp.com', 'x.com', 'twitter.com',
];
