require('dotenv').config();
const express  = require('express');
const multer   = require('multer');
const sharp    = require('sharp');
const axios    = require('axios');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');
const { GoogleGenAI } = require('@google/genai');
const { fal } = require('@fal-ai/client');

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const PORT     = process.env.PORT || 3005;
const GEMINI   = process.env.GEMINI_API_KEY || '';
const MINIMAX  = process.env.MINIMAX_API_KEY || '';
const FAL_KEY  = process.env.FAL_KEY || '';

fal.config({ credentials: FAL_KEY });

// ─── Video jobs store ─────────────────────────────────────────────────────────
// status: 'pending' | 'generating' | 'done' | 'error'
const videoJobs = new Map();

// ─── Outputs folder ───────────────────────────────────────────────────────────
const OUTPUTS_DIR = process.env.OUTPUTS_DIR || path.join(__dirname, 'outputs');
if (!fs.existsSync(OUTPUTS_DIR)) fs.mkdirSync(OUTPUTS_DIR, { recursive: true });

// In-memory history (newest first). Capped at 200 entries.
const history = [];
const MAX_HISTORY = 200;

// Seed history from existing files on startup so restarts don't wipe the feed
fs.readdirSync(OUTPUTS_DIR)
  .filter(f => f.endsWith('.png'))
  .sort() // uuid filenames sort chronologically close enough
  .forEach(f => {
    const id = f.replace('.png', '');
    history.unshift({ id, filename: f, created_at: fs.statSync(path.join(OUTPUTS_DIR, f)).mtime.toISOString() });
  });
if (history.length > MAX_HISTORY) history.splice(MAX_HISTORY);

app.use(cors());
app.use(express.json());

// Serve saved output images as static files
app.use('/outputs', express.static(OUTPUTS_DIR));

// ─── Gemini image editing ─────────────────────────────────────────────────────
async function geminiEdit(imageBuffer) {
  const imageB64 = imageBuffer.toString('base64');

  const prompt =
    'Photo edit: keep the entire image identical except restyle the face/head only. ' +
    'Do NOT add any sticker, overlay, or graphic on top of the image. ' +
    'Instead, repaint the face itself with these cartoon illustration features seamlessly integrated: ' +
    'skin recolored to bright flat yellow, both eyes replaced with scrunched-shut downward curved lines, ' +
    'eyebrows drawn thick and furrowed hard downward, mouth replaced with a wide-open wailing shape showing teeth, ' +
    'two thick bright blue teardrop streams painted flowing down from the eyes. ' +
    'The restyled face must match the original face position, size, angle, and lighting exactly. ' +
    'Hair, body, clothing, and background remain completely unchanged and photorealistic.';

  const res = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image-preview:generateContent?key=${GEMINI}`,
    {
      contents: [{
        parts: [
          { inlineData: { mimeType: 'image/png', data: imageB64 } },
          { text: prompt },
        ],
      }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    },
    { timeout: 90000 }
  );

  const candidate = res.data.candidates?.[0];
  if (candidate?.finishReason === 'PROHIBITED_CONTENT' || candidate?.finishReason === 'SAFETY') {
    throw new Error('This image couldn\'t be processed — try a different one.');
  }
  const parts   = candidate?.content?.parts || [];
  const imgPart = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));
  if (!imgPart) throw new Error('Generation failed — try a different image.');

  return Buffer.from(imgPart.inlineData.data, 'base64');
}

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  const { execSync } = require('child_process');
  let ffmpeg = 'unknown';
  try { execSync('ffmpeg -version', { timeout: 3000 }); ffmpeg = 'ok'; } catch { ffmpeg = 'MISSING'; }
  res.json({
    status: 'ok',
    gemini_key: GEMINI && GEMINI !== 'your_gemini_api_key_here' ? 'configured' : 'MISSING',
    minimax_key: MINIMAX ? 'configured' : 'MISSING',
    fal_key: FAL_KEY ? 'configured' : 'MISSING',
    ffmpeg,
  });
});

// ─── History ──────────────────────────────────────────────────────────────────
app.get('/history', (req, res) => {
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({
    images: history.map(item => ({
      id:           item.id,
      result_image: `${base}/outputs/${item.filename}`,
      created_at:   item.created_at,
    })),
  });
});

// ─── Generate ────────────────────────────────────────────────────────────────
app.post('/generate', upload.single('image'), async (req, res) => {
  const jobId = uuidv4();
  if (!req.file) return res.status(400).json({ error: 'No image uploaded', jobId });
  if (!GEMINI || GEMINI === 'your_gemini_api_key_here') {
    return res.status(500).json({ error: 'GEMINI_API_KEY not configured in .env', jobId });
  }

  try {
    const resized = await sharp(req.file.buffer)
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();

    console.log(`[${jobId}] Sending to Gemini image editing...`);
    const cryBuffer = await geminiEdit(resized);

    // Save to disk
    const filename = `${jobId}.png`;
    fs.writeFileSync(path.join(OUTPUTS_DIR, filename), cryBuffer);

    // Add to in-memory history (newest first)
    const created_at = new Date().toISOString();
    history.unshift({ id: jobId, filename, created_at });
    if (history.length > MAX_HISTORY) history.pop();

    // Return a URL (works locally and on any deployed host)
    const base = `${req.protocol}://${req.get('host')}`;
    const result_image = `${base}/outputs/${filename}`;

    res.json({ success: true, jobId, result_image, created_at });

  } catch (err) {
    const detail = err.response?.data ? JSON.stringify(err.response.data).slice(0, 400) : '';
    console.error(`[${jobId}] Error:`, err.message, detail);
    res.status(500).json({ error: err.message + (detail ? ' — ' + detail : ''), jobId });
  }
});

