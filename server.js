const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const googleTTS = require('google-tts-api');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');

ffmpeg.setFfmpegPath(ffmpegStatic);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

const LANG_MAP = {
  'en-US': 'en',
  'es-ES': 'es',
  'pt-BR': 'pt',
  'de-DE': 'de',
  'fr-FR': 'fr',
  'it-IT': 'it',
  'ko-KR': 'ko',
  'ja-JP': 'ja',
  'hi-IN': 'hi',
  'mr-IN': 'mr'
};

/**
 * Universal text chunker:
 * Handles Western punctuation, spaces, full-width Japanese/Chinese punctuation (。、！？),
 * and hard-slices any string chunks exceeding 180 characters.
 */
function splitTextUniversally(rawText, maxLength = 180) {
  // Regex splitting on both Western & CJK punctuation / newlines
  const regex = /([^。、！？\.,\?!;: \n\r\t]+[。、！？\.,\?!;: \n\r\t]*)/gu;
  const matches = rawText.match(regex) || [rawText];
  const chunks = [];
  let currentChunk = '';

  for (const piece of matches) {
    if ((currentChunk + piece).length <= maxLength) {
      currentChunk += piece;
    } else {
      if (currentChunk.trim().length > 0) {
        chunks.push(currentChunk.trim());
      }
      // If a single segment without punctuation is still longer than maxLength, hard-slice it
      if (piece.length > maxLength) {
        for (let i = 0; i < piece.length; i += maxLength) {
          chunks.push(piece.slice(i, i + maxLength).trim());
        }
        currentChunk = '';
      } else {
        currentChunk = piece;
      }
    }
  }

  if (currentChunk.trim().length > 0) {
    chunks.push(currentChunk.trim());
  }

  return chunks.filter(c => c.length > 0);
}

app.post('/api/generate-tts', async (req, res) => {
  const { text, lang = 'en-US' } = req.body;

  if (!text || text.trim() === '') {
    return res.status(400).json({ error: 'Text prompt is required.' });
  }

  const langCode = LANG_MAP[lang] || 'en';
  const fileId = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const rawMp3Path = path.join(TEMP_DIR, `${fileId}.mp3`);
  const genesysWavPath = path.join(TEMP_DIR, `${fileId}_genesys.wav`);

  console.log(`\n--- [NEW REQUEST] ---`);
  console.log(`Language: ${langCode} (${lang})`);
  console.log(`Total Length: ${text.length} characters`);

  try {
    // 1. Split text with universal punctuation support (including Japanese/Chinese)
    const textChunks = splitTextUniversally(text, 180);
    console.log(`1. Processing ${textChunks.length} text chunk(s)...`);

    // 2. Fetch base64 audio for each chunk in sequence
    const audioBuffers = [];
    for (let i = 0; i < textChunks.length; i++) {
      const chunkText = textChunks[i];
      const base64Audio = await googleTTS.getAudioBase64(chunkText, {
        lang: langCode,
        slow: false,
        timeout: 10000
      });
      audioBuffers.push(Buffer.from(base64Audio, 'base64'));
    }

    // 3. Concatenate all audio segments into a single file
    const combinedBuffer = Buffer.concat(audioBuffers);
    await fs.promises.writeFile(rawMp3Path, combinedBuffer);
    console.log(`✓ Audio downloaded & concatenated (${combinedBuffer.length} bytes).`);

    // 4. Transcode to Genesys Architect specification:
    // 8000 Hz, 1-Channel Mono, 16-bit PCM (pcm_s16le)
    console.log(`2. Transcoding to 8000Hz Mono 16-bit PCM WAV...`);
    await new Promise((resolve, reject) => {
      ffmpeg(rawMp3Path)
        .audioChannels(1)
        .audioFrequency(8000)
        .audioCodec('pcm_s16le')
        .format('wav')
        .output(genesysWavPath)
        .on('end', () => {
          console.log(`✓ Transcode successful.`);
          resolve();
        })
        .on('error', (err) => {
          console.error(`❌ Transcode Error:`, err.message);
          reject(err);
        })
        .run();
    });

    // 5. Send file to browser
    console.log(`3. Sending prompt WAV to client...`);
    const wavBuffer = await fs.promises.readFile(genesysWavPath);

    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Disposition', `attachment; filename="genesys_${langCode}_8k.wav"`);
    res.send(wavBuffer);
    console.log(`✓ Delivered ${wavBuffer.length} bytes.`);

    // Cleanup temp files safely
    setTimeout(() => {
      try {
        if (fs.existsSync(rawMp3Path)) fs.unlinkSync(rawMp3Path);
        if (fs.existsSync(genesysWavPath)) fs.unlinkSync(genesysWavPath);
      } catch (e) {}
    }, 2000);

  } catch (err) {
    console.error(`❌ Process Error:`, err.message || err);
    res.status(500).json({ error: 'TTS request failed: ' + (err.message || err) });
  }
});

app.listen(PORT, () => {
  console.log(`\n======================================================`);
  console.log(`Telephony Studio running at: http://localhost:${PORT}`);
  console.log(`Full Multilingual CJK & Unlimited Text Support active.`);
  console.log(`======================================================\n`);
});