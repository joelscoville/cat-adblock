const fs = require("fs");
const http = require("http");
const path = require("path");
const { execFile } = require("child_process");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 3000);
const CATEGORY_ORDER = ["cat-videos", "memes", "brainrot"];
const SERVER_VIDEO_ROOT = path.join(__dirname, "videos");
const METADATA_PATH = path.join(__dirname, "video-index.json");
const VIDEO_EXTENSION = ".webm";
const MIME_TYPES = {
  ".webm": "video/webm",
  ".json": "application/json; charset=utf-8"
};
const MAX_JSON_BODY_BYTES = 1024 * 16;

function sendCorsHeaders(res, statusCode, extraHeaders = {}) {
  res.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    ...extraHeaders
  });
}

function formatCategoryLabel(categoryId) {
  return categoryId
    .replace(/_/g, "-")
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getVideoRoot() {
  return SERVER_VIDEO_ROOT;
}

function readMetadata() {
  try {
    const raw = fs.readFileSync(METADATA_PATH, "utf8");
    const payload = JSON.parse(raw);
    const metadata = new Map();

    for (const category of payload.categories || []) {
      for (const video of category.videos || []) {
        if (typeof category.id === "string" && typeof video.filename === "string") {
          metadata.set(`${category.id}/${video.filename}`, video);
        }
      }
    }

    return metadata;
  } catch (error) {
    return new Map();
  }
}

function listCategoryDirectories(videoRoot) {
  if (!fs.existsSync(videoRoot)) {
    return [];
  }

  const categoryIds = fs
    .readdirSync(videoRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

  return categoryIds.sort((left, right) => {
    const leftIndex = CATEGORY_ORDER.indexOf(left);
    const rightIndex = CATEGORY_ORDER.indexOf(right);
    if (leftIndex !== -1 || rightIndex !== -1) {
      return (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex) -
        (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex);
    }

    return left.localeCompare(right);
  });
}

function buildVideoEntry(baseUrl, categoryId, filename, metadata) {
  const videoMetadata = metadata.get(`${categoryId}/${filename}`) || {};
  const width = Number.isFinite(videoMetadata.width) ? Number(videoMetadata.width) : null;
  const height = Number.isFinite(videoMetadata.height) ? Number(videoMetadata.height) : null;
  const aspectRatio =
    Number.isFinite(videoMetadata.aspectRatio) && Number(videoMetadata.aspectRatio) > 0
      ? Number(videoMetadata.aspectRatio)
      : width && height
        ? width / height
        : null;

  return {
    id: path.basename(filename, path.extname(filename)),
    filename,
    url: `${baseUrl}/videos/${encodeURIComponent(categoryId)}/${encodeURIComponent(filename)}`,
    width,
    height,
    aspectRatio
  };
}

function buildVideoIndex(baseUrl) {
  const videoRoot = getVideoRoot();
  const metadata = readMetadata();

  return {
    categories: listCategoryDirectories(videoRoot).map((categoryId) => {
      const categoryPath = path.join(videoRoot, categoryId);
      const videos = fs
        .readdirSync(categoryPath, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(VIDEO_EXTENSION))
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right))
        .map((filename) => buildVideoEntry(baseUrl, categoryId, filename, metadata));

      return {
        id: categoryId,
        label: formatCategoryLabel(categoryId),
        videos
      };
    })
  };
}

function filterCategories(index, categoryParam) {
  if (!categoryParam) {
    return index;
  }

  const requestedCategories = new Set(
    categoryParam
      .split(",")
      .map((categoryId) => categoryId.trim())
      .filter(Boolean)
  );

  return {
    categories: index.categories.filter((category) => requestedCategories.has(category.id))
  };
}

function sendJson(res, statusCode, payload) {
  sendCorsHeaders(res, statusCode, {
    "Content-Type": MIME_TYPES[".json"]
  });
  res.end(`${JSON.stringify(payload, null, 2)}\n`);
}

function sendNotFound(res) {
  sendJson(res, 404, { error: "Not found" });
}

function resolveVideoPath(requestPath) {
  const videoPrefix = "/videos/";
  if (!requestPath.startsWith(videoPrefix)) {
    return null;
  }

  const relativePath = decodeURIComponent(requestPath.slice(videoPrefix.length));
  const videoRoot = getVideoRoot();
  const absolutePath = path.resolve(videoRoot, relativePath);
  const rootWithSeparator = `${path.resolve(videoRoot)}${path.sep}`;

  if (!absolutePath.startsWith(rootWithSeparator)) {
    return null;
  }

  return absolutePath;
}

