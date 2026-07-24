// @ts-nocheck
/**
 * =======================================================
 * RadioFa — رادیو آنلاین - Cloudflare Worker
 * پشتیبانی از سه نوع ایستگاه:
 *   type: "direct"   — فایل صوتی مستقیم (mp3/aac/ogg) → پروکسی ساده و پاس‌دهی مستقیم
 *   type: "hls"      — استریم HLS صوتی (.m3u8) → بازنویسی پلی‌لیست + پروکسی سگمنت‌ها (مثل IPTV)
 *   type: "playlist" — آهنگ‌های آپلودی خودت (روی R2) که پشت‌سرهم/شافل پخش می‌شن، مثل یه رادیوی شخصی
 * =======================================================
 * متغیرهای محیطی (Environment Variables) مورد نیاز:
 * RADIO_KV         — KV Namespace binding (الزامی)
 * RADIO_R2         — R2 Bucket binding برای آپلود آهنگ‌های ایستگاه‌های نوع playlist (فقط برای این نوع الزامی)
 * ADMIN_USERNAME   — نام‌کاربری حساب ادمین/owner (پیش‌فرض: "admin")
 * TRUST_CODE       — کد اعتماد مخفی برای وریفای VIP (پیش‌فرض: RADIO2025VIP)
 * TRON_ADDRESS     — آدرس کیف پول ترون برای دریافت پرداخت
 * TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID — اعلان‌های تلگرام (اختیاری)
 * AUDD_API_TOKEN   — توکن AudD برای تشخیص آهنگ (Shazam-like) — بدون آن دکمه «شناسایی آهنگ» غیرفعال است
 * TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY — کپچا Cloudflare Turnstile برای ثبت‌نام (اختیاری؛ اگر تنظیم نشوند کپچا غیرفعال می‌ماند)
 *
 * Cron Trigger (بررسی خودکار سلامت ایستگاه‌ها): در wrangler.toml این خطوط را اضافه کن:
 *   [triggers]
 *   crons = ["-/15 - - - -"]   # هر ۱۵ دقیقه یک‌بار (به‌جای خط‌تیره از ستاره استفاده کن، طبق فرمت cron)
 *
 * سطوح دسترسی کاربران (tier): "none" | "sub" (تیک آبی) | "vip" (تیک طلایی)
 * role="owner" برای username === ADMIN_USERNAME (مستقل از tier)
 * سطح دسترسی ایستگاه (access): "public" | "sub" | "vip"
 *
 * توجه درباره‌ی نوع playlist: پخش «رادیویی واقعی» به این معنی که همه‌ی شنونده‌ها دقیقاً
 * هم‌زمان یک نقطه از پخش رو بشنون نیست (اون نیاز به سرور استریم پیوسته داره که Workers
 * به‌تنهایی نمی‌تونه انجام بده). این حالت مثل یک پخش‌کننده‌ی خودکار عمل می‌کنه: آهنگ‌های
 * خودت رو پشت‌سرهم (یا شافل) برای هر کاربر پخش می‌کنه — تجربه‌ی «رادیوی شخصی».
 *
 * اعلان‌های تلگرام: ثبت‌نام کاربر جدید، فعال‌سازی VIP با کد اعتماد،
 * تغییر tier کاربر توسط ادمین (تغییر به sub = معادل تأیید پرداخت دستی TRON)
 * =======================================================
 */

const DEFAULT_STATIONS = [
  { id: "1001", name: "رادیو جوان",   url: "https://radiojavan.stream/live/audio.mp3", icon: "🎵", genre: "pop",   status: "live", access: "public", type: "direct", nowPlaying: "" },
  { id: "1002", name: "BBC Radio Persian", url: "https://stream.bbc.co.uk/persian/audio.mp3", icon: "📻", genre: "news", status: "live", access: "public", type: "direct", nowPlaying: "" },
  { id: "1003", name: "رادیو کلاسیک", url: "https://classicstream.example.com/live.mp3", icon: "🎻", genre: "classic", status: "live", access: "sub", type: "direct", nowPlaying: "" },
  { id: "1004", name: "رادیو HLS زنده", url: "https://hlsstream.example.com/radio", icon: "🌟", genre: "mix", status: "live", access: "vip", type: "hls", playlistSuffix: "/index.m3u8", nowPlaying: "" },
];

const DEFAULT_SETTINGS = { streamCacheTTL: 5, playlistCacheTTL: 4, subPrice: "10", paymentInstructions: "پس از واریز، رسید پرداخت را به ادمین ارسال کنید تا اشتراک شما فعال شود." };

// فهرست کشورها برای انتخاب پرچم ایستگاه (کد ISO دو حرفی → نام فارسی)
const COUNTRIES = [
  { code: "IR", name: "ایران" }, { code: "US", name: "آمریکا" }, { code: "GB", name: "بریتانیا" },
  { code: "DE", name: "آلمان" }, { code: "FR", name: "فرانسه" }, { code: "TR", name: "ترکیه" },
  { code: "AE", name: "امارات" }, { code: "SA", name: "عربستان" }, { code: "AF", name: "افغانستان" },
  { code: "TJ", name: "تاجیکستان" }, { code: "IQ", name: "عراق" }, { code: "CA", name: "کانادا" },
  { code: "SE", name: "سوئد" }, { code: "NL", name: "هلند" }, { code: "IT", name: "ایتالیا" },
  { code: "ES", name: "اسپانیا" }, { code: "RU", name: "روسیه" }, { code: "IN", name: "هند" },
  { code: "PK", name: "پاکستان" }, { code: "EG", name: "مصر" }, { code: "JP", name: "ژاپن" },
  { code: "KR", name: "کره جنوبی" }, { code: "CN", name: "چین" }, { code: "AU", name: "استرالیا" },
  { code: "BR", name: "برزیل" }, { code: "MX", name: "مکزیک" }, { code: "GR", name: "یونان" },
  { code: "AT", name: "اتریش" }, { code: "CH", name: "سوئیس" }, { code: "BE", name: "بلژیک" },
  { code: "NO", name: "نروژ" }, { code: "DK", name: "دانمارک" }, { code: "FI", name: "فنلاند" },
  { code: "PL", name: "لهستان" }, { code: "AZ", name: "آذربایجان" }, { code: "AM", name: "ارمنستان" },
  { code: "QA", name: "قطر" }, { code: "KW", name: "کویت" }, { code: "OM", name: "عمان" },
  { code: "INTL", name: "بین‌المللی 🌐" },
];
// تبدیل کد کشور دو حرفی ISO به ایموجی پرچم (روش استاندارد: حروف Regional Indicator)
function countryFlagEmoji(code) {
  if (!code || code === "INTL") return "🌐";
  const cc = String(code).toUpperCase();
  if (cc.length !== 2) return "🌐";
  const base = 127397; // 0x1F1E6 - 'A'.charCodeAt(0)
  const chars = [...cc].map(c => c.charCodeAt(0) + base);
  try { return String.fromCodePoint(...chars); } catch { return "🌐"; }
}
function countryName(code) { const c = COUNTRIES.find(x => x.code === code); return c ? c.name : ""; }

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS, POST, PUT, DELETE",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request, env) {
    try {
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

      const url = new URL(request.url);
      const pathParts = url.pathname.split("/").filter(Boolean);

      // ── محدودیت IP: بلاک کردن IP های مخرب (لیست در پنل ادمین قابل مدیریت است) ──
      if (env.RADIO_KV) {
        try {
          const ip = getClientIP(request);
          if (ip && ip !== "unknown") {
            const blocked = await env.RADIO_KV.get("blocked_ip:" + ip);
            if (blocked) return new Response("Access denied", { status: 403, headers: CORS_HEADERS });
          }
        } catch {}
      }

      // ── صفحه اصلی ──
      if (pathParts.length === 0) {
        const allStations = await getStations(env);
        const genres = await getGenres(env);
        const session = await getSessionUser(env, request);
        const owner = session && isOwner(env, session.user);
        const tier = session ? (session.user.tier || "none") : null;

        const visible = [];
        for (const st of allStations) {
          const access = st.access || "public";
          let allowed;
          if (access === "public") allowed = true;
          else if (owner) allowed = true;
          else if (access === "sub") allowed = tier === "sub" || tier === "vip";
          else if (access === "vip") allowed = tier === "vip";
          else allowed = false;
          if (!allowed) continue;
          const engagement = await getEngagementSummary(env, st.id);
          if ((st.type || "direct") === "playlist") {
            const tracks = await getStationTracks(env, st.id);
            visible.push({ ...st, tracks: tracks.map(t => ({ id: t.id, name: t.name })), engagement });
          } else {
            visible.push({ ...st, engagement });
          }
        }

        return new Response(getFrontendHTML(url.origin, visible, genres), { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      if (pathParts[0] === "admin") return handleAdmin(request, env, url, pathParts);

      // ── PWA: مانیفست و سرویس‌ورکر ──
      if (pathParts[0] === "manifest.json") return handleManifest(url);
      if (pathParts[0] === "sw.js") return handleServiceWorker();
      if (pathParts[0] === "icon.svg" || pathParts[0] === "favicon.ico") return handleIcon();

      if (pathParts[0] === "api") {
        if (pathParts[1] === "auth") return handleAuth(request, env, pathParts);
        if (pathParts[1] === "favorites") return handleFavorites(request, env);
        if (pathParts[1] === "verify") return handleVerify(request, env);
        if (pathParts[1] === "payment-info") return handlePaymentInfo(env);
        if (pathParts[1] === "stats" && pathParts[2] === "listen") return handleRecordListen(request, env);
        if (pathParts[1] === "nowplaying" && pathParts[2]) return handleNowPlaying(request, env, pathParts[2]);
        if (pathParts[1] === "tracks" && pathParts[2]) return handleServeTrack(request, env, pathParts[2]);
        if (pathParts[1] === "identify") return handleIdentifySong(request, env);
        if (pathParts[1] === "reactions" && pathParts[2]) return handleReactions(request, env, pathParts[2]);
        if (pathParts[1] === "ratings" && pathParts[2]) return handleRatings(request, env, pathParts[2]);
        if (pathParts[1] === "comments" && pathParts[2]) return handleComments(request, env, pathParts[2]);
        if (pathParts[1] === "popular") return handlePopular(request, env);
        if (pathParts[1] === "config") return jsonResponse({ turnstileSiteKey: env.TURNSTILE_SITE_KEY || null });
      }

      // ── پروکسی استریم صوتی (direct یا HLS) ──
      const settings = await getSettings(env);
      const stationId = pathParts[0];
      const restPath = pathParts.slice(1).join("/");
      const queryString = url.search || "";
      const stations = await getStations(env);
      const station = stations.find(s => s.id === stationId);
      if (!station) return new Response("Station not found", { status: 404 });

      if ((station.type || "direct") === "playlist") {
        return jsonResponse({ error: "این ایستگاه از نوع پلی‌لیست است؛ از طریق صفحه اصلی و /api/tracks/ پخش می‌شود" }, 400);
      }

      const session = await getSessionUser(env, request);
      const accessError = checkStationAccess(station, session, env);
      if (accessError) return jsonResponse({ error: accessError.message, needLogin: accessError.needLogin, needSub: accessError.needSub, needVip: accessError.needVip }, 403);

      const isHls = (station.type || "direct") === "hls";

      // ── مسیر پروکسی سگمنت‌های خارجی (برای HLS که به دامنه‌های دیگر اشاره می‌کنند) ──
      if (isHls && restPath.startsWith("__proxy__/")) {
        return handleProxyPath(request, restPath, queryString, settings, url.origin, stationId);
      }

      // ── ایستگاه مستقیم (mp3/aac/ogg) ──
      if (!isHls) {
        const upstreamResponse = await fetch(station.url, {
          headers: { "User-Agent": request.headers.get("User-Agent") || "Mozilla/5.0", "Icy-MetaData": "0" },
          cf: { cacheTtl: settings.streamCacheTTL, cacheEverything: false },
        });
        if (!upstreamResponse.ok) { await logError(env, "stream_proxy", `Upstream ${upstreamResponse.status} برای ${station.name}`, { stationId: station.id }); return new Response("Upstream Error: " + upstreamResponse.status, { status: upstreamResponse.status, headers: CORS_HEADERS }); }
        const directContentType = upstreamResponse.headers.get("content-type") || "audio/mpeg";
        return new Response(upstreamResponse.body, { status: 200, headers: { "Content-Type": directContentType, "Cache-Control": "no-store", ...CORS_HEADERS } });
      }

      // ── ایستگاه HLS ──
      const base = station.url.replace(/\/$/, "");
      let targetUrl;
      if (restPath === "master.m3u8" || restPath === "") {
        let combinedQuery = queryString;
        const suffix = station.playlistSuffix || "/index.m3u8";
        if (suffix.includes("?") && queryString) combinedQuery = "&" + queryString.replace("?", "");
        targetUrl = base + suffix + combinedQuery;
      } else {
        targetUrl = base + "/" + restPath + queryString;
      }

      const upstreamUrl = new URL(targetUrl);
      const isPlaylist = upstreamUrl.pathname.endsWith(".m3u8");
      const cache = caches.default;

      if (!isPlaylist) {
        const cached = await cache.match(request);
        if (cached) return cached;
      }

      const upstreamHeaders = {
        "User-Agent": request.headers.get("User-Agent") || "Mozilla/5.0",
        "Referer": upstreamUrl.origin + "/",
        ...(request.headers.get("Accept-Encoding") && { "Accept-Encoding": request.headers.get("Accept-Encoding") }),
      };

      const upstreamResponse = await fetch(upstreamUrl.toString(), {
        headers: upstreamHeaders,
        cf: { cacheTtl: isPlaylist ? settings.playlistCacheTTL : settings.streamCacheTTL, cacheEverything: true },
      });

      if (!upstreamResponse.ok) { await logError(env, "stream_proxy", `Upstream HLS ${upstreamResponse.status} برای ${station.name}`, { stationId: station.id }); return new Response("Upstream Error: " + upstreamResponse.status, { status: upstreamResponse.status, headers: CORS_HEADERS }); }

      const contentType = upstreamResponse.headers.get("content-type") || "";

      if (contentType.includes("mpegurl") || contentType.includes("mpegURL") || isPlaylist) {
        const finalUrl = upstreamResponse.url;
        const finalBase = finalUrl.substring(0, finalUrl.lastIndexOf("/") + 1);
        const proxyBase = `${url.origin}/${stationId}`;

        let playlistText = await upstreamResponse.text();
        playlistText = rewritePlaylistText(playlistText, finalBase, proxyBase, base);
        return new Response(playlistText, {
          headers: { "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": `public, max-age=${settings.playlistCacheTTL}`, ...CORS_HEADERS },
        });
      }

      const segResponse = new Response(upstreamResponse.body, {
        status: 200,
        headers: { "Content-Type": contentType || "audio/aac", "Cache-Control": `public, max-age=${settings.streamCacheTTL}`, ...CORS_HEADERS },
      });
      cache.put(request, segResponse.clone()).catch(() => {});
      return segResponse;

    } catch (err) {
      try { await logError(env, "worker_exception", err.message, { url: request.url }); } catch {}
      return new Response("Proxy Error: " + err.message, { status: 500, headers: CORS_HEADERS });
    }
  },

  // ── Cron Trigger: بررسی خودکار دوره‌ای سلامت ایستگاه‌ها (طبق زمان‌بندی wrangler.toml) ──
  async scheduled(event, env, ctx) {
    try {
      ctx.waitUntil(runHealthCheckAll(env));
    } catch (e) {
      try { await logError(env, "cron", e.message, null); } catch {}
    }
  },
};

function handleIcon() {
  const svg = `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffb066"/><stop offset="1" stop-color="#ff8a1e"/></linearGradient></defs>
<rect width="200" height="200" rx="44" fill="url(#bg)"/>
<rect x="96" y="72" width="8" height="86" rx="4" fill="#0b0d10"/>
<circle cx="100" cy="62" r="11" fill="#0b0d10"/>
<path d="M72 158 L128 158 L119 174 L81 174 Z" fill="#0b0d10"/>
<path d="M76 62 A46 46 0 0 0 76 102" stroke="#0b0d10" stroke-width="9" fill="none" stroke-linecap="round"/>
<path d="M54 44 A72 72 0 0 0 54 120" stroke="#0b0d10" stroke-width="9" fill="none" stroke-linecap="round" opacity="0.65"/>
<path d="M124 62 A46 46 0 0 1 124 102" stroke="#0b0d10" stroke-width="9" fill="none" stroke-linecap="round"/>
<path d="M146 44 A72 72 0 0 1 146 120" stroke="#0b0d10" stroke-width="9" fill="none" stroke-linecap="round" opacity="0.65"/>
</svg>`;
  return new Response(svg, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400", ...CORS_HEADERS } });
}

// ─────────────────────────────────────────────────────────────
// PWA — مانیفست و سرویس‌ورکر (برای نصب و پخش پس‌زمینه با MediaSession)
// ─────────────────────────────────────────────────────────────
function handleManifest(url) {
  const manifest = {
    name: "RadioFa — رادیو آنلاین",
    short_name: "RadioFa",
    start_url: "/",
    display: "standalone",
    background_color: "#0b0d10",
    theme_color: "#ff9f43",
    dir: "rtl",
    lang: "fa",
    icons: [
      { src: "/icon.svg", sizes: "192x192", type: "image/svg+xml" },
      { src: "/icon.svg", sizes: "512x512", type: "image/svg+xml" },
    ],
  };
  return new Response(JSON.stringify(manifest), { headers: { "Content-Type": "application/manifest+json", ...CORS_HEADERS } });
}
function handleServiceWorker() {
  const sw = `
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => self.clients.claim());
// بدون fetch handler: نیازی به کش کردن استریم نیست و نبود آن باعث حذف هشدار «no-op fetch handler» می‌شود.
`;
  return new Response(sw, { headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-cache", ...CORS_HEADERS } });
}


// بازنویسی مسیرهای داخل یک پلی‌لیست HLS (m3u8) تا از طریق پروکسی خودمان عبور کنند
function rewritePlaylistText(playlistText, finalBase, proxyBase, base) {
  playlistText = playlistText.replace(/^([^#\r\n][^\r\n]*)/gm, (line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    let absoluteUrl;
    try { absoluteUrl = new URL(trimmed, finalBase).toString(); } catch { return line; }
    if (base && absoluteUrl.startsWith(base)) {
      const relative = absoluteUrl.slice(base.length).replace(/^\//, "");
      return `${proxyBase}/${relative}`;
    }
    return `${proxyBase}/__proxy__/${encodeURIComponent(absoluteUrl)}`;
  });
  playlistText = playlistText.replace(/(#EXT-X-KEY:[^"]*URI=")([^"]+)(")/g, (_, before, uri, after) => {
    let absoluteUri;
    try { absoluteUri = new URL(uri, finalBase).toString(); } catch { return _; }
    const proxied = (base && absoluteUri.startsWith(base))
      ? `${proxyBase}/${absoluteUri.slice(base.length).replace(/^\//, "")}`
      : `${proxyBase}/__proxy__/${encodeURIComponent(absoluteUri)}`;
    return `${before}${proxied}${after}`;
  });
  return playlistText;
}

async function handleProxyPath(request, restPath, queryString, settings, origin, stationId) {
  const encodedUrl = restPath.replace("__proxy__/", "");
  let decodedUrl;
  try { decodedUrl = decodeURIComponent(encodedUrl); new URL(decodedUrl); } catch { return new Response("Invalid proxy URL", { status: 400, headers: CORS_HEADERS }); }

  const targetFull = decodedUrl + queryString;
  let isPlaylist = false;
  try { isPlaylist = new URL(decodedUrl).pathname.toLowerCase().endsWith(".m3u8"); } catch {}

  const cache = caches.default;
  const cacheKey = new Request(targetFull);
  if (!isPlaylist) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
  }

  const upstreamResponse = await fetch(targetFull, {
    headers: { "User-Agent": request.headers.get("User-Agent") || "Mozilla/5.0", "Referer": new URL(decodedUrl).origin + "/" },
    cf: { cacheTtl: isPlaylist ? settings.playlistCacheTTL : settings.streamCacheTTL, cacheEverything: true },
  });
  if (!upstreamResponse.ok) return new Response("Upstream Error: " + upstreamResponse.status, { status: upstreamResponse.status, headers: CORS_HEADERS });

  const contentType = upstreamResponse.headers.get("content-type") || "";

  // ── اگر خود این آدرس هم یک پلی‌لیست دیگر بود (مثل chunklist روی CDN دیگر)، آن را هم بازنویسی کن ──
  if (isPlaylist || contentType.includes("mpegurl") || contentType.includes("mpegURL")) {
    const finalUrl = upstreamResponse.url || targetFull;
    const finalBase = finalUrl.substring(0, finalUrl.lastIndexOf("/") + 1);
    const proxyBase = `${origin}/${stationId}`;
    let playlistText = await upstreamResponse.text();
    playlistText = rewritePlaylistText(playlistText, finalBase, proxyBase, null);
    return new Response(playlistText, {
      headers: { "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": `public, max-age=${settings.playlistCacheTTL}`, ...CORS_HEADERS },
    });
  }

  const response = new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers: { "Content-Type": contentType || "application/octet-stream", "Cache-Control": `public, max-age=${settings.streamCacheTTL}`, ...CORS_HEADERS },
  });
  cache.put(cacheKey, response.clone()).catch(() => {});
  return response;
}

// ═══════════════════════════════════════════════════════════════
// آمار شنیدن ایستگاه‌ها
// ═══════════════════════════════════════════════════════════════
async function handleRecordListen(request, env) {
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  try {
    const body = await request.json();
    const stationId = String(body.stationId || "").trim();
    if (!stationId) return jsonResponse({ error: "stationId الزامی است" }, 400);

    const todayKey = getTodayKey();
    const raw = await env.RADIO_KV.get("stats:listens:" + stationId);
    let data = raw ? JSON.parse(raw) : { total: 0, today: 0, yesterday: 0, dailyKey: todayKey };

    if (data.dailyKey !== todayKey) {
      data.yesterday = data.dailyKey === getYesterdayKey() ? data.today : 0;
      data.today = 0;
      data.dailyKey = todayKey;
    }
    data.total += 1;
    data.today += 1;

    await env.RADIO_KV.put("stats:listens:" + stationId, JSON.stringify(data), { expirationTtl: 60 * 60 * 24 * 90 });
    return jsonResponse({ ok: true });
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}
function getTodayKey() { return new Date().toISOString().slice(0, 10); }
function getYesterdayKey() { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); }

// ═══════════════════════════════════════════════════════════════
// تشخیص آهنگ در حال پخش (ICY Metadata) + کاور/خواننده
// ═══════════════════════════════════════════════════════════════
function concatBytes(a, b) {
  const c = new Uint8Array(a.length + b.length);
  c.set(a, 0); c.set(b, a.length);
  return c;
}

// از استریم آیسی/شاوت‌کست، تیتر لحظه‌ای پخش (StreamTitle) رو استخراج می‌کنه
async function fetchIcyStreamTitle(streamUrl) {
  let reader = null;
  try {
    const resp = await fetch(streamUrl, {
      headers: { "Icy-MetaData": "1", "User-Agent": "Mozilla/5.0" },
      cf: { cacheTtl: 0, cacheEverything: false },
    });
    const metaInt = parseInt(resp.headers.get("icy-metaint") || "0", 10);
    if (!metaInt || !resp.body) { try { await resp.body?.cancel(); } catch {} return null; }

    reader = resp.body.getReader();
    let buffer = new Uint8Array(0);
    const SAFETY_MAX = metaInt + 1 + 255 * 16 + 64;

    // خوندن تا رسیدن به بایت طول متادیتا
    while (buffer.length < metaInt + 1) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer = concatBytes(buffer, value);
      if (buffer.length > SAFETY_MAX) break;
    }
    if (buffer.length <= metaInt) { try { await reader.cancel(); } catch {} return null; }

    const metaLen = buffer[metaInt] * 16;
    if (metaLen === 0) { try { await reader.cancel(); } catch {} return null; }

    while (buffer.length < metaInt + 1 + metaLen) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer = concatBytes(buffer, value);
      if (buffer.length > SAFETY_MAX) break;
    }
    try { await reader.cancel(); } catch {}
    if (buffer.length < metaInt + 1 + metaLen) return null;

    const metaBytes = buffer.slice(metaInt + 1, metaInt + 1 + metaLen);
    const metaStr = new TextDecoder("utf-8").decode(metaBytes);
    const match = metaStr.match(/StreamTitle=['"]([^'"]*)['"]/);
    if (!match) return null;
    const title = match[1].trim();
    return title || null;
  } catch {
    try { await reader?.cancel(); } catch {}
    return null;
  }
}

// جستجوی کاور و نام خواننده از iTunes Search API (رایگان، بدون نیاز به کلید)
async function fetchTrackArtwork(query) {
  try {
    const res = await fetch("https://itunes.apple.com/search?term=" + encodeURIComponent(query) + "&limit=1&media=music", {
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const item = data && data.results && data.results[0];
    if (!item) return null;
    return {
      artist: item.artistName || null,
      track: item.trackName || null,
      cover: item.artworkUrl100 ? item.artworkUrl100.replace("100x100bb", "512x512bb") : null,
    };
  } catch { return null; }
}

async function handleNowPlaying(request, env, stationId) {
  try {
    const stations = await getStations(env);
    const station = stations.find(s => s.id === stationId);
    if (!station) return jsonResponse({ error: "Station not found" }, 404);

    // فقط ایستگاه‌های مستقیم (icecast/shoutcast) متادیتای ICY دارند
    if ((station.type || "direct") !== "direct") {
      return jsonResponse({ supported: false, title: null, artist: null, cover: null, nowPlaying: station.nowPlaying || null });
    }

    const cacheKey = "nowplaying:" + stationId;
    const cached = await env.RADIO_KV?.get(cacheKey);
    if (cached) { try { return jsonResponse(JSON.parse(cached)); } catch {} }

    const rawTitle = await fetchIcyStreamTitle(station.url);
    let result = { supported: true, title: null, artist: null, track: null, cover: null, raw: rawTitle || null };

    if (rawTitle) {
      let artist = null, track = rawTitle;
      const sepMatch = rawTitle.split(/\s-\s/);
      if (sepMatch.length >= 2) { artist = sepMatch[0].trim(); track = sepMatch.slice(1).join(" - ").trim(); }
      const art = await fetchTrackArtwork(rawTitle);
      result.artist = (art && art.artist) || artist;
      result.track = (art && art.track) || track;
      result.title = rawTitle;
      result.cover = art ? art.cover : null;
    }

    if (env.RADIO_KV) await env.RADIO_KV.put(cacheKey, JSON.stringify(result), { expirationTtl: 25 });
    return jsonResponse(result);
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}

// ═══════════════════════════════════════════════════════════════
// شناسایی آهنگ (AudD — مثل Shazam)
// حالت ۱: کلاینت خودش چند ثانیه صدا ضبط می‌کند و فایل را می‌فرستد (multipart/form-data)
// حالت ۲: fallback سمت سرور — اگر ضبط در مرورگر ممکن نبود، خود Worker یک تکه از استریم ایستگاه را می‌گیرد
// ═══════════════════════════════════════════════════════════════
const IDENTIFY_MAX_UPLOAD = 12 * 1024 * 1024; // 12MB سقف فایل ارسالی از کلاینت
const IDENTIFY_SERVER_CLIP_BYTES = 900 * 1024; // ~900KB تکه‌ی صوتی که سرور از استریم برمی‌دارد (fallback)

async function callAudd(env, blob, filename, contentType) {
  const token = env.AUDD_API_TOKEN;
  if (!token) return { error: "سرویس شناسایی آهنگ روی این سرور فعال نیست (AUDD_API_TOKEN تنظیم نشده)" };
  const form = new FormData();
  form.append("api_token", token);
  form.append("file", blob, filename || "clip.mp3");
  form.append("return", "spotify,apple_music");
  let res;
  try {
    res = await fetch("https://api.audd.io/", { method: "POST", body: form });
  } catch (e) {
    return { error: "خطا در ارتباط با سرویس شناسایی آهنگ" };
  }
  if (!res.ok) return { error: "سرویس شناسایی آهنگ پاسخ نداد (" + res.status + ")" };
  let data;
  try { data = await res.json(); } catch { return { error: "پاسخ نامعتبر از سرویس شناسایی" }; }
  if (data.status !== "success") return { error: "خطا در سرویس شناسایی آهنگ" };
  if (!data.result) return { notFound: true };
  const r = data.result;
  const spotifyImg = r.spotify && r.spotify.album && r.spotify.album.images && r.spotify.album.images[0] && r.spotify.album.images[0].url;
  const appleImg = r.apple_music && r.apple_music.artwork && r.apple_music.artwork.url
    ? r.apple_music.artwork.url.replace("{w}", "500").replace("{h}", "500")
    : null;
  return {
    ok: true,
    title: r.title || null,
    artist: r.artist || null,
    album: r.album || null,
    releaseDate: r.release_date || null,
    cover: appleImg || spotifyImg || null,
    spotifyUrl: (r.spotify && r.spotify.external_urls && r.spotify.external_urls.spotify) || null,
    appleUrl: (r.apple_music && r.apple_music.url) || null,
  };
}

async function handleIdentifySong(request, env) {
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  try {
    // چون AudD رایگان محدودیت درخواست داره و این endpoint هزینه‌بر (پهنای باند/CPU) است،
    // هم بر اساس IP و هم بر اساس کاربر لاگین‌شده محدودش می‌کنیم
    const clientIP = getClientIP(request);
    const session = await getSessionUser(env, request);
    const rlKey = session ? "user:" + session.user.username.toLowerCase() : "ip:" + clientIP;
    const rl = await checkRateLimit(env, "identify", rlKey, 15, 3600); // ۱۵ درخواست شناسایی در ساعت
    if (!rl.allowed) return rateLimitResponse(rl);

    const contentType = request.headers.get("content-type") || "";

    // ── حالت ۱: کلاینت فایل صوتی ضبط‌شده فرستاده (multipart/form-data) ──
    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      if (!file || typeof file === "string") return jsonResponse({ error: "فایل صوتی ارسال نشد" }, 400);
      if (file.size > IDENTIFY_MAX_UPLOAD) return jsonResponse({ error: "حجم فایل بیش از حد مجاز است" }, 400);
      const result = await callAudd(env, file, file.name || "clip.webm", file.type || "audio/webm");
      if (result.error) return jsonResponse({ error: result.error }, 502);
      if (result.notFound) return jsonResponse({ notFound: true });
      return jsonResponse(result);
    }

    // ── حالت ۲: fallback سمت سرور — گرفتن یک تکه از استریم خود ایستگاه ──
    const body = await request.json().catch(() => ({}));
    const stationId = String(body.stationId || "").trim();
    if (!stationId) return jsonResponse({ error: "stationId الزامی است" }, 400);
    const stations = await getStations(env);
    const station = stations.find(s => s.id === stationId);
    if (!station) return jsonResponse({ error: "ایستگاه یافت نشد" }, 404);
    if ((station.type || "direct") === "playlist") return jsonResponse({ error: "شناسایی آهنگ برای این نوع ایستگاه لازم نیست" }, 400);

    // آدرس مقصد نمونه صوتی: برای ایستگاه‌های direct همان url مستقیم است.
    // برای HLS، خود url فقط یک پلی‌لیست متنی (m3u8) است، نه صدا؛ پس باید اول پلی‌لیست را گرفت
    // و آخرین سگمنت صوتی واقعی (ts/aac/m4s) را از داخل آن استخراج و دانلود کرد.
    let streamTarget = station.url;
    if ((station.type || "direct") === "hls") {
      try {
        const base = station.url.replace(/\/$/, "");
        const suffix = station.playlistSuffix || "/index.m3u8";
        const playlistResp = await fetch(base + suffix, {
          headers: { "User-Agent": "Mozilla/5.0", "Referer": new URL(base).origin + "/" },
          cf: { cacheTtl: 0, cacheEverything: false },
        });
        if (!playlistResp.ok) return jsonResponse({ error: "دریافت پلی‌لیست HLS ممکن نشد" }, 502);
        const finalUrl = playlistResp.url || (base + suffix);
        const finalBase = finalUrl.substring(0, finalUrl.lastIndexOf("/") + 1);
        let playlistText = await playlistResp.text();

        // اگر این یک master playlist بود (اشاره به یک variant دیگر)، وارد آن شو
        const variantLine = playlistText.split(/\r?\n/).find(l => l.trim() && !l.startsWith("#") && /\.m3u8(\?|$)/i.test(l.trim()));
        if (variantLine && !playlistText.includes("#EXTINF")) {
          const variantUrl = new URL(variantLine.trim(), finalBase).toString();
          const variantResp = await fetch(variantUrl, { headers: { "User-Agent": "Mozilla/5.0" }, cf: { cacheTtl: 0, cacheEverything: false } });
          if (variantResp.ok) {
            playlistText = await variantResp.text();
            const vFinalUrl = variantResp.url || variantUrl;
            var finalBase2 = vFinalUrl.substring(0, vFinalUrl.lastIndexOf("/") + 1);
          }
        }
        const usedBase = typeof finalBase2 !== "undefined" ? finalBase2 : finalBase;

        const segLines = playlistText.split(/\r?\n/).filter(l => l.trim() && !l.startsWith("#"));
        if (!segLines.length) return jsonResponse({ error: "سگمنت صوتی در پلی‌لیست یافت نشد" }, 502);
        // آخرین سگمنت = نزدیک‌ترین به «همین الان»
        const lastSeg = segLines[segLines.length - 1].trim();
        streamTarget = new URL(lastSeg, usedBase).toString();
      } catch (e) {
        return jsonResponse({ error: "پردازش پلی‌لیست HLS با خطا مواجه شد" }, 502);
      }
    }

    let upstreamResponse;
    try {
      upstreamResponse = await fetch(streamTarget, {
        headers: { "User-Agent": "Mozilla/5.0", "Icy-MetaData": "0" },
        cf: { cacheTtl: 0, cacheEverything: false },
      });
    } catch (e) {
      return jsonResponse({ error: "اتصال به استریم ایستگاه ممکن نشد" }, 502);
    }
    if (!upstreamResponse.ok || !upstreamResponse.body) return jsonResponse({ error: "استریم ایستگاه در دسترس نیست" }, 502);

    // خواندن یک تکه محدود از بدنه‌ی استریم (چند صد کیلوبایت) تا برای AudD کافی باشد
    const reader = upstreamResponse.body.getReader();
    let chunks = [], total = 0;
    try {
      while (total < IDENTIFY_SERVER_CLIP_BYTES) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value); total += value.length;
      }
      await reader.cancel();
    } catch { try { await reader.cancel(); } catch {} }
    if (!total) return jsonResponse({ error: "دریافت نمونه صوتی ممکن نشد" }, 502);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) { merged.set(c, offset); offset += c.length; }
    const upstreamCT = upstreamResponse.headers.get("content-type") || "audio/mpeg";
    const blob = new Blob([merged], { type: upstreamCT });

    const result = await callAudd(env, blob, "clip.mp3", upstreamCT);
    if (result.error) return jsonResponse({ error: result.error }, 502);
    if (result.notFound) return jsonResponse({ notFound: true });
    return jsonResponse(result);
  } catch (e) {
    return jsonResponse({ error: "خطا: " + e.message }, 500);
  }
}

