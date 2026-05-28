
const https = require("https");
const http = require("http");

function extractShortcode(url) {
  const patterns = [
    /instagram\.com\/p\/([A-Za-z0-9_-]+)/,
    /instagram\.com\/reel\/([A-Za-z0-9_-]+)/,
    /instagram\.com\/reels\/([A-Za-z0-9_-]+)/,
    /instagram\.com\/tv\/([A-Za-z0-9_-]+)/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function parseMediaFromJson(jsonData) {
  try {
    const root =
      jsonData?.items?.[0] ||
      jsonData?.graphql?.shortcode_media ||
      jsonData?.data?.shortcode_media ||
      jsonData?.item;

    if (!root) return null;

    const caption =
      root?.caption?.text ||
      root?.edge_media_to_caption?.edges?.[0]?.node?.text ||
      "";

    const username =
      root?.user?.username ||
      root?.owner?.username ||
      "unknown";

    const items = [];
    const sidecar = root?.carousel_media || root?.edge_sidecar_to_children?.edges;

    if (sidecar && sidecar.length > 0) {
      for (const edge of sidecar) {
        const node = edge?.node || edge;
        if (node?.video_versions || node?.is_video || node?.__typename === "GraphVideo") {
          const videos = node.video_versions || [];
          items.push({
            type: "video",
            url: videos[0]?.url || node?.video_url,
            thumbnail: node?.image_versions2?.candidates?.[0]?.url || node?.display_url,
          });
        } else {
          const candidates = node?.image_versions2?.candidates || [];
          items.push({
            type: "image",
            url: candidates[0]?.url || node?.display_url,
            thumbnail: candidates[0]?.url || node?.display_url,
          });
        }
      }
      return { type: "carousel", items, caption, username };
    }

    if (root?.video_versions || root?.is_video || root?.__typename === "GraphVideo") {
      const videos = root.video_versions || [];
      return {
        type: "video",
        items: [{
          type: "video",
          url: videos[0]?.url || root?.video_url,
          thumbnail: root?.image_versions2?.candidates?.[0]?.url || root?.display_url || root?.thumbnail_src,
        }],
        caption, username,
      };
    }

    const candidates = root?.image_versions2?.candidates || [];
    return {
      type: "image",
      items: [{
        type: "image",
        url: candidates[0]?.url || root?.display_url,
        thumbnail: candidates[0]?.url || root?.display_url,
      }],
      caption, username,
    };
  } catch (e) {
    return null;
  }
}

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const options = {
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Referer": "https://www.instagram.com/",
      },
    };
    const req = mod.get(url, options, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { body = {}; }

  const { url } = body;
  if (!url) return { statusCode: 400, headers, body: JSON.stringify({ error: "URL is required" }) };

  const shortcode = extractShortcode(url);
  if (!shortcode) return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid Instagram URL" }) };

  const endpoints = [
    `https://www.instagram.com/p/${shortcode}/?__a=1&__d=dis`,
    `https://www.instagram.com/api/v1/media/${shortcode}/info/`,
  ];

  for (const endpoint of endpoints) {
    try {
      const { status, body: text } = await fetchUrl(endpoint);
      if (status !== 200) continue;
      let jsonData;
      try { jsonData = JSON.parse(text); } catch { continue; }
      const parsed = parseMediaFromJson(jsonData);
      if (parsed && parsed.items.length > 0 && parsed.items[0].url) {
        return { statusCode: 200, headers, body: JSON.stringify({ success: true, data: parsed }) };
      }
    } catch { continue; }
  }

  // Fallback: scrape HTML
  try {
    const { status, body: html } = await fetchUrl(`https://www.instagram.com/p/${shortcode}/`);
    if (status === 200) {
      const sharedDataMatch = html.match(/window\._sharedData\s*=\s*(\{.+?\});<\/script>/s);
      if (sharedDataMatch) {
        const sharedData = JSON.parse(sharedDataMatch[1]);
        const media = sharedData?.entry_data?.PostPage?.[0]?.graphql?.shortcode_media;
        if (media) {
          const parsed = parseMediaFromJson({ graphql: { shortcode_media: media } });
          if (parsed) return { statusCode: 200, headers, body: JSON.stringify({ success: true, data: parsed }) };
        }
      }
    }
  } catch {}

  return {
    statusCode: 422,
    headers,
    body: JSON.stringify({ error: "Could not extract media. Make sure the post is public and the URL is correct." }),
  };
};
