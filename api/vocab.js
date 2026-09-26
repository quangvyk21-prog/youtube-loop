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
  timeoutMs = 15000
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
  ).slice(0, 12000);

  const loopName = clean(
    req.body?.loopName
  );

  if (!transcript) {
    return res.status(400).json({
      error:
        "Loop chưa có transcript để lấy từ mới."
    });
  }

  const prompt = [
    "Bạn là giáo viên tiếng Anh cho người Việt.",
    "Từ đoạn phụ đề của loop, chọn tối đa 8 từ hoặc cụm từ đáng học nhất.",
    "Ưu tiên từ/cụm hữu ích giúp người học hiểu nội dung, nhân vật và hành động trong đoạn.",
    "Ưu tiên phrasal verbs, idioms, collocations, slang và từ đáng học.",
    "Từ cơ bản vẫn có thể chọn nếu nó quan trọng trong ngữ cảnh.",
    "Không chọn từ hiếm chỉ vì nó khó.",
    "Không ghép các từ cạnh nhau nếu chúng không phải cụm tự nhiên.",
    "Mỗi mục chỉ có term và meaningVi.",
    "meaningVi phải ngắn, tự nhiên và đúng ngữ cảnh.",
    "Tối đa 8 mục.",
    "",
    `LOOP: ${loopName || "Loop"}`,
    `PHỤ ĐỀ: ${transcript}`
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
              maxOutputTokens: 700,
              temperature: 0.2,

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
        15000
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

    const raw = clean(
      data?.candidates?.[0]?.content?.parts
        ?.map(
          part => part?.text || ""
        )
        .join("")
    );

    let parsed;

    try {
      parsed = JSON.parse(raw);
    } catch {
      return res.status(502).json({
        error:
          "Gemini trả danh sách từ mới không đúng JSON."
      });
    }

    const items =
      Array.isArray(parsed?.items)
        ? parsed.items
            .map(item => ({
              term: clean(
                item?.term
              ),

              meaningVi: clean(
                item?.meaningVi
              )
            }))
            .filter(
              item =>
                item.term &&
                item.meaningVi
            )
            .slice(0, 8)
        : [];

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
