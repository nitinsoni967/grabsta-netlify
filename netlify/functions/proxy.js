
const https = require("https");
const http = require("http");

function fetchBinary(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const options = {
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
        "Referer": "https://www.instagram.com/",
      },
    };
    const req = mod.get(url, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchBinary(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode,
        contentType: res.headers["content-type"] || "application/octet-stream",
        buffer: Buffer.concat(chunks),
      }));
    });
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

exports.handler = async (event) => {
  const { url, filename } = event.queryStringParameters || {};

  if (!url) return { statusCode: 400, body: "URL required" };

  const allowed = ["cdninstagram.com", "instagram.com", "fbcdn.net", "scontent"];
  if (!allowed.some(d => url.includes(d))) {
    return { statusCode: 403, body: "Domain not allowed" };
  }

  try {
    const { status, contentType, buffer } = await fetchBinary(url);
    if (status !== 200) return { statusCode: 502, body: "Upstream error" };

    const ext = contentType.includes("video") ? ".mp4" : ".jpg";
    const dlFilename = filename || `instagram_media${ext}`;

    return {
      statusCode: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${dlFilename}"`,
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=3600",
      },
      body: buffer.toString("base64"),
      isBase64Encoded: true,
    };
  } catch (err) {
    return { statusCode: 500, body: "Failed: " + err.message };
  }
};