async function getStationStats(env, ids) {
  const stats = {};
  await Promise.all(ids.map(async (id) => {
    try {
      const raw = await env.RADIO_KV.get("stats:listens:" + id);
      if (raw) {
        const data = JSON.parse(raw);
        const todayKey = getTodayKey();
        stats[id] = {
          total: data.total || 0,
          today: data.dailyKey === todayKey ? (data.today || 0) : 0,
          yesterday: data.dailyKey === getYesterdayKey() ? (data.today || 0) : (data.yesterday || 0),
        };
      } else stats[id] = { total: 0, today: 0, yesterday: 0 };
    } catch { stats[id] = { total: 0, today: 0, yesterday: 0 }; }
  }));
  return stats;
}

// ═══════════════════════════════════════════════════════════════
// تعامل کاربران: لایک/دیسلایک، امتیازدهی، نظرات، محبوب‌ترین‌ها
// ═══════════════════════════════════════════════════════════════
const MAX_COMMENTS_PER_STATION = 200;
const MAX_COMMENT_LEN = 500;

function reactorKey(stationId) { return "reactions:" + stationId; }
function userReactionKey(username, stationId) { return "user_reaction:" + username.toLowerCase() + ":" + stationId; }
function ratingKey(stationId) { return "ratings:" + stationId; }
function userRatingKey(username, stationId) { return "user_rating:" + username.toLowerCase() + ":" + stationId; }
function commentsKey(stationId) { return "comments:" + stationId; }

async function getReactionSummary(env, stationId) {
  try { const raw = await env.RADIO_KV.get(reactorKey(stationId)); return raw ? JSON.parse(raw) : { likes: 0, dislikes: 0 }; }
  catch { return { likes: 0, dislikes: 0 }; }
}
async function getRatingSummary(env, stationId) {
  try {
    const raw = await env.RADIO_KV.get(ratingKey(stationId));
    const data = raw ? JSON.parse(raw) : { sum: 0, count: 0 };
    return { avg: data.count ? Math.round((data.sum / data.count) * 10) / 10 : 0, count: data.count || 0 };
  } catch { return { avg: 0, count: 0 }; }
}
async function getCommentCount(env, stationId) {
  try { const raw = await env.RADIO_KV.get(commentsKey(stationId)); const list = raw ? JSON.parse(raw) : []; return list.length; }
  catch { return 0; }
}
async function getEngagementSummary(env, stationId) {
  const [reactions, rating, commentCount] = await Promise.all([getReactionSummary(env, stationId), getRatingSummary(env, stationId), getCommentCount(env, stationId)]);
  return { likes: reactions.likes || 0, dislikes: reactions.dislikes || 0, ratingAvg: rating.avg, ratingCount: rating.count, commentCount };
}

// ── لایک/دیسلایک ──
async function handleReactions(request, env, stationId) {
  const stations = await getStations(env);
  const station = stations.find(s => s.id === stationId);
  if (!station) return jsonResponse({ error: "ایستگاه یافت نشد" }, 404);

  if (request.method === "GET") {
    const session = await getSessionUser(env, request);
    const summary = await getReactionSummary(env, stationId);
    let userChoice = null;
    if (session) { try { userChoice = await env.RADIO_KV.get(userReactionKey(session.user.username, stationId)); } catch {} }
    return jsonResponse({ likes: summary.likes || 0, dislikes: summary.dislikes || 0, userChoice: userChoice || null });
  }

  if (request.method === "POST") {
    const session = await getSessionUser(env, request);
    if (!session) return jsonResponse({ error: "ابتدا وارد شوید" }, 401);
    const rl = await checkRateLimit(env, "reaction", session.user.username.toLowerCase(), 60, 600);
    if (!rl.allowed) return rateLimitResponse(rl);
    const body = await request.json().catch(() => ({}));
    const choice = String(body.choice || "").trim();
    if (!["like", "dislike", "none"].includes(choice)) return jsonResponse({ error: "مقدار نامعتبر" }, 400);

    const uKey = userReactionKey(session.user.username, stationId);
    const prev = await env.RADIO_KV.get(uKey);
    const summary = await getReactionSummary(env, stationId);

    if (prev === "like") summary.likes = Math.max(0, (summary.likes || 0) - 1);
    if (prev === "dislike") summary.dislikes = Math.max(0, (summary.dislikes || 0) - 1);
    if (choice === "like") summary.likes = (summary.likes || 0) + 1;
    if (choice === "dislike") summary.dislikes = (summary.dislikes || 0) + 1;

    await env.RADIO_KV.put(reactorKey(stationId), JSON.stringify(summary));
    if (choice === "none") await env.RADIO_KV.delete(uKey);
    else await env.RADIO_KV.put(uKey, choice, { expirationTtl: 60 * 60 * 24 * 365 });

    return jsonResponse({ ok: true, likes: summary.likes, dislikes: summary.dislikes, userChoice: choice === "none" ? null : choice });
  }
  return jsonResponse({ error: "Method not allowed" }, 405);
}

// ── امتیازدهی ۱ تا ۵ ستاره ──
async function handleRatings(request, env, stationId) {
  const stations = await getStations(env);
  const station = stations.find(s => s.id === stationId);
  if (!station) return jsonResponse({ error: "ایستگاه یافت نشد" }, 404);

  if (request.method === "GET") {
    const session = await getSessionUser(env, request);
    const summary = await getRatingSummary(env, stationId);
    let userRating = null;
    if (session) { try { const r = await env.RADIO_KV.get(userRatingKey(session.user.username, stationId)); userRating = r ? parseInt(r, 10) : null; } catch {} }
    return jsonResponse({ avg: summary.avg, count: summary.count, userRating });
  }

  if (request.method === "POST") {
    const session = await getSessionUser(env, request);
    if (!session) return jsonResponse({ error: "ابتدا وارد شوید" }, 401);
    const rl = await checkRateLimit(env, "rating", session.user.username.toLowerCase(), 30, 600);
    if (!rl.allowed) return rateLimitResponse(rl);
    const body = await request.json().catch(() => ({}));
    const stars = parseInt(body.stars, 10);
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) return jsonResponse({ error: "امتیاز باید بین ۱ تا ۵ باشد" }, 400);

    const uKey = userRatingKey(session.user.username, stationId);
    const prevRaw = await env.RADIO_KV.get(uKey);
    const prevStars = prevRaw ? parseInt(prevRaw, 10) : null;

    const raw = await env.RADIO_KV.get(ratingKey(stationId));
    let data = raw ? JSON.parse(raw) : { sum: 0, count: 0 };
    if (prevStars) { data.sum -= prevStars; data.count = Math.max(0, data.count - 1); }
    data.sum += stars; data.count += 1;

    await env.RADIO_KV.put(ratingKey(stationId), JSON.stringify(data));
    await env.RADIO_KV.put(uKey, String(stars), { expirationTtl: 60 * 60 * 24 * 365 });

    const avg = data.count ? Math.round((data.sum / data.count) * 10) / 10 : 0;
    return jsonResponse({ ok: true, avg, count: data.count, userRating: stars });
  }
  return jsonResponse({ error: "Method not allowed" }, 405);
}

// ── نظرات کاربران ──
async function handleComments(request, env, stationId) {
  const stations = await getStations(env);
  const station = stations.find(s => s.id === stationId);
  if (!station) return jsonResponse({ error: "ایستگاه یافت نشد" }, 404);

  if (request.method === "GET") {
    try {
      const raw = await env.RADIO_KV.get(commentsKey(stationId));
      const list = raw ? JSON.parse(raw) : [];
      return jsonResponse(list.slice(-100).reverse());
    } catch { return jsonResponse([]); }
  }

  if (request.method === "POST") {
    const session = await getSessionUser(env, request);
    if (!session) return jsonResponse({ error: "ابتدا وارد شوید" }, 401);
    const rl = await checkRateLimit(env, "comment", session.user.username.toLowerCase(), 10, 600);
    if (!rl.allowed) return rateLimitResponse(rl);
    const body = await request.json().catch(() => ({}));
    const text = String(body.text || "").trim();
    if (!text) return jsonResponse({ error: "متن نظر خالی است" }, 400);
    if (text.length > MAX_COMMENT_LEN) return jsonResponse({ error: "نظر بیش از حد طولانی است" }, 400);

    const raw = await env.RADIO_KV.get(commentsKey(stationId));
    let list = raw ? JSON.parse(raw) : [];
    const comment = { id: randomToken().slice(0, 12), username: session.user.username, text, at: Date.now() };
    list.push(comment);
    if (list.length > MAX_COMMENTS_PER_STATION) list = list.slice(-MAX_COMMENTS_PER_STATION);
    await env.RADIO_KV.put(commentsKey(stationId), JSON.stringify(list));
    return jsonResponse({ ok: true, comment });
  }

  if (request.method === "DELETE") {
    const session = await getSessionUser(env, request);
    if (!session) return jsonResponse({ error: "ابتدا وارد شوید" }, 401);
    const url = new URL(request.url);
    const commentId = url.searchParams.get("id");
    if (!commentId) return jsonResponse({ error: "شناسه نظر الزامی است" }, 400);
    const raw = await env.RADIO_KV.get(commentsKey(stationId));
    let list = raw ? JSON.parse(raw) : [];
    const target = list.find(c => c.id === commentId);
    if (!target) return jsonResponse({ error: "نظر یافت نشد" }, 404);
    const owner = isOwner(env, session.user);
    if (target.username.toLowerCase() !== session.user.username.toLowerCase() && !owner) return jsonResponse({ error: "اجازه حذف این نظر را ندارید" }, 403);
    list = list.filter(c => c.id !== commentId);
    await env.RADIO_KV.put(commentsKey(stationId), JSON.stringify(list));
    return jsonResponse({ ok: true });
  }
  return jsonResponse({ error: "Method not allowed" }, 405);
}

// ── محبوب‌ترین ایستگاه‌ها (ترکیب شنونده‌ها + لایک + امتیاز) ──
async function handlePopular(request, env) {
  try {
    const stations = await getStations(env);
    const session = await getSessionUser(env, request);
    const owner = session && isOwner(env, session.user);
    const tier = session ? (session.user.tier || "none") : null;

    const publicStations = stations.filter(st => {
      const access = st.access || "public";
      if (access === "public" || owner) return true;
      if (access === "sub") return tier === "sub" || tier === "vip";
      if (access === "vip") return tier === "vip";
      return false;
    });

    const listenStats = await getStationStats(env, publicStations.map(s => s.id));
    const enriched = await Promise.all(publicStations.map(async st => {
      const eng = await getEngagementSummary(env, st.id);
      const score = (listenStats[st.id]?.total || 0) + (eng.likes || 0) * 3 - (eng.dislikes || 0) * 2 + (eng.ratingAvg || 0) * (eng.ratingCount || 0);
      return { id: st.id, name: st.name, icon: st.icon || "📻", access: st.access || "public", listens: listenStats[st.id] || { total: 0 }, ...eng, score };
    }));
    enriched.sort((a, b) => b.score - a.score);
    return jsonResponse(enriched.slice(0, 20));
  } catch (e) { return jsonResponse({ error: e.message }, 500); }
}

// ═══════════════════════════════════════════════════════════════
// پشتیبان‌گیری
// ═══════════════════════════════════════════════════════════════
async function handleBackupExport(env) {
  try {
    const [stations, genres, settings] = await Promise.all([getStations(env), getGenres(env), getSettings(env)]);
    const userList = await env.RADIO_KV.list({ prefix: "user:" });
    const users = [];
    for (const key of userList.keys) {
      try {
        const raw = await env.RADIO_KV.get(key.name);
        if (raw) {
          const u = JSON.parse(raw);
          users.push({ username: u.username, tier: u.tier || "none", favorites: u.favorites || [], createdAt: u.createdAt, vipAt: u.vipAt || null, subAt: u.subAt || null });
        }
      } catch {}
    }
    const backup = {
      version: "1.0", exportedAt: new Date().toISOString(), stations, genres,
      settings: { subPrice: settings.subPrice, paymentInstructions: settings.paymentInstructions },
      users,
    };
    const json = JSON.stringify(backup, null, 2);
    const filename = `radiofa-backup-${getTodayKey()}.json`;
    return new Response(json, { headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}"`, ...CORS_HEADERS } });
  } catch (e) {
    return jsonResponse({ error: "خطا در export: " + e.message }, 500);
  }
}

async function handleBackupImport(request, env) {
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  try {
    const body = await request.json();
    if (!body.version || !body.stations) return jsonResponse({ error: "فایل پشتیبان نامعتبر است" }, 400);
    const results = { stations: 0, genres: 0, settings: false, users: 0 };

    if (Array.isArray(body.stations) && body.stations.length > 0) {
      await env.RADIO_KV.put("stations", JSON.stringify(body.stations));
      results.stations = body.stations.length;
    }
    if (Array.isArray(body.genres) && body.genres.length > 0) {
      await env.RADIO_KV.put("genres", JSON.stringify(body.genres));
      results.genres = body.genres.length;
    }
    if (body.settings && typeof body.settings === "object") {
      const current = await getSettings(env);
      await env.RADIO_KV.put("settings", JSON.stringify({ ...current, ...body.settings }));
      results.settings = true;
    }
    if (Array.isArray(body.users)) {
      for (const bu of body.users) {
        try {
          const existing = await env.RADIO_KV.get("user:" + bu.username.toLowerCase());
          if (existing) {
            const user = JSON.parse(existing);
            user.tier = bu.tier || user.tier;
            user.favorites = bu.favorites || user.favorites;
            await env.RADIO_KV.put("user:" + bu.username.toLowerCase(), JSON.stringify(user));
            results.users++;
          }
        } catch {}
      }
    }
    return jsonResponse({ ok: true, results });
  } catch (e) {
    return jsonResponse({ error: "خطا در import: " + e.message }, 500);
  }
}

// ═══════════════════════════════════════════════════════════════
// تلگرام
// ═══════════════════════════════════════════════════════════════
async function sendTelegramNotification(env, message) {
  try {
    const token = env.TELEGRAM_BOT_TOKEN;
    const chatId = env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "HTML" }),
    });
  } catch {}
}

// ─────────────────────────────────────────────────────────────
// دسترسی
// ─────────────────────────────────────────────────────────────
// ── تأیید کپچا Cloudflare Turnstile (اختیاری — فقط اگر TURNSTILE_SECRET_KEY تنظیم شده باشد فعال می‌شود) ──
async function verifyTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET_KEY) return true; // اگر کپچا تنظیم نشده، عبور بده (backward-compatible)
  if (!token) return false;
  try {
    const form = new FormData();
    form.append("secret", env.TURNSTILE_SECRET_KEY);
    form.append("response", token);
    if (ip) form.append("remoteip", ip);
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
    const data = await res.json();
    return !!data.success;
  } catch { return false; }
}
function isOwner(env, user) {
  if (!user) return false;
  const adminUsername = (env.ADMIN_USERNAME || "admin").toLowerCase();
  return (user.username || "").toLowerCase() === adminUsername;
}
function checkStationAccess(station, session, env) {
  const access = station.access || "public";
  if (session && isOwner(env, session.user)) return null;
  const tier = session ? (session.user.tier || "none") : null;
  if (access === "sub" && (!session || tier === "none")) return { message: "برای گوش دادن به این ایستگاه باید اشتراک تهیه کنید", needLogin: !session, needSub: !!session };
  if (access === "vip" && (!session || tier === "none" || tier === "sub")) return { message: "این ایستگاه فقط برای کاربران VIP قابل دسترسی است", needLogin: !session, needVip: !!session };
  return null;
}

// ─────────────────────────────────────────────────────────────
// وریفای VIP
// ─────────────────────────────────────────────────────────────
async function handleVerify(request, env) {
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  try {
    const session = await getSessionUser(env, request);
    if (!session) return jsonResponse({ error: "ابتدا وارد حساب کاربری شوید" }, 401);
    // کد اعتماد یه رشته‌ی ثابته؛ بدون rate limit قابل brute-force است
    const rl = await checkRateLimit(env, "verify", session.user.username.toLowerCase(), 6, 600); // ۶ تلاش در ۱۰ دقیقه
    if (!rl.allowed) return rateLimitResponse(rl);
    const body = await request.json();
    const code = String(body.code || "").trim();
    const TRUST_CODE = env.TRUST_CODE || "RADIO2025VIP";
    if (!timingSafeEqual(code, TRUST_CODE)) return jsonResponse({ error: "کد اعتماد نامعتبر است" }, 400);
    if (session.user.tier === "vip") return jsonResponse({ error: "حساب شما قبلاً تأیید VIP شده است" }, 400);

    const oldTier = session.user.tier || "none";
    session.user.tier = "vip"; session.user.vipAt = Date.now();
    await saveUser(env, session.user);
    await logTierChange(env, session.user.username, oldTier, "vip", "trust_code");

    const vipMsg = `🌟 <b>فعال‌سازی VIP</b>\n\n👤 کاربر: <code>${session.user.username}</code>\n🔑 روش: کد اعتماد\n🕐 زمان: ${new Date().toLocaleString("fa-IR")}`;
    await sendTelegramNotification(env, vipMsg);

    return jsonResponse({ ok: true, tier: "vip" });
  } catch (e) {
    return jsonResponse({ error: "خطا: " + e.message }, 500);
  }
}

async function handlePaymentInfo(env) {
  const address = env.TRON_ADDRESS || "TXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
  const settings = await getSettings(env);
  return jsonResponse({ tronAddress: address, subPrice: settings.subPrice || "10", currency: "USDT (TRC20)", instructions: settings.paymentInstructions || "" });
}

// ── لاگ خطاهای سیستمی (پروکسی، health-check، exception های کلی) ──
async function logError(env, source, message, extra) {
  try {
    if (!env.RADIO_KV) return;
    const raw = await env.RADIO_KV.get("error_logs");
    const logs = raw ? JSON.parse(raw) : [];
    logs.push({ source, message: String(message || "").slice(0, 500), extra: extra || null, at: Date.now() });
    if (logs.length > 500) logs.splice(0, logs.length - 500);
    await env.RADIO_KV.put("error_logs", JSON.stringify(logs));
  } catch {}
}

// ── بررسی سلامت همه‌ی ایستگاه‌ها (هم از پنل ادمین، هم از Cron Trigger صدا زده می‌شود) ──
async function runHealthCheckAll(env) {
  const stations = await getStations(env);
  const checkPromises = stations.map(async (st) => {
    const start = Date.now();
    let status = "error", latency = null, httpCode = null;
    try {
      const resp = await fetch(st.url, { method: "HEAD", headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000), cf: { cacheTtl: 0, cacheEverything: false } });
      latency = Date.now() - start; httpCode = resp.status; status = resp.ok ? "live" : "error";
      if (!resp.ok) await logError(env, "health_check", `HTTP ${resp.status} برای ایستگاه ${st.name}`, { stationId: st.id });
    } catch (e) {
      latency = Date.now() - start;
      await logError(env, "health_check", `اتصال ناموفق به ایستگاه ${st.name}: ${e.message}`, { stationId: st.id });
    }
    return { id: st.id, status, latency, httpCode, checkedAt: Date.now() };
  });
  const checks = await Promise.allSettled(checkPromises);
  const healthMap = {};
  checks.forEach(r => { if (r.status === "fulfilled") healthMap[r.value.id] = r.value; });

  // ── اعلان تلگرام برای تغییر وضعیت (قطعی / بازگشت) ──
  const notifyPromises = [];
  for (const st of stations) {
    const h = healthMap[st.id];
    if (!h || h.status === st.status) continue;
    if (h.status === "error") {
      notifyPromises.push(sendTelegramNotification(env, `🔴 <b>ایستگاه از دسترس خارج شد</b>\n\n📻 ایستگاه: <code>${st.name}</code>\n🕐 زمان: ${new Date().toLocaleString("fa-IR")}`));
    } else if (h.status === "live" && st.status === "error") {
      notifyPromises.push(sendTelegramNotification(env, `🟢 <b>ایستگاه به حالت عادی برگشت</b>\n\n📻 ایستگاه: <code>${st.name}</code>\n🕐 زمان: ${new Date().toLocaleString("fa-IR")}`));
    }
  }
  await Promise.all(notifyPromises);

  const updated = stations.map(st => { const h = healthMap[st.id]; if (!h) return st; return { ...st, status: h.status, lastCheck: { latency: h.latency, httpCode: h.httpCode, checkedAt: h.checkedAt } }; });
  await env.RADIO_KV.put("stations", JSON.stringify(updated));

  // ── ذخیره‌ی تاریخچه‌ی وضعیت هر ایستگاه برای نمایش چارت Uptime ──
  await Promise.all(Object.values(healthMap).map(async (h) => {
    try {
      const key = "uptime_history:" + h.id;
      const raw = await env.RADIO_KV.get(key);
      let history = raw ? JSON.parse(raw) : [];
      history.push({ status: h.status, latency: h.latency, at: h.checkedAt });
      if (history.length > 100) history = history.slice(-100);
      await env.RADIO_KV.put(key, JSON.stringify(history), { expirationTtl: 60 * 60 * 24 * 30 });
    } catch {}
  }));
  return { results: Object.values(healthMap) };
}

// ── وارد کردن ایستگاه‌ها از فایل/متن M3U یا M3U8 ──
function parseM3U(text) {
  const lines = text.split(/\r?\n/);
  const items = [];
  let pendingName = null, pendingLogo = null, pendingGroup = null;
  for (let raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXTINF")) {
      const nameMatch = line.match(/,(.*)$/);
      pendingName = nameMatch ? nameMatch[1].trim() : null;
      const logoMatch = line.match(/tvg-logo="([^"]*)"/i);
      pendingLogo = logoMatch ? logoMatch[1] : null;
      const groupMatch = line.match(/group-title="([^"]*)"/i);
      pendingGroup = groupMatch ? groupMatch[1] : null;
      continue;
    }
    if (line.startsWith("#")) continue;
    // این خط یک URL است
    items.push({ name: pendingName || ("ایستگاه " + (items.length + 1)), url: line, logo: pendingLogo, group: pendingGroup });
    pendingName = null; pendingLogo = null; pendingGroup = null;
  }
  return items;
}
async function handleM3UImport(request, env) {
  if (request.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);
  try {
    const body = await request.json().catch(() => ({}));
    const text = String(body.text || "");
    if (!text.trim()) return jsonResponse({ error: "متن M3U خالی است" }, 400);
    const items = parseM3U(text);
    if (!items.length) return jsonResponse({ error: "هیچ ایستگاهی در فایل M3U یافت نشد" }, 400);

    const stations = await getStations(env);
    const existingIds = new Set(stations.map(s => s.id));
    let added = 0;
    for (const item of items) {
      let id = "m3u-" + randomToken().slice(0, 8);
      while (existingIds.has(id)) id = "m3u-" + randomToken().slice(0, 8);
      existingIds.add(id);
      const isHls = /\.m3u8(\?|$)/i.test(item.url);
      stations.push({
        id, name: item.name, url: item.url, icon: "📻", status: "live",
        access: "public", genre: "", type: isHls ? "hls" : "direct",
        playlistSuffix: "/index.m3u8", nowPlaying: "", country: "",
      });
      added++;
    }
    await env.RADIO_KV.put("stations", JSON.stringify(stations));
    return jsonResponse({ ok: true, added, total: items.length });
  } catch (e) {
    return jsonResponse({ error: "خطا در پردازش M3U: " + e.message }, 500);
  }
}