// ─── Animate (GIF / MP4) ─────────────────────────────────────────────────────
function runFFmpeg(inputPath, outputPath, type) {
  return new Promise((resolve, reject) => {
    // Shake filter: oscillates crop window to create a sobbing effect
    const shake = 'fps=15,crop=in_w-20:in_h-20:10+sin(t*25)*10:10+cos(t*20)*7';

    let args;
    if (type === 'gif') {
      args = [
        '-loop', '1', '-t', '3.5', '-i', inputPath,
        '-filter_complex',
        `[0:v]${shake},split=2[s0][s1];[s0]palettegen=stats_mode=full[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5[out]`,
        '-map', '[out]', '-loop', '0', '-y', outputPath,
      ];
    } else {
      args = [
        '-loop', '1', '-t', '4', '-i', inputPath,
        '-vf', shake.replace('fps=15', 'fps=30'),
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
        '-y', outputPath,
      ];
    }

    const proc = spawn('ffmpeg', args);
    let errLog = '';
    proc.stderr.on('data', d => { errLog += d.toString(); });
    proc.on('error', err => reject(new Error(`ffmpeg spawn error: ${err.message}`)));
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(errLog.slice(-400))));
  });
}

app.get('/animate/:id', async (req, res) => {
  const { id } = req.params;
  if (!/^[a-f0-9-]+$/i.test(id)) return res.status(400).json({ error: 'Invalid id' });

  const type = req.query.type === 'mp4' ? 'mp4' : 'gif';
  const inputPath = path.join(OUTPUTS_DIR, `${id}.png`);
  if (!fs.existsSync(inputPath)) return res.status(404).json({ error: 'Image not found' });

  const outFilename = `${id}-animated.${type}`;
  const outputPath  = path.join(OUTPUTS_DIR, outFilename);

  // Serve cached result if it already exists
  if (fs.existsSync(outputPath)) {
    const base = `${req.protocol}://${req.get('host')}`;
    return res.json({ url: `${base}/outputs/${outFilename}` });
  }

  try {
    console.log(`[animate] Generating ${type} for ${id}...`);
    await runFFmpeg(inputPath, outputPath, type);
    const base = `${req.protocol}://${req.get('host')}`;
    res.json({ url: `${base}/outputs/${outFilename}` });
  } catch (err) {
    console.error('[animate] Error:', err.message);
    res.status(500).json({ error: 'Animation failed' });
  }
});

// ─── Video generation (MiniMax I2V) ──────────────────────────────────────────

