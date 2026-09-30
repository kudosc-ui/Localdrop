# LocalDrop → APK with PWABuilder

1. Host this folder over **HTTPS** (Netlify / Vercel / GitHub Pages / Cloudflare Pages). Keep `index.html` at the site root.
2. Open https://www.pwabuilder.com, paste your site URL, press **Start**. Manifest, service worker and icons should all pass.
3. **Package for stores → Android**. Set a Package ID (e.g. `com.zynsoft.localdrop`). Display mode: Standalone (choose *Fullscreen* to hide the status bar too).
4. Download the zip. It contains the `.apk`, the `.aab`, a signing key and an `assetlinks.json` snippet.
5. Put the `sha256_cert_fingerprints` value from that snippet into `.well-known/assetlinks.json` (and your package ID), redeploy, so the app opens without the browser address bar.
6. Install the `.apk` on your phone. Use the `.aab` for Play Store. Back up the signing key.

Note: `.well-known/` must be served from the site root (GitHub Pages needs a `.nojekyll` file — included).