// ─────────────────────────────────────────────────────────────
// پنل مدیریت
// ─────────────────────────────────────────────────────────────
async function handleAdmin(request, env, url, pathParts) {
  const session = await getSessionUser(env, request);
  if (!session || !isOwner(env, session.user)) return new Response("Not found", { status: 404, headers: CORS_HEADERS });

  const subPath = pathParts.slice(1).join("/");

  if (subPath === "api/stats/listens" && request.method === "GET") {
    try {
      const stations = await getStations(env);
      const stats = await getStationStats(env, stations.map(s => s.id));
      const result = stations.map(st => ({ id: st.id, name: st.name, icon: st.icon || "📻", access: st.access || "public", status: st.status, genre: st.genre || "", listens: stats[st.id] || { total: 0, today: 0, yesterday: 0 } })).sort((a, b) => b.listens.total - a.listens.total);
      return jsonResponse(result);
    } catch (e) { return jsonResponse({ error: e.message }, 500); }
  }

  if (subPath === "api/backup/export" && request.method === "GET") return handleBackupExport(env);
  if (subPath === "api/backup/import" && request.method === "POST") return handleBackupImport(request, env);
  if (subPath === "api/import/m3u" && request.method === "POST") return handleM3UImport(request, env);
  if (subPath === "api/error-logs" && request.method === "GET") {
    try { const raw = await env.RADIO_KV.get("error_logs"); const logs = raw ? JSON.parse(raw) : []; return jsonResponse(logs.slice(-150).reverse()); }
    catch { return jsonResponse([]); }
  }
  const uptimeMatch = subPath.match(/^api\/uptime\/([^/]+)$/);
  if (uptimeMatch && request.method === "GET") {
    try { const raw = await env.RADIO_KV.get("uptime_history:" + uptimeMatch[1]); return jsonResponse(raw ? JSON.parse(raw) : []); }
    catch { return jsonResponse([]); }
  }

  if (subPath === "api/stations") {
    if (request.method === "GET") return jsonResponse(await getStations(env));
    if (request.method === "POST") {
      const body = await request.json();
      const stations = await getStations(env);
      if (stations.find(s => s.id === body.id)) return jsonResponse({ error: "شناسه ایستگاه تکراری است" }, 400);
      stations.push({ id: body.id, name: body.name, url: body.url, icon: body.icon || "📻", status: body.status || "live", access: body.access || "public", genre: body.genre || "", type: body.type || "direct", playlistSuffix: body.playlistSuffix || "/index.m3u8", nowPlaying: body.nowPlaying || "", country: body.country || "" });
      await env.RADIO_KV.put("stations", JSON.stringify(stations));
      return jsonResponse({ ok: true });
    }
  }

  // ── مدیریت آهنگ‌های ایستگاه نوع playlist ──
  const trackListMatch = subPath.match(/^api\/stations\/([^/]+)\/tracks$/);
  if (trackListMatch) {
    const stId = trackListMatch[1];
    if (request.method === "GET") return jsonResponse(await getStationTracks(env, stId));
    if (request.method === "POST") return handleTrackUpload(request, env, stId);
  }
  const trackDeleteMatch = subPath.match(/^api\/stations\/([^/]+)\/tracks\/([^/]+)$/);
  if (trackDeleteMatch && request.method === "DELETE") {
    return handleTrackDelete(env, trackDeleteMatch[1], trackDeleteMatch[2]);
  }
  const trackReorderMatch = subPath.match(/^api\/stations\/([^/]+)\/tracks-reorder$/);
  if (trackReorderMatch && request.method === "POST") {
    return handleTrackReorder(request, env, trackReorderMatch[1]);
  }

  if (subPath.startsWith("api/stations/")) {
    const id = subPath.replace("api/stations/", "");
    const stations = await getStations(env);
    const idx = stations.findIndex(s => s.id === id);
    if (id === "delete-errors" && request.method === "POST") {
      const remaining = stations.filter(s => s.status !== "error");
      const removed = stations.length - remaining.length;
      await env.RADIO_KV.put("stations", JSON.stringify(remaining));
      return jsonResponse({ ok: true, removed });
    }
    if (request.method === "PUT") {
      if (idx === -1) return jsonResponse({ error: "Not found" }, 404);
      const body = await request.json();
      stations[idx] = { ...stations[idx], ...body };
      await env.RADIO_KV.put("stations", JSON.stringify(stations));
      return jsonResponse({ ok: true });
    }
    if (request.method === "DELETE") {
      if (idx === -1) return jsonResponse({ error: "Not found" }, 404);
      stations.splice(idx, 1);
      await env.RADIO_KV.put("stations", JSON.stringify(stations));
      return jsonResponse({ ok: true });
    }
  }

  if (subPath === "api/health/run" && request.method === "POST") {
    const result = await runHealthCheckAll(env);
    return jsonResponse({ ok: true, results: result.results });
  }

  // ── ژانرها (دسته‌بندی) ──
  if (subPath === "api/genres") {
    if (request.method === "GET") return jsonResponse(await getGenres(env));
    if (request.method === "POST") {
      const body = await request.json();
      if (!body.name) return jsonResponse({ error: "نام الزامی است" }, 400);
      const genres = await getGenres(env);
      const id = body.name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9\u0600-\u06FF-]/g, "");
      if (genres.find(g => g.id === id)) return jsonResponse({ error: "این ژانر قبلاً وجود دارد" }, 400);
      genres.push({ id, name: body.name, icon: body.icon || "🎵", color: body.color || "#4da6ff" });
      await env.RADIO_KV.put("genres", JSON.stringify(genres));
      return jsonResponse({ ok: true, id });
    }
  }
  if (subPath.startsWith("api/genres/")) {
    const gid = subPath.replace("api/genres/", "");
    const genres = await getGenres(env);
    const idx = genres.findIndex(g => g.id === gid);
    if (request.method === "PUT") {
      if (idx === -1) return jsonResponse({ error: "Not found" }, 404);
      genres[idx] = { ...genres[idx], ...(await request.json()) };
      await env.RADIO_KV.put("genres", JSON.stringify(genres));
      return jsonResponse({ ok: true });
    }
    if (request.method === "DELETE") {
      if (idx === -1) return jsonResponse({ error: "Not found" }, 404);
      genres.splice(idx, 1);
      await env.RADIO_KV.put("genres", JSON.stringify(genres));
      const stations = await getStations(env);
      const remaining = stations.filter(s => s.genre !== gid);
      await env.RADIO_KV.put("stations", JSON.stringify(remaining));
      return jsonResponse({ ok: true, removedStations: stations.length - remaining.length });
    }
  }

  // ── کاربران ──
  if (subPath === "api/users") {
    if (request.method === "GET") {
      const list = await env.RADIO_KV.list({ prefix: "user:" });
      const users = [];
      for (const key of list.keys) {
        try {
          const raw = await env.RADIO_KV.get(key.name);
          if (raw) { const u = JSON.parse(raw); users.push({ username: u.username, tier: u.tier || "none", createdAt: u.createdAt, vipAt: u.vipAt || null, subAt: u.subAt || null, favorites: (u.favorites || []).length }); }
        } catch {}
      }
      users.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      return jsonResponse(users);
    }
  }
  if (subPath.startsWith("api/users/")) {
    const username = decodeURIComponent(subPath.replace("api/users/", ""));
    if (request.method === "PUT") {
      const user = await getUserByUsername(env, username);
      if (!user) return jsonResponse({ error: "کاربر یافت نشد" }, 404);
      const body = await request.json();
      const oldTier = user.tier || "none";
      if (body.tier) {
        user.tier = body.tier;
        if (body.tier === "vip") user.vipAt = Date.now();
        if (body.tier === "sub") user.subAt = Date.now();
        if (body.tier === "none") { delete user.vipAt; delete user.subAt; }
        await logTierChange(env, username, oldTier, body.tier, "admin");
        if (body.tier !== oldTier) {
          if (body.tier === "sub") {
            const payMsg = `💳 <b>پرداخت تأیید شد</b>\n\n👤 کاربر: <code>${username}</code>\n✅ اشتراک فعال شد توسط ادمین\n🕐 زمان: ${new Date().toLocaleString("fa-IR")}`;
            await sendTelegramNotification(env, payMsg);
          } else {
            const tierNames = { none: "بدون اشتراک", sub: "اشتراک ✅", vip: "VIP 🌟" };
            const msg = `⚙️ <b>تغییر سطح دسترسی توسط ادمین</b>\n\n👤 کاربر: <code>${username}</code>\n📊 از: ${tierNames[oldTier] || oldTier} → ${tierNames[body.tier] || body.tier}\n🕐 زمان: ${new Date().toLocaleString("fa-IR")}`;
            await sendTelegramNotification(env, msg);
          }
        }
      }
      await saveUser(env, user);
      return jsonResponse({ ok: true });
    }
    if (request.method === "DELETE") { await env.RADIO_KV.delete("user:" + username.toLowerCase()); return jsonResponse({ ok: true }); }
  }

  // ── تنظیمات پرداخت ──
  if (subPath === "api/settings/payment") {
    if (request.method === "GET") {
      const settings = await getSettings(env);
      return jsonResponse({ tronAddress: env.TRON_ADDRESS || "", subPrice: settings.subPrice || "10", paymentInstructions: settings.paymentInstructions || "" });
    }
    if (request.method === "POST") {
      const body = await request.json();
      const settings = await getSettings(env);
      const updated = { ...settings };
      if (body.subPrice) updated.subPrice = body.subPrice;
      if (body.paymentInstructions !== undefined) updated.paymentInstructions = body.paymentInstructions;
      await env.RADIO_KV.put("settings", JSON.stringify(updated));
      return jsonResponse({ ok: true });
    }
  }

  // ── تلگرام ──
  if (subPath === "api/settings/telegram") {
    if (request.method === "GET") {
      return jsonResponse({ botTokenSet: !!(env.TELEGRAM_BOT_TOKEN), chatIdSet: !!(env.TELEGRAM_CHAT_ID), chatId: env.TELEGRAM_CHAT_ID || "", note: "توکن ربات از طریق متغیر TELEGRAM_BOT_TOKEN و آیدی چت از TELEGRAM_CHAT_ID تنظیم می‌شود." });
    }
    if (request.method === "POST") {
      try {
        const testMsg = `🔔 <b>تست اعلان RadioFa</b>\n\nاتصال به تلگرام با موفقیت برقرار شد!\n🕐 ${new Date().toLocaleString("fa-IR")}`;
        if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return jsonResponse({ error: "ابتدا TELEGRAM_BOT_TOKEN و TELEGRAM_CHAT_ID را در متغیرهای محیطی تنظیم کنید" }, 400);
        await sendTelegramNotification(env, testMsg);
        return jsonResponse({ ok: true, message: "پیام تست ارسال شد." });
      } catch (e) { return jsonResponse({ error: "خطا در ارسال: " + e.message }, 500); }
    }
  }

  if (subPath === "api/tier-logs" && request.method === "GET") {
    try { const raw = await env.RADIO_KV.get("tier_logs"); const logs = raw ? JSON.parse(raw) : []; return jsonResponse(logs.slice(-100).reverse()); }
    catch { return jsonResponse([]); }
  }

  // ── لیست IP های بلاک‌شده ──
  if (subPath === "api/blocked-ips") {
    if (request.method === "GET") {
      try {
        const list = await env.RADIO_KV.list({ prefix: "blocked_ip:" });
        const ips = [];
        for (const key of list.keys) {
          try { const raw = await env.RADIO_KV.get(key.name); const d = raw ? JSON.parse(raw) : {}; ips.push({ ip: key.name.replace("blocked_ip:", ""), reason: d.reason || "", at: d.at || null }); } catch {}
        }
        return jsonResponse(ips);
      } catch { return jsonResponse([]); }
    }
    if (request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const ip = String(body.ip || "").trim();
      if (!ip) return jsonResponse({ error: "IP الزامی است" }, 400);
      await env.RADIO_KV.put("blocked_ip:" + ip, JSON.stringify({ reason: String(body.reason || "").slice(0, 200), at: Date.now() }));
      return jsonResponse({ ok: true });
    }
  }
  if (subPath.startsWith("api/blocked-ips/") && request.method === "DELETE") {
    const ip = decodeURIComponent(subPath.replace("api/blocked-ips/", ""));
    await env.RADIO_KV.delete("blocked_ip:" + ip);
    return jsonResponse({ ok: true });
  }

  // ── لاگ فعالیت کاربران (ورود/ثبت‌نام/تغییر رمز/...) ──
  if (subPath === "api/activity-logs" && request.method === "GET") {
    try { const raw = await env.RADIO_KV.get("activity_logs"); const logs = raw ? JSON.parse(raw) : []; return jsonResponse(logs.slice(-150).reverse()); }
    catch { return jsonResponse([]); }
  }

  if (!subPath || subPath === "") return new Response(getAdminHTML(url.origin), { headers: { "Content-Type": "text/html; charset=utf-8" } });
  return new Response("Not found", { status: 404 });
}

// ─────────────────────────────────────────────────────────────
// احراز هویت
// ─────────────────────────────────────────────────────────────
async function handleAuth(request, env, pathParts) {
  const action = pathParts[2] || "";
  const clientIP = getClientIP(request);

  if (action === "signup" && request.method === "POST") {
    try {
      const rl = await checkRateLimit(env, "signup", clientIP, 5, 600); // ۵ ثبت‌نام در ۱۰ دقیقه از هر IP
      if (!rl.allowed) return rateLimitResponse(rl);
      const body = await request.json();
      const username = String(body.username || "").trim();
      const password = String(body.password || "");
      const captchaOk = await verifyTurnstile(env, body.captchaToken, clientIP);
      if (!captchaOk) return jsonResponse({ error: "تأیید کپچا ناموفق بود، دوباره تلاش کن" }, 400);
      if (!username || username.length < 3) return jsonResponse({ error: "نام کاربری باید حداقل ۳ کاراکتر باشد" }, 400);
      if (!/^[a-zA-Z0-9_\u0600-\u06FF]+$/.test(username)) return jsonResponse({ error: "نام کاربری فقط می‌تواند حروف، عدد و _ داشته باشد" }, 400);
      if (!password || password.length < 4) return jsonResponse({ error: "رمز عبور باید حداقل ۴ کاراکتر باشد" }, 400);
      if (await getUserByUsername(env, username)) return jsonResponse({ error: "این نام کاربری قبلاً ثبت شده است" }, 400);

      const user = { username, passwordHash: await hashPassword(password), tier: "none", favorites: [], createdAt: Date.now(), sessionVersion: 0 };
      await saveUser(env, user);
      const token = await createSession(env, username, user);

      const signupMsg = `👤 <b>کاربر جدید ثبت‌نام کرد</b>\n\n🆔 نام کاربری: <code>${username}</code>\n🕐 زمان: ${new Date().toLocaleString("fa-IR")}`;
      await sendTelegramNotification(env, signupMsg);
      await logActivity(env, username, "signup", clientIP);

      return jsonResponse({ ok: true, user: publicUser(user, env) }, 200, { "Set-Cookie": sessionCookieHeader(token) });
    } catch (e) { return jsonResponse({ error: "خطا در ثبت‌نام: " + e.message }, 500); }
  }

  if (action === "login" && request.method === "POST") {
    try {
      const body = await request.json();
      const username = String(body.username || "").trim();
      const password = String(body.password || "");

      // Rate limit ترکیبی: هم بر اساس IP (ضد اسپری روی چند حساب) و هم بر اساس username (ضد brute-force روی یک حساب خاص از IP های مختلف)
      const ipRl = await checkRateLimit(env, "login_ip", clientIP, 20, 600); // ۲۰ تلاش در ۱۰ دقیقه از هر IP
      if (!ipRl.allowed) return rateLimitResponse(ipRl);
      if (username) {
        const userRl = await checkRateLimit(env, "login_user", username.toLowerCase(), 8, 600); // ۸ تلاش در ۱۰ دقیقه روی هر حساب
        if (!userRl.allowed) return rateLimitResponse(userRl);
      }

      const user = await getUserByUsername(env, username);
      if (!user) return jsonResponse({ error: "نام کاربری یا رمز عبور اشتباه است" }, 401);

      const { valid, needsMigration } = await verifyPassword(password, user);
      if (!valid) {
        // اعلان ورود مشکوک: چند تلاش ناموفق پشت‌سرهم روی یک حساب
        await maybeNotifySuspiciousLogin(env, username, clientIP);
        return jsonResponse({ error: "نام کاربری یا رمز عبور اشتباه است" }, 401);
      }

      // اگر پسورد با فرمت قدیمی (SHA-256 بدون salt) بود، همین الان به PBKDF2 ارتقا بده
      if (needsMigration) {
        user.passwordHash = await hashPassword(password);
        await saveUser(env, user);
      }

      // هشدار ورود از IP جدید (که قبلاً برای این کاربر دیده نشده)
      await checkAndNotifyNewIP(env, username, clientIP);

      const token = await createSession(env, username, user, clientIP, request.headers.get("User-Agent") || "");
      await logActivity(env, username, "login", clientIP);
      return jsonResponse({ ok: true, user: publicUser(user, env) }, 200, { "Set-Cookie": sessionCookieHeader(token) });
    } catch (e) { return jsonResponse({ error: "خطا در ورود: " + e.message }, 500); }
  }

  if (action === "logout" && request.method === "POST") {
    const s = await getSessionUser(env, request);
    await destroySession(env, request);
    if (s) await logActivity(env, s.user.username, "logout", clientIP);
    return jsonResponse({ ok: true }, 200, { "Set-Cookie": clearSessionCookieHeader() });
  }

  // خروج از همه‌ی دستگاه‌ها: با بالا بردن sessionVersion، همه‌ی توکن‌های صادرشده (حتی دستگاه فعلی) بلافاصله باطل می‌شوند
  if (action === "logout-all" && request.method === "POST") {
    try {
      const session = await getSessionUser(env, request);
      if (!session) return jsonResponse({ error: "ابتدا وارد شوید" }, 401);
      session.user.sessionVersion = (typeof session.user.sessionVersion === "number" ? session.user.sessionVersion : 0) + 1;
      await saveUser(env, session.user);
      await destroySession(env, request);
      return jsonResponse({ ok: true, message: "از همه‌ی دستگاه‌ها خارج شدید. لطفاً دوباره وارد شوید." }, 200, { "Set-Cookie": clearSessionCookieHeader() });
    } catch (e) { return jsonResponse({ error: "خطا: " + e.message }, 500); }
  }

  // لیست دستگاه‌ها/session های فعال کاربر (best-effort، بر اساس ایندکس ذخیره‌شده هنگام ورود)
  if (action === "sessions" && request.method === "GET") {
    try {
      const session = await getSessionUser(env, request);
      if (!session) return jsonResponse({ error: "ابتدا وارد شوید" }, 401);
      const raw = await env.RADIO_KV.get("user_sessions:" + session.user.username.toLowerCase());
      const list = raw ? JSON.parse(raw) : [];
      // فقط session هایی که هنوز در KV معتبرند را برگردان
      const active = [];
      for (const s of list) {
        const exists = await env.RADIO_KV.get("session:" + s.token);
        if (exists) active.push({ ip: s.ip, userAgent: s.userAgent, createdAt: s.createdAt, current: s.token === session.token });
      }
      return jsonResponse({ sessions: active });
    } catch (e) { return jsonResponse({ error: "خطا: " + e.message }, 500); }
  }

  if (action === "me" && request.method === "GET") {
    const session = await getSessionUser(env, request);
    if (!session) return jsonResponse({ user: null });
    return jsonResponse({ user: publicUser(session.user, env) });
  }

  if (action === "change-password" && request.method === "POST") {
    try {
      const session = await getSessionUser(env, request);
      if (!session) return jsonResponse({ error: "ابتدا وارد شوید" }, 401);
      const body = await request.json();
      const { valid: curValid } = await verifyPassword(String(body.currentPassword || ""), session.user);
      if (!curValid) return jsonResponse({ error: "رمز فعلی اشتباه است" }, 400);
      if (!body.newPassword || String(body.newPassword).length < 4) return jsonResponse({ error: "رمز جدید باید حداقل ۴ کاراکتر باشد" }, 400);
      // تغییر رمز هم به‌عنوان یک اقدام امنیتی، همه‌ی سشن‌های دیگر را باطل می‌کند تا اگر رمز قبلی لو رفته، دسترسی مهاجم قطع شود
      session.user.passwordHash = await hashPassword(String(body.newPassword));
      session.user.sessionVersion = (typeof session.user.sessionVersion === "number" ? session.user.sessionVersion : 0) + 1;
      await saveUser(env, session.user);
      const newToken = await createSession(env, session.user.username, session.user);
      await logActivity(env, session.user.username, "change_password", clientIP);
      return jsonResponse({ ok: true }, 200, { "Set-Cookie": sessionCookieHeader(newToken) });
    } catch (e) { return jsonResponse({ error: "خطا: " + e.message }, 500); }
  }

  return jsonResponse({ error: "Not found" }, 404);
}

// ─────────────────────────────────────────────────────────────
// آهنگ‌های ایستگاه‌های نوع playlist (آپلود روی R2)
// ─────────────────────────────────────────────────────────────
const MAX_TRACK_SIZE = 30 * 1024 * 1024; // 30MB
const ALLOWED_TRACK_TYPES = ["audio/mpeg", "audio/mp3", "audio/aac", "audio/ogg", "audio/wav", "audio/x-wav", "audio/mp4", "audio/m4a"];

async function getStationTracks(env, stationId) {
  try {
    const raw = await env.RADIO_KV.get("playlist:" + stationId);
    const ids = raw ? JSON.parse(raw) : [];
    const metas = await Promise.all(ids.map(id => getTrackMeta(env, id)));
    return metas.filter(Boolean);
  } catch { return []; }
}
async function getTrackMeta(env, trackId) {
  try { const raw = await env.RADIO_KV.get("track_meta:" + trackId); return raw ? JSON.parse(raw) : null; } catch { return null; }
}
async function saveTrackMeta(env, meta) { await env.RADIO_KV.put("track_meta:" + meta.id, JSON.stringify(meta)); }

async function handleServeTrack(request, env, trackId) {
  try {
    const meta = await getTrackMeta(env, trackId);
    if (!meta) return new Response("Not found", { status: 404 });
    const stations = await getStations(env);
    const station = stations.find(s => s.id === meta.stationId);
    if (station) {
      const session = await getSessionUser(env, request);
      const accessError = checkStationAccess(station, session, env);
      if (accessError) return jsonResponse({ error: accessError.message, needLogin: accessError.needLogin, needSub: accessError.needSub, needVip: accessError.needVip }, 403);
    }
    if (!env.RADIO_R2) return new Response("R2 not configured", { status: 500 });
    const obj = await env.RADIO_R2.get("tracks/" + trackId);
    if (!obj) return new Response("Not found", { status: 404 });
    return new Response(obj.body, {
      headers: {
        "Content-Type": meta.type || "audio/mpeg",
        "Content-Disposition": `inline; filename="${encodeURIComponent(meta.name || trackId)}"`,
        "Cache-Control": "public, max-age=3600",
        "Accept-Ranges": "bytes",
        ...CORS_HEADERS,
      },
    });
  } catch (e) {
    return new Response("Error: " + e.message, { status: 500 });
  }
}

async function handleTrackUpload(request, env, stationId) {
  if (!env.RADIO_R2) return jsonResponse({ error: "آپلود فایل روی این سرور فعال نیست (R2 متصل نشده). باید یک R2 bucket با نام RADIO_R2 به Worker بایند شود." }, 500);
  try {
    const existing = await getStationTracks(env, stationId);
    const form = await request.formData();
    const file = form.get("file");
    if (!file || typeof file === "string") return jsonResponse({ error: "فایلی ارسال نشد" }, 400);
    if (file.size > MAX_TRACK_SIZE) return jsonResponse({ error: "حجم فایل باید کمتر از ۳۰ مگابایت باشد" }, 400);
    if (file.type && !ALLOWED_TRACK_TYPES.includes(file.type)) return jsonResponse({ error: "فرمت فایل پشتیبانی نمی‌شود (mp3/aac/ogg/wav مجاز است)" }, 400);

    const trackId = randomToken().slice(0, 16);
    await env.RADIO_R2.put("tracks/" + trackId, await file.arrayBuffer(), { httpMetadata: { contentType: file.type || "audio/mpeg" } });

    const meta = { id: trackId, name: (file.name || "track").replace(/\.[a-zA-Z0-9]+$/, ""), type: file.type || "audio/mpeg", size: file.size, stationId, uploadedAt: Date.now() };
    await saveTrackMeta(env, meta);

    const ids = existing.map(t => t.id);
    ids.push(trackId);
    await env.RADIO_KV.put("playlist:" + stationId, JSON.stringify(ids));

    return jsonResponse({ ok: true, track: { id: trackId, name: meta.name } });
  } catch (e) {
    return jsonResponse({ error: "خطا در آپلود: " + e.message }, 500);
  }
}

async function handleTrackDelete(env, stationId, trackId) {
  try {
    const meta = await getTrackMeta(env, trackId);
    if (!meta || meta.stationId !== stationId) return jsonResponse({ error: "آهنگ یافت نشد" }, 404);
    if (env.RADIO_R2) { try { await env.RADIO_R2.delete("tracks/" + trackId); } catch {} }
    await env.RADIO_KV.delete("track_meta:" + trackId);
    const existing = await getStationTracks(env, stationId);
    const ids = existing.filter(t => t.id !== trackId).map(t => t.id);
    await env.RADIO_KV.put("playlist:" + stationId, JSON.stringify(ids));
    return jsonResponse({ ok: true });
  } catch (e) {
    return jsonResponse({ error: "خطا: " + e.message }, 500);
  }
}

async function handleTrackReorder(request, env, stationId) {
  try {
    const body = await request.json();
    const order = Array.isArray(body.order) ? body.order : [];
    if (!order.length) return jsonResponse({ error: "ترتیب نامعتبر است" }, 400);
    await env.RADIO_KV.put("playlist:" + stationId, JSON.stringify(order));
    return jsonResponse({ ok: true });
  } catch (e) {
    return jsonResponse({ error: "خطا: " + e.message }, 500);
  }
}

// ─────────────────────────────────────────────────────────────
// علاقه‌مندی‌ها
// ─────────────────────────────────────────────────────────────
async function handleFavorites(request, env) {
  const session = await getSessionUser(env, request);
  if (!session) return jsonResponse({ error: "ابتدا وارد شوید" }, 401);
  if (request.method === "GET") return jsonResponse({ favorites: session.user.favorites || [] });
  if (request.method === "POST") {
    const body = await request.json();
    const stationId = String(body.stationId || "");
    if (!stationId) return jsonResponse({ error: "stationId الزامی است" }, 400);
    const favs = new Set(session.user.favorites || []);
    if (favs.has(stationId)) favs.delete(stationId); else favs.add(stationId);
    session.user.favorites = Array.from(favs);
    await saveUser(env, session.user);
    return jsonResponse({ ok: true, favorites: session.user.favorites });
  }
  return jsonResponse({ error: "Not found" }, 404);
}

// ─────────────────────────────────────────────────────────────
// توابع کمکی KV
// ─────────────────────────────────────────────────────────────
async function getStations(env) {
  try { if (!env.RADIO_KV) return DEFAULT_STATIONS; const r = await env.RADIO_KV.get("stations"); return r ? JSON.parse(r) : DEFAULT_STATIONS; } catch { return DEFAULT_STATIONS; }
}
async function getSettings(env) {
  try { if (!env.RADIO_KV) return DEFAULT_SETTINGS; const r = await env.RADIO_KV.get("settings"); return r ? { ...DEFAULT_SETTINGS, ...JSON.parse(r) } : DEFAULT_SETTINGS; } catch { return DEFAULT_SETTINGS; }
}
async function getGenres(env) {
  try { if (!env.RADIO_KV) return []; const r = await env.RADIO_KV.get("genres"); return r ? JSON.parse(r) : []; } catch { return []; }
}
function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...extraHeaders } });
}

const SESSION_COOKIE_NAME = "radio_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

// ─────────────────────────────────────────────────────────────
// Rate limiting (KV-based، تقریبی ولی برای جلوگیری از brute-force/سوءاستفاده کافیست)
// ─────────────────────────────────────────────────────────────
function getClientIP(request) {
  return request.headers.get("CF-Connecting-IP") || request.headers.get("x-forwarded-for") || "unknown";
}
async function checkRateLimit(env, bucket, key, limit, windowSeconds) {
  if (!env.RADIO_KV) return { allowed: true, remaining: limit };
  const rlKey = `ratelimit:${bucket}:${key}`;
  let data = null;
  try { const raw = await env.RADIO_KV.get(rlKey); data = raw ? JSON.parse(raw) : null; } catch { data = null; }
  const now = Date.now();
  if (!data || !data.resetAt || data.resetAt < now) data = { count: 0, resetAt: now + windowSeconds * 1000 };
  data.count += 1;
  const allowed = data.count <= limit;
  const ttlSeconds = Math.max(1, Math.ceil((data.resetAt - now) / 1000));
  try { await env.RADIO_KV.put(rlKey, JSON.stringify(data), { expirationTtl: ttlSeconds }); } catch {}
  return { allowed, remaining: Math.max(0, limit - data.count), resetAt: data.resetAt, retryAfter: ttlSeconds };
}
function rateLimitResponse(rl) {
  return jsonResponse(
    { error: "تعداد درخواست‌های شما زیاد بوده، کمی صبر کن و دوباره امتحان کن ⏳" },
    429,
    { "Retry-After": String(rl.retryAfter || 60) }
  );
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ─────────────────────────────────────────────────────────────
// هش پسورد امن (PBKDF2 + salt تصادفی + 100000 تکرار)
// فرمت ذخیره‌سازی: "pbkdf2:<iterations>:<saltHex>:<hashHex>"
// پسوردهای قدیمی (فرمت SHA-256 ساده، بدون ":") هنگام لاگین موفق به‌صورت خودکار migrate می‌شوند.
// ─────────────────────────────────────────────────────────────
const PBKDF2_ITERATIONS = 100000;
function bytesToHex(bytes) { return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join(""); }
function hexToBytes(hex) { const arr = hex.match(/.{1,2}/g) || []; return new Uint8Array(arr.map(b => parseInt(b, 16))); }

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" }, keyMaterial, 256);
  return `pbkdf2:${PBKDF2_ITERATIONS}:${bytesToHex(salt)}:${bytesToHex(new Uint8Array(bits))}`;
}

async function verifyPasswordPbkdf2(password, stored) {
  try {
    const parts = stored.split(":");
    if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
    const iterations = parseInt(parts[1], 10);
    const salt = hexToBytes(parts[2]);
    const expectedHex = parts[3];
    const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations, hash: "SHA-256" }, keyMaterial, 256);
    const computedHex = bytesToHex(new Uint8Array(bits));
    return timingSafeEqual(computedHex, expectedHex);
  } catch { return false; }
}

// بررسی پسورد با پشتیبانی از فرمت قدیمی (SHA-256 بدون salt) + گزارش نیاز به migration
async function verifyPassword(password, user) {
  const stored = user.passwordHash || "";
  if (stored.startsWith("pbkdf2:")) {
    return { valid: await verifyPasswordPbkdf2(password, stored), needsMigration: false };
  }
  const legacyHash = await sha256Hex(password);
  const valid = timingSafeEqual(legacyHash, stored);
  return { valid, needsMigration: valid };
}

