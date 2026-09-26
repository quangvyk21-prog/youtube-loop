import * as transcriptPkg from "youtube-transcript";

const fetchTranscript =
  transcriptPkg.fetchTranscript ||
  transcriptPkg.YoutubeTranscript?.fetchTranscript?.bind(transcriptPkg.YoutubeTranscript);

export default async function handler(req, res) {
  const videoId = String(req.query?.videoId || "");
  const lang = String(req.query?.lang || "en");

  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({ error: "Invalid YouTube video ID." });
  }

  if (!fetchTranscript) {
    return res.status(500).json({ error: "Transcript module is unavailable." });
  }

  try {
    const items = await fetchTranscript(videoId, { lang });

    return res.status(200).json({
      videoId,
      lang,
      items: Array.isArray(items) ? items : []
    });
  } catch (error) {
    return res.status(404).json({
      error: error?.message || "No transcript is available for this video."
    });
  }
}
