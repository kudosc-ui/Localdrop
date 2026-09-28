// pwa.js — service worker registration + hash shortcuts (#clipboard, #devices).
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}
const h = location.hash.slice(1);
if (h) setTimeout(() => document.querySelector(`[data-nav="${h}"]`)?.click(), 300);