// مقایسه‌ی امن در برابر timing attack
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) {
    let dummy = 0; for (let i = 0; i < Math.max(a.length, b.length); i++) dummy |= (a.charCodeAt(i % a.length) || 0) ^ (b.charCodeAt(i % b.length) || 0);
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}

function randomToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
}
async function getUserByUsername(env, username) {
  try { if (!env.RADIO_KV) return null; const r = await env.RADIO_KV.get("user:" + username.toLowerCase()); return r ? JSON.parse(r) : null; } catch { return null; }
}
async function saveUser(env, user) { await env.RADIO_KV.put("user:" + user.username.toLowerCase(), JSON.stringify(user)); }

// نکته امنیتی: هر سشن با شماره‌نسخه‌ی (sessionVersion) کاربر مهر می‌خوره. با «خروج از همه دستگاه‌ها»
// این عدد یک واحد بالا می‌ره و همه‌ی توکن‌های قدیمی (حتی اگه از KV پاک نشده باشن) بلافاصله نامعتبر می‌شن.
async function createSession(env, username, user, ip, userAgent) {
  const token = randomToken();
  const v = (user && typeof user.sessionVersion === "number") ? user.sessionVersion : 0;
  const record = { username, createdAt: Date.now(), v, ip: ip || null, userAgent: (userAgent || "").slice(0, 200) };
  await env.RADIO_KV.put("session:" + token, JSON.stringify(record), { expirationTtl: SESSION_TTL_SECONDS });
  // برای «دستگاه‌های فعال»، لیست کوتاهی از توکن‌های صادرشده برای هر کاربر را هم نگه می‌داریم (best-effort، نه critical-path)
  try {
    const idxKey = "user_sessions:" + username.toLowerCase();
    const raw = await env.RADIO_KV.get(idxKey);
    let list = raw ? JSON.parse(raw) : [];
    list.push({ token, createdAt: record.createdAt, ip: record.ip, userAgent: record.userAgent });
    if (list.length > 20) list = list.slice(-20);
    await env.RADIO_KV.put(idxKey, JSON.stringify(list), { expirationTtl: SESSION_TTL_SECONDS });
  } catch {}
  return token;
}

// اگر همین کاربر قبلاً از این IP وارد نشده بود، یک اعلان امنیتی به تلگرام بفرست (best-effort)
async function checkAndNotifyNewIP(env, username, ip) {
  if (!ip || ip === "unknown" || !env.RADIO_KV) return;
  try {
    const key = "known_ips:" + username.toLowerCase();
    const raw = await env.RADIO_KV.get(key);
    let ips = raw ? JSON.parse(raw) : [];
    if (ips.includes(ip)) return;
    const isFirstEver = ips.length === 0;
    ips.push(ip);
    if (ips.length > 15) ips = ips.slice(-15);
    await env.RADIO_KV.put(key, JSON.stringify(ips), { expirationTtl: 60 * 60 * 24 * 180 });
    if (!isFirstEver) {
      await sendTelegramNotification(env, `⚠️ <b>ورود از IP جدید</b>\n\n👤 کاربر: <code>${username}</code>\n🌐 IP: <code>${ip}</code>\n🕐 زمان: ${new Date().toLocaleString("fa-IR")}`);
    }
  } catch {}
}

// چند تلاش ناموفق پشت‌سرهم روی یک حساب را به تلگرام گزارش بده (سیگنال احتمالی brute-force هدفمند)
async function maybeNotifySuspiciousLogin(env, username, ip) {
  if (!env.RADIO_KV) return;
  try {
    const key = "failed_login:" + username.toLowerCase();
    const raw = await env.RADIO_KV.get(key);
    let data = raw ? JSON.parse(raw) : { count: 0 };
    data.count = (data.count || 0) + 1;
    await env.RADIO_KV.put(key, JSON.stringify(data), { expirationTtl: 600 });
    if (data.count === 5) {
      await sendTelegramNotification(env, `🚨 <b>تلاش‌های ورود ناموفق مکرر</b>\n\n👤 کاربر: <code>${username}</code>\n🌐 آخرین IP: <code>${ip}</code>\n🔢 تعداد: ${data.count} تلاش در ۱۰ دقیقه اخیر\n🕐 زمان: ${new Date().toLocaleString("fa-IR")}`);
    }
  } catch {}
}
async function getSessionUser(env, request) {
  try {
    const cookieHeader = request.headers.get("Cookie") || "";
    const match = cookieHeader.match(new RegExp(SESSION_COOKIE_NAME + "=([^;]+)"));
    if (!match) return null;
    const raw = await env.RADIO_KV.get("session:" + match[1]);
    if (!raw) return null;
    const session = JSON.parse(raw);
    const user = await getUserByUsername(env, session.username);
    if (!user) return null;
    const currentV = typeof user.sessionVersion === "number" ? user.sessionVersion : 0;
    const sessionV = typeof session.v === "number" ? session.v : 0;
    if (sessionV !== currentV) { try { await env.RADIO_KV.delete("session:" + match[1]); } catch {} return null; }
    return { user, token: match[1] };
  } catch { return null; }
}
async function destroySession(env, request) {
  const cookieHeader = request.headers.get("Cookie") || "";
  const match = cookieHeader.match(new RegExp(SESSION_COOKIE_NAME + "=([^;]+)"));
  if (match) await env.RADIO_KV.delete("session:" + match[1]);
}
function sessionCookieHeader(token) { return `${SESSION_COOKIE_NAME}=${token}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; SameSite=Lax; Secure`; }
function clearSessionCookieHeader() { return `${SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure`; }
function publicUser(user, env) {
  const owner = isOwner(env, user);
  return { username: user.username, tier: user.tier || "none", role: owner ? "owner" : "user", favorites: user.favorites || [] };
}
async function logActivity(env, username, action, ip, extra) {
  try {
    const raw = await env.RADIO_KV.get("activity_logs");
    const logs = raw ? JSON.parse(raw) : [];
    logs.push({ username, action, ip: ip || null, extra: extra || null, at: Date.now() });
    if (logs.length > 1000) logs.splice(0, logs.length - 1000);
    await env.RADIO_KV.put("activity_logs", JSON.stringify(logs));
  } catch {}
}
async function logTierChange(env, username, fromTier, toTier, source) {
  try {
    const raw = await env.RADIO_KV.get("tier_logs");
    const logs = raw ? JSON.parse(raw) : [];
    logs.push({ username, fromTier, toTier, source, at: Date.now() });
    if (logs.length > 500) logs.splice(0, logs.length - 500);
    await env.RADIO_KV.put("tier_logs", JSON.stringify(logs));
  } catch {}
}