const VIDEO_PROMPTS = [
  // Structured / controlled — clean output, face-only motion
  '[Static locked-off shot] ' +
  'The character from the first frame, exact same art style, colors, proportions, and design — no morphing or redesign. ' +
  'Bawling uncontrollably: head shaking and bobbing with each sob, mouth wide open wailing, thick rivers of tears pouring down face, chin trembling, exaggerated cartoon crying expression. ' +
  'Same background and environment as input image. ' +
  'Arms, hands, and body completely frozen and still — only face and head animate. ' +
  'Dramatic emotional lighting, vivid colors, sharp crisp animation quality.',

  // Crazy motion — more fun/viral, full body chaos
  '[Static locked-off shot] ' +
  'The character from the first frame, exact same art style, colors, proportions, and design — no morphing or redesign. ' +
  'Bawling uncontrollably: head shaking and bobbing violently with each sob, shoulders heaving, body rocking forward and back, mouth wide open wailing, tear droplets flying off face, hands trembling. ' +
  'Same background and environment as input image. ' +
  'Maximum emotional chaos — exaggerated cartoon crying, heavy snot and tear overflow, accelerating bursts of tears. ' +
  'Vivid colors, sharp crisp animation quality.',
];

async function runVideoGeneration(jobId, imageBuffer) {
  const { width, height } = await sharp(imageBuffer).metadata();
  const VIDEO_PROMPT = VIDEO_PROMPTS[Math.floor(Math.random() * VIDEO_PROMPTS.length)];
  const promptLabel = VIDEO_PROMPT.startsWith('[Static locked') ? 'controlled' : 'crazy';
  console.log(`[video:${jobId}] Starting MiniMax I2V (${width}x${height}) — prompt: ${promptLabel}`);

  const imageB64 = `data:image/png;base64,${imageBuffer.toString('base64')}`;

  // Submit generation job
  const submitRes = await axios.post(
    'https://api.minimax.io/v1/video_generation',
    {
      model: 'MiniMax-Hailuo-2.3-Fast',
      first_frame_image: imageB64,
      prompt: VIDEO_PROMPT,
      prompt_optimizer: false,
      fast_pretreatment: true,
      duration: 6,
    },
    {
      headers: { 'Authorization': `Bearer ${MINIMAX}`, 'Content-Type': 'application/json' },
      timeout: 30_000,
    }
  );

  const taskId = submitRes.data?.task_id;
  if (!taskId) throw new Error(`MiniMax submit failed: ${JSON.stringify(submitRes.data)}`);
  console.log(`[video:${jobId}] MiniMax task_id: ${taskId}`);

  // Poll up to 10 minutes (60 × 10s)
  let fileId;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 10_000));
    const pollRes = await axios.get(
      `https://api.minimax.io/v1/query/video_generation?task_id=${taskId}`,
      { headers: { 'Authorization': `Bearer ${MINIMAX}` }, timeout: 30_000 }
    );
    const { status, file_id } = pollRes.data;
    if (i % 3 === 0) console.log(`[video:${jobId}] MiniMax status: ${status} (~${(i+1)*10}s)`);
    if (status === 'Success') { fileId = file_id; break; }
    if (status === 'Fail') throw new Error('MiniMax generation failed');
  }

  if (!fileId) throw new Error('MiniMax generation timed out');

  // Get download URL from file_id
  const fileRes = await axios.get(
    `https://api.minimax.io/v1/files/retrieve?file_id=${fileId}`,
    { headers: { 'Authorization': `Bearer ${MINIMAX}` }, timeout: 30_000 }
  );
  const downloadUrl = fileRes.data?.file?.download_url;
  if (!downloadUrl) throw new Error('MiniMax: no download URL in response');

  // Download video
  console.log(`[video:${jobId}] Downloading video...`);
  const videoRes = await axios.get(downloadUrl, { responseType: 'arraybuffer', timeout: 120_000 });

  const filename = `${jobId}-video.mp4`;
  const rawPath  = path.join(OUTPUTS_DIR, `${jobId}-raw.mp4`);
  const outPath  = path.join(OUTPUTS_DIR, filename);
  fs.writeFileSync(rawPath, Buffer.from(videoRes.data));

  // Upload silent video to fal storage for MMAudio to access
  console.log(`[video:${jobId}] Uploading to fal storage...`);
  const videoFile = new File([fs.readFileSync(rawPath)], 'video.mp4', { type: 'video/mp4' });
  const publicUrl = await fal.storage.upload(videoFile);
  console.log(`[video:${jobId}] Fal URL: ${publicUrl}`);

  // MMAudio V2 — generate crying audio matched to video
  console.log(`[video:${jobId}] Running MMAudio V2...`);
  const audioResult = await fal.subscribe('fal-ai/mmaudio-v2', {
    input: {
      video_url: publicUrl,
      prompt: 'Loud uncontrollable crying and sobbing, heavy tears streaming, emotional breakdown, sniffling, wailing, gasping between sobs',
      duration: 6,
      cfg_strength: 7,
      num_steps: 25,
    },
  });

  const audioVideoUrl = audioResult?.data?.video?.url;
  if (!audioVideoUrl) {
    console.warn(`[video:${jobId}] MMAudio failed — falling back to silent video`);
    // Strip metadata from raw and use as final output
    await new Promise((resolve, reject) => {
      const proc = spawn('ffmpeg', [
        '-i', rawPath, '-map_metadata', '-1',
        '-c:v', 'copy', '-y', outPath,
      ]);
      proc.on('error', err => reject(new Error(`ffmpeg spawn error: ${err.message}`)));
      proc.on('close', code => {
        fs.unlinkSync(rawPath);
        code === 0 ? resolve() : reject(new Error('FFmpeg fallback failed'));
      });
    });
    return filename;
  }

  // Download final video (audio already merged by MMAudio)
  console.log(`[video:${jobId}] Downloading final video with audio...`);
  const finalRes = await axios.get(audioVideoUrl, { responseType: 'arraybuffer', timeout: 120_000 });
  fs.unlinkSync(rawPath);

  // Strip metadata
  const withAudioPath = path.join(OUTPUTS_DIR, `${jobId}-audio.mp4`);
  fs.writeFileSync(withAudioPath, Buffer.from(finalRes.data));
  await new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-i', withAudioPath, '-map_metadata', '-1',
      '-c:v', 'copy', '-c:a', 'copy', '-y', outPath,
    ]);
    let errLog = '';
    proc.stderr.on('data', d => { errLog += d.toString(); });
    proc.on('error', err => reject(new Error(`ffmpeg spawn error: ${err.message}`)));
    proc.on('close', code => {
      fs.unlinkSync(withAudioPath);
      code === 0 ? resolve() : reject(new Error(errLog.slice(-400)));
    });
  });

  return filename;
}

