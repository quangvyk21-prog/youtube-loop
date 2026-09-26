const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function checkAccess(req, res) {
  const apiKey = process.env.GEMINI_API_KEY;
  const privateCode = process.env.TRANSLATE_ACCESS_CODE;
  const suppliedCode = String(req.headers["x-translate-access"] || "");

  if (!apiKey) {
    res.status(500).json({
      error: "Server chưa cấu hình GEMINI_API_KEY."
    });
    return null;
  }

  if (!privateCode) {
    res.status(500).json({
      error: "Server chưa cấu hình TRANSLATE_ACCESS_CODE."
    });
    return null;
  }

  if (!suppliedCode || suppliedCode !== privateCode) {
    res.status(403).json({
      error: "Mã dịch cá nhân không đúng."
    });
    return null;
  }

  return apiKey;
}

function getModelText(data) {
  return String(
    data?.candidates?.[0]?.content?.parts
      ?.map(part => part?.text || "")
      .join("") || ""
  ).trim();
}

function parseJson(text) {
  const raw = String(text || "").trim();

  try {
    return JSON.parse(raw);
  } catch {}

  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");

  if (first >= 0 && last > first) {
    try {
      return JSON.parse(
        raw.slice(first, last + 1)
      );
    } catch {}
  }

  return null;
}

async function fetchWithTimeout(
  url,
  options = {},
  timeoutMs = 15000
) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error(
        "Gemini phản hồi quá lâu. Đợi vài giây rồi thử lại."
      );

      timeoutError.status = 504;

      throw timeoutError;
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function callGemini(
  apiKey,
  prompt,
  maxOutputTokens
) {
  const response = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }]
          }
        ],
        generationConfig: {
          maxOutputTokens,
          temperature: 0.2
        }
      })
    },
    15000
  );

  const data = await response
    .json()
    .catch(() => ({}));

  if (!response.ok) {
    const error = new Error(
      data?.error?.message ||
      `Gemini HTTP ${response.status}`
    );

    error.status = response.status;

    throw error;
  }

  return getModelText(data);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return res.status(405).json({
      error: "Method not allowed."
    });
  }

  const apiKey = checkAccess(req, res);

  if (!apiKey) return;

  try {
    // ===== DỊCH THEO BATCH 12 CÂU =====
    const batch = Array.isArray(req.body?.items)
      ? req.body.items
          .map(item => clean(item?.text))
          .filter(Boolean)
          .slice(0, 12)
      : [];

    if (batch.length) {
      const prompt = [
        "Bạn là biên dịch viên phụ đề tiếng Anh sang tiếng Việt.",
        "Dịch tự nhiên theo đúng ngữ cảnh hội thoại, không dịch từng chữ.",
        "Các câu dưới đây nằm liên tiếp trong cùng một video.",
        "Hãy dùng toàn bộ nhóm câu để hiểu ngữ cảnh.",
        "Giữ đúng số lượng câu và đúng thứ tự.",
        'Chỉ trả JSON dạng: {"translations":["câu 1","câu 2"]}',
        "Không giải thích, không markdown.",
        "",
        `SUBTITLES: ${JSON.stringify(batch)}`
      ].join("\n");

      const raw = await callGemini(
        apiKey,
        prompt,
        1800
      );

      const parsed = parseJson(raw);

      const translations =
        Array.isArray(parsed?.translations)
          ? parsed.translations.map(clean)
          : [];

      if (
        translations.length !== batch.length ||
        translations.some(item => !item)
      ) {
        return res.status(502).json({
          error:
            "Gemini trả về batch dịch không đủ số câu."
        });
      }

      return res.status(200).json({
        translations,
        model: MODEL
      });
    }

    // ===== DỊCH 1 CÂU =====
    const text = clean(req.body?.text);
    const previous = clean(req.body?.previous);
    const next = clean(req.body?.next);

    if (!text) {
      return res.status(400).json({
        error: "Thiếu câu cần dịch."
      });
    }

    const prompt = [
      "Bạn là biên dịch viên phụ đề tiếng Anh sang tiếng Việt.",
      "Dịch tự nhiên theo đúng ngữ cảnh hội thoại.",
      'Chỉ trả JSON dạng: {"translation":"..."}',
      "",
      `CÂU TRƯỚC: ${previous || "(không có)"}`,
      `CÂU HIỆN TẠI: ${text}`,
      `CÂU SAU: ${next || "(không có)"}`
    ].join("\n");

    const raw = await callGemini(
      apiKey,
      prompt,
      240
    );

    const parsed = parseJson(raw);

    const translation = clean(
      parsed?.translation
    );

    if (!translation) {
      return res.status(502).json({
        error:
          "Gemini trả về bản dịch rỗng."
      });
    }

    return res.status(200).json({
      translation,
      model: MODEL
    });

  } catch (error) {
    return res
      .status(error?.status || 502)
      .json({
        error:
          error?.message ||
          "Không gọi được Gemini API."
      });
  }
}