// ═══════════════════════════════════════════════════════════════
// HTML فرانت‌اند کاربر
// ═══════════════════════════════════════════════════════════════
function getFrontendHTML(workerOrigin, stationsData, genresData) {
  return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>RadioFa — رادیو آنلاین</title>
<link rel="manifest" href="/manifest.json">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icon.svg">
<meta name="theme-color" content="#ff9f43">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@300;400;500;700&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/hls.js@1.4.12/dist/hls.min.js"></script>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
:root{--bg:#0b0d10;--bg2:#13161c;--bg3:#1c2029;--border:rgba(255,255,255,0.07);--border2:rgba(255,255,255,0.13);
--accent:#ff9f43;--accent2:#ff8a1e;--text:#f0f2f5;--muted:#7a8090;--red:#ff4d4d;--green:#3ddc84;--blue:#4da6ff;--gold:#ffcc00;--gray:#9aa3b2;--card-radius:16px;}
:root[data-theme="light"]{--bg:#f4f5f8;--bg2:#ffffff;--bg3:#eef0f4;--border:rgba(15,20,30,0.08);--border2:rgba(15,20,30,0.14);
--accent:#ff8a1e;--accent2:#e6790f;--text:#181b21;--muted:#7c8494;--red:#e6473f;--green:#1fa971;--blue:#2e7fd8;--gold:#c99700;--gray:#5a6270;}
*,body,nav,.card,.modal,.now-playing-bar,.btn-account,.btn-play,input,select{transition:background-color .3s ease,color .3s ease,border-color .3s ease;}
body{font-family:'Vazirmatn',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;direction:rtl;}
.theme-toggle-btn{background:var(--bg2);border:1px solid var(--border);color:var(--text);border-radius:20px;width:36px;height:36px;cursor:pointer;font-size:15px;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.theme-toggle-btn:hover{border-color:var(--border2);}
.card{animation:cardFadeIn .35s ease both;}
@keyframes cardFadeIn{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:translateY(0);}}
.now-playing-bar{transition:transform .3s ease,opacity .3s ease;}
.mini-player{position:fixed;bottom:20px;left:20px;z-index:160;display:none;align-items:center;gap:10px;background:var(--bg2);border:1px solid var(--border2);border-radius:50px;padding:8px 16px 8px 8px;box-shadow:0 8px 28px rgba(0,0,0,0.35);cursor:pointer;animation:cardFadeIn .3s ease both;}
.mini-player.show{display:flex;}
.mini-player-icon{width:34px;height:34px;border-radius:50%;background:var(--bg3);display:flex;align-items:center;justify-content:center;font-size:15px;overflow:hidden;flex-shrink:0;}
.mini-player-icon img{width:100%;height:100%;object-fit:cover;}
.mini-player-name{font-size:12px;font-weight:600;max-width:120px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.mini-player-dot{width:6px;height:6px;border-radius:50%;background:var(--green);animation:pulse 1.5s ease-in-out infinite;flex-shrink:0;}
.np-mini-btn{background:var(--bg3);border:none;width:30px;height:30px;border-radius:8px;color:var(--muted);cursor:pointer;flex-shrink:0;font-size:13px;}
.np-mini-btn:hover{color:var(--text);}
nav{position:sticky;top:0;z-index:100;display:flex;align-items:center;justify-content:space-between;padding:0 2rem;height:60px;background:rgba(11,13,16,0.9);backdrop-filter:blur(16px);border-bottom:1px solid var(--border);}
.logo{font-size:20px;font-weight:700;}
.logo span{color:var(--accent);}
.nav-actions{display:flex;gap:10px;align-items:center;}
.btn-admin{background:var(--accent);color:#0b0d10;border:none;border-radius:8px;padding:7px 16px;font-family:inherit;font-size:13px;font-weight:700;cursor:pointer;text-decoration:none;display:inline-block;}
.btn-admin:hover{background:var(--accent2);}
.tick{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;font-size:9px;flex-shrink:0;}
.tick-sub{background:var(--blue);color:#fff;}.tick-vip{background:var(--gold);color:#3a2e00;}.tick-owner{background:var(--gray);color:#1a1d22;}
.btn-account{background:var(--bg2);border:1px solid var(--border);color:var(--text);border-radius:20px;padding:7px 14px;font-family:inherit;font-size:13px;cursor:pointer;display:inline-flex;align-items:center;gap:7px;}
.btn-account:hover{border-color:var(--border2);}
.account-role-label{font-size:9px;font-weight:700;padding:1px 6px;border-radius:8px;background:rgba(154,163,178,0.18);color:var(--gray);}
.modal-overlay{display:none;position:fixed;inset:0;z-index:200;background:rgba(0,0,0,0.85);align-items:center;justify-content:center;padding:1rem;}
.modal-overlay.open{display:flex;}
.modal{background:var(--bg2);border:1px solid var(--border2);border-radius:20px;width:100%;max-width:440px;max-height:90vh;overflow-y:auto;}
.modal-header{position:sticky;top:0;background:var(--bg2);display:flex;align-items:center;justify-content:space-between;padding:1rem 1.25rem;border-bottom:1px solid var(--border);}
.modal-title{font-size:15px;font-weight:500;}
.modal-close{background:var(--bg3);border:none;width:32px;height:32px;border-radius:8px;color:var(--muted);cursor:pointer;font-size:18px;}
.auth-modal-body{padding:1.25rem;}
.auth-tabs{display:flex;gap:4px;background:var(--bg3);border-radius:10px;padding:4px;margin-bottom:1.1rem;}
.auth-tab{flex:1;padding:8px;border:none;border-radius:7px;background:transparent;color:var(--muted);font-family:inherit;font-size:13px;cursor:pointer;}
.auth-tab.active{background:var(--bg2);color:var(--text);font-weight:700;}
.auth-field{margin-bottom:12px;display:flex;flex-direction:column;gap:6px;}
.auth-field label{font-size:12px;color:var(--muted);}
.auth-field input{background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:10px 12px;color:var(--text);font-family:inherit;font-size:14px;outline:none;}
.auth-error{color:var(--red);font-size:12.5px;min-height:18px;margin-bottom:8px;}
.btn-auth-submit{width:100%;background:var(--accent);color:#0b0d10;border:none;border-radius:8px;padding:11px;font-family:inherit;font-size:14px;font-weight:700;cursor:pointer;}
.btn-auth-submit:hover{background:var(--accent2);}
.up-section{border-top:1px solid var(--border);padding-top:14px;margin-top:14px;}
.up-section:first-child{border-top:none;padding-top:0;margin-top:0;}
.up-title{font-size:13px;font-weight:700;margin-bottom:10px;}
.payment-card{background:var(--bg3);border:1px solid var(--border);border-radius:12px;padding:1rem;}
.payment-address{font-family:monospace;font-size:12px;color:var(--text);word-break:break-all;background:var(--bg);border-radius:6px;padding:8px 10px;margin:8px 0;cursor:pointer;border:1px solid var(--border);}
.trust-code-wrap{display:flex;gap:8px;}
.trust-code-wrap input{flex:1;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:9px 12px;color:var(--text);font-family:monospace;font-size:13px;outline:none;}
.btn-sm{padding:7px 14px;font-size:13px;background:var(--bg3);border:1px solid var(--border);color:var(--text);border-radius:8px;cursor:pointer;font-family:inherit;}
.access-gate{position:absolute;inset:0;background:rgba(11,13,16,0.88);backdrop-filter:blur(4px);border-radius:var(--card-radius);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;z-index:3;}
.access-gate-icon{font-size:28px;}
.access-gate-text{font-size:13px;color:var(--muted);text-align:center;padding:0 16px;}
.access-gate-btn{background:var(--accent);color:#0b0d10;border:none;border-radius:8px;padding:8px 18px;font-family:inherit;font-size:13px;font-weight:700;cursor:pointer;margin-top:4px;}
.access-gate-btn.blue{background:var(--blue);color:#fff;}
.hero{padding:4rem 2rem 2rem;max-width:960px;margin:0 auto;}
.hero h1{font-size:clamp(28px,5vw,46px);font-weight:700;line-height:1.2;margin-bottom:12px;}
.hero h1 em{color:var(--accent);font-style:normal;}
.hero p{color:var(--muted);font-size:15px;font-weight:300;}
.controls{max-width:960px;margin:2rem auto 0.75rem;padding:0 2rem;display:flex;gap:10px;flex-wrap:wrap;}
.search-wrap{flex:1;min-width:200px;}
.search-wrap input{width:100%;background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:10px 14px;color:var(--text);font-family:inherit;font-size:14px;outline:none;}
.genre-bar{max-width:960px;margin:0.75rem auto 1.25rem;padding:0 2rem;display:flex;gap:8px;flex-wrap:wrap;}
.genre-chip{display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border-radius:20px;border:1px solid var(--border);background:var(--bg2);color:var(--muted);font-family:inherit;font-size:13px;cursor:pointer;}
.genre-chip.active{font-weight:700;color:#0b0d10;border-color:transparent;}
.grid{max-width:960px;margin:0 auto;padding:0 2rem 4rem;display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:14px;}
.card{background:var(--bg2);border:1px solid var(--border);border-radius:var(--card-radius);padding:1.25rem;cursor:pointer;transition:border-color 0.2s,transform 0.15s;position:relative;overflow:hidden;}
.card:hover{border-color:var(--border2);transform:translateY(-2px);}
.card.vip-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,var(--gold),transparent);}
.card.sub-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,var(--blue),transparent);}
.card-header{display:flex;align-items:center;gap:12px;margin-bottom:10px;}
.ch-icon{width:44px;height:44px;border-radius:10px;background:var(--bg3);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;}
.ch-info{flex:1;min-width:0;}
.ch-name{font-size:15px;font-weight:500;margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.status-badge{font-size:11px;padding:3px 8px;border-radius:20px;font-weight:500;display:flex;align-items:center;gap:4px;flex-shrink:0;}
.status-live{background:rgba(61,220,132,0.12);color:var(--green);}
.status-error{background:rgba(255,77,77,0.12);color:var(--red);}
.status-dot{width:5px;height:5px;border-radius:50%;background:currentColor;}
.ch-meta{display:flex;align-items:center;gap:8px;margin-bottom:12px;flex-wrap:wrap;}
.ch-genre{font-size:11px;padding:2px 8px;border-radius:10px;font-weight:500;}
.ch-nowplaying{font-size:11px;color:var(--accent);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;}
.card-actions{display:flex;gap:8px;align-items:center;}
.btn-play{flex:1;background:var(--accent);color:#0b0d10;border:none;border-radius:8px;padding:9px;font-family:inherit;font-size:13px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px;}
.btn-play:hover{background:var(--accent2);}
.fav-star-btn{background:transparent;border:none;color:var(--muted);cursor:pointer;font-size:17px;line-height:1;padding:2px;}
.fav-star-btn.active{color:var(--accent);}
.now-playing-bar{position:fixed;bottom:0;right:0;left:0;z-index:150;background:var(--bg2);border-top:1px solid var(--border2);padding:12px 2rem;display:none;align-items:center;gap:16px;}
.now-playing-bar.show{display:flex;}
.np-info{display:flex;align-items:center;gap:10px;flex:1;min-width:0;}
.np-icon{width:36px;height:36px;border-radius:8px;background:var(--bg3);display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0;overflow:hidden;}
.np-icon img{width:100%;height:100%;object-fit:cover;border-radius:8px;}
.np-name{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.np-artist{font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px;}
.np-track{font-size:11px;color:var(--accent);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:260px;}
.np-live-dot{width:6px;height:6px;border-radius:50%;background:var(--green);animation:pulse 1.5s ease-in-out infinite;flex-shrink:0;}
@keyframes pulse{0%,100%{opacity:1;}50%{opacity:0.3;}}
.np-close{background:var(--bg3);border:none;width:30px;height:30px;border-radius:8px;color:var(--muted);cursor:pointer;flex-shrink:0;}
.np-controls{display:flex;align-items:center;gap:10px;flex-shrink:0;}
.np-vol-wrap{display:flex;align-items:center;gap:6px;}
.np-mute-btn{background:var(--bg3);border:none;width:30px;height:30px;border-radius:8px;color:var(--text2);cursor:pointer;font-size:14px;flex-shrink:0;display:flex;align-items:center;justify-content:center;}
.np-mute-btn:hover{color:var(--text);}
.np-vol-slider{width:80px;accent-color:var(--accent);cursor:pointer;}
.np-sleep-wrap{position:relative;}
.np-sleep-btn{background:var(--bg3);border:none;border-radius:8px;padding:6px 10px;color:var(--text2);cursor:pointer;font-size:12px;display:flex;align-items:center;gap:5px;white-space:nowrap;}
.np-sleep-btn:hover{color:var(--text);}
.np-sleep-btn.active{color:var(--accent);background:rgba(255,159,67,0.12);}
.np-sleep-menu{display:none;position:absolute;bottom:calc(100% + 8px);left:0;background:var(--bg3);border:1px solid var(--border2);border-radius:10px;padding:6px;min-width:140px;box-shadow:0 8px 24px rgba(0,0,0,0.4);}
.np-sleep-menu.open{display:block;}
.np-sleep-opt{padding:8px 10px;font-size:12.5px;color:var(--text2);cursor:pointer;border-radius:6px;white-space:nowrap;}
.np-sleep-opt:hover{background:var(--bg2);color:var(--text);}
.np-sleep-opt.selected{color:var(--accent);font-weight:700;}
.resume-banner{max-width:960px;margin:0 auto;padding:0 2rem;}
.resume-banner-inner{display:flex;align-items:center;gap:12px;background:var(--bg2);border:1px solid var(--border2);border-radius:14px;padding:12px 16px;margin-bottom:0.5rem;}
.resume-banner-icon{width:38px;height:38px;border-radius:10px;background:var(--bg3);display:flex;align-items:center;justify-content:center;font-size:17px;flex-shrink:0;}
.resume-banner-text{flex:1;min-width:0;font-size:12.5px;color:var(--text2);}
.resume-banner-text strong{color:var(--text);}
.resume-banner-btn{background:var(--accent);color:#0b0d10;border:none;border-radius:8px;padding:7px 14px;font-family:inherit;font-size:12.5px;font-weight:700;cursor:pointer;flex-shrink:0;}
.resume-banner-close{background:transparent;border:none;color:var(--muted);cursor:pointer;font-size:15px;flex-shrink:0;}
.toast{position:fixed;bottom:90px;left:50%;transform:translateX(-50%) translateY(80px);background:var(--text);color:var(--bg);border-radius:10px;padding:10px 20px;font-size:13px;font-weight:500;z-index:999;transition:transform 0.3s ease;pointer-events:none;}
.toast.show{transform:translateX(-50%) translateY(0);}
.empty{grid-column:1/-1;text-align:center;padding:4rem 0;color:var(--muted);font-size:14px;}
.engagement-row{display:flex;align-items:center;gap:10px;margin-top:8px;padding-top:8px;border-top:1px solid var(--border);flex-wrap:wrap;}
.eng-btn{background:transparent;border:none;color:var(--muted);cursor:pointer;font-size:12px;display:flex;align-items:center;gap:4px;padding:3px 6px;border-radius:6px;}
.eng-btn:hover{background:var(--bg3);}
.eng-btn.active-like{color:var(--green);}
.eng-btn.active-dislike{color:var(--red);}
.eng-rating{font-size:11px;color:var(--gold);display:flex;align-items:center;gap:3px;}
.popular-toggle{display:inline-flex;align-items:center;gap:6px;padding:9px 16px;border-radius:10px;border:1px solid var(--border);background:var(--bg2);color:var(--text2);font-family:inherit;font-size:13px;cursor:pointer;}
.popular-toggle.active{background:linear-gradient(90deg,var(--accent),var(--accent2));color:#0b0d10;font-weight:700;border-color:transparent;}
.popular-rank{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:6px;background:var(--bg3);font-size:11px;font-weight:700;color:var(--accent);flex-shrink:0;}
.comments-modal-body{padding:0;}
.comments-list-wrap{max-height:280px;overflow-y:auto;padding:0 1.25rem;}
.comment-item{padding:10px 0;border-bottom:1px solid var(--border);}
.comment-item:last-child{border-bottom:none;}
.comment-head{display:flex;align-items:center;gap:8px;margin-bottom:4px;}
.comment-user{font-size:12.5px;font-weight:700;color:var(--accent);}
.comment-time{font-size:10.5px;color:var(--muted);margin-right:auto;}
.comment-text{font-size:13px;color:var(--text);line-height:1.7;word-break:break-word;}
.comment-del{background:transparent;border:none;color:var(--red);font-size:11px;cursor:pointer;}
.stars-input{display:flex;gap:4px;justify-content:center;padding:1rem 1.25rem 0.5rem;font-size:26px;}
.star-opt{cursor:pointer;color:var(--border2);transition:color .15s;}
.star-opt.filled{color:var(--gold);}
.rating-summary-line{text-align:center;font-size:12.5px;color:var(--muted);padding:0 1.25rem 0.75rem;}
.comment-compose{padding:1rem 1.25rem;border-top:1px solid var(--border);display:flex;gap:8px;}
.comment-compose input{flex:1;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:9px 12px;color:var(--text);font-family:inherit;font-size:13px;outline:none;}
@media(max-width:600px){.hero,.controls,.genre-bar,.grid,.resume-banner{padding-right:1rem;padding-left:1rem;}nav{padding:0 1rem;}.now-playing-bar{padding:12px 1rem;flex-wrap:wrap;}.np-vol-wrap{display:none;}}
</style>
</head>
<body>

<nav>
  <div class="logo">Radio<span>Fa</span></div>
  <div class="nav-actions">
    <button class="theme-toggle-btn" id="theme-toggle-btn" onclick="toggleFrontendTheme()" title="تغییر تم روشن/تیره">🌓</button>
    <button class="btn-account" id="btn-account-guest" onclick="openAuthModal('login')">ورود / ثبت‌نام</button>
    <button class="btn-account" id="btn-account-user" style="display:none;" onclick="openUserPanel()">
      <span id="account-username"></span><span id="account-tick"></span>
      <span id="account-role-label" style="display:none;" class="account-role-label"></span>
    </button>
    <a href="/admin" class="btn-admin" id="btn-admin-link" style="display:none;">پنل مدیریت</a>
  </div>
</nav>

<div class="modal-overlay" id="auth-modal" onclick="closeAuthModal(event)">
  <div class="modal">
    <div class="modal-header"><span class="modal-title" id="auth-modal-title">ورود به حساب کاربری</span><button class="modal-close" onclick="closeAuthModal(null)">✕</button></div>
    <div class="auth-modal-body">
      <div class="auth-tabs"><button class="auth-tab active" id="auth-tab-login" onclick="switchAuthTab('login')">ورود</button><button class="auth-tab" id="auth-tab-signup" onclick="switchAuthTab('signup')">ثبت‌نام</button></div>
      <div class="auth-field"><label>نام کاربری</label><input type="text" id="auth-username"></div>
      <div class="auth-field"><label>رمز عبور</label><input type="password" id="auth-password"></div>
      <div id="turnstile-widget-wrap" style="display:none;margin-bottom:12px;"><div id="turnstile-widget"></div></div>
      <div class="auth-error" id="auth-error"></div>
      <button class="btn-auth-submit" id="auth-submit-btn" onclick="submitAuth()">ورود</button>
    </div>
  </div>
</div>

<div class="modal-overlay" id="user-panel-modal" onclick="closeUserPanel(event)">
  <div class="modal">
    <div class="modal-header"><span class="modal-title">پنل کاربری</span><button class="modal-close" onclick="closeUserPanel(null)">✕</button></div>
    <div class="auth-modal-body">
      <div class="up-section">
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <div><div style="font-size:15px;font-weight:700;display:flex;align-items:center;gap:6px;" id="up-username-display"></div><div id="up-tier-badge" style="margin-top:5px;"></div></div>
          <button class="btn-sm" onclick="logoutUser()">خروج</button>
        </div>
      </div>
      <div class="up-section" id="up-sub-section">
        <div class="up-title">💳 خرید اشتراک</div>
        <div class="payment-card" id="payment-card-content">در حال بارگذاری...</div>
      </div>
      <div class="up-section" id="up-vip-section">
        <div class="up-title">🌟 فعال‌سازی VIP</div>
        <div class="trust-code-wrap"><input type="text" id="trust-code-input" placeholder="کد اعتماد..."><button class="btn-sm" onclick="submitTrustCode()">تأیید</button></div>
        <div class="auth-error" id="trust-code-error"></div>
      </div>
      <div class="up-section">
        <div class="up-title">⭐ ایستگاه‌های مورد علاقه</div>
        <div id="up-favorites-list"></div>
      </div>
      <div class="up-section">
        <div class="up-title">🔒 تغییر رمز عبور</div>
        <div class="auth-field"><label>رمز فعلی</label><input type="password" id="cp-current"></div>
        <div class="auth-field"><label>رمز جدید</label><input type="password" id="cp-new"></div>
        <div class="auth-error" id="cp-error"></div>
        <button class="btn-auth-submit" onclick="submitChangePassword()">تغییر رمز</button>
      </div>
      <div class="up-section">
        <div class="up-title">🛡️ امنیت حساب</div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:10px;line-height:1.7;">اگه حس می‌کنی حساب کاربریت روی دستگاه دیگه‌ای هم بازه، با این دکمه از همه‌ی دستگاه‌ها (از جمله همین دستگاه) خارج می‌شی و باید دوباره وارد شی.</div>
        <button class="btn-sm" style="border-color:rgba(255,77,77,0.35);color:var(--red);" onclick="logoutAllDevices()">🚪 خروج از همه دستگاه‌ها</button>
        <div style="margin-top:14px;">
          <div style="font-size:12px;color:var(--muted);margin-bottom:8px;">دستگاه‌های فعال (ورودهای اخیر):</div>
          <div id="up-sessions-list" style="font-size:12px;color:var(--muted);">در حال بارگذاری...</div>
        </div>
      </div>
    </div>
  </div>
</div>

<div class="hero"><h1>رادیو<br><em>بدون مرز</em></h1><p>ایستگاه مورد نظرت رو انتخاب کن و مستقیم گوش کن</p></div>

<div class="resume-banner" id="resume-banner" style="display:none;">
  <div class="resume-banner-inner">
    <div class="resume-banner-icon" id="resume-icon">📻</div>
    <div class="resume-banner-text">آخرین بار در حال گوش دادن به <strong id="resume-name"></strong> بودی</div>
    <button class="resume-banner-btn" onclick="resumeLastStation()">▶ ادامه پخش</button>
    <button class="resume-banner-close" onclick="dismissResumeBanner()">✕</button>
  </div>
</div>

<div class="controls"><div class="search-wrap"><input type="text" id="search" placeholder="جستجوی ایستگاه..." oninput="renderCards()"></div><button class="popular-toggle" id="popular-toggle-btn" onclick="togglePopularView()">🔥 محبوب‌ترین‌ها</button></div>
<div class="genre-bar" id="genre-bar"></div>
<div class="grid" id="grid"></div>

<div class="now-playing-bar" id="now-playing-bar">
  <audio id="audio-player" preload="none"></audio>
  <div class="np-info"><div class="np-icon" id="np-icon">📻</div><div><div class="np-name" id="np-name"></div><div style="display:flex;align-items:center;gap:5px;font-size:11px;color:var(--muted);" id="np-live-row"><span class="np-live-dot"></span> در حال پخش زنده</div><div class="np-artist" id="np-artist" style="display:none;"></div><div class="np-track" id="np-track" style="display:none;"></div></div></div>
  <div class="np-controls">
    <button class="np-sleep-btn" id="np-shuffle-btn" style="display:none;" onclick="toggleShuffle()">🔀 <span id="np-shuffle-label">پخش پشت‌سرهم</span></button>
    <button class="np-mute-btn" id="np-next-btn" style="display:none;" onclick="playNextTrack()" title="آهنگ بعدی">⏭</button>
    <button class="np-sleep-btn" id="np-identify-btn" style="display:none;" onclick="identifySong()" title="شناسایی آهنگ در حال پخش">🎙️ <span id="np-identify-label">شناسایی آهنگ</span></button>
    <div class="np-vol-wrap">
      <button class="np-mute-btn" id="np-mute-btn" onclick="toggleMute()">🔊</button>
      <input type="range" class="np-vol-slider" id="np-vol-slider" min="0" max="100" value="100" oninput="onVolumeChange(this.value)">
    </div>
    <div class="np-sleep-wrap">
      <button class="np-sleep-btn" id="np-sleep-btn" onclick="toggleSleepMenu()">⏰ <span id="np-sleep-label">تایمر خواب</span></button>
      <div class="np-sleep-menu" id="np-sleep-menu">
        <div class="np-sleep-opt" onclick="setSleepTimer(0)">خاموش</div>
        <div class="np-sleep-opt" onclick="setSleepTimer(15)">۱۵ دقیقه</div>
        <div class="np-sleep-opt" onclick="setSleepTimer(30)">۳۰ دقیقه</div>
        <div class="np-sleep-opt" onclick="setSleepTimer(45)">۴۵ دقیقه</div>
        <div class="np-sleep-opt" onclick="setSleepTimer(60)">۶۰ دقیقه</div>
      </div>
    </div>
  </div>
  <button class="np-mini-btn" onclick="enterMiniPlayer()" title="حالت مینی">🗕</button>
  <button class="np-close" onclick="stopPlayback()">✕</button>
</div>

<div class="modal-overlay" id="comments-modal" onclick="closeCommentsModal(event)">
  <div class="modal">
    <div class="modal-header"><span class="modal-title">💬 نظرات و امتیاز — <span id="comments-station-name"></span></span><button class="modal-close" onclick="closeCommentsModal(null)">✕</button></div>
    <div class="comments-modal-body">
      <div class="stars-input" id="stars-input"></div>
      <div class="rating-summary-line" id="rating-summary-line">در حال بارگذاری...</div>
      <div class="comments-list-wrap" id="comments-list-wrap"><div style="text-align:center;padding:1.5rem 0;color:var(--muted);font-size:12.5px;">در حال بارگذاری...</div></div>
      <div class="comment-compose" id="comment-compose">
        <input type="text" id="comment-input" placeholder="نظرت رو بنویس..." maxlength="500" onkeydown="if(event.key==='Enter')submitComment()">
        <button class="btn-sm" onclick="submitComment()">ارسال</button>
      </div>
    </div>
  </div>
</div>


<div class="mini-player" id="mini-player" onclick="exitMiniPlayer()">
  <div class="mini-player-icon" id="mini-player-icon">📻</div>
  <div><div class="mini-player-name" id="mini-player-name"></div><div style="display:flex;align-items:center;gap:4px;"><span class="mini-player-dot"></span><span style="font-size:10px;color:var(--muted);">در حال پخش</span></div></div>
</div>
<div class="toast" id="toast"></div>

<div class="modal-overlay" id="identify-modal" onclick="closeIdentifyModal(event)">
  <div class="modal">
    <div class="modal-header"><span class="modal-title">🎙️ شناسایی آهنگ</span><button class="modal-close" onclick="closeIdentifyModal(null)">✕</button></div>
    <div class="auth-modal-body" id="identify-modal-body" style="text-align:center;">
      <div style="padding:2rem 0;color:var(--muted);font-size:13px;">در حال گوش دادن و شناسایی...</div>
    </div>
  </div>
</div>

<script>
const WORKER_BASE = '${workerOrigin}';
const stations = ${JSON.stringify(stationsData)};
const genres = ${JSON.stringify(genresData)};
let currentUser = null;
let activeGenre = '__all__';
let activeStation = null;
let hlsInstance = null;
const listenedStations = new Set();
let userReactions = {};
let popularView = false;
let popularData = [];
let commentsStationId = null;
let commentsUserRating = 0;

// ── حالت پلی‌لیست (پخش پشت‌سرهم/شافل آهنگ‌های شخصی) ──
let playlistTracks = [];
let playlistIndex = -1;
let shuffleOn = localStorage.getItem('radiofa_shuffle')==='1';

// ── تایمر خواب ──
let sleepTimerId = null;
let sleepEndsAt = null;
let sleepCountdownId = null;

// ── تشخیص خودکار آهنگ در حال پخش (ICY) ──
let nowPlayingPollId = null;
let nowPlayingStationId = null;

function escHtml(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
const COUNTRY_NAMES_JS = ${JSON.stringify(Object.fromEntries(COUNTRIES.map(c => [c.code, c.name])))};
function countryFlagJs(code){
  if(!code||code==='INTL')return'🌐';
  const cc=String(code).toUpperCase();
  if(cc.length!==2)return'🌐';
  const base=127397;
  try{return String.fromCodePoint(...[...cc].map(c=>c.charCodeAt(0)+base));}catch(e){return'🌐';}
}
function countryNameJs(code){return COUNTRY_NAMES_JS[code]||'';}
function showToast(msg){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove('show'),2500);}
function streamUrl(st){return (st.type==='hls')?(WORKER_BASE+'/'+st.id+'/master.m3u8'):(WORKER_BASE+'/'+st.id);}
function trackUrl(trackId){return WORKER_BASE+'/api/tracks/'+trackId;}

async function recordListen(stationId){
  if(listenedStations.has(stationId))return;
  listenedStations.add(stationId);
  try{ await fetch(WORKER_BASE+'/api/stats/listen',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({stationId})}); }catch(e){}
}

function statusLabel(s){return s==='live'?{cls:'status-live',text:'زنده'}:{cls:'status-error',text:'خطا'};}
function tierTickHtml(u){if(!u)return'';if(u.role==='owner')return'<span class="tick tick-owner">✓</span>';if(u.tier==='vip')return'<span class="tick tick-vip">✓</span>';if(u.tier==='sub')return'<span class="tick tick-sub">✓</span>';return'';}
function tierLabel(u){if(!u)return'';if(u.role==='owner')return'⚙️ ادمین';if(u.tier==='vip')return'🌟 VIP';if(u.tier==='sub')return'✅ اشتراک فعال';return'بدون اشتراک';}

function renderGenreBar(){
  const bar=document.getElementById('genre-bar');
  if(!genres.length){bar.style.display='none';return;}
  bar.style.display='flex';
  bar.innerHTML='<button class="genre-chip'+(activeGenre==='__all__'?' active':'')+'" style="'+(activeGenre==='__all__'?'background:var(--accent)':'')+'" onclick="setGenre(\\'__all__\\')">همه</button>'
    +genres.map(g=>'<button class="genre-chip'+(activeGenre===g.id?' active':'')+'" style="'+(activeGenre===g.id?'background:'+g.color+';color:#0b0d10':'')+'" onclick="setGenre(\\''+g.id+'\\')">'+escHtml(g.icon)+' '+escHtml(g.name)+'</button>').join('');
}
function setGenre(g){activeGenre=g;renderGenreBar();renderCards();}

function cardHtml(st){
  const s=statusLabel(st.status);
  const genre=genres.find(g=>g.id===st.genre);
  const genreBadge=genre?'<span class="ch-genre" style="background:'+genre.color+'22;color:'+genre.color+'">'+genre.icon+' '+genre.name+'</span>':'';
  const isFav=currentUser&&(currentUser.favorites||[]).includes(st.id);
  const favBtn=currentUser?'<button class="fav-star-btn'+(isFav?' active':'')+'" onclick="event.stopPropagation();toggleFavorite(\\''+st.id+'\\')">'+(isFav?'★':'☆')+'</button>':'';
  const access=st.access||'public';
  let gate='';
  if(!currentUser&&access!=='public') gate='<div class="access-gate"><div class="access-gate-icon">🔒</div><div class="access-gate-text">برای گوش دادن ابتدا وارد شوید</div><button class="access-gate-btn" onclick="event.stopPropagation();openAuthModal(\\'login\\')">ورود</button></div>';
  else if(currentUser&&access==='sub'&&currentUser.tier==='none'&&currentUser.role!=='owner') gate='<div class="access-gate"><div class="access-gate-icon">💳</div><div class="access-gate-text">این ایستگاه نیاز به اشتراک دارد</div><button class="access-gate-btn blue" onclick="event.stopPropagation();openUserPanel()">خرید اشتراک</button></div>';
  else if(currentUser&&access==='vip'&&currentUser.tier!=='vip'&&currentUser.role!=='owner') gate='<div class="access-gate"><div class="access-gate-icon">🌟</div><div class="access-gate-text">این ایستگاه فقط برای VIP است</div><button class="access-gate-btn blue" onclick="event.stopPropagation();openUserPanel()">فعال‌سازی VIP</button></div>';
  const cardClass=access==='vip'?'card vip-card':(access==='sub'?'card sub-card':'card');
  const trackCount=st.type==='playlist'?(st.tracks||[]).length:0;
  const npText=st.type==='playlist'?(trackCount?trackCount+' آهنگ':'هنوز آهنگی آپلود نشده'):st.nowPlaying;
  const npHtml=npText?'<div class="ch-nowplaying">🎧 '+escHtml(npText)+'</div>':'';
  const eng=st.engagement||{likes:0,dislikes:0,ratingAvg:0,ratingCount:0,commentCount:0};
  const userChoice=(userReactions[st.id]||null);
  const engRow='<div class="engagement-row">'+
    '<button class="eng-btn'+(userChoice==='like'?' active-like':'')+'" onclick="event.stopPropagation();toggleReaction(\\''+st.id+'\\',\\'like\\')">👍 <span id="like-count-'+st.id+'">'+(eng.likes||0)+'</span></button>'+
    '<button class="eng-btn'+(userChoice==='dislike'?' active-dislike':'')+'" onclick="event.stopPropagation();toggleReaction(\\''+st.id+'\\',\\'dislike\\')">👎 <span id="dislike-count-'+st.id+'">'+(eng.dislikes||0)+'</span></button>'+
    '<span class="eng-rating">⭐ '+(eng.ratingAvg||0)+' <span style="color:var(--muted);">('+(eng.ratingCount||0)+')</span></span>'+
    '<button class="eng-btn" onclick="event.stopPropagation();openCommentsModal(\\''+st.id+'\\',\\''+escHtml(st.name).replace(/'/g,"\\\\'")+'\\')">💬 '+(eng.commentCount||0)+'</button>'+
  '</div>';
  return '<div class="'+cardClass+'" onclick="playStation(\\''+st.id+'\\')">'+gate+
    '<div class="card-header"><div class="ch-icon">'+(st.icon||'📻')+'</div><div class="ch-info"><div class="ch-name">'+(st.country?'<span title="'+escHtml(countryNameJs(st.country))+'">'+countryFlagJs(st.country)+'</span> ':'')+escHtml(st.name)+'</div></div>'+favBtn+
    '<div class="status-badge '+s.cls+'"><div class="status-dot"></div>'+s.text+'</div></div>'+
    (genreBadge||npHtml?'<div class="ch-meta">'+genreBadge+npHtml+'</div>':'')+
    '<div class="card-actions"><button class="btn-play" onclick="event.stopPropagation();playStation(\\''+st.id+'\\')">▶ پخش</button></div>'+engRow+'</div>';
}
function renderCards(){
  const grid=document.getElementById('grid');
  if(popularView){renderPopularList();return;}
  const q=(document.getElementById('search').value||'').trim().toLowerCase();
  const list=stations.filter(st=>{
    const mq=!q||st.name.toLowerCase().includes(q);
    const mg=activeGenre==='__all__'||st.genre===activeGenre;
    return mq&&mg;
  });
  if(!list.length){grid.innerHTML='<div class="empty">ایستگاهی یافت نشد</div>';return;}
  grid.innerHTML=list.map(cardHtml).join('');
}

async function togglePopularView(){
  popularView=!popularView;
  const btn=document.getElementById('popular-toggle-btn');
  btn.classList.toggle('active',popularView);
  const grid=document.getElementById('grid');
  if(popularView){
    grid.innerHTML='<div class="empty">در حال بارگذاری محبوب‌ترین‌ها...</div>';
    try{
      const res=await fetch(WORKER_BASE+'/api/popular',{credentials:'include'});
      popularData=await res.json();
    }catch(e){popularData=[];}
  }
  renderCards();
}
function renderPopularList(){
  const grid=document.getElementById('grid');
  if(!popularData||!popularData.length){grid.innerHTML='<div class="empty">هنوز داده‌ای برای محبوب‌ترین‌ها نیست</div>';return;}
  grid.innerHTML=popularData.map((p,i)=>{
    const st=stations.find(s=>s.id===p.id)||{};
    const userChoice=userReactions[p.id]||null;
    return '<div class="card" onclick="playStation(\\''+p.id+'\\')">'+
      '<div class="card-header"><span class="popular-rank">#'+(i+1)+'</span><div class="ch-icon">'+(p.icon||'📻')+'</div><div class="ch-info"><div class="ch-name">'+escHtml(p.name)+'</div></div></div>'+
      '<div class="ch-meta"><span class="ch-nowplaying">🎧 '+(p.listens?p.listens.total:0)+' بار شنیده شده</span></div>'+
      '<div class="card-actions"><button class="btn-play" onclick="event.stopPropagation();playStation(\\''+p.id+'\\')">▶ پخش</button></div>'+
      '<div class="engagement-row">'+
        '<button class="eng-btn'+(userChoice==='like'?' active-like':'')+'" onclick="event.stopPropagation();toggleReaction(\\''+p.id+'\\',\\'like\\')">👍 <span id="like-count-'+p.id+'">'+(p.likes||0)+'</span></button>'+
        '<button class="eng-btn'+(userChoice==='dislike'?' active-dislike':'')+'" onclick="event.stopPropagation();toggleReaction(\\''+p.id+'\\',\\'dislike\\')">👎 <span id="dislike-count-'+p.id+'">'+(p.dislikes||0)+'</span></button>'+
        '<span class="eng-rating">⭐ '+(p.ratingAvg||0)+' <span style="color:var(--muted);">('+(p.ratingCount||0)+')</span></span>'+
        '<button class="eng-btn" onclick="event.stopPropagation();openCommentsModal(\\''+p.id+'\\',\\''+escHtml(p.name).replace(/'/g,"\\\\'")+'\\')">💬 '+(p.commentCount||0)+'</button>'+
      '</div></div>';
  }).join('');
}

// ── لایک/دیسلایک ──
async function toggleReaction(stationId,choice){
  if(!currentUser){showToast('برای لایک/دیسلایک باید وارد شوید 🔒');openAuthModal('login');return;}
  const current=userReactions[stationId]||null;
  const next=current===choice?'none':choice;
  try{
    const res=await fetch(WORKER_BASE+'/api/reactions/'+stationId,{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({choice:next})});
    const data=await res.json();
    if(!res.ok){showToast(data.error||'خطا ❌');return;}
    userReactions[stationId]=data.userChoice;
    const likeEl=document.getElementById('like-count-'+stationId);
    const dislikeEl=document.getElementById('dislike-count-'+stationId);
    if(likeEl)likeEl.textContent=data.likes;
    if(dislikeEl)dislikeEl.textContent=data.dislikes;
    renderCards();
  }catch(e){showToast('خطا در ارتباط با سرور ❌');}
}
async function loadMyReaction(stationId){
  try{
    const res=await fetch(WORKER_BASE+'/api/reactions/'+stationId,{credentials:'include'});
    const data=await res.json();
    if(data.userChoice)userReactions[stationId]=data.userChoice;
  }catch(e){}
}

// ── نظرات و امتیازدهی ──
function openCommentsModal(stationId,name){
  commentsStationId=stationId;commentsUserRating=0;
  document.getElementById('comments-station-name').textContent=name||'';
  document.getElementById('comments-modal').classList.add('open');
  document.getElementById('comment-input').value='';
  loadCommentsAndRating();
}
function closeCommentsModal(e){if(e&&e.target!==document.getElementById('comments-modal'))return;document.getElementById('comments-modal').classList.remove('open');commentsStationId=null;}
async function loadCommentsAndRating(){
  if(!commentsStationId)return;
  const listWrap=document.getElementById('comments-list-wrap');
  listWrap.innerHTML='<div style="text-align:center;padding:1.5rem 0;color:var(--muted);font-size:12.5px;">در حال بارگذاری...</div>';
  try{
    const [ratingRes,commentsRes]=await Promise.all([
      fetch(WORKER_BASE+'/api/ratings/'+commentsStationId,{credentials:'include'}),
      fetch(WORKER_BASE+'/api/comments/'+commentsStationId,{credentials:'include'})
    ]);
    const rating=await ratingRes.json();
    const comments=await commentsRes.json();
    commentsUserRating=rating.userRating||0;
    renderStarsInput();
    document.getElementById('rating-summary-line').textContent='میانگین امتیاز: ⭐ '+(rating.avg||0)+' از '+(rating.count||0)+' رأی';
    renderComments(comments);
  }catch(e){listWrap.innerHTML='<div style="text-align:center;padding:1.5rem 0;color:var(--red);font-size:12.5px;">خطا در بارگذاری</div>';}
}
function renderStarsInput(){
  const wrap=document.getElementById('stars-input');
  let html='';
  for(let i=1;i<=5;i++){
    html+='<span class="star-opt'+(i<=commentsUserRating?' filled':'')+'" onclick="submitRating('+i+')">★</span>';
  }
  wrap.innerHTML=html;
}
async function submitRating(stars){
  if(!currentUser){showToast('برای امتیازدهی باید وارد شوید 🔒');openAuthModal('login');return;}
  if(!commentsStationId)return;
  try{
    const res=await fetch(WORKER_BASE+'/api/ratings/'+commentsStationId,{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({stars})});
    const data=await res.json();
    if(!res.ok){showToast(data.error||'خطا ❌');return;}
    commentsUserRating=stars;renderStarsInput();
    document.getElementById('rating-summary-line').textContent='میانگین امتیاز: ⭐ '+(data.avg||0)+' از '+(data.count||0)+' رأی';
    showToast('امتیاز ثبت شد ✓');
  }catch(e){showToast('خطا در ارتباط با سرور ❌');}
}
function renderComments(list){
  const wrap=document.getElementById('comments-list-wrap');
  if(!list||!list.length){wrap.innerHTML='<div style="text-align:center;padding:1.5rem 0;color:var(--muted);font-size:12.5px;">هنوز نظری ثبت نشده</div>';return;}
  wrap.innerHTML=list.map(c=>{
    const canDelete=currentUser&&(currentUser.username.toLowerCase()===c.username.toLowerCase()||currentUser.role==='owner');
    const date=new Date(c.at).toLocaleString('fa-IR');
    return '<div class="comment-item"><div class="comment-head"><span class="comment-user">'+escHtml(c.username)+'</span><span class="comment-time">'+date+'</span>'+(canDelete?'<button class="comment-del" onclick="deleteComment(\\''+c.id+'\\')">حذف</button>':'')+'</div><div class="comment-text">'+escHtml(c.text)+'</div></div>';
  }).join('');
}
async function submitComment(){
  if(!currentUser){showToast('برای ارسال نظر باید وارد شوید 🔒');openAuthModal('login');return;}
  const input=document.getElementById('comment-input');
  const text=input.value.trim();
  if(!text||!commentsStationId)return;
  try{
    const res=await fetch(WORKER_BASE+'/api/comments/'+commentsStationId,{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})});
    const data=await res.json();
    if(!res.ok){showToast(data.error||'خطا ❌');return;}
    input.value='';
    loadCommentsAndRating();
    const st=stations.find(s=>s.id===commentsStationId);
    if(st&&st.engagement)st.engagement.commentCount=(st.engagement.commentCount||0)+1;
    renderCards();
  }catch(e){showToast('خطا در ارتباط با سرور ❌');}
}
async function deleteComment(commentId){
  if(!commentsStationId||!confirm('این نظر حذف شود؟'))return;
  try{
    const res=await fetch(WORKER_BASE+'/api/comments/'+commentsStationId+'?id='+encodeURIComponent(commentId),{method:'DELETE',credentials:'include'});
    if(res.ok){loadCommentsAndRating();showToast('حذف شد ✓');}else showToast('خطا ❌');
  }catch(e){showToast('خطا در ارتباط با سرور ❌');}
}

async function toggleFavorite(stationId){
  if(!currentUser){openAuthModal('login');return;}
  try{
    const res=await fetch(WORKER_BASE+'/api/favorites',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({stationId})});
    const data=await res.json();
    if(res.ok){currentUser.favorites=data.favorites;renderCards();if(document.getElementById('user-panel-modal').classList.contains('open'))renderFavoritesList();}
    else showToast(data.error||'خطا ❌');
  }catch(e){showToast('خطا در ارتباط با سرور ❌');}
}

function canAccessStation(st){
  const access=st.access||'public';
  if(access==='public'||currentUser?.role==='owner')return true;
  if(!currentUser)return false;
  if(access==='sub')return currentUser.tier==='sub'||currentUser.tier==='vip';
  if(access==='vip')return currentUser.tier==='vip';
  return false;
}
function playStation(id){
  const st=stations.find(s=>s.id===id);if(!st)return;
  const access=st.access||'public';
  if(!canAccessStation(st)){
    if(!currentUser){showToast('برای پخش باید وارد شوید 🔒');openAuthModal('login');return;}
    if(access==='sub'){showToast('برای پخش این ایستگاه اشتراک تهیه کنید 💳');openUserPanel();return;}
    if(access==='vip'){showToast('این ایستگاه فقط برای VIP است 🌟');openUserPanel();return;}
  }
  activeStation=st;
  recordListen(id);
  localStorage.setItem('radiofa_last_station', id);
  dismissResumeBanner();
  const audio=document.getElementById('audio-player');
  if(hlsInstance){hlsInstance.destroy();hlsInstance=null;}
  audio.onended=null;

  if(st.type==='playlist'){
    playlistTracks=(st.tracks||[]).slice();
    if(!playlistTracks.length){showToast('هنوز آهنگی برای این ایستگاه آپلود نشده 📀');return;}
    playlistIndex=shuffleOn?Math.floor(Math.random()*playlistTracks.length):0;
    playCurrentTrack();
    audio.onended=()=>playNextTrack();
  }else{
    const url=streamUrl(st);
    if(st.type==='hls'){
      if(window.Hls&&Hls.isSupported()){
        hlsInstance=new Hls({maxMaxBufferLength:20});
        hlsInstance.loadSource(url);hlsInstance.attachMedia(audio);
        hlsInstance.on(Hls.Events.MANIFEST_PARSED,()=>{audio.play().catch(()=>{});});
        hlsInstance.on(Hls.Events.ERROR,(e,data)=>{if(data.fatal)showToast('خطا در پخش HLS ❌');});
      }else if(audio.canPlayType('application/vnd.apple.mpegurl')){
        audio.src=url;audio.play().catch(()=>{showToast('خطا در پخش ❌');});
      }else{showToast('مرورگر شما از HLS پشتیبانی نمی‌کند ❌');return;}
    }else{
      audio.src=url;
      audio.play().catch(()=>{showToast('خطا در پخش ❌');});
    }
    updateNowPlayingUI(st.name, st.icon, st.nowPlaying, st.type==='playlist');
    startNowPlayingPolling(st);
  }

  document.getElementById('now-playing-bar').classList.add('show');
  applyVolumeUI();
}
function playCurrentTrack(){
  const audio=document.getElementById('audio-player');
  const track=playlistTracks[playlistIndex];
  if(!track)return;
  audio.src=trackUrl(track.id);
  audio.play().catch(()=>{showToast('خطا در پخش آهنگ ❌');});
  updateNowPlayingUI(activeStation.name, activeStation.icon, track.name, true);
}
function playNextTrack(){
  if(!playlistTracks.length)return;
  playlistIndex=shuffleOn?Math.floor(Math.random()*playlistTracks.length):(playlistIndex+1)%playlistTracks.length;
  playCurrentTrack();
}
function updateNowPlayingUI(name, icon, trackText, isPlaylist, opts){
  opts=opts||{};
  const iconEl=document.getElementById('np-icon');
  if(opts.cover){iconEl.innerHTML='<img src="'+escHtml(opts.cover)+'" alt="cover">';}
  else{iconEl.textContent=icon||'📻';}
  document.getElementById('np-name').textContent=name;
  const trackEl=document.getElementById('np-track');
  const artistEl=document.getElementById('np-artist');
  if(trackText){trackEl.textContent='🎧 '+trackText;trackEl.style.display='block';}else{trackEl.style.display='none';}
  if(opts.artist){artistEl.textContent='🎤 '+opts.artist;artistEl.style.display='block';}else{artistEl.style.display='none';}
  const shuffleBtn=document.getElementById('np-shuffle-btn');
  const nextBtn=document.getElementById('np-next-btn');
  const identifyBtn=document.getElementById('np-identify-btn');
  if(shuffleBtn)shuffleBtn.style.display=isPlaylist?'flex':'none';
  if(nextBtn)nextBtn.style.display=isPlaylist?'flex':'none';
  if(identifyBtn)identifyBtn.style.display=isPlaylist?'none':'flex';
  if(isPlaylist)updateShuffleLabel();

  if('mediaSession' in navigator){
    const artwork=opts.cover
      ? [{src:opts.cover,sizes:'512x512',type:'image/jpeg'}]
      : [{src:WORKER_BASE+'/icon.svg',sizes:'192x192',type:'image/svg+xml'},{src:WORKER_BASE+'/icon.svg',sizes:'512x512',type:'image/svg+xml'}];
    navigator.mediaSession.metadata=new MediaMetadata({
      title:trackText||name, artist:opts.artist||name, album:'RadioFa',
      artwork:artwork
    });
    navigator.mediaSession.playbackState='playing';
    const audio=document.getElementById('audio-player');
    navigator.mediaSession.setActionHandler('play',()=>{audio.play();});
    navigator.mediaSession.setActionHandler('pause',()=>{audio.pause();});
    navigator.mediaSession.setActionHandler('stop',()=>{stopPlayback();});
    navigator.mediaSession.setActionHandler('nexttrack', playlistTracks.length?()=>playNextTrack():null);
  }
}

// ── پول کردن دوره‌ای متادیتای ICY برای ایستگاه‌های مستقیم ──
function startNowPlayingPolling(station){
  stopNowPlayingPolling();
  if(!station||station.type!=='direct')return;
  nowPlayingStationId=station.id;
  const poll=async()=>{
    if(!activeStation||activeStation.id!==station.id)return;
    try{
      const res=await fetch(WORKER_BASE+'/api/nowplaying/'+station.id,{credentials:'include'});
      const data=await res.json();
      if(!activeStation||activeStation.id!==station.id)return;
      if(data&&data.title){
        updateNowPlayingUI(station.name, station.icon, data.track||data.title, false, {artist:data.artist, cover:data.cover});
      }
    }catch(e){}
  };
  poll();
  nowPlayingPollId=setInterval(poll,20000);
}
function stopNowPlayingPolling(){
  if(nowPlayingPollId){clearInterval(nowPlayingPollId);nowPlayingPollId=null;}
  nowPlayingStationId=null;
}

// ── شناسایی آهنگ (مثل Shazam) — ابتدا ضبط سمت کلاینت، در صورت شکست fallback سمت سرور ──
let identifyBusy=false;
function openIdentifyModal(loadingHtml){
  document.getElementById('identify-modal-body').innerHTML=loadingHtml||'<div style="padding:2rem 0;color:var(--muted);font-size:13px;">در حال گوش دادن و شناسایی...</div>';
  document.getElementById('identify-modal').classList.add('open');
}
function closeIdentifyModal(e){if(e&&e.target!==document.getElementById('identify-modal'))return;document.getElementById('identify-modal').classList.remove('open');}
function renderIdentifyResult(data){
  const body=document.getElementById('identify-modal-body');
  if(data.notFound){body.innerHTML='<div style="padding:1.5rem 0;color:var(--muted);font-size:13px;">😕 آهنگی شناسایی نشد. کمی بعد دوباره امتحان کن.</div>';return;}
  const cover=data.cover?'<img src="'+escHtml(data.cover)+'" style="width:140px;height:140px;border-radius:14px;object-fit:cover;margin:0 auto 14px;display:block;box-shadow:0 8px 24px rgba(0,0,0,0.4);">':'<div style="font-size:48px;margin-bottom:10px;">🎵</div>';
  const links=[data.spotifyUrl?'<a href="'+escHtml(data.spotifyUrl)+'" target="_blank" rel="noopener" class="btn-sm" style="text-decoration:none;display:inline-block;">Spotify</a>':'',
               data.appleUrl?'<a href="'+escHtml(data.appleUrl)+'" target="_blank" rel="noopener" class="btn-sm" style="text-decoration:none;display:inline-block;">Apple Music</a>':''].filter(Boolean).join(' ');
  body.innerHTML=cover+
    '<div style="font-size:16px;font-weight:700;margin-bottom:4px;">'+escHtml(data.title||'نامشخص')+'</div>'+
    '<div style="font-size:13px;color:var(--muted);margin-bottom:2px;">'+escHtml(data.artist||'')+'</div>'+
    (data.album?'<div style="font-size:11.5px;color:var(--muted);margin-bottom:12px;">'+escHtml(data.album)+'</div>':'<div style="margin-bottom:12px;"></div>')+
    (links?'<div style="display:flex;gap:8px;justify-content:center;">'+links+'</div>':'');
}
async function identifySong(){
  if(identifyBusy||!activeStation)return;
  identifyBusy=true;
  openIdentifyModal();
  const audio=document.getElementById('audio-player');
  try{
    const captured=await tryClientCapture(audio);
    let data;
    if(captured){
      const fd=new FormData();fd.append('file',captured,'clip.webm');
      const res=await fetch(WORKER_BASE+'/api/identify',{method:'POST',credentials:'include',body:fd});
      data=await res.json();
      if(!res.ok||data.error){data=await serverSideIdentify();}
    }else{
      data=await serverSideIdentify();
    }
    if(data.error){document.getElementById('identify-modal-body').innerHTML='<div style="padding:1.5rem 0;color:var(--red);font-size:13px;">❌ '+escHtml(data.error)+'</div>';}
    else renderIdentifyResult(data);
  }catch(e){
    document.getElementById('identify-modal-body').innerHTML='<div style="padding:1.5rem 0;color:var(--red);font-size:13px;">❌ خطا در شناسایی آهنگ</div>';
  }
  identifyBusy=false;
}
async function serverSideIdentify(){
  try{
    const res=await fetch(WORKER_BASE+'/api/identify',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({stationId:activeStation.id})});
    return await res.json();
  }catch(e){return {error:'خطا در ارتباط با سرور'};}
}
// ضبط ~7 ثانیه از خروجی صوتی پلیر با Web Audio API + MediaRecorder (در صورت عدم پشتیبانی مرورگر، null برمی‌گرداند)
function tryClientCapture(audioEl){
  return new Promise((resolve)=>{
    try{
      if(typeof MediaRecorder==='undefined'||!audioEl.captureStream){resolve(null);return;}
      const stream=audioEl.captureStream();
      if(!stream||!stream.getAudioTracks||!stream.getAudioTracks().length){resolve(null);return;}
      let mime='audio/webm';
      if(MediaRecorder.isTypeSupported&&!MediaRecorder.isTypeSupported(mime)){
        mime=MediaRecorder.isTypeSupported('audio/ogg')?'audio/ogg':'';
      }
      const recorder=mime?new MediaRecorder(stream,{mimeType:mime}):new MediaRecorder(stream);
      const chunks=[];
      recorder.ondataavailable=(e)=>{if(e.data&&e.data.size>0)chunks.push(e.data);};
      recorder.onstop=()=>{
        if(!chunks.length){resolve(null);return;}
        resolve(new Blob(chunks,{type:mime||'audio/webm'}));
      };
      recorder.onerror=()=>resolve(null);
      recorder.start();
      setTimeout(()=>{try{recorder.stop();}catch(e){resolve(null);}},7000);
    }catch(e){resolve(null);}
  });
}

function stopPlayback(){
  const audio=document.getElementById('audio-player');
  audio.pause();audio.src='';audio.onended=null;
  if(hlsInstance){hlsInstance.destroy();hlsInstance=null;}
  document.getElementById('now-playing-bar').classList.remove('show');
  document.getElementById('mini-player').classList.remove('show');
  activeStation=null;playlistTracks=[];playlistIndex=-1;
  clearSleepTimer();
  stopNowPlayingPolling();
  document.getElementById('np-artist').style.display='none';
  document.getElementById('np-icon').innerHTML='📻';
  document.getElementById('np-identify-btn').style.display='none';
  if('mediaSession' in navigator) navigator.mediaSession.playbackState='none';
}

// ── شافل / پشت‌سرهم برای پلی‌لیست ──
function toggleShuffle(){
  shuffleOn=!shuffleOn;
  localStorage.setItem('radiofa_shuffle', shuffleOn?'1':'0');
  updateShuffleLabel();
}
function updateShuffleLabel(){
  const btn=document.getElementById('np-shuffle-btn');
  const label=document.getElementById('np-shuffle-label');
  if(!btn||!label)return;
  label.textContent=shuffleOn?'شافل':'پخش پشت‌سرهم';
  btn.classList.toggle('active', shuffleOn);
}

// ── حجم صدا / میوت ──
let lastVolume=100;
function applyVolumeUI(){
  const saved=localStorage.getItem('radiofa_volume');
  const vol=saved!==null?parseInt(saved,10):100;
  document.getElementById('np-vol-slider').value=vol;
  document.getElementById('audio-player').volume=vol/100;
  updateMuteIcon(vol);
}
function onVolumeChange(val){
  const v=parseInt(val,10);
  document.getElementById('audio-player').volume=v/100;
  localStorage.setItem('radiofa_volume', v);
  if(v>0)lastVolume=v;
  updateMuteIcon(v);
}
function updateMuteIcon(vol){
  document.getElementById('np-mute-btn').textContent=vol==0?'🔇':(vol<50?'🔉':'🔊');
}
function toggleMute(){
  const slider=document.getElementById('np-vol-slider');
  const audio=document.getElementById('audio-player');
  if(parseInt(slider.value,10)>0){
    lastVolume=parseInt(slider.value,10);
    slider.value=0;audio.volume=0;localStorage.setItem('radiofa_volume','0');updateMuteIcon(0);
  }else{
    slider.value=lastVolume||100;audio.volume=(lastVolume||100)/100;localStorage.setItem('radiofa_volume',String(lastVolume||100));updateMuteIcon(lastVolume||100);
  }
}

// ── تایمر خواب ──
function toggleSleepMenu(){document.getElementById('np-sleep-menu').classList.toggle('open');}
document.addEventListener('click',e=>{
  const wrap=document.querySelector('.np-sleep-wrap');
  const menu=document.getElementById('np-sleep-menu');
  if(menu&&menu.classList.contains('open')&&wrap&&!wrap.contains(e.target))menu.classList.remove('open');
});
function setSleepTimer(minutes){
  clearSleepTimer();
  document.getElementById('np-sleep-menu').classList.remove('open');
  if(!minutes){showToast('تایمر خواب خاموش شد');return;}
  sleepEndsAt=Date.now()+minutes*60*1000;
  sleepTimerId=setTimeout(()=>{
    showToast('⏰ زمان تایمر خواب تمام شد، پخش متوقف شد');
    stopPlayback();
  }, minutes*60*1000);
  document.getElementById('np-sleep-btn').classList.add('active');
  updateSleepLabel();
  sleepCountdownId=setInterval(updateSleepLabel,1000*15);
  showToast('⏰ تایمر خواب برای '+minutes+' دقیقه دیگر تنظیم شد');
}
function clearSleepTimer(){
  if(sleepTimerId){clearTimeout(sleepTimerId);sleepTimerId=null;}
  if(sleepCountdownId){clearInterval(sleepCountdownId);sleepCountdownId=null;}
  sleepEndsAt=null;
  const btn=document.getElementById('np-sleep-btn');
  if(btn){btn.classList.remove('active');document.getElementById('np-sleep-label').textContent='تایمر خواب';}
}
function updateSleepLabel(){
  if(!sleepEndsAt)return;
  const remainMin=Math.max(0,Math.ceil((sleepEndsAt-Date.now())/60000));
  const label=document.getElementById('np-sleep-label');
  if(label)label.textContent=remainMin+' دقیقه مانده';
}

// ── ادامه‌ی آخرین ایستگاه ──
function showResumeBannerIfNeeded(){
  const lastId=localStorage.getItem('radiofa_last_station');
  if(!lastId)return;
  const st=stations.find(s=>s.id===lastId);
  if(!st||!canAccessStation(st))return;
  document.getElementById('resume-icon').textContent=st.icon||'📻';
  document.getElementById('resume-name').textContent=st.name;
  document.getElementById('resume-banner').style.display='block';
  document.getElementById('resume-banner').dataset.stationId=lastId;
}
function resumeLastStation(){
  const id=document.getElementById('resume-banner').dataset.stationId;
  if(id)playStation(id);
}
function dismissResumeBanner(){document.getElementById('resume-banner').style.display='none';}

if('serviceWorker' in navigator){window.addEventListener('load',()=>{navigator.serviceWorker.register('/sw.js').catch(()=>{});});}


let authMode='login';
let turnstileSiteKey=null;
let turnstileWidgetId=null;
fetch(WORKER_BASE+'/api/config').then(r=>r.json()).then(d=>{turnstileSiteKey=d.turnstileSiteKey||null;}).catch(()=>{});
function renderTurnstileIfNeeded(){
  const wrap=document.getElementById('turnstile-widget-wrap');
  if(authMode!=='signup'||!turnstileSiteKey||typeof turnstile==='undefined'){wrap.style.display='none';return;}
  wrap.style.display='block';
  document.getElementById('turnstile-widget').innerHTML='';
  try{ turnstileWidgetId=turnstile.render('#turnstile-widget',{sitekey:turnstileSiteKey}); }catch(e){}
}
function openAuthModal(mode){authMode=mode;switchAuthTab(mode);document.getElementById('auth-error').textContent='';document.getElementById('auth-username').value='';document.getElementById('auth-password').value='';document.getElementById('auth-modal').classList.add('open');}
function closeAuthModal(e){if(e&&e.target!==document.getElementById('auth-modal'))return;document.getElementById('auth-modal').classList.remove('open');}
function switchAuthTab(mode){
  authMode=mode;
  document.getElementById('auth-tab-login').classList.toggle('active',mode==='login');
  document.getElementById('auth-tab-signup').classList.toggle('active',mode==='signup');
  document.getElementById('auth-modal-title').textContent=mode==='login'?'ورود به حساب کاربری':'ساخت حساب کاربری جدید';
  document.getElementById('auth-submit-btn').textContent=mode==='login'?'ورود':'ثبت‌نام';
  document.getElementById('auth-error').textContent='';
  setTimeout(renderTurnstileIfNeeded,50);
}
async function submitAuth(){
  const username=document.getElementById('auth-username').value.trim();
  const password=document.getElementById('auth-password').value;
  const errEl=document.getElementById('auth-error');const btn=document.getElementById('auth-submit-btn');
  errEl.textContent='';
  if(!username||!password){errEl.textContent='نام کاربری و رمز عبور را وارد کن';return;}
  let captchaToken=null;
  if(authMode==='signup'&&turnstileSiteKey&&typeof turnstile!=='undefined'&&turnstileWidgetId!==null){
    captchaToken=turnstile.getResponse(turnstileWidgetId);
    if(!captchaToken){errEl.textContent='لطفاً کپچا را تأیید کن';return;}
  }
  const endpoint=authMode==='login'?'/api/auth/login':'/api/auth/signup';
  btn.disabled=true;
  try{
    const res=await fetch(WORKER_BASE+endpoint,{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password,captchaToken})});
    const data=await res.json();
    if(!res.ok){errEl.textContent=data.error||'خطایی رخ داد';btn.disabled=false;if(turnstileWidgetId!==null&&typeof turnstile!=='undefined')turnstile.reset(turnstileWidgetId);return;}
    currentUser=data.user;closeAuthModal(null);updateAccountUI();renderCards();
    showToast(authMode==='login'?'خوش آمدی ✓':'حساب ساخته شد ✓');
  }catch(e){errEl.textContent='خطا در ارتباط با سرور';}
  btn.disabled=false;
}
async function logoutUser(){
  try{await fetch(WORKER_BASE+'/api/auth/logout',{method:'POST',credentials:'include'});}catch(e){}
  currentUser=null;closeUserPanel(null);updateAccountUI();renderCards();showToast('خروج موفق');
  document.getElementById('btn-admin-link').style.display='none';
}
function updateAccountUI(){
  const guest=document.getElementById('btn-account-guest');const user=document.getElementById('btn-account-user');const adminLink=document.getElementById('btn-admin-link');
  if(currentUser){
    guest.style.display='none';user.style.display='inline-flex';
    document.getElementById('account-username').textContent=currentUser.username;
    document.getElementById('account-tick').innerHTML=tierTickHtml(currentUser);
    const roleLabel=document.getElementById('account-role-label');
    if(currentUser.role==='owner'){roleLabel.style.display='inline-block';roleLabel.textContent='OWNER';}else roleLabel.style.display='none';
    adminLink.style.display=currentUser.role==='owner'?'inline-block':'none';
  }else{guest.style.display='inline-block';user.style.display='none';adminLink.style.display='none';}
}
async function checkAuthStatus(){
  try{const res=await fetch(WORKER_BASE+'/api/auth/me',{credentials:'include'});const data=await res.json();currentUser=data.user||null;}catch(e){currentUser=null;}
  updateAccountUI();renderCards();
}

