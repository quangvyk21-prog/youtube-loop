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
    20000
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

async function translateBatchRobust(
  apiKey,
  batch
) {
  const makePrompt = (
    entries,
    retry = false
  ) => [
    "Bạn là biên dịch viên phụ đề tiếng Anh sang tiếng Việt.",
    "Dịch tự nhiên theo đúng ngữ cảnh hội thoại, không dịch từng chữ.",
    "Mỗi câu có ID riêng. PHẢI trả lại đúng ID tương ứng.",
    "Không được gộp hai câu thành một. Không được bỏ sót câu.",
    "Không được đổi thứ tự ID.",
    retry
      ? "Đây là các câu còn thiếu từ lần trước. Hãy dịch ĐỦ tất cả ID."
      : "Hãy dịch ĐỦ tất cả câu.",
    'Chỉ trả JSON dạng: {"translations":[{"id":0,"text":"..."},{"id":1,"text":"..."}]}',
    "Không giải thích, không markdown.",
    "",
    `SUBTITLES: ${JSON.stringify(entries)}`
  ].join("\n");

  const parseItems = raw => {
    const parsed = parseJson(raw);
    const source =
      Array.isArray(parsed?.translations)
        ? parsed.translations
        : [];

    const map = new Map();

    source.forEach((item, index) => {
      // Hỗ trợ cả format cũ ["..."] lẫn format mới [{id,text}]
      if (typeof item === "string") {
        const value = clean(item);
        if (value) map.set(index, value);
        return;
      }

      const id = Number(item?.id);
      const value = clean(
        item?.text ??
        item?.translation
      );

      if (
        Number.isInteger(id) &&
        id >= 0 &&
        id < batch.length &&
        value
      ) {
        map.set(id, value);
      }
    });

    return map;
  };

  const entries = batch.map(
    (text, id) => ({ id, text })
  );

  const firstRaw = await callGemini(
    apiKey,
    makePrompt(entries, false),
    2200
  );

  const resultMap =
    parseItems(firstRaw);

  const missing = entries.filter(
    item => !resultMap.has(item.id)
  );

  // Gemini đôi lúc bỏ 1-2 câu trong batch.
  // Retry riêng đúng những ID còn thiếu thay vì làm hỏng cả batch.
  if (missing.length) {
    const retryRaw = await callGemini(
      apiKey,
      makePrompt(missing, true),
      Math.max(
        500,
        missing.length * 220
      )
    );

    const retryMap =
      parseItems(retryRaw);

    retryMap.forEach(
      (value, id) => {
        resultMap.set(id, value);
      }
    );
  }

  const translations =
    batch.map(
      (_, id) =>
        clean(resultMap.get(id))
    );

  if (
    translations.some(item => !item)
  ) {
    throw new Error(
      "Gemini chưa trả đủ bản dịch sau khi tự thử lại."
    );
  }

  return translations;
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
      const translations =
        await translateBatchRobust(
          apiKey,
          batch
        );

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
