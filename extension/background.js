// Reddit Reels Bridge Background Service Worker (Manifest V3)

let redgifsToken = null;
let redgifsTokenExpiry = 0;
let currentModhash = null;

// Automatically ensure Reddit's over18 cookie is set to bypass NSFW age gates
async function ensureOver18Cookie() {
  try {
    await chrome.cookies.set({
      url: "https://www.reddit.com",
      name: "over18",
      value: "1",
      domain: ".reddit.com",
      path: "/",
      secure: true
    });
  } catch (err) {
    console.warn("Failed to set over18 cookie:", err);
  }
}
ensureOver18Cookie();
if (chrome.runtime?.onInstalled) chrome.runtime.onInstalled.addListener(ensureOver18Cookie);
if (chrome.runtime?.onStartup) chrome.runtime.onStartup.addListener(ensureOver18Cookie);

// Check Reddit session cookies and user info
let cachedRedditUser = null;

async function checkRedditSession() {
  await ensureOver18Cookie();
  try {
    const cookies = await chrome.cookies.getAll({ domain: "reddit.com" });
    const hasSession = cookies.some((c) => c.name === "reddit_session" || c.name === "token");
    const cookieNames = cookies.map((c) => c.name);
    let username = cachedRedditUser;

    if (hasSession && !username) {
      try {
        const meRes = await fetch("https://www.reddit.com/api/me.json", {
          credentials: "include",
          headers: { Accept: "application/json" }
        });
        if (meRes.ok) {
          const meData = await meRes.json();
          if (meData?.data?.name) {
            username = meData.data.name;
            cachedRedditUser = username;
            if (meData?.data?.modhash) {
              currentModhash = meData.data.modhash;
            }
          }
        }
      } catch (_) {}
    }

    return {
      loggedIn: hasSession,
      hasSessionCookie: hasSession,
      username: username ? `u/${username}` : (hasSession ? "Logged In" : "Guest"),
      cookieCount: cookies.length,
      cookieNames
    };
  } catch (err) {
    console.warn("Failed to check cookies:", err);
    return { loggedIn: false, error: err.message };
  }
}

// Fetch with strict timeout to prevent hangs when ISP drops or blocks connections
async function fetchWithTimeout(url, options = {}, timeoutMs = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// Fetch or reuse temporary Redgifs auth token
async function getRedgifsToken() {
  const now = Date.now();
  if (redgifsToken && now < redgifsTokenExpiry) {
    return redgifsToken;
  }

  try {
    const res = await fetchWithTimeout("https://api.redgifs.com/v2/auth/temporary", {
      headers: {
        Accept: "application/json"
      }
    }, 2500);

    if (res.ok) {
      const data = await res.json();
      if (data && data.token) {
        redgifsToken = data.token;
        redgifsTokenExpiry = now + 50 * 60 * 1000;
        return redgifsToken;
      }
    }
  } catch (err) {
    console.warn("Redgifs token request timed out or blocked by ISP:", err.message);
  }
  return null;
}

// Extract Redgifs ID from watch/ifr URL or raw ID
function extractRedgifsId(input) {
  if (!input) return null;
  const str = String(input).trim();
  const match = str.match(/(?:watch|ifr)\/([a-zA-Z0-9_\-]+)/i);
  if (match && match[1]) {
    return match[1];
  }
  const urlMatch = str.match(/redgifs\.com\/(?:[a-zA-Z]+\/)?([a-zA-Z0-9_\-]+)/i);
  if (urlMatch && urlMatch[1] && urlMatch[1] !== "watch" && urlMatch[1] !== "ifr") {
    return urlMatch[1];
  }
  const clean = str.replace(/[^a-zA-Z0-9_\-]/g, "");
  return clean || null;
}

function responseLooksLikeVideo(res) {
  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("text/html") || contentType.includes("application/xhtml")) return false;
  if (contentType.includes("video") || contentType.includes("octet-stream")) return true;
  // A range response is media bytes. A 200 HTML block page is not, even when the URL ends in .mp4.
  return res.status === 206;
}

