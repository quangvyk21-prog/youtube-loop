import * as transcriptPkg from "youtube-transcript";

const fetchTranscript =
  transcriptPkg.fetchTranscript ||
  transcriptPkg.YoutubeTranscript?.fetchTranscript?.bind(
    transcriptPkg.YoutubeTranscript
  );

async function tryOldMethod(videoId, lang) {
  if (!fetchTranscript) return [];

  try {
    const items = await fetchTranscript(videoId, { lang });

    if (Array.isArray(items) && items.length) {
      return items;
    }
  } catch (error) {
    console.log(
      "youtube-transcript failed, using Supadata:",
      error?.message
    );
  }

  return [];
}

async function getFromSupadata(videoId, lang) {
  const apiKey = String(
    process.env.SUPADATA_API_KEY || ""
  ).trim();

  if (!apiKey) {
    throw new Error(
      "Vercel chưa có SUPADATA_API_KEY."
    );
  }

  const url = new URL(
    "https://api.supadata.ai/v1/transcript"
  );

  url.searchParams.set(
    "url",
    `https://www.youtube.com/watch?v=${videoId}`
  );

  url.searchParams.set("lang", lang);

  const response = await fetch(url, {
    headers: {
      "x-api-key": apiKey,
      Accept: "application/json"
    }
  });

  const data = await response
    .json()
    .catch(() => ({}));

  if (!response.ok) {
    throw new Error(
      data?.message ||
      data?.error ||
      `Supadata HTTP ${response.status}`
    );
  }

  const content = Array.isArray(data?.content)
    ? data.content
    : [];

  if (!content.length) {
    throw new Error(
      "Supadata không trả về transcript."
    );
  }

  return content
    .map(item => ({
      text: String(item?.text || "")
        .replace(/\s+/g, " ")
        .trim(),

      offset: Number(item?.offset) || 0,

      duration: Number(item?.duration) || 0
    }))
    .filter(item => item.text);
}

export default async function handler(req, res) {
  const videoId = String(
    req.query?.videoId || ""
  ).trim();

  const lang = String(
    req.query?.lang || "en"
  ).trim();

  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({
      error: "Invalid YouTube video ID."
    });
  }

  try {
    // 1. Thử cách cũ trước: không tốn Supadata credit
    const oldItems = await tryOldMethod(
      videoId,
      lang
    );

    if (oldItems.length) {
      res.setHeader(
        "Cache-Control",
        "public, s-maxage=31536000, stale-while-revalidate=86400"
      );

      return res.status(200).json({
        videoId,
        lang,
        source: "youtube-transcript",
        items: oldItems
      });
    }

    // 2. Cách cũ fail -> Supadata
    const items = await getFromSupadata(
      videoId,
      lang
    );

    res.setHeader(
      "Cache-Control",
      "public, s-maxage=31536000, stale-while-revalidate=86400"
    );

    return res.status(200).json({
      videoId,
      lang,
      source: "supadata",
      items
    });

  } catch (error) {
    res.setHeader(
      "Cache-Control",
      "no-store"
    );

    return res.status(502).json({
      error:
        error?.message ||
        "Không lấy được transcript."
    });
  }
}