// ─── GIF generation ───────────────────────────────────────────────────────────
async function runGifGeneration(sourceJobId, isMobile) {
  const inputPath   = path.join(OUTPUTS_DIR, `${sourceJobId}.png`);
  const gifId       = uuidv4();
  const outPath     = path.join(OUTPUTS_DIR, `${gifId}-crying.gif`);
  const palettePath = path.join(OUTPUTS_DIR, `${gifId}-palette.png`);

  const { width, height } = await sharp(inputPath).metadata();

  // Size targets: mobile < 5MB, desktop < 14MB
  const targetW = isMobile ? 360 : 540;
  const w       = targetW % 2 === 0 ? targetW : targetW - 1;
  const h       = Math.round(height * w / width) & ~1;
  const fps     = isMobile ? 10 : 13;
  const dur     = isMobile ? 2.8 : 3.4;
  const colors  = isMobile ? 128 : 256;
  const shakeX  = isMobile ? 6 : 10;
  const shakeY  = isMobile ? 4 : 6;
  const bigW    = Math.round(w * 1.12) & ~1;  // 12% extra for shake room
  const bigH    = Math.round(h * 1.12) & ~1;

  const runFF = (args) => new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    let errLog = '';
    proc.stderr.on('data', d => { errLog += d.toString(); });
    proc.on('error', err => reject(new Error(`ffmpeg spawn error: ${err.message}`)));
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(errLog.slice(-600))));
  });

  // Pass 1 — generate palette from the static source image (instant, 1 frame)
  // Must match same eq settings as pass 2 so colours are consistent
  await runFF([
    '-y', '-i', inputPath,
    '-vf', `scale=${w}:${h}:flags=lanczos,eq=saturation=1.45:contrast=1.1,palettegen=max_colors=${colors}`,
    palettePath,
  ]);

  // Pass 2 — loop image, apply shake via crop, apply palette
  // crop x/y use `t` (seconds) — mismatched periods = organic trembling feel
  const animFilter =
    `fps=${fps},` +
    `scale=${bigW}:${bigH}:flags=lanczos,` +
    `crop=${w}:${h}:x='(in_w-${w})/2+${shakeX}*sin(6.28318*t/0.27)':y='(in_h-${h})/2+${shakeY}*sin(6.28318*t/0.21)',` +
    `eq=saturation=1.45:contrast=1.1,` +
    `vignette=0.785`;

  await runFF([
    '-y', '-loop', '1', '-i', inputPath,
    '-i', palettePath,
    '-t', String(dur),
    '-lavfi', `${animFilter} [x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5`,
    outPath,
  ]);

  fs.unlinkSync(palettePath);
  return { gifId, filename: `${gifId}-crying.gif` };
}

