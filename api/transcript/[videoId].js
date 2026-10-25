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

function extractJsonArrayAfterMarker(source, marker) {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) return null;

  const start = source.indexOf("[", markerIndex + marker.length);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < source.length; i++) {
    const ch = source[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "[") depth++;
    if (ch === "]") {
      depth--;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }

  return null;
}

function chooseCaptionTrack(tracks, lang) {
  if (!Array.isArray(tracks) || !tracks.length) {
    return null;
  }

  const wanted = String(lang || "en").toLowerCase();

  return (
    tracks.find(
      track =>
        String(track?.languageCode || "")
          .toLowerCase() === wanted
    ) ||
    tracks.find(
      track =>
        String(track?.languageCode || "")
          .toLowerCase()
          .startsWith(wanted.split("-")[0])
    ) ||
    tracks.find(
      track =>
        String(track?.languageCode || "")
          .toLowerCase()
          .startsWith("en")
    ) ||
    tracks[0]
  );
}

async function getYoutubeWordTiming(videoId, lang) {
  try {
    const watchResponse = await fetch(
      `https://www.youtube.com/watch?v=${videoId}&hl=en`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/156 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9"
        }
      }
    );

    if (!watchResponse.ok) return [];

    const html = await watchResponse.text();

    const tracksJson =
      extractJsonArrayAfterMarker(
        html,
        '"captionTracks":'
      );

    if (!tracksJson) return [];

    const tracks = JSON.parse(tracksJson);
    const track = chooseCaptionTrack(tracks, lang);

    if (!track?.baseUrl) return [];

    const captionUrl = new URL(track.baseUrl);
    captionUrl.searchParams.set("fmt", "json3");

    const captionResponse = await fetch(
      captionUrl.toString(),
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/156 Safari/537.36"
        }
      }
    );

    if (!captionResponse.ok) return [];

    const json3 = await captionResponse.json();
    const rawWords = [];

    for (const event of json3?.events || []) {
      if (!Array.isArray(event?.segs)) continue;

      const eventStart =
        Number(event?.tStartMs) || 0;

      const eventDuration =
        Number(event?.dDurationMs) || 0;

      for (let i = 0; i < event.segs.length; i++) {
        const seg = event.segs[i];

        const text = String(seg?.utf8 || "")
          .replace(/\n/g, " ")
          .trim();

        if (!text) continue;

        const offset =
          eventStart +
          (Number(seg?.tOffsetMs) || 0);

        let nextOffset = null;

        for (let j = i + 1; j < event.segs.length; j++) {
          const nextText = String(
            event.segs[j]?.utf8 || ""
          )
            .replace(/\n/g, " ")
            .trim();

          if (!nextText) continue;

          nextOffset =
            eventStart +
            (Number(event.segs[j]?.tOffsetMs) || 0);
          break;
        }

        const eventEnd =
          eventStart +
          Math.max(80, eventDuration);

        const duration = Math.max(
          50,
          (nextOffset ?? eventEnd) - offset
        );

        rawWords.push({
          text,
          offset,
          duration
        });
      }
    }

    // Auto captions can repeat rolling caption segments.
    // Deduplicate same text occurring at nearly the same timestamp.
    const deduped = [];
    const seen = new Set();

    for (const word of rawWords) {
      const key =
        `${Math.round(word.offset / 20)}:${word.text}`;

      if (seen.has(key)) continue;

      seen.add(key);
      deduped.push(word);
    }

    return deduped.sort(
      (a, b) => a.offset - b.offset
    );
  } catch (error) {
    console.log(
      "YouTube json3 word timing unavailable:",
      error?.message
    );

    return [];
  }
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
    // Word-level timing từ YouTube json3.
    // Nếu nguồn caption không hỗ trợ thì trả [] và UI tự fallback.
    const words = await getYoutubeWordTiming(
      videoId,
      lang
    );

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
        items: oldItems,
        words
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
      items,
      words
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
