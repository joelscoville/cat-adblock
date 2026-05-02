const fs = require("fs");
const http = require("http");
const path = require("path");
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
  res.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
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

function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
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