function openUserPanel(){
  if(!currentUser)return;
  document.getElementById('up-username-display').innerHTML='👤 '+escHtml(currentUser.username)+' '+tierTickHtml(currentUser);
  document.getElementById('up-tier-badge').textContent=tierLabel(currentUser);
  document.getElementById('cp-current').value='';document.getElementById('cp-new').value='';document.getElementById('cp-error').textContent='';
  document.getElementById('trust-code-input').value='';document.getElementById('trust-code-error').textContent='';
  const subSec=document.getElementById('up-sub-section');const vipSec=document.getElementById('up-vip-section');
  if(currentUser.role==='owner'||currentUser.tier==='vip'){subSec.style.display='none';vipSec.style.display='none';}
  else if(currentUser.tier==='sub'){subSec.style.display='none';vipSec.style.display='block';}
  else{subSec.style.display='block';vipSec.style.display='block';}
  renderFavoritesList();loadPaymentInfo();loadActiveSessions();
  document.getElementById('user-panel-modal').classList.add('open');
}
async function loadActiveSessions(){
  const wrap=document.getElementById('up-sessions-list');
  if(!wrap)return;
  wrap.textContent='در حال بارگذاری...';
  try{
    const res=await fetch(WORKER_BASE+'/api/auth/sessions',{credentials:'include'});
    const data=await res.json();
    const list=data.sessions||[];
    if(!list.length){wrap.innerHTML='<div style="padding:6px 0;">اطلاعاتی یافت نشد</div>';return;}
    wrap.innerHTML=list.map(s=>{
      const date=new Date(s.createdAt).toLocaleString('fa-IR');
      const ua=(s.userAgent||'').slice(0,40)||'نامشخص';
      return '<div style="display:flex;align-items:center;gap:8px;padding:7px 10px;background:var(--bg3);border-radius:8px;margin-bottom:6px;">'+
        '<span style="flex:1;min-width:0;">'+(s.current?'🟢 <strong>این دستگاه</strong> — ':'⚪ ')+escHtml(s.ip||'IP نامشخص')+'<br><span style="font-size:10.5px;">'+escHtml(ua)+' • '+date+'</span></span>'+
      '</div>';
    }).join('');
  }catch(e){wrap.innerHTML='<div style="color:var(--red);">خطا در بارگذاری</div>';}
}
function closeUserPanel(e){if(e&&e.target!==document.getElementById('user-panel-modal'))return;document.getElementById('user-panel-modal').classList.remove('open');}
function renderFavoritesList(){
  const wrap=document.getElementById('up-favorites-list');
  const favs=(currentUser?.favorites||[]).map(id=>stations.find(s=>s.id===id)).filter(Boolean);
  if(!favs.length){wrap.innerHTML='<div style="font-size:12.5px;color:var(--muted);text-align:center;padding:1rem 0;">هنوز ایستگاهی اضافه نشده</div>';return;}
  wrap.innerHTML=favs.map(st=>'<div style="display:flex;align-items:center;gap:8px;padding:7px 10px;background:var(--bg3);border-radius:8px;margin-bottom:6px;font-size:12.5px;"><span>'+(st.icon||'📻')+'</span><span style="flex:1;">'+escHtml(st.name)+'</span><button style="background:transparent;border:none;color:var(--red);cursor:pointer;" onclick="toggleFavorite(\\''+st.id+'\\')">حذف</button></div>').join('');
}
async function loadPaymentInfo(){
  try{
    const res=await fetch(WORKER_BASE+'/api/payment-info');
    const data=await res.json();
    document.getElementById('payment-card-content').innerHTML=
      '<div style="font-size:12.5px;color:var(--muted);margin-bottom:4px;">قیمت اشتراک: <strong style="color:var(--text);">'+escHtml(data.subPrice||'10')+' '+escHtml(data.currency||'USDT TRC20')+'</strong></div>'+
      '<div style="font-size:12px;color:var(--muted);margin-bottom:4px;">آدرس کیف پول ترون (TRC20):</div>'+
      '<div class="payment-address" onclick="copyText(\\''+escHtml(data.tronAddress)+'\\',this)">'+escHtml(data.tronAddress)+'</div>'+
      '<div style="font-size:12px;color:var(--muted);line-height:1.6;">'+escHtml(data.instructions||'')+'</div>';
  }catch(e){document.getElementById('payment-card-content').innerHTML='<div style="font-size:12px;color:var(--red);">خطا در بارگذاری</div>';}
}
function copyText(text,el){navigator.clipboard.writeText(text).catch(()=>{});const orig=el.textContent;el.textContent='کپی شد ✓';setTimeout(()=>el.textContent=orig,1500);}

async function submitTrustCode(){
  const code=document.getElementById('trust-code-input').value.trim();
  const errEl=document.getElementById('trust-code-error');errEl.textContent='';
  if(!code){errEl.textContent='کد را وارد کن';return;}
  try{
    const res=await fetch(WORKER_BASE+'/api/verify',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({code})});
    const data=await res.json();
    if(!res.ok){errEl.textContent=data.error||'خطا';return;}
    currentUser.tier='vip';closeUserPanel(null);updateAccountUI();renderCards();showToast('🌟 دسترسی VIP فعال شد!');
  }catch(e){errEl.textContent='خطا در ارتباط با سرور';}
}
async function submitChangePassword(){
  const cur=document.getElementById('cp-current').value;const nw=document.getElementById('cp-new').value;
  const errEl=document.getElementById('cp-error');errEl.textContent='';
  if(!cur||!nw){errEl.textContent='هر دو فیلد را پر کن';return;}
  try{
    const res=await fetch(WORKER_BASE+'/api/auth/change-password',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({currentPassword:cur,newPassword:nw})});
    const data=await res.json();
    if(!res.ok){errEl.textContent=data.error||'خطا';return;}
    document.getElementById('cp-current').value='';document.getElementById('cp-new').value='';showToast('رمز تغییر کرد ✓');
  }catch(e){errEl.textContent='خطا در ارتباط با سرور';}
}

// ── تم روشن/تیره (پیش‌فرض تیره، قابل تغییر و ذخیره) ──
const FRONTEND_THEME_KEY='radiofa_theme';
function applyFrontendTheme(theme){
  document.documentElement.setAttribute('data-theme', theme);
  const btn=document.getElementById('theme-toggle-btn');
  if(btn) btn.textContent = theme==='light' ? '☀️' : '🌙';
}
function initFrontendTheme(){
  const saved=localStorage.getItem(FRONTEND_THEME_KEY);
  const theme=saved==='light'?'light':'dark';
  applyFrontendTheme(theme);
}
function toggleFrontendTheme(){
  const current=document.documentElement.getAttribute('data-theme')||'dark';
  const next=current==='dark'?'light':'dark';
  localStorage.setItem(FRONTEND_THEME_KEY, next);
  applyFrontendTheme(next);
}
initFrontendTheme();

// ── Mini Player: جمع کردن نوار پخش به یک ویجت شناور کوچک ──
function enterMiniPlayer(){
  if(!activeStation)return;
  document.getElementById('now-playing-bar').classList.remove('show');
  document.getElementById('mini-player').classList.add('show');
  document.getElementById('mini-player-name').textContent=activeStation.name;
  const npIconHtml=document.getElementById('np-icon').innerHTML;
  document.getElementById('mini-player-icon').innerHTML=npIconHtml||(activeStation.icon||'📻');
}
function exitMiniPlayer(){
  document.getElementById('mini-player').classList.remove('show');
  if(activeStation) document.getElementById('now-playing-bar').classList.add('show');
}

