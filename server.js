require('dotenv').config();
const express  = require('express');
const multer   = require('multer');
const sharp    = require('sharp');
const axios    = require('axios');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');
const { v4: uuidv4 } = require('uuid');

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const PORT   = process.env.PORT || 3005;
const GEMINI = process.env.GEMINI_API_KEY || '';

// ─── Outputs folder ───────────────────────────────────────────────────────────
const OUTPUTS_DIR = path.join(__dirname, 'outputs');
if (!fs.existsSync(OUTPUTS_DIR)) fs.mkdirSync(OUTPUTS_DIR);

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

  const parts   = res.data.candidates?.[0]?.content?.parts || [];
  const imgPart = parts.find(p => p.inlineData?.mimeType?.startsWith('image/'));
  if (!imgPart) throw new Error('Gemini returned no image. Response: ' + JSON.stringify(res.data).slice(0, 300));

  return Buffer.from(imgPart.inlineData.data, 'base64');
}

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    gemini_key: GEMINI && GEMINI !== 'your_gemini_api_key_here' ? 'configured' : 'MISSING',
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
      .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 6 })
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

// ─── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const line = '─'.repeat(48);
  console.log(`\n╔${line}╗`);
  console.log(`║  😭  CRY-IFY BACKEND (Gemini)                  ║`);
  console.log(`╠${line}╣`);
  console.log(`║  Server  →  http://localhost:${PORT}               ║`);
  console.log(`║  Gemini  →  ${(GEMINI && GEMINI !== 'your_gemini_api_key_here' ? '✓ configured' : '✗ MISSING — add to .env').padEnd(35)}║`);
  console.log(`╚${line}╝\n`);
});
