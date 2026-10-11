# Order Tracker

A phone-friendly purchase tracker (installable PWA). This repo holds **only the app code**. No order data lives here.
Live app: https://braydendueck.github.io/order-tracker/

- Orders are stored in a separate **private** repo (`braydendueck/order-tracker-data`, file `orders.json`).
- The app reads and writes that file straight from your phone through the GitHub API, using a token you paste once.
  The token is kept only in that browser's local storage. Use **Settings ⚙ → Sign out / forget token** to remove it.
- A copy of the last loaded list is kept on the device, so the app works offline. Changes made offline are saved when you're back online.
- If someone else saves at the same time, the app reloads the latest list, re-applies your change and saves again, so neither change is lost.

## Create the access token (one time, about 2 minutes)

1. Open this link (signed in to GitHub as braydendueck):
   https://github.com/settings/personal-access-tokens/new?name=Order+Tracker+phone&target_name=braydendueck&expires_in=90&contents=write
   It's a **fine-grained** token. The link fills in the name, a 90-day expiry, and the Contents permission.
2. **Repository access:** choose **Only select repositories**, then pick **order-tracker-data** only.
3. **Permissions → Repository permissions → Contents:** **Read and write**. Leave everything else off.
   (GitHub adds "Metadata: Read-only" automatically. That's normal.)
4. **Expiration:** keep an expiry date. 90 days is fine. When the token expires, the app asks for a new one.
5. Tap **Generate token**, copy it (it starts with `github_pat_`), open the app and paste it in.

On iPhone: open the app in Safari → Share → **Add to Home Screen**.

## Development
Static files only (no build): `index.html`, `app.js`, `styles.css`, `sw.js`, `manifest.webmanifest`.
