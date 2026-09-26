import express from "express";
import { createServer as createViteServer } from "vite";
import * as transcriptPkg from "youtube-transcript";

const app = express();
const PORT = Number(process.env.PORT || 5173);

const fetchTranscript =
  transcriptPkg.fetchTranscript ||
  transcriptPkg.YoutubeTranscript?.fetchTranscript?.bind(transcriptPkg.YoutubeTranscript);

app.get("/api/transcript/:videoId", async (req, res) => {
  const { videoId } = req.params;
  const lang = String(req.query.lang || "en");

  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: "Invalid YouTube video ID." });
  }

  if (!fetchTranscript) {
    return res.status(500).json({ error: "Transcript module is unavailable." });
  }

  try {
    const items = await fetchTranscript(videoId, { lang });
    res.json({
      videoId,
      lang,
      items: Array.isArray(items) ? items : []
    });
  } catch (error) {
    res.status(404).json({
      error: error?.message || "No transcript is available for this video."
    });
  }
});

const vite = await createViteServer({
  server: {
    middlewareMode: true
  },
  appType: "spa"
});

app.use(vite.middlewares);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`YouTube Loop V5: http://localhost:${PORT}/`);
});