renderGenreBar();renderCards();checkAuthStatus();showResumeBannerIfNeeded();
</script>
</body>
</html>`;
}

// ═══════════════════════════════════════════════════════════════
// HTML پنل مدیریت
// ═══════════════════════════════════════════════════════════════
function getAdminHTML(workerOrigin) {
  return `<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>RadioFa — پنل مدیریت</title>
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
:root{--bg:#0b0d10;--bg2:#13161c;--bg3:#1c2029;--border:rgba(255,255,255,0.07);--border2:rgba(255,255,255,0.13);
--accent:#ff9f43;--accent2:#ff8a1e;--text:#f0f2f5;--text2:#a8b0be;--muted:#5a6070;
--red:#ff4d4d;--red-bg:rgba(255,77,77,0.1);--green:#3ddc84;--green-bg:rgba(61,220,132,0.1);
--blue:#4da6ff;--blue-bg:rgba(77,166,255,0.1);--gold:#ffcc00;--gold-bg:rgba(255,204,0,0.1);--r:12px;--r2:8px;--sidebar:220px;--topbar-bg:rgba(11,13,16,0.8);}
:root[data-theme="light"]{--bg:#f4f5f8;--bg2:#ffffff;--bg3:#eef0f4;--border:rgba(15,20,30,0.08);--border2:rgba(15,20,30,0.14);
--accent:#ff8a1e;--accent2:#e6790f;--text:#181b21;--text2:#4a5160;--muted:#8991a1;
--red:#e6473f;--red-bg:rgba(230,71,63,0.08);--green:#1fa971;--green-bg:rgba(31,169,113,0.08);
--blue:#2e7fd8;--blue-bg:rgba(46,127,216,0.08);--gold:#c99700;--gold-bg:rgba(201,151,0,0.1);--topbar-bg:rgba(244,245,248,0.85);}
*,body,.sidebar,.topbar,.stat-card,.table-wrap,.form-card,.cat-card,.backup-card,.nav-item,.btn,.card,input,select,textarea{transition:background-color .35s ease,color .35s ease,border-color .35s ease,box-shadow .35s ease;}
.theme-switch{position:relative;width:56px;height:30px;border-radius:20px;background:var(--bg3);border:1px solid var(--border2);cursor:pointer;flex-shrink:0;display:inline-flex;align-items:center;padding:0 5px;justify-content:space-between;transition:transform .15s ease,background-color .35s ease,border-color .35s ease;}
.theme-switch .ts-icon{font-size:12px;line-height:1;z-index:1;opacity:.55;}
.theme-switch .ts-knob{position:absolute;top:2px;right:2px;width:24px;height:24px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:12px;box-shadow:0 2px 6px rgba(0,0,0,0.35);transition:transform .35s cubic-bezier(.68,-0.4,.27,1.4),background .35s ease;}
:root[data-theme="light"] .theme-switch .ts-knob{transform:translateX(-26px);background:#ffb020;}
.theme-switch-wrap{display:flex;align-items:center;gap:8px;}
.theme-mode-label{font-size:11px;color:var(--muted);white-space:nowrap;}
body{font-family:'Vazirmatn',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex;direction:rtl;}
.sidebar{width:var(--sidebar);flex-shrink:0;background:var(--bg2);border-left:1px solid var(--border);display:flex;flex-direction:column;position:sticky;top:0;height:100vh;overflow-y:auto;}
.sidebar-logo{padding:1.25rem 1.25rem 0.5rem;display:flex;align-items:center;gap:10px;}
.logo-mark{width:32px;height:32px;background:var(--accent);border-radius:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.logo-text{font-size:15px;font-weight:700;}
.logo-sub{font-size:10px;color:var(--muted);}
.nav-item{display:flex;align-items:center;gap:10px;padding:9px 1rem;margin:1px 0.5rem;border-radius:var(--r2);font-size:13px;color:var(--text2);cursor:pointer;border:none;background:transparent;width:calc(100% - 1rem);font-family:inherit;text-align:right;}
.nav-item:hover{background:var(--bg3);color:var(--text);}
.nav-item.active{background:rgba(255,159,67,0.12);color:var(--accent);font-weight:600;}
.main{flex:1;display:flex;flex-direction:column;min-width:0;overflow:hidden;}
.topbar{height:58px;display:flex;align-items:center;justify-content:space-between;padding:0 1.5rem;border-bottom:1px solid var(--border);position:sticky;top:0;z-index:50;background:var(--topbar-bg);backdrop-filter:blur(12px);}
.page-title{font-size:16px;font-weight:600;}
.btn{display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:var(--r2);font-family:inherit;font-size:13px;cursor:pointer;border:1px solid transparent;}
.btn-primary{background:var(--accent);color:#0b0d10;border-color:var(--accent);font-weight:700;}
.btn-primary:hover{background:var(--accent2);}
.btn-ghost{background:transparent;border-color:var(--border);color:var(--text2);}
.btn-ghost:hover{border-color:var(--border2);color:var(--text);background:var(--bg3);}
.btn-danger{background:var(--red-bg);border-color:rgba(255,77,77,0.3);color:var(--red);}
.btn-tg{background:rgba(41,182,246,0.12);border-color:rgba(41,182,246,0.3);color:#29b6f6;}
.btn-sm{padding:6px 10px;font-size:12px;}
.content{flex:1;padding:1.5rem;overflow-y:auto;}
.section{display:none;}.section.active{display:block;}
.stats-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:1.5rem;}
.stat-card{background:var(--bg2);border:1px solid var(--border);border-radius:var(--r);padding:1rem 1.25rem;position:relative;overflow:hidden;}
.stat-card::after{content:'';position:absolute;bottom:0;left:0;right:0;height:2px;}
.stat-card.green::after{background:var(--green);}.stat-card.red::after{background:var(--red);}.stat-card.blue::after{background:var(--blue);}.stat-card.gold::after{background:var(--gold);}
.stat-label{font-size:11px;color:var(--muted);margin-bottom:6px;text-transform:uppercase;}
.stat-val{font-size:28px;font-weight:700;}
.table-wrap{background:var(--bg2);border:1px solid var(--border);border-radius:var(--r);overflow:hidden;}
.table-toolbar{display:flex;align-items:center;gap:10px;padding:1rem 1.25rem;border-bottom:1px solid var(--border);flex-wrap:wrap;}
.search-box input,select,input[type=text],textarea{background:var(--bg3);border:1px solid var(--border);border-radius:var(--r2);padding:8px 12px;color:var(--text);font-family:inherit;font-size:13px;outline:none;}
table{width:100%;border-collapse:collapse;}
th{text-align:right;padding:10px 1.25rem;font-size:11px;color:var(--muted);font-weight:600;text-transform:uppercase;white-space:nowrap;}
td{padding:12px 1.25rem;font-size:13px;border-bottom:1px solid var(--border);vertical-align:middle;}
tr:hover td{background:rgba(255,255,255,0.02);}
.ch-cell{display:flex;align-items:center;gap:10px;}
.ch-icon-sm{width:34px;height:34px;border-radius:8px;background:var(--bg3);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0;}
.ch-name-sm{font-weight:500;font-size:13px;}.ch-id-sm{font-size:11px;color:var(--muted);font-family:monospace;}
.badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;padding:3px 9px;border-radius:20px;font-weight:500;white-space:nowrap;}
.badge-dot{width:5px;height:5px;border-radius:50%;background:currentColor;}
.b-live{background:var(--green-bg);color:var(--green);}.b-error{background:var(--red-bg);color:var(--red);}
.b-sub{background:var(--blue-bg);color:var(--blue);}.b-vip{background:var(--gold-bg);color:var(--gold);}.b-none{background:var(--bg3);color:var(--muted);}
.form-card{background:var(--bg2);border:1px solid var(--border);border-radius:var(--r);padding:1.5rem;}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:1rem;}
.form-group{display:flex;flex-direction:column;gap:6px;}
.form-group.full{grid-column:1/-1;}
label{font-size:12px;color:var(--text2);}
.form-actions{display:flex;gap:10px;justify-content:flex-end;padding-top:1rem;border-top:1px solid var(--border);}
.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(80px);background:var(--text);color:var(--bg);border-radius:10px;padding:10px 20px;font-size:13px;font-weight:600;z-index:999;transition:transform .3s ease;pointer-events:none;}
.toast.show{transform:translateX(-50%) translateY(0);}
.tbl-empty td{text-align:center;padding:3rem;color:var(--muted);}
.icon-picker{display:flex;gap:6px;flex-wrap:wrap;}
.icon-opt{width:36px;height:36px;border-radius:8px;background:var(--bg3);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;font-size:16px;cursor:pointer;}
.icon-opt.selected{border-color:var(--accent);background:rgba(255,159,67,0.08);}
.cat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin-bottom:1.5rem;}
.cat-card{background:var(--bg2);border:1px solid var(--border);border-radius:var(--r);padding:1rem;display:flex;align-items:center;gap:10px;}
.cat-icon-big{width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;}
.color-row{display:flex;gap:8px;flex-wrap:wrap;}
.color-opt{width:28px;height:28px;border-radius:50%;cursor:pointer;border:2px solid transparent;}
.color-opt.selected{border-color:#fff;transform:scale(1.15);}
.tg-status-row{display:flex;align-items:center;gap:10px;margin-bottom:12px;}
.tg-indicator{width:10px;height:10px;border-radius:50%;flex-shrink:0;}
.tg-indicator.on{background:var(--green);}.tg-indicator.off{background:var(--muted);}
.backup-card{background:var(--bg2);border:1px solid var(--border);border-radius:var(--r);padding:1.5rem;margin-bottom:1.25rem;}
.drop-zone-import{border:2px dashed var(--border2);border-radius:var(--r);padding:2rem;text-align:center;cursor:pointer;background:var(--bg3);font-size:13px;color:var(--muted);}
.backup-result-box{margin-top:1rem;background:var(--bg3);border-radius:10px;padding:1rem;font-size:12.5px;color:var(--text2);line-height:1.8;display:none;}
.log-row{display:flex;align-items:center;gap:12px;padding:10px 1.25rem;border-bottom:1px solid var(--border);font-size:12.5px;}
.log-time{font-size:11px;color:var(--muted);margin-right:auto;}
.overlay{display:none;position:fixed;inset:0;z-index:300;background:rgba(0,0,0,0.85);align-items:center;justify-content:center;padding:1rem;}
.overlay.open{display:flex;}
.modal-box{background:var(--bg2);border:1px solid var(--border2);border-radius:16px;width:100%;max-height:90vh;overflow-y:auto;}
.modal-hdr{position:sticky;top:0;background:var(--bg2);display:flex;align-items:center;justify-content:space-between;padding:1rem 1.25rem;border-bottom:1px solid var(--border);}
.modal-hdr h3{font-size:15px;font-weight:600;}
.modal-close-btn{background:var(--bg3);border:none;width:32px;height:32px;border-radius:8px;color:var(--muted);cursor:pointer;font-size:16px;flex-shrink:0;}
.modal-close-btn:hover{color:var(--text);}
.modal-body{padding:1.25rem;}
@media(max-width:700px){.sidebar{display:none;}.form-grid{grid-template-columns:1fr;}}
</style>
</head>
<body>

<aside class="sidebar">
  <div class="sidebar-logo"><div class="logo-mark">📻</div><div><div class="logo-text">RadioFa</div><div class="logo-sub">پنل مدیریت</div></div></div>
  <button class="nav-item active" onclick="goto('stations',this)">📻 ایستگاه‌ها</button>
  <button class="nav-item" onclick="goto('add',this)">➕ افزودن ایستگاه</button>
  <button class="nav-item" onclick="goto('health',this)">💓 بررسی سلامت</button>
  <button class="nav-item" onclick="goto('genres',this)">📂 ژانرها</button>
  <button class="nav-item" onclick="goto('listens',this)">📊 آمار شنیدن</button>
  <button class="nav-item" onclick="goto('users',this)">👥 مدیریت کاربران</button>
  <button class="nav-item" onclick="goto('payment',this)">💳 تنظیمات پرداخت</button>
  <button class="nav-item" onclick="goto('telegram',this)">🤖 تلگرام</button>
  <button class="nav-item" onclick="goto('backup',this)">💾 پشتیبان‌گیری</button>
  <button class="nav-item" onclick="goto('logs',this)">📋 لاگ تغییرات</button>
  <button class="nav-item" onclick="goto('security',this)">🛡️ امنیت</button>
  <button class="nav-item" onclick="goto('errors',this)">⚠️ لاگ خطاها</button>
  <button class="nav-item" onclick="window.location.href='/'">↗ صفحه کاربری</button>
</aside>

<main class="main">
  <div class="topbar">
    <div class="page-title" id="page-title">ایستگاه‌ها</div>
    <div style="display:flex;align-items:center;gap:14px;">
      <div class="theme-switch-wrap">
        <span class="theme-mode-label" id="theme-mode-label">خودکار</span>
        <div class="theme-switch" id="theme-switch" onclick="toggleTheme()" title="تغییر تم روشن/تیره">
          <span class="ts-icon">🌙</span><span class="ts-icon">☀️</span>
          <div class="ts-knob" id="ts-knob">🌓</div>
        </div>
      </div>
      <button class="btn btn-primary btn-sm" onclick="goto('add',document.querySelectorAll('.nav-item')[1])">➕ ایستگاه جدید</button>
    </div>
  </div>
  <div class="content">

    <div class="section active" id="sec-stations">
      <div class="stats-row" id="stats-row"></div>
      <div class="table-wrap">
        <div class="table-toolbar">
          <div class="search-box"><input type="text" id="tbl-search" placeholder="جستجو..." oninput="renderTable()"></div>
          <select id="tbl-filter" onchange="renderTable()"><option value="all">همه وضعیت‌ها</option><option value="live">فعال</option><option value="error">خطا</option></select>
          <select id="tbl-access-filter" onchange="renderTable()"><option value="all">همه سطوح</option><option value="public">عمومی</option><option value="sub">اشتراک</option><option value="vip">VIP</option></select>
        </div>
        <div style="overflow-x:auto;"><table><thead><tr><th>ایستگاه</th><th>وضعیت</th><th>سطح دسترسی</th><th>ژانر</th><th>آدرس</th><th>عملیات</th></tr></thead><tbody id="st-tbody"></tbody></table></div>
      </div>
    </div>

    <div class="section" id="sec-add">
      <div class="form-card">
        <div style="font-size:15px;font-weight:600;margin-bottom:1.25rem;" id="form-heading">افزودن ایستگاه جدید</div>
        <div class="form-grid">
          <div class="form-group"><label>شناسه (ID)</label><input type="text" id="f-id" oninput="validateAddForm()"></div>
          <div class="form-group"><label>نام ایستگاه</label><input type="text" id="f-name" oninput="validateAddForm()"></div>
          <div class="form-group"><label>نوع استریم</label><select id="f-type" onchange="onTypeChange()"><option value="direct">🎵 مستقیم (mp3/aac)</option><option value="hls">📡 HLS (m3u8)</option><option value="playlist">📀 پلی‌لیست شخصی (آهنگ‌های آپلودی)</option></select></div>
          <div class="form-group" id="f-suffix-wrap" style="display:none;"><label>پسوند پلی‌لیست (Playlist Suffix)</label><input type="text" id="f-suffix" placeholder="/index.m3u8"></div>
          <div class="form-group full" id="f-url-wrap"><label id="f-url-label">آدرس مستقیم استریم صوتی (mp3/aac)</label><input type="text" id="f-url" placeholder="https://stream.example.com/live.mp3"></div>
          <div class="form-group full" id="f-playlist-hint" style="display:none;background:var(--bg3);border-radius:8px;padding:10px 12px;font-size:12px;color:var(--text2);line-height:1.7;">
            📀 برای این نوع ایستگاه آدرسی لازم نیست. اول ایستگاه رو با یه اسم ذخیره کن، بعد از جدول ایستگاه‌ها دکمه‌ی «🎵 آهنگ‌ها» رو بزن تا فایل‌های mp3 خودت رو آپلود کنی.
          </div>
          <div class="form-group"><label>وضعیت</label><select id="f-status"><option value="live">فعال</option><option value="error">خطا</option></select></div>
          <div class="form-group"><label>سطح دسترسی</label><select id="f-access"><option value="public">🌍 عمومی</option><option value="sub">✅ اشتراک</option><option value="vip">🌟 VIP</option></select></div>
          <div class="form-group"><label>کشور / پرچم</label><select id="f-country"></select></div>
          <div class="form-group full"><label>ژانر</label><select id="f-genre"><option value="">بدون ژانر</option></select></div>
          <div class="form-group full"><label>در حال پخش (Now Playing — اختیاری، دستی)</label><input type="text" id="f-nowplaying" placeholder="مثلاً: برنامه صبحگاهی با فلانی"></div>
          <div class="form-group full"><label>آیکون</label><div class="icon-picker" id="icon-picker"></div></div>
        </div>
        <div class="form-actions"><button class="btn btn-ghost" onclick="resetForm()">انصراف</button><button class="btn btn-primary" id="btn-submit" onclick="submitForm()" disabled style="opacity:.4;">ذخیره ایستگاه</button></div>
      </div>

    </div>

    <div class="section" id="sec-health">
      <div class="table-wrap">
        <div class="table-toolbar"><button class="btn btn-primary" onclick="runHealthCheck()">💓 بررسی همه</button><button class="btn btn-danger" onclick="deleteErrorStations()">🗑 حذف خطادارها</button></div>
        <div style="overflow-x:auto;"><table><thead><tr><th>ایستگاه</th><th>وضعیت</th><th>زمان پاسخ</th><th>HTTP</th><th>چارت</th></tr></thead><tbody id="health-tbody"></tbody></table></div>
      </div>
    </div>

    <div class="section" id="sec-genres">
      <div class="cat-grid" id="cat-grid"></div>
      <div class="form-card">
        <div style="font-size:14px;font-weight:600;margin-bottom:1rem;" id="cat-form-heading">افزودن ژانر جدید</div>
        <div class="form-grid">
          <div class="form-group"><label>نام ژانر</label><input type="text" id="cf-name" oninput="validateCatForm()"></div>
          <div class="form-group"><label>آیکون</label><input type="text" id="cf-icon" placeholder="🎵" maxlength="2" style="max-width:80px;"></div>
          <div class="form-group full"><label>رنگ</label><div class="color-row" id="color-row"></div></div>
        </div>
        <div class="form-actions"><button class="btn btn-ghost" onclick="resetCatForm()">انصراف</button><button class="btn btn-primary" id="btn-cat-submit" onclick="submitCat()" disabled style="opacity:.4;">ذخیره</button></div>
      </div>
    </div>

    <div class="section" id="sec-listens">
      <div class="stats-row" id="listens-hero"></div>
      <div class="table-wrap" style="padding:1.25rem;margin-bottom:1.25rem;">
        <div style="font-size:13px;color:var(--text2);font-weight:600;margin-bottom:14px;">📊 نمودار ۱۰ ایستگاه پرشنونده</div>
        <div id="listens-chart-wrap"></div>
      </div>
      <div class="table-wrap">
        <div class="table-toolbar"><span style="font-size:13px;color:var(--text2);font-weight:600;">📊 پرشنونده‌ترین ایستگاه‌ها</span><button class="btn btn-ghost btn-sm" onclick="loadListenStats()">🔄 بروزرسانی</button></div>
        <div style="overflow-x:auto;"><table><thead><tr><th>رتبه</th><th>ایستگاه</th><th>وضعیت</th><th>سطح</th><th>امروز/دیروز</th><th>کل</th></tr></thead><tbody id="listens-tbody"></tbody></table></div>
      </div>
    </div>

    <div class="section" id="sec-users">
      <div class="stats-row" id="user-stats-row"></div>
      <div class="table-wrap">
        <div class="table-toolbar">
          <div class="search-box"><input type="text" id="user-search" placeholder="جستجوی کاربر..." oninput="renderUsersTable()"></div>
          <select id="user-tier-filter" onchange="renderUsersTable()"><option value="all">همه سطوح</option><option value="none">بدون اشتراک</option><option value="sub">اشتراک</option><option value="vip">VIP</option></select>
        </div>
        <div style="overflow-x:auto;"><table><thead><tr><th>نام کاربری</th><th>سطح دسترسی</th><th>علاقه‌مندی‌ها</th><th>تاریخ عضویت</th><th>عملیات</th></tr></thead><tbody id="users-tbody"></tbody></table></div>
      </div>
    </div>

    <div class="section" id="sec-payment">
      <div class="form-card">
        <div style="font-size:15px;font-weight:600;margin-bottom:1.25rem;">💳 تنظیمات پرداخت</div>
        <div class="form-grid">
          <div class="form-group full"><label>آدرس کیف پول ترون (از TRON_ADDRESS)</label><div style="background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:9px 12px;font-family:monospace;font-size:12.5px;color:var(--muted);" id="tron-address-display">در حال بارگذاری...</div></div>
          <div class="form-group"><label>قیمت اشتراک (USDT TRC20)</label><input type="text" id="sub-price"></div>
          <div class="form-group full"><label>توضیحات پرداخت</label><textarea id="payment-instructions" style="min-height:80px;"></textarea></div>
        </div>
        <div class="form-actions"><button class="btn btn-primary" onclick="savePaymentSettings()">ذخیره تنظیمات</button></div>
      </div>
    </div>

    <div class="section" id="sec-telegram">
      <div class="form-card">
        <div style="font-size:15px;font-weight:600;margin-bottom:1rem;">🤖 اعلان‌های تلگرام</div>
        <div class="tg-status-row"><div class="tg-indicator off" id="tg-indicator"></div><span id="tg-status-text" style="font-size:13px;color:var(--muted);">در حال بررسی...</span></div>
        <button class="btn btn-tg" onclick="testTelegram()">📨 ارسال پیام تست</button>
        <div id="tg-test-result" style="margin-top:10px;font-size:12.5px;"></div>
      </div>
    </div>

    <div class="section" id="sec-backup">
      <div class="backup-card">
        <div style="font-size:14px;font-weight:600;margin-bottom:12px;">📤 خروجی گرفتن (Export)</div>
        <button class="btn btn-primary" onclick="exportBackup()">⬇️ دانلود فایل پشتیبان</button>
      </div>
      <div class="backup-card">
        <div style="font-size:14px;font-weight:600;margin-bottom:12px;">📥 بازگردانی (Import)</div>
        <div class="drop-zone-import" onclick="document.getElementById('backup-file-input').click()">📁 فایل پشتیبان (.json) را انتخاب کنید</div>
        <input type="file" id="backup-file-input" accept=".json" style="display:none;" onchange="onBackupFileSelected(event)">
        <div class="backup-result-box" id="backup-result-box"></div>
      </div>
      <div class="backup-card">
        <div style="font-size:14px;font-weight:600;margin-bottom:12px;">📡 وارد کردن از فایل M3U</div>
        <div style="font-size:12px;color:var(--muted);margin-bottom:10px;line-height:1.7;">فایل M3U/M3U8 رو انتخاب کن یا محتواش رو مستقیم پیست کن؛ همه‌ی ایستگاه‌ها به‌صورت عمومی و مستقیم/HLS (بسته به پسوند لینک) اضافه می‌شن.</div>
        <div class="drop-zone-import" onclick="document.getElementById('m3u-file-input').click()" style="margin-bottom:10px;">📁 انتخاب فایل M3U</div>
        <input type="file" id="m3u-file-input" accept=".m3u,.m3u8,text/plain" style="display:none;" onchange="onM3UFileSelected(event)">
        <textarea id="m3u-textarea" placeholder="یا محتوای M3U رو اینجا پیست کن..." style="width:100%;min-height:100px;margin-bottom:10px;"></textarea>
        <button class="btn btn-primary btn-sm" onclick="importM3UText()">وارد کردن ایستگاه‌ها</button>
        <div class="backup-result-box" id="m3u-result-box"></div>
      </div>
    </div>

    <div class="section" id="sec-logs">
      <div class="table-wrap"><div class="table-toolbar"><span style="font-size:13px;color:var(--text2);">آخرین تغییرات سطح دسترسی</span><button class="btn btn-ghost btn-sm" onclick="loadLogs()">🔄 بروزرسانی</button></div><div id="logs-list"></div></div>
    </div>

    <div class="section" id="sec-security">
      <div class="form-card" style="margin-bottom:1.25rem;">
        <div style="font-size:15px;font-weight:600;margin-bottom:1rem;">🚫 مسدودسازی IP</div>
        <div style="display:flex;gap:8px;margin-bottom:1rem;flex-wrap:wrap;">
          <input type="text" id="block-ip-input" placeholder="مثلاً 1.2.3.4" style="flex:1;min-width:160px;">
          <input type="text" id="block-ip-reason" placeholder="دلیل (اختیاری)" style="flex:1;min-width:160px;">
          <button class="btn btn-danger" onclick="blockIP()">مسدود کن</button>
        </div>
        <div id="blocked-ips-list" style="font-size:12.5px;color:var(--text2);">در حال بارگذاری...</div>
      </div>
      <div class="table-wrap">
        <div class="table-toolbar"><span style="font-size:13px;color:var(--text2);">📋 لاگ فعالیت کاربران (ورود/خروج/ثبت‌نام/تغییر رمز)</span><button class="btn btn-ghost btn-sm" onclick="loadActivityLogs()">🔄 بروزرسانی</button></div>
        <div id="activity-logs-list"></div>
      </div>
    </div>

    <div class="section" id="sec-errors">
      <div class="table-wrap">
        <div class="table-toolbar"><span style="font-size:13px;color:var(--text2);">⚠️ خطاهای اخیر سیستم (پروکسی، health-check، exception ها)</span><button class="btn btn-ghost btn-sm" onclick="loadErrorLogs()">🔄 بروزرسانی</button></div>
        <div id="error-logs-list"></div>
      </div>
    </div>

  </div>
</main>

<div class="overlay" id="uptime-chart-modal" onclick="if(event.target===this)closeUptimeChart()">
  <div class="modal-box" style="max-width:640px;">
    <div class="modal-hdr"><h3>📈 چارت Uptime — <span id="uptime-chart-station-name"></span></h3><button class="modal-close-btn" onclick="closeUptimeChart()">✕</button></div>
    <div class="modal-body">
      <div id="uptime-chart-summary" style="display:flex;gap:10px;margin-bottom:1rem;flex-wrap:wrap;"></div>
      <div id="uptime-chart-svg-wrap" style="overflow-x:auto;"></div>
      <div style="font-size:11px;color:var(--muted);margin-top:10px;">هر میله نتیجه‌ی یک بررسی سلامت است (سبز=فعال، قرمز=خطا). حداکثر ۱۰۰ بررسی آخر ذخیره می‌شود.</div>
    </div>
  </div>
</div>

<div class="overlay" id="tracks-modal" onclick="if(event.target===this)closeTracksModal()">
  <div class="modal-box" style="max-width:560px;">
    <div class="modal-hdr"><h3>🎵 مدیریت آهنگ‌ها — <span id="tracks-station-name"></span></h3><button class="modal-close-btn" onclick="closeTracksModal()">✕</button></div>
    <div class="modal-body">
      <div class="drop-zone-import" id="track-drop-zone" onclick="document.getElementById('track-file-input').click()" style="margin-bottom:1rem;">📤 برای آپلود آهنگ (mp3/aac/ogg/wav — حداکثر ۳۰ مگابایت) کلیک کن</div>
      <input type="file" id="track-file-input" accept="audio/*" style="display:none;" onchange="onTrackFileSelected(event)">
      <div class="progress-bar-wrap" id="track-progress-wrap" style="display:none;background:var(--bg3);border-radius:20px;height:6px;overflow:hidden;margin-bottom:1rem;"><div class="progress-bar" id="track-progress-bar" style="height:100%;background:var(--accent);width:0%;transition:width .3s;"></div></div>
      <div id="tracks-list" style="display:flex;flex-direction:column;gap:6px;max-height:340px;overflow-y:auto;"></div>
    </div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
let currentTracksStationId=null, currentTracks=[];

const WORKER_BASE = '${workerOrigin}';
const ADMIN_COUNTRIES = ${JSON.stringify(COUNTRIES)};
function countryFlagJs(code){
  if(!code||code==='INTL')return'🌐';
  const cc=String(code).toUpperCase();
  if(cc.length!==2)return'🌐';
  const base=127397;
  try{return String.fromCodePoint(...[...cc].map(c=>c.charCodeAt(0)+base));}catch(e){return'🌐';}
}
function populateCountrySelect(){
  const sel=document.getElementById('f-country');
  if(!sel)return;
  sel.innerHTML='<option value="">— بدون پرچم —</option>'+ADMIN_COUNTRIES.map(c=>'<option value="'+c.code+'">'+countryFlagJs(c.code)+' '+escHtml(c.name)+'</option>').join('');
}
let stations=[], genres=[], users=[], editingId=null, editingCatId=null, selectedIcon='📻', selectedColor='#4da6ff', healthResults={};
const CAT_COLORS=['#4da6ff','#3ddc84','#ff9f43','#ff4d4d','#c77dff','#ff6b9d','#00d4ff','#ffcc00'];

function escHtml(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function showToast(msg){const t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');clearTimeout(t._t);t._t=setTimeout(()=>t.classList.remove('show'),2500);}

async function loadStations(){
  try{
    const [sr,gr]=await Promise.all([fetch('/admin/api/stations',{credentials:'include'}),fetch('/admin/api/genres',{credentials:'include'})]);
    if(sr.ok) stations=await sr.json();
    if(gr.ok) genres=await gr.json();
    renderStats();renderTable();renderGenreSelect();renderCatGrid();
  }catch(e){showToast('خطا در ارتباط با دیتابیس ❌');}
}
function goto(name,btn){
  document.querySelectorAll('.section').forEach(s=>s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(b=>b.classList.remove('active'));
  document.getElementById('sec-'+name).classList.add('active');if(btn)btn.classList.add('active');
  const titles={stations:'ایستگاه‌ها',add:'افزودن ایستگاه',health:'بررسی سلامت',genres:'ژانرها',listens:'آمار شنیدن',users:'مدیریت کاربران',payment:'تنظیمات پرداخت',telegram:'تلگرام',backup:'پشتیبان‌گیری',logs:'لاگ تغییرات',security:'امنیت',errors:'لاگ خطاها'};
  document.getElementById('page-title').textContent=titles[name]||'';
  if(name==='stations'){renderStats();renderTable();}
  if(name==='health')renderHealthTable();
  if(name==='genres')renderCatGrid();
  if(name==='listens')loadListenStats();
  if(name==='users')loadUsers();
  if(name==='payment')loadPaymentSettings();
  if(name==='telegram')loadTelegramStatus();
  if(name==='logs')loadLogs();
  if(name==='security'){loadBlockedIPs();loadActivityLogs();}
  if(name==='errors')loadErrorLogs();
}
function renderStats(){
  const live=stations.filter(s=>s.status==='live').length,error=stations.filter(s=>s.status==='error').length;
  const vip=stations.filter(s=>s.access==='vip').length,sub=stations.filter(s=>s.access==='sub').length;
  document.getElementById('stats-row').innerHTML='<div class="stat-card green"><div class="stat-label">فعال</div><div class="stat-val">'+live+'</div></div><div class="stat-card red"><div class="stat-label">خطا</div><div class="stat-val">'+error+'</div></div><div class="stat-card blue"><div class="stat-label">اشتراک</div><div class="stat-val">'+sub+'</div></div><div class="stat-card gold"><div class="stat-label">VIP</div><div class="stat-val">'+vip+'</div></div>';
}
function accessBadge(a){if(a==='vip')return '<span class="badge b-vip">🌟 VIP</span>';if(a==='sub')return '<span class="badge b-sub">✅ اشتراک</span>';return '<span class="badge b-none">🌍 عمومی</span>';}
function statusBadge(s){return s==='live'?'<span class="badge b-live"><span class="badge-dot"></span>فعال</span>':'<span class="badge b-error"><span class="badge-dot"></span>خطا</span>';}
function renderGenreSelect(){const sel=document.getElementById('f-genre');const cur=sel.value;sel.innerHTML='<option value="">بدون ژانر</option>'+genres.map(g=>'<option value="'+g.id+'">'+g.icon+' '+escHtml(g.name)+'</option>').join('');sel.value=cur;}
function renderTable(){
  const q=(document.getElementById('tbl-search').value||'').toLowerCase();
  const f=document.getElementById('tbl-filter').value,fa=document.getElementById('tbl-access-filter').value;
  const list=stations.filter(s=>{const mq=!q||s.name.toLowerCase().includes(q);const mf=f==='all'||s.status===f;const ma=fa==='all'||(s.access||'public')===fa;return mq&&mf&&ma;});
  const tbody=document.getElementById('st-tbody');
  if(!list.length){tbody.innerHTML='<tr class="tbl-empty"><td colspan="6">ایستگاهی یافت نشد</td></tr>';return;}
  tbody.innerHTML=list.map(st=>{
    const genre=genres.find(g=>g.id===st.genre);
    const genreCell=genre?'<span class="badge" style="background:'+genre.color+'22;color:'+genre.color+'">'+genre.icon+' '+escHtml(genre.name)+'</span>':'<span style="color:var(--muted);font-size:12px;">—</span>';
    const typeBadge=st.type==='hls'?'<span class="badge" style="background:var(--blue-bg);color:var(--blue);">📡 HLS</span>':(st.type==='playlist'?'<span class="badge" style="background:var(--gold-bg);color:var(--gold);">📀 پلی‌لیست</span>':'<span class="badge b-none">🎵 مستقیم</span>');
    const tracksBtn=st.type==='playlist'?' <button class="btn btn-ghost btn-sm" onclick="openTracksModal(\\''+st.id+'\\')">🎵 آهنگ‌ها</button>':'';
    const npCell=st.nowPlaying?'<div style="font-size:10.5px;color:var(--accent);margin-top:3px;">🎧 '+escHtml(st.nowPlaying)+'</div>':'';
    return '<tr><td><div class="ch-cell"><div class="ch-icon-sm">'+(st.icon||'📻')+'</div><div><div class="ch-name-sm">'+(st.country?countryFlagJs(st.country)+' ':'')+escHtml(st.name)+'</div><div class="ch-id-sm">#'+st.id+'</div>'+npCell+'</div></div></td><td>'+statusBadge(st.status)+'<div style="margin-top:4px;">'+typeBadge+'</div></td><td>'+accessBadge(st.access||'public')+'</td><td>'+genreCell+'</td><td><div style="font-size:11px;color:var(--muted);font-family:monospace;max-width:200px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">'+escHtml(st.url||'—')+'</div></td><td><button class="btn btn-ghost btn-sm" onclick="editStation(\\''+st.id+'\\')">ویرایش</button> <button class="btn btn-ghost btn-sm" onclick="quickEditNowPlaying(\\''+st.id+'\\')">🎧 پخش فعلی</button>'+tracksBtn+' <button class="btn btn-danger btn-sm" onclick="deleteStation(\\''+st.id+'\\')">حذف</button></td></tr>';
  }).join('');
}
function initIconPicker(){const icons=['📻','🎵','🎶','📡','🎧','📰','🎻','🎤','🌍','⚡'];document.getElementById('icon-picker').innerHTML=icons.map(ic=>'<div class="icon-opt'+(ic===selectedIcon?' selected':'')+'" onclick="selectIcon(\\''+ic+'\\',this)">'+ic+'</div>').join('');}
function selectIcon(ic,el){selectedIcon=ic;document.querySelectorAll('.icon-opt').forEach(e=>e.classList.remove('selected'));el.classList.add('selected');}
function validateAddForm(){
  const id=document.getElementById('f-id').value.trim(),name=document.getElementById('f-name').value.trim();
  const idTaken=stations.some(s=>s.id===id&&s.id!==editingId);
  const ok=id&&!idTaken&&name;const btn=document.getElementById('btn-submit');btn.disabled=!ok;btn.style.opacity=ok?'1':'.4';
}
function onTypeChange(){
  const type=document.getElementById('f-type').value;
  const isHls=type==='hls';
  const isPlaylist=type==='playlist';
  document.getElementById('f-suffix-wrap').style.display=isHls?'flex':'none';
  document.getElementById('f-url-wrap').style.display=isPlaylist?'none':'block';
  document.getElementById('f-playlist-hint').style.display=isPlaylist?'block':'none';
  document.getElementById('f-url-label').textContent=isHls?'آدرس پایه استریم HLS (بدون پسوند)':'آدرس مستقیم استریم صوتی (mp3/aac)';
}
async function submitForm(){
  const payload={id:document.getElementById('f-id').value.trim(),name:document.getElementById('f-name').value.trim(),url:document.getElementById('f-url').value.trim(),status:document.getElementById('f-status').value,access:document.getElementById('f-access').value,genre:document.getElementById('f-genre').value,icon:selectedIcon,type:document.getElementById('f-type').value,playlistSuffix:document.getElementById('f-suffix').value.trim()||'/index.m3u8',nowPlaying:document.getElementById('f-nowplaying').value.trim(),country:document.getElementById('f-country').value};
  try{
    let res;
    if(editingId) res=await fetch('/admin/api/stations/'+editingId,{method:'PUT',credentials:'include',body:JSON.stringify(payload)});
    else res=await fetch('/admin/api/stations',{credentials:'include',method:'POST',body:JSON.stringify(payload)});
    if(res.ok){showToast(editingId?'ویرایش شد ✓':'اضافه شد ✓');await loadStations();resetForm();goto('stations',document.querySelectorAll('.nav-item')[0]);}
    else showToast('خطا در ذخیره ❌');
  }catch(e){showToast('خطا در سرور ❌');}
}
function resetForm(){
  editingId=null;selectedIcon='📻';
  document.getElementById('f-id').value='';document.getElementById('f-id').disabled=false;
  document.getElementById('f-name').value='';document.getElementById('f-url').value='';
  document.getElementById('f-status').value='live';document.getElementById('f-access').value='public';document.getElementById('f-genre').value='';
  document.getElementById('f-country').value='';
  document.getElementById('f-type').value='direct';document.getElementById('f-suffix').value='';document.getElementById('f-nowplaying').value='';
  onTypeChange();
  document.getElementById('form-heading').textContent='افزودن ایستگاه جدید';
  initIconPicker();validateAddForm();
}
function editStation(id){
  const st=stations.find(s=>s.id===id);if(!st)return;
  editingId=id;selectedIcon=st.icon||'📻';
  document.getElementById('f-id').value=st.id;document.getElementById('f-id').disabled=true;
  document.getElementById('f-name').value=st.name;document.getElementById('f-url').value=st.url;
  document.getElementById('f-status').value=st.status;document.getElementById('f-access').value=st.access||'public';document.getElementById('f-genre').value=st.genre||'';
  document.getElementById('f-country').value=st.country||'';
  document.getElementById('f-type').value=st.type||'direct';document.getElementById('f-suffix').value=st.playlistSuffix||'';document.getElementById('f-nowplaying').value=st.nowPlaying||'';
  onTypeChange();
  document.getElementById('form-heading').textContent='ویرایش: '+st.name;
  initIconPicker();validateAddForm();goto('add',document.querySelectorAll('.nav-item')[1]);
}
async function quickEditNowPlaying(id){
  const st=stations.find(s=>s.id===id);if(!st)return;
  const val=prompt('متن «در حال پخش» برای «'+st.name+'»:',st.nowPlaying||'');
  if(val===null)return;
  try{
    const res=await fetch('/admin/api/stations/'+id,{method:'PUT',credentials:'include',body:JSON.stringify({nowPlaying:val.trim()})});
    if(res.ok){showToast('بروزرسانی شد ✓');await loadStations();}else showToast('خطا ❌');
  }catch(e){showToast('خطا در سرور ❌');}
}
async function deleteStation(id){
  const st=stations.find(s=>s.id===id);if(!st)return;
  if(!confirm('ایستگاه "'+st.name+'" حذف شود؟'))return;
  try{const res=await fetch('/admin/api/stations/'+id,{method:'DELETE',credentials:'include'});if(res.ok){await loadStations();showToast('حذف شد ✓');}}catch(e){showToast('خطا ❌');}
}

let healthRunning=false;
function renderHealthTable(){
  const tbody=document.getElementById('health-tbody');
  if(!stations.length){tbody.innerHTML='<tr class="tbl-empty"><td colspan="4">ایستگاهی وجود ندارد</td></tr>';return;}
  tbody.innerHTML=stations.map(st=>{
    const r=healthResults[st.id]||st.lastCheck;
    const badge=r?(r.status==='live'||st.status==='live'?'<span class="badge b-live">✓ فعال</span>':'<span class="badge b-error">✗ خطا</span>'):'<span class="badge b-none">—</span>';
    return '<tr><td><div class="ch-cell"><div class="ch-icon-sm">'+(st.icon||'📻')+'</div>'+escHtml(st.name)+'</div></td><td>'+badge+'</td><td>'+(r&&r.latency?r.latency+'ms':'—')+'</td><td>'+(r&&r.httpCode?r.httpCode:'—')+'</td><td><button class="btn btn-ghost btn-sm" onclick="openUptimeChart(\\''+st.id+'\\',\\''+escHtml(st.name).replace(/'/g,"\\\\'")+'\\')">📈 چارت</button></td></tr>';
  }).join('');
}
async function runHealthCheck(){
  if(healthRunning)return;healthRunning=true;
  try{const res=await fetch('/admin/api/health/run',{credentials:'include',method:'POST'});const data=await res.json();if(data.results)data.results.forEach(r=>{healthResults[r.id]=r;});await loadStations();}catch(e){showToast('خطا ❌');}
  healthRunning=false;renderHealthTable();
}
async function deleteErrorStations(){
  const errCount=stations.filter(s=>s.status==='error').length;
  if(!errCount){showToast('هیچ ایستگاه خطاداری نیست');return;}
  if(!confirm(errCount+' ایستگاه خطادار حذف شوند؟'))return;
  try{const res=await fetch('/admin/api/stations/delete-errors',{credentials:'include',method:'POST'});const data=await res.json();if(res.ok){await loadStations();renderHealthTable();showToast(data.removed+' حذف شد ✓');}}catch(e){showToast('خطا ❌');}
}

function initColorPicker(){document.getElementById('color-row').innerHTML=CAT_COLORS.map(c=>'<div class="color-opt'+(c===selectedColor?' selected':'')+'" style="background:'+c+'" onclick="selectColor(\\''+c+'\\',this)"></div>').join('');}
function selectColor(c,el){selectedColor=c;document.querySelectorAll('.color-opt').forEach(e=>e.classList.remove('selected'));el.classList.add('selected');}
function validateCatForm(){const n=document.getElementById('cf-name').value.trim();const btn=document.getElementById('btn-cat-submit');btn.disabled=!n;btn.style.opacity=n?'1':'.4';}
async function submitCat(){
  const name=document.getElementById('cf-name').value.trim();const icon=document.getElementById('cf-icon').value.trim()||'🎵';if(!name)return;
  try{
    let res;
    if(editingCatId) res=await fetch('/admin/api/genres/'+editingCatId,{method:'PUT',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,icon,color:selectedColor})});
    else res=await fetch('/admin/api/genres',{credentials:'include',method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,icon,color:selectedColor})});
    if(res.ok){showToast('ذخیره شد ✓');await loadStations();resetCatForm();}else{const d=await res.json();showToast(d.error||'خطا ❌');}
  }catch(e){showToast('خطا ❌');}
}
function resetCatForm(){editingCatId=null;selectedColor='#4da6ff';document.getElementById('cf-name').value='';document.getElementById('cf-icon').value='';document.getElementById('cat-form-heading').textContent='افزودن ژانر جدید';initColorPicker();validateCatForm();}
function renderCatGrid(){
  const grid=document.getElementById('cat-grid');
  if(!genres.length){grid.innerHTML='<div style="color:var(--muted);font-size:13px;">هنوز ژانری اضافه نشده</div>';return;}
  grid.innerHTML=genres.map(g=>{
    const cnt=stations.filter(s=>s.genre===g.id).length;
    return '<div class="cat-card"><div class="cat-icon-big" style="background:'+g.color+'22;">'+g.icon+'</div><div style="flex:1;"><div style="font-weight:600;color:'+g.color+';">'+escHtml(g.name)+'</div><div style="font-size:12px;color:var(--muted);">'+cnt+' ایستگاه</div></div><button class="btn btn-ghost btn-sm" onclick="editCat(\\''+g.id+'\\')">ویرایش</button><button class="btn btn-danger btn-sm" onclick="deleteCat(\\''+g.id+'\\')">حذف</button></div>';
  }).join('');
}
function editCat(id){const g=genres.find(x=>x.id===id);if(!g)return;editingCatId=id;selectedColor=g.color;document.getElementById('cf-name').value=g.name;document.getElementById('cf-icon').value=g.icon;document.getElementById('cat-form-heading').textContent='ویرایش: '+g.name;initColorPicker();validateCatForm();}
async function deleteCat(id){
  const g=genres.find(x=>x.id===id);if(!g)return;
  if(!confirm('ژانر "'+g.name+'" حذف شود؟'))return;
  try{const res=await fetch('/admin/api/genres/'+id,{method:'DELETE',credentials:'include'});if(res.ok){await loadStations();showToast('حذف شد ✓');}}catch(e){showToast('خطا ❌');}
}

