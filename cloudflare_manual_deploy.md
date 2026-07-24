# RadioFa — Cloudflare Manual Deploy Guide

This guide walks you through deploying RadioFa manually from the Cloudflare dashboard — no CLI or local setup required.

## Prerequisites

- A free [Cloudflare account](https://dash.cloudflare.com/sign-up)
- The `src/index.js` source file from this repo

## 1. Create the Worker

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com).
2. Select **Workers & Pages** → **Create** → **Create Worker**.
3. Give it a name (e.g. `radiofa`) and click **Deploy** to create the default version.
4. Open the Worker → **Edit code**.
5. Delete the placeholder code, paste in the full contents of `src/index.js`, then click **Deploy**.

## 2. Add Bindings

Go to **Settings** → **Bindings**.

### KV Namespace (required)
- **Add** → **KV Namespace**
- Create a new namespace and bind it as `RADIO_KV`

### R2 Bucket (required only for playlist-type stations)
- **Add** → **R2 Bucket**
- Create a new bucket and bind it as `RADIO_R2`

## 3. Add Environment Variables & Secrets

Go to **Settings** → **Variables and Secrets** → **Add**.

Add each variable as a **Secret** (encrypted) rather than plain text:

| Variable | Required | Purpose |
|---|---|---|
| `ADMIN_USERNAME` | Recommended | Username for the owner/admin account (default: `admin`) |
| `TRUST_CODE` | Optional | Secret code for VIP self-verification |
| `TRON_ADDRESS` | Optional | TRON wallet address for payments |
| `TELEGRAM_BOT_TOKEN` | Optional | Enables Telegram notifications |
| `TELEGRAM_CHAT_ID` | Optional | Chat ID that receives Telegram notifications |
| `AUDD_API_TOKEN` | Optional | Enables song recognition (AudD API) |
| `TURNSTILE_SITE_KEY` | Optional | Enables Cloudflare Turnstile captcha on signup |
| `TURNSTILE_SECRET_KEY` | Optional | Server-side Turnstile verification |

Leave any optional variable unset if you don't need the related feature — it will be disabled automatically.

## 4. Set Up the Cron Trigger (station health checks)

1. Go to the **Triggers** tab.
2. Under **Cron Triggers**, click **Add**.
3. Enter the schedule: `*/15 * * * *` (runs every 15 minutes).
4. Save.

## 5. Deploy

Click **Save and Deploy** to apply all bindings, variables, and triggers.

Your Worker will be live at:
```
https://<your-worker-name>.<your-subdomain>.workers.dev
```

## 6. First Login

Visit `/admin` on your deployed URL and sign up with the username set in `ADMIN_USERNAME`. The first user to register with that username becomes the `owner`.

## 7. Custom Domain (optional)

1. Add your domain to Cloudflare if it isn't already there.
2. Go to your Worker → **Settings** → **Domains & Routes** → **Add**.
3. Enter your custom domain or route (e.g. `radio.yourdomain.com`) and confirm.

## Security Notes

- Always add sensitive values (`TRUST_CODE`, `TRON_ADDRESS`, tokens) as **Secret**, never as plain text variables.
- Don't hardcode secrets in `src/index.js` before deploying.
- Review bindings and variables periodically if you rotate tokens or wallets.