function sendVideo(req, res, requestPath) {
  const videoPath = resolveVideoPath(requestPath);
  if (!videoPath || !fs.existsSync(videoPath) || !fs.statSync(videoPath).isFile()) {
    sendNotFound(res);
    return;
  }

  const extension = path.extname(videoPath).toLowerCase();
  const stat = fs.statSync(videoPath);
  const headers = {
    "Accept-Ranges": "bytes",
    "Access-Control-Allow-Origin": "*",
    "Content-Length": stat.size,
    "Content-Type": MIME_TYPES[extension] || "application/octet-stream"
  };

  res.writeHead(200, headers);

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  fs.createReadStream(videoPath).pipe(res);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_JSON_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function getFiniteNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function toScreenPoint(payload) {
  const x = getFiniteNumber(payload?.x);
  const y = getFiniteNumber(payload?.y);
  const screenX = getFiniteNumber(payload?.screenX);
  const screenY = getFiniteNumber(payload?.screenY);
  const outerWidth = getFiniteNumber(payload?.outerWidth);
  const outerHeight = getFiniteNumber(payload?.outerHeight);
  const innerWidth = getFiniteNumber(payload?.innerWidth);
  const innerHeight = getFiniteNumber(payload?.innerHeight);

  if (
    x === null ||
    y === null ||
    screenX === null ||
    screenY === null ||
    outerWidth === null ||
    outerHeight === null ||
    innerWidth === null ||
    innerHeight === null
  ) {
    return null;
  }

  const sideChrome = Math.max((outerWidth - innerWidth) / 2, 0);
  const topChrome = Math.max(outerHeight - innerHeight - sideChrome, 0);

  return {
    x: Math.round(screenX + sideChrome + x),
    y: Math.round(screenY + topChrome + y)
  };
}

function moveCursorOnMac(screenPoint) {
  const script = `
function run(argv) {
  ObjC.import("ApplicationServices");
  const x = Number(argv[0]);
  const y = Number(argv[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error("Invalid cursor coordinates");
  }
  $.CGWarpMouseCursorPosition($.CGPointMake(x, y));
  $.CGAssociateMouseAndMouseCursorPosition(true);
  return "ok";
}
`;

  return new Promise((resolve, reject) => {
    execFile("osascript", ["-l", "JavaScript", "-e", script, String(screenPoint.x), String(screenPoint.y)], (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function handleCursorMove(req, res) {
  if (process.platform !== "darwin") {
    sendJson(res, 501, {
      error: "Cursor movement is only implemented for macOS in this local server."
    });
    return;
  }

  let payload;
  try {
    payload = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
    return;
  }

  const screenPoint = toScreenPoint(payload);
  if (!screenPoint) {
    sendJson(res, 400, { error: "Missing or invalid cursor coordinates" });
    return;
  }

  try {
    await moveCursorOnMac(screenPoint);
    sendJson(res, 200, {
      ok: true,
      x: screenPoint.x,
      y: screenPoint.y
    });
  } catch (error) {
    sendJson(res, 500, {
      error: "Failed to move cursor",
      details: error.message
    });
  }
}

function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);

  if (req.method === "OPTIONS") {
    sendCorsHeaders(res, 204, {
      "Access-Control-Allow-Methods": "GET,HEAD,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    res.end();
    return;
  }

  if (url.pathname === "/api/videos" && req.method === "GET") {
    const baseUrl = `http://${req.headers.host || `localhost:${PORT}`}`;
    sendJson(res, 200, filterCategories(buildVideoIndex(baseUrl), url.searchParams.get("categories")));
    return;
  }

  if (url.pathname === "/api/cursor/move" && req.method === "POST") {
    handleCursorMove(req, res);
    return;
  }

  if (url.pathname.startsWith("/videos/") && (req.method === "GET" || req.method === "HEAD")) {
    sendVideo(req, res, url.pathname);
    return;
  }

  sendNotFound(res);
}

const server = http.createServer(handleRequest);

server.listen(PORT, () => {
  console.log(`Cat Adblocker video API running at http://localhost:${PORT}`);
  console.log(`Serving videos from ${getVideoRoot()}`);
});
