const express = require('express');
const path = require('path');
const fs = require('fs/promises');
const { execFile } = require('child_process');
const { promisify } = require('util');

const app = express();
const execFileAsync = promisify(execFile);

// ==================== CONFIG ====================

const PORT = 3000;

const BASE_URL =
  'https://www.homemadexxxporn.com/contents/videos/0';

const PAGE_LIMIT = 20;
const BATCH_SIZE = 25;

const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const VIDEOS_JSON_PATH = path.join(DATA_DIR, 'videos.json');

const THUMBNAIL_DIR = path.join(
  __dirname,
  'cache',
  'thumbnails'
);

const FFMPEG_PATH = process.env.FFMPEG_PATH || 'ffmpeg';

const FORCE_REFRESH = process.argv.includes('--refresh-index');

// ==================== STATE ====================

let videosData = [];
let isLoading = true;

const thumbnailJobs = new Map();

// ==================== MIDDLEWARE ====================

app.use(express.static(PUBLIC_DIR));

// ==================== HELPERS ====================

function getVideoUrl(folder) {
  return `${BASE_URL}/${folder}/${folder}.mp4`;
}

function getThumbnailUrl(folder) {
  return `/api/videos/${folder}/thumbnail`;
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function saveVideosJson(videos) {
  await fs.mkdir(DATA_DIR, { recursive: true });

  // Write to a temporary file before replacing the index.
  const tempPath = `${VIDEOS_JSON_PATH}.tmp`;

  await fs.writeFile(
    tempPath,
    JSON.stringify(videos, null, 2),
    'utf8'
  );

  await fs.rename(tempPath, VIDEOS_JSON_PATH);
}

async function fetchRemoteDirectory() {
  console.log('📡 Fetching directory index...');

  const response = await fetch(BASE_URL, {
    signal: AbortSignal.timeout(30000)
  });

  if (!response.ok) {
    throw new Error(
      `Directory request failed: HTTP ${response.status}`
    );
  }

  const html = await response.text();

  const folders = new Set();
  const regex = /href=["'](\d+)\/["']/g;

  let match;

  while ((match = regex.exec(html)) !== null) {
    folders.add(match[1]);
  }

  return [...folders];
}

async function getVideoMetadata(folder) {
  const videoUrl = getVideoUrl(folder);

  try {
    const response = await fetch(videoUrl, {
      method: 'HEAD',
      signal: AbortSignal.timeout(15000)
    });

    if (!response.ok) {
      console.warn(
        `⚠️ Skipping ${folder}: HTTP ${response.status}`
      );
      return null;
    }

    const sizeBytes = Number(
      response.headers.get('content-length') || 0
    );

    return {
      id: Number(folder),
      folder,
      title: `Video ${folder}`,
      fileName: `${folder}.mp4`,
      videoUrl,
      thumbnailUrl: getThumbnailUrl(folder),
      sizeBytes,
      sizeMB: (sizeBytes / (1024 * 1024)).toFixed(2)
    };
  } catch (error) {
    console.warn(
      `⚠️ Failed to check ${folder}: ${error.message}`
    );

    return null;
  }
}


async function prewarmThumbnailCache() {
    const ids = videosData.map(video => video.id);
    const batchSize = 4;

    console.log(`🖼️ Prewarming ${ids.length} thumbnails...`);

    let completed = 0;

    for (let i = 0; i < ids.length; i += batchSize) {
        const batch = ids.slice(i, i + batchSize);

        await Promise.all(
            batch.map(async id => {
                try {
                    const response = await fetch(
                        `http://127.0.0.1:${PORT}/api/videos/${id}/thumbnail`
                    );

                    await response.arrayBuffer();

                    if (!response.ok) {
                        console.warn(`Thumbnail ${id} failed: ${response.status}`);
                    }
                } catch (error) {
                    console.warn(`Thumbnail ${id} failed: ${error.message}`);
                } finally {
                    completed++;
                }
            })
        );

        console.log(`🖼️ Thumbnails: ${completed}/${ids.length}`);
    }

    console.log('✅ Thumbnail cache prewarming finished.');
}


// ==================== LOAD / CACHE INDEX ====================

async function loadAllVideos() {
  isLoading = true;

  try {
    // Normal startup: use the local JSON cache.
    if (!FORCE_REFRESH) {
      try {
        const json = await fs.readFile(
          VIDEOS_JSON_PATH,
          'utf8'
        );

        const cachedVideos = JSON.parse(json);

        if (
          Array.isArray(cachedVideos) &&
          cachedVideos.length > 0 &&
          cachedVideos.every(
            video =>
              video &&
              /^\d+$/.test(String(video.folder)) &&
              typeof video.videoUrl === 'string' &&
              typeof video.sizeBytes === 'number'
          )
        ) {
          videosData = cachedVideos.reverse();

          console.log(
            `📦 Loaded ${videosData.length} videos from JSON cache.`
          );

          return;
        }

        console.warn('⚠️ JSON cache is invalid. Rebuilding index...');
      } catch (error) {
        if (error.code === 'ENOENT') {
          console.log('📝 No saved index found. Building one...');
        } else if (error instanceof SyntaxError) {
          console.warn('⚠️ JSON cache is corrupted. Rebuilding...');
        } else {
          console.warn(
            `⚠️ Could not read JSON cache: ${error.message}`
          );
        }
      }
    } else {
      console.log('🔄 Forced index refresh requested.');
    }

    // Fetch the remote directory only when needed.
    const folders = await fetchRemoteDirectory();

    console.log(
      `✅ Found ${folders.length} folders. Checking file sizes...`
    );

    const freshVideos = [];

    for (let i = 0; i < folders.length; i += BATCH_SIZE) {
      const batch = folders.slice(i, i + BATCH_SIZE);

      const results = await Promise.all(
        batch.map(folder => getVideoMetadata(folder))
      );

      for (const video of results) {
        if (video) {
          freshVideos.push(video);
        }
      }

      console.log(
        `📊 Progress: ${Math.min(i + batch.length, folders.length)}/${folders.length}`
      );
    }

    // FIX: Largest files first (was incorrectly sorting smallest first)
    freshVideos.sort(
      (a, b) => b.sizeBytes - a.sizeBytes
    );

    // Persist the index for future restarts.
    await saveVideosJson(freshVideos);

    videosData = freshVideos;

    console.log(
      `💾 Saved ${videosData.length} videos to data/videos.json`
    );

    console.log(`🎉 Loaded ${videosData.length} videos.`);
  } catch (error) {
    console.error('❌ Index initialization failed:', error.message);

    // Preserve an existing in-memory index if one was loaded.
    // On a fresh startup, the API will report the error state.
    if (videosData.length === 0) {
      throw error;
    }
  } finally {
    isLoading = false;
  }
}

// ==================== VIDEO API ====================

app.get('/api/videos', (req, res) => {
  if (isLoading) {
    return res.status(503).json({
      error: 'Video index is still loading.',
      loading: true
    });
  }

  const requestedPage = Number.parseInt(req.query.page, 10);

  const page =
    Number.isFinite(requestedPage) && requestedPage > 0
      ? requestedPage
      : 1;

  const totalVideos = videosData.length;
  const totalPages = Math.ceil(totalVideos / PAGE_LIMIT);

  const start = (page - 1) * PAGE_LIMIT;

  const videos = videosData.slice(
    start,
    start + PAGE_LIMIT
  );

  res.json({
    videos,
    page,
    limit: PAGE_LIMIT,
    totalVideos,
    totalPages
  });
});

// ==================== THUMBNAIL API ====================

async function generateThumbnail(video) {
  const folder = video.folder;

  const outputPath = path.join(
    THUMBNAIL_DIR,
    `${folder}.jpg`
  );

  const tempPath = path.join(
    THUMBNAIL_DIR,
    `${folder}.tmp.jpg`
  );

  // Another request may have generated it already.
  if (await fileExists(outputPath)) {
    return outputPath;
  }

  try {
    await execFileAsync(
      FFMPEG_PATH,
      [
        '-hide_banner',
        '-loglevel', 'error',
        '-y',
        // FIX: Add User-Agent to prevent 403 Forbidden from remote servers blocking default FFmpeg UA
        '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
        '-ss', '2',
        '-i', video.videoUrl,
        '-frames:v', '1',
        '-vf', 'scale=320:-1',
        '-q:v', '3',
        '-an',
        tempPath
      ],
      {
        timeout: 60000,
        maxBuffer: 1024 * 1024
      }
    );

    if (!(await fileExists(tempPath))) {
      throw new Error('FFmpeg did not create the thumbnail.');
    }

    // Avoid renaming if another request created the cache meanwhile.
    if (await fileExists(outputPath)) {
      await fs.unlink(tempPath).catch(() => {});
    } else {
      await fs.rename(tempPath, outputPath);
    }

    console.log(`🖼️ Thumbnail generated: ${folder}.jpg`);

    return outputPath;
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {});

    console.error(
      `❌ Thumbnail failed for ${folder}: ${error.message}`
    );

    throw error;
  }
}

app.get('/api/videos/:id/thumbnail', async (req, res) => {
  const { id } = req.params;

  // Only accept numeric folder IDs.
  if (!/^\d+$/.test(id)) {
    return res.status(400).json({
      error: 'Invalid video ID.'
    });
  }

  const video = videosData.find(
    item => String(item.folder) === id
  );

  if (!video) {
    return res.status(404).json({
      error: 'Video not found in the index.'
    });
  }

  const thumbnailPath = path.join(
    THUMBNAIL_DIR,
    `${id}.jpg`
  );

  try {
    await fs.mkdir(THUMBNAIL_DIR, {
      recursive: true
    });

    // Serve cached thumbnail without running FFmpeg.
    if (await fileExists(thumbnailPath)) {
      res.setHeader(
        'Cache-Control',
        'public, max-age=2592000, immutable'
      );

      return res.sendFile(thumbnailPath);
    }

    // Deduplicate simultaneous requests for the same thumbnail.
    let job = thumbnailJobs.get(id);

    if (!job) {
      job = generateThumbnail(video);
      thumbnailJobs.set(id, job);
    }

    try {
      const generatedPath = await job;

      res.setHeader(
        'Cache-Control',
        'public, max-age=2592000, immutable'
      );

      return res.sendFile(generatedPath);
    } finally {
      if (thumbnailJobs.get(id) === job) {
        thumbnailJobs.delete(id);
      }
    }
  } catch (error) {
    if (!res.headersSent) {
      return res.status(500).json({
        error: 'Could not generate thumbnail.'
      });
    }
  }
});

// ==================== START SERVER ====================

async function startServer() {
  await fs.mkdir(DATA_DIR, {
    recursive: true
  });

  await fs.mkdir(THUMBNAIL_DIR, {
    recursive: true
  });

  app.listen(PORT, () => {
    console.log(
      `🚀 StreamVault running at http://localhost:${PORT}`
    );

    console.log('🔄 Starting server initialization...');

    // FIX: Chain prewarmThumbnailCache to run ONLY AFTER loadAllVideos completes
    loadAllVideos()
      .then(() => {
        console.log('🔄 Starting thumbnail prewarming...');
        return prewarmThumbnailCache();
      })
      .catch(error => {
        console.error(
          '❌ Server initialization failed:',
          error.message
        );
      });
  });
}

startServer();