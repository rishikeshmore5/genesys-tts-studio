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
  'zh-CN': 'zh',
  'hi-IN': 'hi',
  'mr-IN': 'mr'
};

// Acoustic filter configurations for different voice personas
// Rescaling input sample clock (asetrate) + tempo normalization (atempo) shifts vocal timbre
const PERSONA_FILTERS = {
  'standard': [],
  'deep': [
    'asetrate=44100*0.84', // Lowers pitch down for a deeper tone
    'atempo=1.19'          // Restores standard speaking tempo
  ],
  'soft': [
    'asetrate=44100*0.93', // Subtle lower shift
    'atempo=0.92',         // Slower, calmer cadence
    'lowpass=f=3200'       // Rolls off sharp sibilance for warmer sound
  ],
  'expressive': [
    'asetrate=44100*1.12', // Slightly brighter/higher pitch
    'atempo=0.89'          // Compensates pacing
  ]
};

function splitTextUniversally(rawText, maxLength = 180) {
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
  const { text, lang = 'en-US', persona = 'standard' } = req.body;

  if (!text || text.trim() === '') {
    return res.status(400).json({ error: 'Text prompt is required.' });
  }

  const langCode = LANG_MAP[lang] || 'en';
  const fileId = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  const rawMp3Path = path.join(TEMP_DIR, `${fileId}.mp3`);
  const genesysWavPath = path.join(TEMP_DIR, `${fileId}_genesys.wav`);

  console.log(`\n--- [NEW REQUEST] ---`);
  console.log(`Language: ${langCode} (${lang})`);
  console.log(`Persona: ${persona}`);
  console.log(`Total Length: ${text.length} characters`);

  try {
    // 1. Chunk and download speech segments over HTTPS
    const textChunks = splitTextUniversally(text, 180);
    console.log(`1. Processing ${textChunks.length} text chunk(s)...`);

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

    const combinedBuffer = Buffer.concat(audioBuffers);
    await fs.promises.writeFile(rawMp3Path, combinedBuffer);
    console.log(`✓ Audio downloaded & concatenated (${combinedBuffer.length} bytes).`);

    // 2. Transcode with persona filters to Genesys 8000Hz 16-bit Mono WAV
    console.log(`2. Transcoding with [${persona}] persona filters...`);
    const customFilters = PERSONA_FILTERS[persona] || PERSONA_FILTERS['standard'];

    await new Promise((resolve, reject) => {
      let command = ffmpeg(rawMp3Path);

      if (customFilters.length > 0) {
        command = command.audioFilters(customFilters);
      }

      command
        .audioChannels(1)              // Mono
        .audioFrequency(8000)          // 8 kHz
        .audioCodec('pcm_s16le')       // Signed 16-bit PCM
        .format('wav')
        .output(genesysWavPath)
        .on('end', () => {
          console.log(`✓ Transcode completed with [${persona}] styling.`);
          resolve();
        })
        .on('error', (err) => {
          console.error(`❌ Transcode Error:`, err.message);
          reject(err);
        })
        .run();
    });

    // 3. Send file to browser
    const wavBuffer = await fs.promises.readFile(genesysWavPath);
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Content-Disposition', `attachment; filename="genesys_${langCode}_${persona}_8k.wav"`);
    res.send(wavBuffer);
    console.log(`✓ Delivered ${wavBuffer.length} bytes.`);

    // Cleanup temp files
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
  console.log(`Persona Engine & CJK Multilingual active.`);
  console.log(`======================================================\n`);
});
