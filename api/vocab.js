const PRIMARY_MODEL =
  process.env.GEMINI_MODEL ||
  "gemini-3.5-flash-lite";

const FALLBACK_MODEL =
  "gemini-3.8-flash";

function clean(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function checkAccess(req, res) {
  const apiKey =
    process.env.GEMINI_API_KEY;

  const privateCode =
    process.env.TRANSLATE_ACCESS_CODE;

  const suppliedCode = String(
    req.headers["x-translate-access"] || ""
  );

  if (!apiKey) {
    res.status(500).json({
      error:
        "Server chưa cấu hình GEMINI_API_KEY."
    });
    return null;
  }

  if (!privateCode) {
    res.status(500).json({
      error:
        "Server chưa cấu hình TRANSLATE_ACCESS_CODE."
    });
    return null;
  }

  if (
    !suppliedCode ||
    suppliedCode !== privateCode
  ) {
    res.status(403).json({
      error:
        "Mã dịch cá nhân không đúng."
    });
    return null;
  }

  return apiKey;
}

async function fetchWithTimeout(
  url,
  options = {},
  timeoutMs = 22000
) {
  const controller =
    new AbortController();

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
      const timeoutError =
        new Error(
          "Gemini tạo từ vựng phản hồi quá lâu."
        );

      timeoutError.status = 504;
      throw timeoutError;
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function parseItems(data) {
  const raw = String(
    data?.candidates?.[0]?.content?.parts
      ?.map(part => part?.text || "")
      .join("") || ""
  ).trim();

  if (!raw) return [];

  let parsed = null;

  try {
    parsed = JSON.parse(raw);
  } catch {
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");

    if (first >= 0 && last > first) {
      try {
        parsed = JSON.parse(
          raw.slice(first, last + 1)
        );
      } catch {}
    }
  }

  const items =
    Array.isArray(parsed?.items)
      ? parsed.items
      : [];

  return items
    .map(item => ({
      term: clean(item?.term),
      meaningVi: clean(
        item?.meaningVi
      )
    }))
    .filter(
      item =>
        item.term &&
        item.meaningVi
    )
    .slice(0, 8);
}

function getThinkingLevel(model) {
  return model.includes("3.8")
    ? "low"
    : "minimal";
}

async function callModel(
  apiKey,
  model,
  prompt
) {
  const response =
    await fetchWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          "x-goog-api-key":
            apiKey
        },

        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: prompt
                }
              ]
            }
          ],

          generationConfig: {
            maxOutputTokens: 520,

            thinkingConfig: {
              thinkingLevel:
                getThinkingLevel(model)
            },

            responseMimeType:
              "application/json",

            responseSchema: {
              type: "OBJECT",

              properties: {
                items: {
                  type: "ARRAY",
                  maxItems: 8,

                  items: {
                    type: "OBJECT",

                    properties: {
                      term: {
                        type: "STRING"
                      },

                      meaningVi: {
                        type: "STRING"
                      }
                    },

                    required: [
                      "term",
                      "meaningVi"
                    ]
                  }
                }
              },

              required: ["items"]
            }
          }
        })
      },
      22000
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

  const items =
    parseItems(data);

  if (!items.length) {
    const error = new Error(
      "Gemini không trả được danh sách từ vựng."
    );

    error.status = 502;
    throw error;
  }

  return {
    items,
    model
  };
}

function canFallback(error) {
  const status =
    Number(error?.status) || 0;

  return (
    status === 0 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

export default async function handler(
  req,
  res
) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");

    return res.status(405).json({
      error: "Method not allowed."
    });
  }

  const apiKey =
    checkAccess(req, res);

  if (!apiKey) return;

  const transcript = clean(
    req.body?.transcript
  ).slice(0, 3500);

  const loopName = clean(
    req.body?.loopName
  ).slice(0, 120);

  if (!transcript) {
    return res.status(400).json({
      error:
        "Loop chưa có transcript để lấy từ mới."
    });
  }

  const prompt = [
    "Bạn là giáo viên tiếng Anh cho người Việt.",
    "Từ đoạn hội thoại dưới đây, chọn tối đa 8 từ/cụm từ hữu ích nhất.",
    "Ưu tiên collocation, phrasal verb, expression, idiom, slang và từ khóa nội dung.",
    "Ưu tiên cụm tự nhiên hơn từ đơn.",
    "Sắp xếp đúng thứ tự xuất hiện trong transcript.",
    "meaningVi phải ngắn, tự nhiên, đúng ngữ cảnh.",
    "Không giải thích thêm.",
    "",
    `LOOP: ${loopName || "Loop"}`,
    `TRANSCRIPT: ${transcript}`
  ].join("\n");

  const models = [
    PRIMARY_MODEL,
    FALLBACK_MODEL
  ].filter(
    (model, index, list) =>
      model &&
      list.indexOf(model) === index
  );

  let lastError = null;

  for (const model of models) {
    try {
      const result =
        await callModel(
          apiKey,
          model,
          prompt
        );

      return res.status(200).json({
        items: result.items,
        model: result.model
      });

    } catch (error) {
      lastError = error;

      if (!canFallback(error)) {
        break;
      }
    }
  }

  return res
    .status(lastError?.status || 502)
    .json({
      error:
        lastError?.message ||
        "Không tạo được từ vựng."
    });
}