async function loadListenStats(){
  const tbody=document.getElementById('listens-tbody');
  tbody.innerHTML='<tr><td colspan="6" style="text-align:center;padding:2rem;color:var(--muted);">در حال بارگذاری...</td></tr>';
  try{
    const res=await fetch('/admin/api/stats/listens',{credentials:'include'});
    const data=await res.json();
    const totalAll=data.reduce((s,c)=>s+c.listens.total,0),todayAll=data.reduce((s,c)=>s+c.listens.today,0),yAll=data.reduce((s,c)=>s+c.listens.yesterday,0);
    document.getElementById('listens-hero').innerHTML='<div class="stat-card blue"><div class="stat-label">کل شنیده‌شده</div><div class="stat-val">'+totalAll+'</div></div><div class="stat-card green"><div class="stat-label">امروز</div><div class="stat-val">'+todayAll+'</div></div><div class="stat-card"><div class="stat-label">دیروز</div><div class="stat-val">'+yAll+'</div></div>';
    renderListensBarChart(data.slice(0,10));
    if(!data.length){tbody.innerHTML='<tr class="tbl-empty"><td colspan="6">داده‌ای نیست</td></tr>';return;}
    tbody.innerHTML=data.map((c,i)=>'<tr><td>#'+(i+1)+'</td><td><div class="ch-cell"><div class="ch-icon-sm">'+(c.icon||'📻')+'</div>'+escHtml(c.name)+'</div></td><td>'+statusBadge(c.status)+'</td><td>'+accessBadge(c.access||'public')+'</td><td>امروز: '+c.listens.today+' / دیروز: '+c.listens.yesterday+'</td><td><strong>'+c.listens.total+'</strong></td></tr>').join('');
  }catch(e){tbody.innerHTML='<tr class="tbl-empty"><td colspan="6">خطا در بارگذاری</td></tr>';}
}
function renderListensBarChart(top){
  const wrap=document.getElementById('listens-chart-wrap');
  if(!wrap)return;
  if(!top||!top.length){wrap.innerHTML='';return;}
  const max=Math.max(...top.map(t=>t.listens.total),1);
  const rowH=28,gap=8,chartW=560,labelW=130,barMaxW=chartW-labelW-50;
  let rows='';
  top.forEach((t,i)=>{
    const y=i*(rowH+gap);
    const w=Math.max(4,Math.round((t.listens.total/max)*barMaxW));
    const color='hsl('+(28+i*10)+',85%,60%)';
    rows+='<text x="'+labelW+'" y="'+(y+rowH/2-4)+'" fill="var(--text2)" font-size="11" text-anchor="end" font-family="Vazirmatn,sans-serif">'+escHtml(t.name.length>18?t.name.slice(0,18)+'…':t.name)+'</text>'+
      '<rect x="'+(labelW+8)+'" y="'+y+'" width="'+w+'" height="'+rowH+'" rx="6" fill="'+color+'"><title>'+t.listens.total+'</title></rect>'+
      '<text x="'+(labelW+16+w)+'" y="'+(y+rowH/2+4)+'" fill="var(--text)" font-size="11" font-family="Vazirmatn,sans-serif">'+t.listens.total+'</text>';
  });
  const svgH=top.length*(rowH+gap);
  wrap.innerHTML='<svg width="100%" height="'+svgH+'" viewBox="0 0 '+chartW+' '+svgH+'" style="display:block;direction:ltr;">'+rows+'</svg>';
}

async function loadUsers(){
  try{const res=await fetch('/admin/api/users',{credentials:'include'});if(res.ok)users=await res.json();renderUserStats();renderUsersTable();}catch(e){showToast('خطا ❌');}
}
function renderUserStats(){
  const total=users.length,subs=users.filter(u=>u.tier==='sub').length,vips=users.filter(u=>u.tier==='vip').length,none=users.filter(u=>!u.tier||u.tier==='none').length;
  document.getElementById('user-stats-row').innerHTML='<div class="stat-card"><div class="stat-label">کل کاربران</div><div class="stat-val">'+total+'</div></div><div class="stat-card blue"><div class="stat-label">اشتراک</div><div class="stat-val">'+subs+'</div></div><div class="stat-card gold"><div class="stat-label">VIP</div><div class="stat-val">'+vips+'</div></div><div class="stat-card"><div class="stat-label">بدون اشتراک</div><div class="stat-val">'+none+'</div></div>';
}
function renderUsersTable(){
  const q=(document.getElementById('user-search').value||'').toLowerCase();const tf=document.getElementById('user-tier-filter').value;
  const list=users.filter(u=>{const mq=!q||u.username.toLowerCase().includes(q);const mt=tf==='all'||(u.tier||'none')===tf;return mq&&mt;});
  const tbody=document.getElementById('users-tbody');
  if(!list.length){tbody.innerHTML='<tr class="tbl-empty"><td colspan="5">کاربری یافت نشد</td></tr>';return;}
  tbody.innerHTML=list.map(u=>{
    const tier=u.tier||'none';
    const dateStr=u.createdAt?new Date(u.createdAt).toLocaleDateString('fa-IR'):'—';
    return '<tr><td><strong>'+escHtml(u.username)+'</strong></td><td>'+accessBadge(tier==='none'?'public':tier)+' <select onchange="changeTier(\\''+escHtml(u.username)+'\\',this.value)" style="margin-right:6px;"><option value="none"'+(tier==='none'?' selected':'')+'>بدون اشتراک</option><option value="sub"'+(tier==='sub'?' selected':'')+'>اشتراک</option><option value="vip"'+(tier==='vip'?' selected':'')+'>VIP</option></select></td><td>'+(u.favorites||0)+' ایستگاه</td><td>'+dateStr+'</td><td><button class="btn btn-danger btn-sm" onclick="deleteUser(\\''+escHtml(u.username)+'\\')">حذف</button></td></tr>';
  }).join('');
}
async function changeTier(username,newTier){
  try{const res=await fetch('/admin/api/users/'+encodeURIComponent(username),{method:'PUT',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({tier:newTier})});if(res.ok){showToast('بروزرسانی شد ✓');await loadUsers();}else showToast('خطا ❌');}catch(e){showToast('خطا ❌');}
}
async function deleteUser(username){
  if(!confirm('کاربر "'+username+'" حذف شود؟'))return;
  try{const res=await fetch('/admin/api/users/'+encodeURIComponent(username),{method:'DELETE',credentials:'include'});if(res.ok){showToast('حذف شد ✓');await loadUsers();}else showToast('خطا ❌');}catch(e){showToast('خطا ❌');}
}

async function loadPaymentSettings(){
  try{const res=await fetch('/admin/api/settings/payment',{credentials:'include'});const data=await res.json();document.getElementById('tron-address-display').textContent=data.tronAddress||'(تنظیم نشده)';document.getElementById('sub-price').value=data.subPrice||'10';document.getElementById('payment-instructions').value=data.paymentInstructions||'';}catch(e){}
}
async function savePaymentSettings(){
  try{const res=await fetch('/admin/api/settings/payment',{credentials:'include',method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({subPrice:document.getElementById('sub-price').value.trim(),paymentInstructions:document.getElementById('payment-instructions').value})});if(res.ok)showToast('ذخیره شد ✓');else showToast('خطا ❌');}catch(e){showToast('خطا ❌');}
}

async function loadTelegramStatus(){
  const indicator=document.getElementById('tg-indicator'),text=document.getElementById('tg-status-text');
  try{
    const res=await fetch('/admin/api/settings/telegram',{credentials:'include'});const data=await res.json();
    const ready=data.botTokenSet&&data.chatIdSet;indicator.classList.toggle('on',ready);indicator.classList.toggle('off',!ready);
    text.textContent=ready?'✅ تلگرام تنظیم شده':'❌ تنظیم نشده';
  }catch(e){text.textContent='خطا';}
}
async function testTelegram(){
  const resultEl=document.getElementById('tg-test-result');resultEl.textContent='در حال ارسال...';
  try{const res=await fetch('/admin/api/settings/telegram',{credentials:'include',method:'POST'});const data=await res.json();if(res.ok){resultEl.style.color='var(--green)';resultEl.textContent='✓ '+(data.message||'ارسال شد');}else{resultEl.style.color='var(--red)';resultEl.textContent='✗ '+(data.error||'خطا');}}catch(e){resultEl.textContent='خطا در ارتباط با سرور';}
}

function exportBackup(){window.open('/admin/api/backup/export','_blank');showToast('در حال دانلود...');}
function onBackupFileSelected(e){
  const file=e.target.files[0];if(!file)return;
  const reader=new FileReader();
  reader.onload=async(ev)=>{
    let parsed;try{parsed=JSON.parse(ev.target.result);}catch(err){showToast('فایل JSON معتبر نیست ❌');return;}
    const box=document.getElementById('backup-result-box');box.style.display='block';box.innerHTML='در حال بازگردانی...';
    try{
      const res=await fetch('/admin/api/backup/import',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify(parsed)});
      const data=await res.json();
      if(!res.ok){box.innerHTML='❌ '+(data.error||'خطا');return;}
      const r=data.results||{};
      box.innerHTML='✅ بازگردانی انجام شد:<br>📻 '+(r.stations||0)+' ایستگاه<br>📂 '+(r.genres||0)+' ژانر<br>👥 '+(r.users||0)+' کاربر بروزرسانی شد';
      showToast('بازگردانی موفق ✓');await loadStations();
    }catch(e){box.innerHTML='❌ خطا در ارتباط با سرور';}
  };
  reader.readAsText(file,'UTF-8');
}

async function loadErrorLogs(){
  const wrap=document.getElementById('error-logs-list');
  wrap.innerHTML='<div style="text-align:center;padding:2rem;color:var(--muted);">در حال بارگذاری...</div>';
  try{
    const res=await fetch('/admin/api/error-logs',{credentials:'include'});
    const logs=await res.json();
    if(!logs.length){wrap.innerHTML='<div style="text-align:center;padding:2rem;color:var(--muted);">خطایی ثبت نشده — همه‌چیز روبراهه ✅</div>';return;}
    const sourceLabel=s=>({stream_proxy:'📡 پروکسی استریم',health_check:'💓 بررسی سلامت',worker_exception:'💥 خطای داخلی',cron:'⏰ Cron'})[s]||s;
    wrap.innerHTML=logs.map(l=>'<div class="log-row"><span style="min-width:120px;">'+sourceLabel(l.source)+'</span><span style="flex:1;color:var(--text2);">'+escHtml(l.message)+'</span><span class="log-time">'+new Date(l.at).toLocaleString('fa-IR')+'</span></div>').join('');
  }catch(e){wrap.innerHTML='<div style="text-align:center;padding:2rem;color:var(--red);">خطا در بارگذاری</div>';}
}

function onM3UFileSelected(e){
  const file=e.target.files[0];if(!file)return;
  const reader=new FileReader();
  reader.onload=(ev)=>{document.getElementById('m3u-textarea').value=ev.target.result;};
  reader.readAsText(file,'UTF-8');
}
async function importM3UText(){
  const text=document.getElementById('m3u-textarea').value;
  const box=document.getElementById('m3u-result-box');
  if(!text.trim()){showToast('محتوای M3U را وارد کن یا فایل انتخاب کن');return;}
  box.style.display='block';box.innerHTML='در حال وارد کردن...';
  try{
    const res=await fetch('/admin/api/import/m3u',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})});
    const data=await res.json();
    if(!res.ok){box.innerHTML='❌ '+(data.error||'خطا');return;}
    box.innerHTML='✅ '+data.added+' ایستگاه از '+data.total+' مورد اضافه شد';
    showToast('وارد شد ✓');document.getElementById('m3u-textarea').value='';
    await loadStations();
  }catch(e){box.innerHTML='❌ خطا در ارتباط با سرور';}
}

async function loadLogs(){
  try{
    const res=await fetch('/admin/api/tier-logs',{credentials:'include'});const logs=await res.json();
    const container=document.getElementById('logs-list');
    if(!logs.length){container.innerHTML='<div style="text-align:center;padding:2rem;color:var(--muted);">لاگی وجود ندارد</div>';return;}
    const tierLabel=t=>t==='vip'?'🌟 VIP':t==='sub'?'✅ اشتراک':'👤 بدون اشتراک';
    container.innerHTML=logs.map(l=>'<div class="log-row"><strong>'+escHtml(l.username)+'</strong><span>'+tierLabel(l.fromTier)+' → '+tierLabel(l.toTier)+'</span><span class="log-time">'+new Date(l.at).toLocaleString('fa-IR')+'</span></div>').join('');
  }catch(e){showToast('خطا ❌');}
}

// ══ امنیت: مسدودسازی IP و لاگ فعالیت ══════════════════════════
async function loadBlockedIPs(){
  const wrap=document.getElementById('blocked-ips-list');
  wrap.textContent='در حال بارگذاری...';
  try{
    const res=await fetch('/admin/api/blocked-ips',{credentials:'include'});
    const list=await res.json();
    if(!list.length){wrap.innerHTML='<div style="padding:8px 0;color:var(--muted);">هیچ IP مسدودی وجود ندارد</div>';return;}
    wrap.innerHTML=list.map(b=>'<div style="display:flex;align-items:center;gap:10px;padding:8px 10px;background:var(--bg3);border-radius:8px;margin-bottom:6px;"><span style="font-family:monospace;flex:1;">'+escHtml(b.ip)+'</span><span style="color:var(--muted);flex:1;">'+escHtml(b.reason||'—')+'</span><button class="btn btn-ghost btn-sm" onclick="unblockIP(\\''+escHtml(b.ip)+'\\')">رفع مسدودیت</button></div>').join('');
  }catch(e){wrap.innerHTML='<div style="color:var(--red);">خطا در بارگذاری</div>';}
}
async function blockIP(){
  const ip=document.getElementById('block-ip-input').value.trim();
  const reason=document.getElementById('block-ip-reason').value.trim();
  if(!ip){showToast('IP را وارد کن');return;}
  try{
    const res=await fetch('/admin/api/blocked-ips',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({ip,reason})});
    if(res.ok){showToast('مسدود شد ✓');document.getElementById('block-ip-input').value='';document.getElementById('block-ip-reason').value='';loadBlockedIPs();}else showToast('خطا ❌');
  }catch(e){showToast('خطا در سرور ❌');}
}
async function unblockIP(ip){
  try{const res=await fetch('/admin/api/blocked-ips/'+encodeURIComponent(ip),{method:'DELETE',credentials:'include'});if(res.ok){showToast('رفع مسدودیت شد ✓');loadBlockedIPs();}else showToast('خطا ❌');}catch(e){showToast('خطا در سرور ❌');}
}
async function loadActivityLogs(){
  const wrap=document.getElementById('activity-logs-list');
  wrap.innerHTML='<div style="text-align:center;padding:2rem;color:var(--muted);">در حال بارگذاری...</div>';
  try{
    const res=await fetch('/admin/api/activity-logs',{credentials:'include'});
    const logs=await res.json();
    if(!logs.length){wrap.innerHTML='<div style="text-align:center;padding:2rem;color:var(--muted);">لاگی وجود ندارد</div>';return;}
    const actionLabel=a=>({signup:'👤 ثبت‌نام',login:'🔓 ورود',logout:'🔒 خروج',change_password:'🔑 تغییر رمز'})[a]||a;
    wrap.innerHTML=logs.map(l=>'<div class="log-row"><strong>'+escHtml(l.username)+'</strong><span>'+actionLabel(l.action)+'</span><span style="color:var(--muted);font-family:monospace;font-size:11px;">'+escHtml(l.ip||'')+'</span><span class="log-time">'+new Date(l.at).toLocaleString('fa-IR')+'</span></div>').join('');
  }catch(e){wrap.innerHTML='<div style="text-align:center;padding:2rem;color:var(--red);">خطا در بارگذاری</div>';}
}

// ══ چارت Uptime (SVG، بدون کتابخانه خارجی) ══════════════════════════
async function openUptimeChart(stationId,name){
  document.getElementById('uptime-chart-station-name').textContent=name||'';
  document.getElementById('uptime-chart-modal').classList.add('open');
  document.getElementById('uptime-chart-summary').innerHTML='';
  document.getElementById('uptime-chart-svg-wrap').innerHTML='<div style="text-align:center;padding:2rem;color:var(--muted);">در حال بارگذاری...</div>';
  try{
    const res=await fetch('/admin/api/uptime/'+stationId,{credentials:'include'});
    const history=await res.json();
    renderUptimeChart(history);
  }catch(e){document.getElementById('uptime-chart-svg-wrap').innerHTML='<div style="text-align:center;padding:2rem;color:var(--red);">خطا در بارگذاری</div>';}
}
function closeUptimeChart(){document.getElementById('uptime-chart-modal').classList.remove('open');}
function renderUptimeChart(history){
  const wrap=document.getElementById('uptime-chart-svg-wrap');
  const summary=document.getElementById('uptime-chart-summary');
  if(!history||!history.length){
    wrap.innerHTML='<div style="text-align:center;padding:2rem;color:var(--muted);">هنوز داده‌ی سلامتی برای این ایستگاه ثبت نشده — یک بار «بررسی همه» را بزن.</div>';
    summary.innerHTML='';
    return;
  }
  const total=history.length;
  const upCount=history.filter(h=>h.status==='live').length;
  const uptimePct=Math.round((upCount/total)*1000)/10;
  const latencies=history.filter(h=>h.latency!=null).map(h=>h.latency);
  const avgLatency=latencies.length?Math.round(latencies.reduce((a,b)=>a+b,0)/latencies.length):null;
  summary.innerHTML=
    '<div class="stat-card '+(uptimePct>=95?'green':(uptimePct>=80?'gold':'red'))+'" style="flex:1;min-width:120px;"><div class="stat-label">درصد فعال بودن</div><div class="stat-val">'+uptimePct+'%</div></div>'+
    '<div class="stat-card blue" style="flex:1;min-width:120px;"><div class="stat-label">میانگین تأخیر</div><div class="stat-val">'+(avgLatency!=null?avgLatency+'ms':'—')+'</div></div>'+
    '<div class="stat-card" style="flex:1;min-width:120px;"><div class="stat-label">تعداد بررسی</div><div class="stat-val">'+total+'</div></div>';

  const barW=8,barGap=3,chartH=140,maxLatency=Math.max(...latencies,1);
  const svgW=total*(barW+barGap)+20;
  let bars='';
  history.forEach((h,i)=>{
    const x=10+i*(barW+barGap);
    const isUp=h.status==='live';
    const latH=h.latency!=null?Math.max(4,Math.round((h.latency/maxLatency)*chartH)):4;
    const y=chartH-latH;
    const color=isUp?'var(--green)':'var(--red)';
    const title=(isUp?'✓ فعال':'✗ خطا')+' — '+(h.latency!=null?h.latency+'ms':'—')+' — '+new Date(h.at).toLocaleString('fa-IR');
    bars+='<rect x="'+x+'" y="'+y+'" width="'+barW+'" height="'+latH+'" fill="'+color+'" rx="2"><title>'+title.replace(/&/g,'&amp;').replace(/</g,'&lt;')+'</title></rect>';
  });
  wrap.innerHTML='<svg width="'+svgW+'" height="'+(chartH+10)+'" viewBox="0 0 '+svgW+' '+(chartH+10)+'" style="display:block;">'+bars+'</svg>';
}

// ══ مدیریت آهنگ‌های ایستگاه playlist ══════════════════════════
function openTracksModal(stationId){
  const st=stations.find(s=>s.id===stationId);if(!st)return;
  currentTracksStationId=stationId;
  document.getElementById('tracks-station-name').textContent=st.name;
  document.getElementById('tracks-modal').classList.add('open');
  loadTracks();
}
function closeTracksModal(){document.getElementById('tracks-modal').classList.remove('open');currentTracksStationId=null;}
async function loadTracks(){
  const wrap=document.getElementById('tracks-list');
  wrap.innerHTML='<div style="text-align:center;padding:1.5rem;color:var(--muted);font-size:12.5px;">در حال بارگذاری...</div>';
  try{
    const res=await fetch('/admin/api/stations/'+currentTracksStationId+'/tracks',{credentials:'include'});
    currentTracks=await res.json();
    renderTracksList();
  }catch(e){wrap.innerHTML='<div style="text-align:center;padding:1.5rem;color:var(--red);">خطا در بارگذاری</div>';}
}
function fmtBytes(n){if(!n)return'—';if(n<1024)return n+' B';if(n<1024*1024)return(n/1024).toFixed(1)+' KB';return(n/1024/1024).toFixed(1)+' MB';}
function renderTracksList(){
  const wrap=document.getElementById('tracks-list');
  if(!currentTracks.length){wrap.innerHTML='<div style="text-align:center;padding:1.5rem;color:var(--muted);font-size:12.5px;">هنوز آهنگی آپلود نشده</div>';return;}
  wrap.innerHTML=currentTracks.map((t,i)=>'<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--bg3);border-radius:8px;font-size:12.5px;">'+
    '<span style="color:var(--muted);font-family:monospace;min-width:20px;">'+(i+1)+'</span>'+
    '<span style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">🎵 '+escHtml(t.name)+'</span>'+
    '<span style="color:var(--muted);font-size:11px;">'+fmtBytes(t.size)+'</span>'+
    '<button class="btn btn-ghost btn-sm" '+(i===0?'disabled style="opacity:.3;"':'')+' onclick="moveTrack('+i+',-1)">▲</button>'+
    '<button class="btn btn-ghost btn-sm" '+(i===currentTracks.length-1?'disabled style="opacity:.3;"':'')+' onclick="moveTrack('+i+',1)">▼</button>'+
    '<button class="btn btn-danger btn-sm" onclick="deleteTrack(\\''+t.id+'\\')">حذف</button>'+
  '</div>').join('');
}
async function moveTrack(idx,dir){
  const newIdx=idx+dir;
  if(newIdx<0||newIdx>=currentTracks.length)return;
  const arr=[...currentTracks];
  [arr[idx],arr[newIdx]]=[arr[newIdx],arr[idx]];
  currentTracks=arr;renderTracksList();
  try{await fetch('/admin/api/stations/'+currentTracksStationId+'/tracks-reorder',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({order:arr.map(t=>t.id)})});}catch(e){showToast('خطا در ذخیره ترتیب ❌');}
}
async function deleteTrack(trackId){
  if(!confirm('این آهنگ حذف شود؟'))return;
  try{
    const res=await fetch('/admin/api/stations/'+currentTracksStationId+'/tracks/'+trackId,{method:'DELETE',credentials:'include'});
    if(res.ok){showToast('حذف شد ✓');await loadTracks();}else showToast('خطا ❌');
  }catch(e){showToast('خطا در سرور ❌');}
}
async function onTrackFileSelected(e){
  const file=e.target.files[0];if(!file)return;
  const wrap=document.getElementById('track-progress-wrap');const bar=document.getElementById('track-progress-bar');
  wrap.style.display='block';bar.style.width='20%';
  const fd=new FormData();fd.append('file',file);
  try{
    bar.style.width='60%';
    const res=await fetch('/admin/api/stations/'+currentTracksStationId+'/tracks',{method:'POST',credentials:'include',body:fd});
    bar.style.width='100%';
    const data=await res.json();
    if(!res.ok){showToast(data.error||'خطا در آپلود ❌');setTimeout(()=>wrap.style.display='none',400);return;}
    showToast('آهنگ اضافه شد ✓');
    setTimeout(()=>{wrap.style.display='none';bar.style.width='0%';},500);
    await loadTracks();
  }catch(err){showToast('خطا در ارتباط با سرور ❌');wrap.style.display='none';}
  e.target.value='';
}

// ══ تم روشن/تیره: پیش‌فرض خودکار بر اساس سیستم، با امکان تغییر دستی ══
const THEME_STORAGE_KEY='radiofa_admin_theme'; // 'light' | 'dark' | absent = auto
function systemPrefersDark(){return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;}
function applyTheme(theme, isAuto){
  document.documentElement.setAttribute('data-theme', theme);
  const label=document.getElementById('theme-mode-label');
  const knob=document.getElementById('ts-knob');
  if(label) label.textContent = isAuto ? 'خودکار' : (theme==='dark'?'تیره':'روشن');
  if(knob) knob.textContent = isAuto ? '🌓' : (theme==='dark'?'🌙':'☀️');
}
function getEffectiveTheme(){
  const saved=localStorage.getItem(THEME_STORAGE_KEY);
  if(saved==='light'||saved==='dark') return {theme:saved, isAuto:false};
  return {theme: systemPrefersDark()?'dark':'light', isAuto:true};
}
function initTheme(){
  const {theme,isAuto}=getEffectiveTheme();
  applyTheme(theme,isAuto);
  if(window.matchMedia){
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e)=>{
      const saved=localStorage.getItem(THEME_STORAGE_KEY);
      if(saved==='light'||saved==='dark') return; // کاربر دستی انتخاب کرده، دخالت نکن
      applyTheme(e.matches?'dark':'light', true);
    });
  }
}
function toggleTheme(){
  const current=document.documentElement.getAttribute('data-theme')||'dark';
  const next = current==='dark' ? 'light' : 'dark';
  localStorage.setItem(THEME_STORAGE_KEY, next);
  applyTheme(next, false);
  const sw=document.getElementById('theme-switch');
  sw.style.transform='scale(0.94)';
  setTimeout(()=>{sw.style.transform='';},150);
}
initTheme();

initIconPicker();initColorPicker();populateCountrySelect();onTypeChange();loadStations();
</script>
</body>
</html>`;
}