// Stop a ranged probe from keeping a full MP4 when the server ignores Range.
async function cancelResponseBody(res) {
  try {
    await res?.body?.cancel();
  } catch (_) {}
}

// Verify that a video URL actually exists and serves video.
// Headers are enough. The body is cancelled so a 200 that ignores Range
// cannot download the whole file. Playback fetches the winner on its own.
async function verifyVideoUrl(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  let res = null;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        Range: "bytes=0-1024"
      },
      signal: controller.signal
    });
    if ((res.ok || res.status === 206) && responseLooksLikeVideo(res)) {
      return true;
    }
  } catch (e) {
    try {
      const headRes = await fetchWithTimeout(url, { method: "HEAD" }, 2000);
      try {
        if (headRes.ok && responseLooksLikeVideo(headRes)) {
          return true;
        }
      } finally {
        await cancelResponseBody(headRes);
      }
    } catch (ignore) {}
  } finally {
    clearTimeout(timer);
    await cancelResponseBody(res);
    controller.abort();
  }
  return false;
}

// Multi-strategy Redgifs resolver
async function resolveRedgifs(payload) {
  const rawInput = typeof payload === "string" ? payload : payload?.url || payload?.id;
  const hasCachedVideo = typeof payload === "object" && Boolean(payload?.hasCachedVideo);
  const gifId = extractRedgifsId(rawInput);

  if (!gifId) {
    throw new Error(`Invalid Redgifs input: "${rawInput}"`);
  }

  // Strategy 1: Official Redgifs API with temporary token (prefer SD for fast playback & low data)
  try {
    const token = await getRedgifsToken();
    if (token) {
      const apiRes = await fetchWithTimeout(`https://api.redgifs.com/v2/gifs/${encodeURIComponent(gifId.toLowerCase())}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json"
        }
      }, 2500);

      if (apiRes.ok) {
        const apiData = await apiRes.json();
        const urls = apiData?.gif?.urls;
        // Prefer SD (mobile stream) for playback: loads 5x-10x faster and saves huge data.
        // Keep HD url explicitly for download / full quality.
        const sdUrl = urls?.sd || null;
        const hdUrl = urls?.hd || null;
        const candidate = sdUrl || hdUrl;
        if (candidate) {
          return {
            id: gifId,
            videoUrl: candidate,
            sdUrl,
            hdUrl,
            thumbnailUrl: urls?.thumbnail || urls?.poster || null,
            width: apiData?.gif?.width,
            height: apiData?.gif?.height,
            hasAudio: apiData?.gif?.hasAudio !== false,
            strategy: "api"
          };
        }
      }
    }
  } catch (err) {
    console.warn("Redgifs API strategy timed out or blocked by ISP:", err.message);
  }

  // Strategy 4: Direct CDN probe across top hosts (strictly prioritizing mobile stream)
  const mobileCandidates = [
    `https://media.redgifs.com/${gifId.toLowerCase()}-mobile.mp4`,
    `https://files.redgifs.com/${gifId.toLowerCase()}-mobile.mp4`
  ];
  const hdCandidates = [
    `https://media.redgifs.com/${gifId.toLowerCase()}.mp4`,
    `https://files.redgifs.com/${gifId.toLowerCase()}.mp4`
  ];

  try {
    const validMobile = await Promise.any(
      mobileCandidates.map(async (candidate) => {
        const isVideo = await verifyVideoUrl(candidate);
        if (isVideo) return candidate;
        throw new Error("Invalid CDN URL");
      })
    );
    if (validMobile) {
      return {
        id: gifId,
        videoUrl: validMobile,
        sdUrl: validMobile,
        hdUrl: validMobile.replace("-mobile.mp4", ".mp4"),
        hasAudio: true,
        strategy: "cdn_probe_mobile"
      };
    }
  } catch (_) {
    try {
      const validHd = await Promise.any(
        hdCandidates.map(async (candidate) => {
          const isVideo = await verifyVideoUrl(candidate);
          if (isVideo) return candidate;
          throw new Error("Invalid CDN URL");
        })
      );
      if (validHd) {
        return {
          id: gifId,
          videoUrl: validHd,
          sdUrl: null,
          hdUrl: validHd,
          hasAudio: true,
          strategy: "cdn_probe_hd"
        };
      }
    } catch (_) {}
  }

  // If Reddit preview cache is already available, skip slow HTML scraping to avoid UI freezes
  if (!hasCachedVideo) {
    // Strategy 2: Fetch Redgifs iframe page HTML (/ifr/{id})
    try {
      const ifrUrl = `https://www.redgifs.com/ifr/${encodeURIComponent(gifId)}`;
      const pageRes = await fetchWithTimeout(ifrUrl, {
        headers: {
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        }
      }, 2500);

      if (pageRes.ok) {
        const html = await pageRes.text();
        const patterns = [
          /<source\s+[^>]*src=["'](https:\/\/[^"']+\.mp4[^"']*)["']/i,
          /<video\s+[^>]*src=["'](https:\/\/[^"']+\.mp4[^"']*)["']/i,
          /"videoUrl"\s*:\s*"(https:\/\/[^"]+\.mp4[^"]*)"/i,
          /"contentUrl"\s*:\s*"(https:\/\/[^"]+\.mp4[^"]*)"/i,
          /https:\/\/[a-zA-Z0-9_\-.]+\.redgifs\.com\/[a-zA-Z0-9_\-]+\.mp4/gi
        ];

        for (const pattern of patterns) {
          const match = html.match(pattern);
          if (match) {
            const matchedUrl = match[1] || match[0];
            const cleanUrl = matchedUrl.replace(/\\u002F/g, "/").replace(/\\\//g, "/");
            if (cleanUrl.startsWith("http")) {
              return {
                id: gifId,
                videoUrl: cleanUrl,
                hdUrl: cleanUrl,
                hasAudio: true,
                strategy: "iframe_scrape"
              };
            }
          }
        }
      }
    } catch (err) {
      console.warn("Redgifs iframe strategy timed out or blocked by ISP:", err.message);
    }

    // Strategy 3: Fetch Redgifs watch page HTML and parse
    try {
      const watchUrl = `https://www.redgifs.com/watch/${encodeURIComponent(gifId)}`;
      const pageRes = await fetchWithTimeout(watchUrl, {
        headers: {
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        }
      }, 2000);

      if (pageRes.ok) {
        const html = await pageRes.text();
        const patterns = [
          /<meta\s+property=["']og:video["']\s+content=["'](https:\/\/[^"']+\.mp4[^"']*)["']/i,
          /<meta\s+name=["']twitter:player:stream["']\s+content=["'](https:\/\/[^"']+\.mp4[^"']*)["']/i,
          /"videoUrl"\s*:\s*"(https:\/\/[^"]+\.mp4[^"]*)"/i,
          /"contentUrl"\s*:\s*"(https:\/\/[^"]+\.mp4[^"]*)"/i,
          /https:\/\/[a-zA-Z0-9_\-.]+\.redgifs\.com\/[a-zA-Z0-9_\-]+\.mp4/gi
        ];

        for (const pattern of patterns) {
          const match = html.match(pattern);
          if (match) {
            const matchedUrl = match[1] || match[0];
            const cleanUrl = matchedUrl.replace(/\\u002F/g, "/").replace(/\\\//g, "/");
            if (cleanUrl.startsWith("http")) {
              return {
                id: gifId,
                videoUrl: cleanUrl,
                hdUrl: cleanUrl,
                strategy: "scrape"
              };
            }
          }
        }
      }
    } catch (err) {
      console.warn("Redgifs scrape strategy failed or timed out:", err.message);
    }
  }

  // Final Fallback: Return responsive iframe embed instead of throwing error
  return {
    id: gifId,
    videoUrl: null,
    embedUrl: `https://www.redgifs.com/ifr/${encodeURIComponent(gifId)}?autoplay=0`,
    isEmbedFallback: true,
    strategy: "iframe_fallback"
  };
}

// Perform single fetch with credentials and timeout
async function executeRedditFetch(targetUrl) {
  let url = targetUrl;
  if (!url.includes("raw_json=1")) {
    url += (url.includes("?") ? "&" : "?") + "raw_json=1";
  }
  // Cache-busting parameter to ensure Reddit's dynamic feed rotates fresh on every refresh
  url += (url.includes("?") ? "&" : "?") + `_t=${Date.now()}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Cache-Control": "no-cache"
      },
      signal: controller.signal
    });

    clearTimeout(timeoutId);
    return response;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

// Get user modhash for authorized Reddit actions (Save/Unsave)
async function getModhash() {
  if (currentModhash) return currentModhash;
  try {
    const res = await fetch("https://www.reddit.com/api/me.json", {
      credentials: "include",
      headers: { Accept: "application/json" }
    });
    if (res.ok) {
      const data = await res.json();
      if (data?.data?.modhash) {
        currentModhash = data.data.modhash;
        return currentModhash;
      }
    }
  } catch (_) {}
  return "";
}

// Save or unsave post to Reddit account
async function saveToReddit({ id, unsave = false }) {
  if (!id) throw new Error("No post ID provided for saving");
  const fullname = id.startsWith("t3_") ? id : `t3_${id}`;
  const modhash = await getModhash();
  const endpoint = unsave ? "https://www.reddit.com/api/unsave" : "https://www.reddit.com/api/save";

  const res = await fetch(endpoint, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: `id=${encodeURIComponent(fullname)}&uh=${encodeURIComponent(modhash || "")}`
  });

  if (!res.ok) {
    throw new Error(`Failed to ${unsave ? "unsave" : "save"} post on Reddit (HTTP ${res.status})`);
  }

  return { success: true, saved: !unsave, id: fullname };
}

// Subscribe (join) or unsubscribe from a subreddit or user profile
async function subscribeTarget({ target, type = "sub", action = "sub" }) {
  if (!target) throw new Error("No target community or profile provided");
  const cleanName = String(target).trim().replace(/^\/?(?:r|u)\//i, "");

  // Determine sr_name for Reddit API:
  // For subreddits: sr_name is "funny"
  // For user profiles: sr_name is "u_username"
  const isUser = type === "user" || target.toLowerCase().startsWith("u/") || target.toLowerCase().startsWith("/u/") || target.toLowerCase().startsWith("u_");
  let srName = cleanName;
  if (isUser && !srName.toLowerCase().startsWith("u_")) {
    srName = `u_${srName}`;
  }

  const modhash = await getModhash();
  const endpoint = "https://www.reddit.com/api/subscribe";

  const bodyParams = new URLSearchParams();
  bodyParams.append("action", action === "unsub" ? "unsub" : "sub");
  bodyParams.append("sr_name", srName);
  bodyParams.append("api_type", "json");
  bodyParams.append("skip_initial_defaults", "true");
  if (modhash) bodyParams.append("uh", modhash);

  const res = await fetch(endpoint, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: bodyParams.toString()
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error("You must be logged into your Reddit account in Chrome to join or follow.");
  }

  if (!res.ok) {
    throw new Error(`Failed to ${action === "unsub" ? "leave" : "join"} ${isUser ? "u/" : "r/"}${cleanName} (HTTP ${res.status})`);
  }

  const resText = await res.text();
  try {
    const json = JSON.parse(resText);
    if (json?.json?.errors?.length) {
      const errDetail = json.json.errors.map((e) => e[1] || e[0]).join(", ");
      throw new Error(`Reddit API Error: ${errDetail}`);
    }
  } catch (parseErr) {
    if (parseErr.message.startsWith("Reddit API Error:")) throw parseErr;
  }

  return { success: true, target: cleanName, srName, action, isUser };
}

// Download media directly to user's device via chrome.downloads
async function downloadMedia(payload) {
  const url = payload?.url;
  const filename = payload?.filename;
  if (!url) throw new Error("No media URL provided for download");

  const safeFilename = (filename || "reelit-media")
    .replace(/[/\\?%*:|"<>]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 100);

  let ext = ".mp4";
  if (url.includes(".jpg") || url.includes(".jpeg")) ext = ".jpg";
  else if (url.includes(".png")) ext = ".png";
  else if (url.includes(".gif")) ext = ".gif";

  const finalName = safeFilename.endsWith(ext) ? safeFilename : `${safeFilename}${ext}`;

  if (chrome.downloads) {
    return new Promise((resolve, reject) => {
      chrome.downloads.download(
        {
          url: url,
          filename: `Reelit/${finalName}`,
          conflictAction: "uniquify",
          saveAs: false
        },
        (downloadId) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve({ success: true, downloadId, filename: finalName });
          }
        }
      );
    });
  } else {
    return { success: false, fallbackUrl: url, filename: finalName };
  }
}

// Bulletproof Reddit Fetch with fallback & detailed diagnostics
async function fetchReddit(payload) {
  let primaryUrl = typeof payload === "string" ? payload : payload?.url;
  if (!primaryUrl) {
    throw new Error("No URL provided for FETCH_REDDIT");
  }

  // Normalize URL: remove double slashes (except protocol)
  primaryUrl = primaryUrl.replace(/([^:])\/\//g, "$1/");

  let response;
  let lastError = null;

  try {
    response = await executeRedditFetch(primaryUrl);
  } catch (err) {
    lastError = err;
    console.warn(`Primary fetch failed for ${primaryUrl}:`, err);
  }

  // If primary fetch resulted in 404 or network failure, attempt fallback from old.reddit <-> www.reddit
  if (!response || response.status === 404 || response.status >= 500) {
    let fallbackUrl = null;
    if (primaryUrl.includes("old.reddit.com")) {
      fallbackUrl = primaryUrl.replace("old.reddit.com", "www.reddit.com");
    } else if (primaryUrl.includes("www.reddit.com")) {
      fallbackUrl = primaryUrl.replace("www.reddit.com", "old.reddit.com");
    }

    if (fallbackUrl) {
      try {
        console.log(`Attempting fallback to: ${fallbackUrl}`);
        const fallbackRes = await executeRedditFetch(fallbackUrl);
        if (fallbackRes.ok) {
          response = fallbackRes;
        }
      } catch (e) {
        console.warn(`Fallback fetch failed for ${fallbackUrl}:`, e);
      }
    }
  }

  if (!response) {
    throw new Error(
      lastError?.name === "AbortError"
        ? "Reddit request timed out. Please check your network connection."
        : `Network error connecting to Reddit: ${lastError?.message || "Unknown error"}`
    );
  }

  if (response.status === 401 || response.status === 403) {
    const session = await checkRedditSession();
    if (!session.loggedIn) {
      throw new Error(
        `Reddit returned HTTP ${response.status}. You are not logged in. Open a tab to reddit.com, log in, and refresh.`
      );
    }
    throw new Error(`Reddit returned HTTP ${response.status} (Access Forbidden). Check your account permissions.`);
  }

  if (response.status === 429) {
    throw new Error("Reddit rate limit reached (HTTP 429). Please wait a few seconds before refreshing.");
  }

  if (!response.ok) {
    throw new Error(`Reddit request failed: HTTP ${response.status} ${response.statusText} (${primaryUrl})`);
  }

  const json = await response.json();
  if (json.error) {
    throw new Error(`Reddit API Error: ${json.message || json.error}`);
  }

  // Save modhash from listing response if present
  if (json?.data?.modhash) {
    currentModhash = json.data.modhash;
  }

  return json;
}

// Global message dispatcher
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const { type, payload } = request || {};

  const handleAsync = async () => {
    switch (type) {
      case "FETCH_REDDIT":
        return await fetchReddit(payload);

      case "RESOLVE_REDGIFS":
        return await resolveRedgifs(payload);

      case "SAVE_POST":
        return await saveToReddit(payload);

      case "SUBSCRIBE_TARGET":
        return await subscribeTarget(payload);

      case "DOWNLOAD_MEDIA":
        return await downloadMedia(payload);

      case "CHECK_SESSION":
        return await checkRedditSession();

      case "PING":
        return { pong: true, time: Date.now() };

      default:
        throw new Error(`Unknown message type: "${type}"`);
    }
  };

  handleAsync()
    .then((data) => {
      sendResponse({ ok: true, data });
    })
    .catch((err) => {
      sendResponse({ ok: false, error: err.message || String(err) });
    });

  return true;
});
