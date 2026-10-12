// Reddit API Client & Media Classifier
import bridge from './bridge.js';

/**
 * Format large numbers cleanly (e.g. 15200 -> "15.2k")
 */
export function formatNumber(num) {
  if (num === null || num === undefined) return "0";
  if (num >= 1000000) return (num / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
  if (num >= 1000) return (num / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(num);
}

/**
 * Clean up HTML entities in URLs (e.g. &amp; -> &)
 */
export function cleanUrl(url) {
  if (!url) return "";
  return url.replace(/&amp;/g, "&");
}

/**
 * Classify a raw Reddit post child object into a structured Reel item
 */
export function classifyPost(rawChild) {
  const post = rawChild?.data;
  if (!post) return null;

  // Handle crossposts if parent post is empty/crossposted
  const effectivePost = (post.crosspost_parent_list && post.crosspost_parent_list[0]) || post;

  const baseInfo = {
    id: post.id,
    name: post.name,
    title: post.title,
    subreddit: post.subreddit,
    subredditPrefixed: post.subreddit_name_prefixed || `r/${post.subreddit}`,
    author: post.author,
    authorPrefixed: `u/${post.author}`,
    score: post.score,
    scoreFormatted: formatNumber(post.score),
    numComments: post.num_comments,
    commentsFormatted: formatNumber(post.num_comments),
    permalink: `https://reddit.com${post.permalink}`,
    createdUtc: post.created_utc,
    over18: post.over_18,
    saved: !!post.saved,
    userIsSubscriber: post.user_is_subscriber === true,
    url: post.url
  };

  const domain = (post.domain || "").toLowerCase();
  const postUrl = (post.url || "").toLowerCase();
  const destUrl = (post.url_overridden_by_dest || "").toLowerCase();
  const isRedgifs = domain.includes("redgifs.com") || postUrl.includes("redgifs.com") || destUrl.includes("redgifs.com");

  // 1. Redgifs (Checked first so external embeds are never misidentified as native Reddit videos)
  if (isRedgifs) {
    const rawUrl = post.url_overridden_by_dest || post.url || "";
    const match = rawUrl.match(/(?:watch|ifr)\/([a-zA-Z0-9_\-]+)/i) || rawUrl.match(/redgifs\.com\/(?:[a-zA-Z]+\/)?([a-zA-Z0-9_\-]+)/i);
    const redgifsId = match ? match[1] : null;

    // Check if Reddit already cached an MP4 transcode in preview
    const previewVideo = effectivePost.preview?.reddit_video_preview ||
                        effectivePost.media?.reddit_video ||
                        effectivePost.secure_media?.reddit_video;
    const cachedVideoUrl = previewVideo?.fallback_url ? cleanUrl(previewVideo.fallback_url) : null;
    const thumbnailUrl = effectivePost.preview?.images?.[0]?.source?.url
      ? cleanUrl(effectivePost.preview.images[0].source.url)
      : (effectivePost.thumbnail && effectivePost.thumbnail.startsWith("http") ? effectivePost.thumbnail : null);

    return {
      ...baseInfo,
      mediaType: "redgifs",
      sourceType: cachedVideoUrl ? "reddit_cache" : "redgifs_pending",
      needsResolution: true,
      redgifsId,
      originalUrl: rawUrl,
      thumbnailUrl,
      cachedVideoUrl,
      hlsUrl: null, // Reddit preview HLS manifests do not exist or 404; direct MP4 fallback_url is used
      videoUrl: cachedVideoUrl,
      hasAudio: false,
      isIspFallback: !!cachedVideoUrl
    };
  }

  // 2. Reddit Video (Native hosted on v.redd.it)
  const redditVideo = effectivePost.media?.reddit_video ||
                      effectivePost.secure_media?.reddit_video ||
                      effectivePost.preview?.reddit_video_preview;

  if (redditVideo && redditVideo.fallback_url) {
    const fallbackUrl = cleanUrl(redditVideo.fallback_url);
    const isGif = !!redditVideo.is_gif;
    const hasAudio = !isGif && redditVideo.has_audio !== false;

    // Ordered Reddit DASH audio candidates
    const audioCandidates = [];
    if (hasAudio && fallbackUrl.includes("v.redd.it")) {
      const baseUrl = fallbackUrl.substring(0, fallbackUrl.lastIndexOf("/"));
      audioCandidates.push(`${baseUrl}/DASH_AUDIO_128.mp4`);
      audioCandidates.push(`${baseUrl}/DASH_AUDIO_64.mp4`);
      audioCandidates.push(`${baseUrl}/DASH_audio.mp4`);
    }

    return {
      ...baseInfo,
      mediaType: "reddit_video",
      sourceType: "reddit_video",
      videoUrl: fallbackUrl,
      hlsUrl: redditVideo.hls_url ? cleanUrl(redditVideo.hls_url) : null,
      audioCandidates,
      audioUrl: audioCandidates[0] || null,
      isGif,
      hasAudio,
      width: redditVideo.width,
      height: redditVideo.height,
      duration: redditVideo.duration,
      aspectRatio: redditVideo.width && redditVideo.height ? (redditVideo.width / redditVideo.height) : 9 / 16
    };
  }

  // 3. Imgur gifv / mp4
  if (domain.includes("imgur.com") && postUrl.endsWith(".gifv")) {
    const mp4Url = postUrl.replace(/\.gifv$/i, ".mp4");
    return {
      ...baseInfo,
      mediaType: "video",
      videoUrl: cleanUrl(mp4Url),
      isGif: true
    };
  }

  // 4. Reddit Gallery
  if (post.is_gallery && post.gallery_data?.items && post.media_metadata) {
    const images = [];
    for (const item of post.gallery_data.items) {
      const meta = post.media_metadata[item.media_id];
      if (!meta) continue;

      let imgUrl = null;
      let isGif = false;
      // Prioritize animated GIF if present, otherwise uncompressed image
      if (meta.s?.gif) {
        imgUrl = cleanUrl(meta.s.gif);
        isGif = true;
      } else if (meta.s?.u) {
        imgUrl = cleanUrl(meta.s.u);
      } else if (meta.p && meta.p.length > 0) {
        imgUrl = cleanUrl(meta.p[meta.p.length - 1].u);
      }

      if (imgUrl) {
        images.push({
          url: imgUrl,
          caption: item.caption || null,
          width: meta.s?.x,
          height: meta.s?.y,
          isGif
        });
      }
    }

    if (images.length > 0) {
      return {
        ...baseInfo,
        mediaType: "gallery",
        sourceType: "gallery",
        images,
        isGallery: true
      };
    }
  }

  // 5. Direct Image
  const isImageHint = post.post_hint === "image";
  const hasImageExt = /\.(jpe?g|png|webp|gif)$/i.test(postUrl);

  if (isImageHint || hasImageExt) {
    let bestUrl = postUrl;
    // If Reddit preview has higher quality uncropped source
    if (post.preview?.images?.[0]?.source?.url) {
      bestUrl = cleanUrl(post.preview.images[0].source.url);
    }

    return {
      ...baseInfo,
      mediaType: "image",
      sourceType: "image",
      imageUrl: cleanUrl(bestUrl)
    };
  }

  // 6. Text-Only / Self Post
  const isSelf = post.is_self || (!post.post_hint && !post.media && !post.preview?.images);
  if (isSelf || post.selftext) {
    return {
      ...baseInfo,
      mediaType: "text",
      sourceType: "text_post",
      selfText: post.selftext || "",
      isText: true
    };
  }

  // Non-media or unsupported external links
  return null;
}

/**
 * Build a bulletproof Reddit endpoint URL
 */
export function buildRedditUrl({
  subreddit = "",
  user = "",
  sort = "best",
  t = "day",
  after = null,
  limit = 50
} = {}) {
  const cleanSub = (subreddit || "").trim().replace(/^r\//i, "");
  const cleanUser = (user || "").trim().replace(/^u\//i, "");
  let path = "";

  if (cleanUser) {
    // Creator profile submitted posts: Reddit API expects sort as query param (?sort=new|hot|top)
    const effectiveSort = (sort === "best" || !sort) ? "new" : sort;
    let url = `https://old.reddit.com/user/${encodeURIComponent(cleanUser)}/submitted/.json?limit=${limit}&raw_json=1&sort=${encodeURIComponent(effectiveSort)}`;
    if (effectiveSort === "top" && t) {
      url += `&t=${encodeURIComponent(t)}`;
    }
    if (after) {
      url += `&after=${encodeURIComponent(after)}`;
    }
    return url;
  }

  // Subreddit or Home feed:
  if (cleanSub) {
    // Subreddit feed: e.g. /r/popular, /r/funny (subreddits don't have 'best', use 'hot' instead)
    const effectiveSort = sort === "best" ? "hot" : sort;
    path = `/r/${encodeURIComponent(cleanSub)}`;
    if (effectiveSort && effectiveSort !== "hot") {
      path += `/${encodeURIComponent(effectiveSort)}`;
    }
  } else {
    // Personal home feed:
    // 'best' is Reddit's default recommendation algorithm that rotates content fresh on each reload
    const effectiveSort = sort || "best";
    if (effectiveSort === "best") {
      path = "/best";
    } else if (effectiveSort === "new" || effectiveSort === "top" || effectiveSort === "rising") {
      path = `/${encodeURIComponent(effectiveSort)}`;
    } else {
      path = ""; // hot is root
    }
  }

  let url = `https://old.reddit.com${path}/.json?limit=${limit}&raw_json=1`;

  if (sort === "top" && t) {
    url += `&t=${encodeURIComponent(t)}`;
  }

  if (after) {
    url += `&after=${encodeURIComponent(after)}`;
  }

  return url;
}

/**
 * Check if the browser currently holds active Reddit session cookies
 */
export async function checkRedditSession() {
  try {
    return await bridge.send("CHECK_SESSION", {});
  } catch (err) {
    return { loggedIn: false, error: err.message };
  }
}

/**
 * Fetch a feed of posts from Reddit via Extension Bridge
 * @param {Object} options
 * @param {string} [options.subreddit] - Subreddit name or empty for personal home feed
 * @param {string} [options.sort="hot"] - hot, top, new, rising
 * @param {string} [options.t="day"] - Time filter for "top" sort (day, week, month, year, all)
 * @param {string} [options.after] - Pagination token
 * @param {number} [options.limit=50] - Number of items to fetch
 */
export async function fetchFeed(options = {}) {
  const endpoint = buildRedditUrl(options);
  const response = await bridge.fetchReddit(endpoint);

  const children = response?.data?.children || [];
  const nextAfter = response?.data?.after || null;

  const isHomeFeed = !options.subreddit && !options.user;
  const items = [];
  for (const child of children) {
    const item = classifyPost(child);
    if (item) {
      if (isHomeFeed && item.subreddit) {
        setTargetJoined(item.subreddit, "sub", true);
      }
      items.push(item);
    }
  }

  return {
    items,
    after: nextAfter,
    rawCount: children.length,
    endpoint
  };
}

/**
 * Format subscriber count into human-readable string (e.g. 52M members, 120K members)
 */
export function formatSubscribers(num) {
  if (!num || isNaN(num) || num <= 0) return "";
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1).replace(/\.0$/, "") + "M members";
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1).replace(/\.0$/, "") + "K members";
  }
  return num + " members";
}

function cleanIconUrl(url) {
  if (!url) return "";
  return url.replace(/&amp;/g, "&").split("?")[0];
}

/**
 * Search subreddits with typeahead autocomplete via Reddit Bridge
 * @param {string} query
 * @param {number} [limit=8]
 */
export async function searchSubreddits(query, limit = 8) {
  if (!query || !query.trim()) return [];
  const clean = query.trim().replace(/^r\//i, "");
  if (!clean) return [];

  // 1. Try modern Reddit autocomplete_v2 endpoint
  try {
    const url = `https://www.reddit.com/api/subreddit_autocomplete_v2.json?query=${encodeURIComponent(clean)}&include_over_18=true&include_profiles=false&limit=${limit}`;
    const res = await bridge.fetchReddit(url);
    const children = res?.data?.children || [];
    const results = [];

    for (const child of children) {
      const d = child?.data;
      if (!d || !d.display_name) continue;
      if (d.name && d.name.startsWith("t2_")) continue; // Skip user profiles

      results.push({
        name: d.display_name,
        prefixed: d.display_name_prefixed || `r/${d.display_name}`,
        subscribers: d.subscribers || 0,
        subscribersFormatted: formatSubscribers(d.subscribers || 0),
        title: d.title || "",
        over18: Boolean(d.over_18),
        icon: cleanIconUrl(d.community_icon || d.icon_img)
      });
    }

    if (results.length > 0) return results;
  } catch (err) {
    console.warn("[Reelit] Autocomplete v2 failed, attempting search fallback:", err);
  }

  // 2. Fallback to subreddits search
  try {
    const fallbackUrl = `https://old.reddit.com/subreddits/search.json?q=${encodeURIComponent(clean)}&limit=${limit}`;
    const res = await bridge.fetchReddit(fallbackUrl);
    const children = res?.data?.children || [];
    return children.map((c) => {
      const d = c.data;
      return {
        name: d.display_name,
        prefixed: `r/${d.display_name}`,
        subscribers: d.subscribers || 0,
        subscribersFormatted: formatSubscribers(d.subscribers || 0),
        title: d.title || "",
        over18: Boolean(d.over18 || d.over_18),
        icon: cleanIconUrl(d.community_icon || d.icon_img)
      };
    });
  } catch (err) {
    console.warn("[Reelit] Subreddit search fallback error:", err);
    return [];
  }
}

// Local cache for joined communities and followed profiles
const JOINED_TARGETS_KEY = "reelit_joined_targets_v1";

export function getJoinedTargets() {
  try {
    const raw = localStorage.getItem(JOINED_TARGETS_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return new Set(arr.map((s) => String(s).toLowerCase()));
    }
  } catch (_) {}
  return new Set();
}

export function saveJoinedTargets(set) {
  try {
    localStorage.setItem(JOINED_TARGETS_KEY, JSON.stringify([...set]));
  } catch (_) {}
}

export function isTargetJoined(target, type = "sub") {
  if (!target) return false;
  const clean = String(target).trim().toLowerCase().replace(/^(?:r|u)\//, "");
  const key = `${type}:${clean}`;
  return getJoinedTargets().has(key);
}

export function setTargetJoined(target, type = "sub", joined = true) {
  if (!target) return;
  const clean = String(target).trim().toLowerCase().replace(/^(?:r|u)\//, "");
  const set = getJoinedTargets();
  const key = `${type}:${clean}`;
  if (joined) {
    set.add(key);
  } else {
    set.delete(key);
  }
  saveJoinedTargets(set);
}

/**
 * Authoritatively check if user is subscribed to a subreddit from Reddit API
 * Endpoint: /r/{sub}/about.json -> data.user_is_subscriber
 */
export async function checkSubredditSubscription(subName) {
  if (!subName || !subName.trim()) return false;
  const clean = subName.trim().replace(/^r\//i, "");
  try {
    const url = `https://www.reddit.com/r/${encodeURIComponent(clean)}/about.json`;
    const res = await bridge.fetchReddit(url);
    if (res?.data?.user_is_subscriber !== undefined && res?.data?.user_is_subscriber !== null) {
      const isSub = Boolean(res.data.user_is_subscriber);
      setTargetJoined(clean, "sub", isSub);
      return isSub;
    }
  } catch (err) {
    console.warn(`[Reelit] Failed to query subscription status for r/${clean}:`, err);
  }
  return isTargetJoined(clean, "sub");
}

/**
 * Authoritatively check if user is following a creator from Reddit API
 * Endpoint: /user/{user}/about.json -> data.subreddit.user_is_subscriber
 */
export async function checkUserSubscription(userName) {
  if (!userName || !userName.trim()) return false;
  const clean = userName.trim().replace(/^u\//i, "");
  try {
    const url = `https://www.reddit.com/user/${encodeURIComponent(clean)}/about.json`;
    const res = await bridge.fetchReddit(url);
    const subMeta = res?.data?.subreddit;
    if (subMeta?.user_is_subscriber !== undefined && subMeta?.user_is_subscriber !== null) {
      const isFollowed = Boolean(subMeta.user_is_subscriber);
      setTargetJoined(clean, "user", isFollowed);
      return isFollowed;
    }
  } catch (err) {
    console.warn(`[Reelit] Failed to query follow status for u/${clean}:`, err);
  }
  return isTargetJoined(clean, "user");
}

/**
 * Sync user's subscribed subreddits and followed users from Reddit API
 * Endpoint: /subreddits/mine/subscriber.json?limit=100 (paginated)
 */
export async function syncUserSubscriptions() {
  try {
    let after = null;
    let pages = 0;
    const maxPages = 4; // up to 400 subreddits
    const set = getJoinedTargets();

    while (pages < maxPages) {
      pages++;
      let url = `https://www.reddit.com/subreddits/mine/subscriber.json?limit=100`;
      if (after) url += `&after=${encodeURIComponent(after)}`;

      const res = await bridge.fetchReddit(url);
      const children = res?.data?.children || [];
      if (children.length === 0) break;

      for (const child of children) {
        const d = child?.data;
        if (!d) continue;
        const name = d.display_name;
        if (!name) continue;

        if (name.toLowerCase().startsWith("u_")) {
          const userClean = name.substring(2).toLowerCase();
          set.add(`user:${userClean}`);
        } else {
          set.add(`sub:${name.toLowerCase()}`);
        }
      }

      after = res?.data?.after;
      if (!after) break;
    }

    saveJoinedTargets(set);
    return set;
  } catch (err) {
    console.warn("[Reelit] Failed to sync user subscriptions:", err);
    return getJoinedTargets();
  }
}


