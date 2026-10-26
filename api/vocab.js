const MODEL =
  process.env.GEMINI_MODEL ||
  "gemini-3.5-flash-lite";

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
  timeoutMs = 10000
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
          "Tạo từ vựng bị timeout."
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

  // Vocab chỉ cần nội dung của loop,
  // không cần gửi paragraph quá dài cho Gemini.
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

  try {
    const response =
      await fetchWithTimeout(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
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
                  "minimal"
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
        10000
      );

    const data = await response
      .json()
      .catch(() => ({}));

    if (!response.ok) {
      return res
        .status(response.status)
        .json({
          error:
            data?.error?.message ||
            `Gemini HTTP ${response.status}`
        });
    }

    const items =
      parseItems(data);

    if (!items.length) {
      return res.status(502).json({
        error:
          "Gemini không trả được danh sách từ vựng."
      });
    }

    return res.status(200).json({
      items,
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