// POST /generate-gif — synchronous (FFmpeg only, fast)
app.post('/generate-gif', upload.none(), async (req, res) => {
  const sourceJobId = (req.body?.sourceJobId || '').trim();
  if (!sourceJobId || !/^[a-f0-9-]+$/i.test(sourceJobId)) {
    return res.status(400).json({ error: 'sourceJobId is required' });
  }
  const inputPath = path.join(OUTPUTS_DIR, `${sourceJobId}.png`);
  if (!fs.existsSync(inputPath)) {
    return res.status(404).json({ error: 'Source image not found' });
  }

  const isMobile = req.body?.mobile === 'true';
  console.log(`[gif] Generating for ${sourceJobId} (mobile=${isMobile})...`);

  try {
    const { filename } = await runGifGeneration(sourceJobId, isMobile);
    const base = `${req.protocol}://${req.get('host')}`;
    console.log(`[gif] Done → ${filename}`);
    res.json({ url: `${base}/outputs/${filename}` });
  } catch (err) {
    console.error('[gif] Error:', err.message);
    res.status(500).json({ error: 'GIF generation failed' });
  }
});

// POST /generate-video — starts MiniMax I2V in background, returns videoJobId immediately
app.post('/generate-video', upload.none(), async (req, res) => {
  if (!MINIMAX) {
    return res.status(500).json({ error: 'MINIMAX_API_KEY not configured' });
  }

  const sourceJobId = (req.body?.sourceJobId || '').trim();
  if (!sourceJobId || !/^[a-f0-9-]+$/i.test(sourceJobId)) {
    return res.status(400).json({ error: 'sourceJobId is required' });
  }

  const sourceFile = path.join(OUTPUTS_DIR, `${sourceJobId}.png`);
  if (!fs.existsSync(sourceFile)) {
    return res.status(404).json({ error: 'Source image not found' });
  }

  const videoJobId = uuidv4();
  videoJobs.set(videoJobId, { status: 'generating', created_at: new Date().toISOString() });

  // Fire-and-forget — Veo takes 2-5 min
  (async () => {
    try {
      const imageBuffer = fs.readFileSync(sourceFile);
      const filename = await runVideoGeneration(videoJobId, imageBuffer);
      const job = videoJobs.get(videoJobId);
      job.status   = 'done';
      job.filename = filename;
      console.log(`[video:${videoJobId}] Done — ${filename}`);
    } catch (err) {
      console.error(`[video:${videoJobId}] Error:`, err.message);
      const job = videoJobs.get(videoJobId);
      job.status = 'error';
      job.error  = err.message;
    }
  })();

  res.json({ videoJobId, status: 'generating' });
});

// GET /video-status/:videoJobId — frontend polls this
app.get('/video-status/:videoJobId', (req, res) => {
  const { videoJobId } = req.params;
  if (!/^[a-f0-9-]+$/i.test(videoJobId)) return res.status(400).json({ error: 'Invalid videoJobId' });

  const job = videoJobs.get(videoJobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  if (job.status === 'done') {
    const base = `${req.protocol}://${req.get('host')}`;
    return res.json({ status: 'done', url: `${base}/outputs/${job.filename}`, created_at: job.created_at });
  }
  if (job.status === 'error') {
    return res.json({ status: 'error', error: job.error });
  }
  res.json({ status: 'generating' });
});

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const line = '─'.repeat(48);
  console.log(`\n╔${line}╗`);
  console.log(`║  😭  CRY-IFY BACKEND (Gemini+MiniMax+MMAudio)  ║`);
  console.log(`╠${line}╣`);
  console.log(`║  Server  →  http://localhost:${PORT}               ║`);
  console.log(`║  Gemini  →  ${(GEMINI ? '✓ configured' : '✗ MISSING').padEnd(35)}║`);
  console.log(`║  MiniMax →  ${(MINIMAX ? '✓ configured' : '✗ MISSING — add to .env').padEnd(35)}║`);
  console.log(`╚${line}╝\n`);
});
