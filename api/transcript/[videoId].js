import * as transcriptPkg from "youtube-transcript";

const fetchTranscript =
  transcriptPkg.fetchTranscript ||
  transcriptPkg.YoutubeTranscript?.fetchTranscript?.bind(
    transcriptPkg.YoutubeTranscript
  );

function decodeEntities(text = "") {
  return String(text)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCodePoint(parseInt(hex, 16))
    )
    .replace(/&#(\d+);/g, (_, dec) =>
      String.fromCodePoint(parseInt(dec, 10))
    );
}

function parseSrv3Words(xml = "") {
  const words = [];

  const pRegex =
    /<p\s+([^>]*)>([\s\S]*?)<\/p>/g;

  let pMatch;

  while ((pMatch = pRegex.exec(xml)) !== null) {
    const pAttrs = pMatch[1] || "";
    const inner = pMatch[2] || "";

    const pStartMatch =
      pAttrs.match(/\bt="(\d+)"/);

    const pDurationMatch =
      pAttrs.match(/\bd="(\d+)"/);

    if (!pStartMatch) continue;

    const pStart =
      Number(pStartMatch[1]) || 0;

    const pDuration =
      Number(pDurationMatch?.[1]) || 0;

    const spans = [];
    const sRegex =
      /<s([^>]*)>([\s\S]*?)<\/s>/g;

    let sMatch;

    while ((sMatch = sRegex.exec(inner)) !== null) {
      const attrs = sMatch[1] || "";

      const rawText = decodeEntities(
        String(sMatch[2] || "")
          .replace(/<[^>]+>/g, "")
      );

      const text = rawText
        .replace(/\s+/g, " ");

      if (!text.trim()) continue;

      const offsetMatch =
        attrs.match(/\bt="(\d+)"/);

      spans.push({
        text,
        offset:
          Number(offsetMatch?.[1]) || 0
      });
    }

    if (!spans.length) continue;

    // Word-level SRV3 only counts if YouTube actually gave
    // multiple timed spans. Plain untimed <s> is not enough.
    const hasRealOffsets =
      spans.some(
        (span, index) =>
          index > 0 && span.offset > 0
      );

    if (!hasRealOffsets) continue;

    spans.forEach((span, index) => {
      const start =
        pStart + span.offset;

      const nextOffset =
        spans[index + 1]?.offset;

      const paragraphEnd =
        pStart + Math.max(80, pDuration);

      const end =
        Number.isFinite(nextOffset) &&
        nextOffset > span.offset
          ? pStart + nextOffset
          : paragraphEnd;

      words.push({
        text: span.text,
        offset: start,
        duration: Math.max(
          40,
          end - start
        )
      });
    });
  }

  return words;
}

async function tryOldMethod(videoId, lang) {
  if (!fetchTranscript) {
    return {
      items: [],
      words: []
    };
  }

  let rawTimedText = "";

  const captureFetch = async (
    input,
    init
  ) => {
    const response =
      await fetch(input, init);

    try {
      const url =
        typeof input === "string"
          ? input
          : input?.url || "";

      if (
        String(url).includes(
          "api/timedtext"
        )
      ) {
        const text =
          await response
            .clone()
            .text();

        if (
          text.includes("<timedtext") ||
          text.includes("<p ")
        ) {
          rawTimedText = text;
        }
      }
    } catch {}

    return response;
  };

  try {
    const items =
      await fetchTranscript(
        videoId,
        {
          lang,
          fetch: captureFetch
        }
      );

    if (
      Array.isArray(items) &&
      items.length
    ) {
      return {
        items,
        words:
          parseSrv3Words(
            rawTimedText
          )
      };
    }
  } catch (error) {
    console.log(
      "youtube-transcript failed, using Supadata:",
      error?.message
    );
  }

  return {
    items: [],
    words: []
  };
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
    const oldResult = await tryOldMethod(
      videoId,
      lang
    );

    const oldItems =
      oldResult.items || [];

    const words =
      oldResult.words || [];

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
