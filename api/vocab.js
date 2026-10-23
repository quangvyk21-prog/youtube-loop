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
    res.setHeader(
      "Allow",
      "POST"
    );

    return res.status(405).json({
      error:
        "Method not allowed."
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
        "Loop chưa có transcript để lấy nội dung."
    });
  }

  const prompt = [
    "Bạn là giáo viên tiếng Anh cho người Việt.",
    "",
    "Bạn sẽ nhận transcript của MỘT ĐOẠN LOOP trong video tiếng Anh.",
    "",
    "Hãy thực hiện 2 nhiệm vụ:",
    "",
    "NHIỆM VỤ 1 - TÓM TẮT Ý CHÍNH:",
    "- Viết summaryVi bằng tiếng Việt.",
    "- Tóm tắt nội dung chính của đoạn hội thoại để người học hiểu bối cảnh TRƯỚC KHI NGHE.",
    "- Chỉ 2 đến 3 câu ngắn.",
    "- Không dịch từng câu.",
    "- Không kể lan man.",
    "- Nêu rõ hai bên đang nói về chuyện gì, quan điểm hoặc sự việc chính là gì.",
    "- Dùng tiếng Việt tự nhiên, dễ hiểu.",
    "",
    "NHIỆM VỤ 2 - TỪ VỰNG:",
    "Chọn các từ/cụm từ quan trọng nhất để người học nhìn danh sách từ vựng và có thể đoán được nội dung chính của đoạn loop.",
    "",
    "QUY TẮC CHỌN TỪ:",
    "1. Ưu tiên CỤM TỪ tự nhiên hơn từ đơn.",
    "2. Ưu tiên phrasal verbs, collocations, expressions, idioms, slang.",
    "3. Ưu tiên từ/cụm là từ khóa nội dung: chủ đề, người/sự vật, hành động chính, cảm xúc, trạng thái, sự kiện.",
    "4. Phải giúp hiểu TOÀN BỘ đoạn loop.",
    "5. Cố gắng phủ nội dung từ đầu đến cuối loop.",
    "6. Không chọn từ hiếm chỉ vì nó khó.",
    "7. Từ cơ bản vẫn được chọn nếu quan trọng.",
    "8. Không tách cụm tự nhiên thành nhiều từ đơn.",
    "9. Không tự tạo cụm không xuất hiện hoặc không phù hợp transcript.",
    "10. Không chọn nhiều mục có ý nghĩa trùng nhau.",
    "11. Sắp xếp theo thứ tự xuất hiện.",
    "12. Chọn tối đa 8 mục, không bắt buộc đủ 8.",
    "",
    "meaningVi:",
    "- Dịch ngắn.",
    "- Tự nhiên.",
    "- Đúng nghĩa trong ngữ cảnh.",
    "- Không giải thích dài.",
    "",
    "MỤC TIÊU CUỐI CÙNG:",
    "summaryVi + danh sách từ vựng phải giúp người học hình dung đoạn hội thoại đang nói gì trước khi bấm nghe.",
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
              maxOutputTokens: 900,
              temperature: 0.2,

              responseMimeType:
                "application/json",

              responseSchema: {
                type: "OBJECT",

                properties: {
                  summaryVi: {
                    type: "STRING"
                  },

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

                required: [
                  "summaryVi",
                  "items"
                ]
              }
            }
          })
        },
        15000
      );

    const data =
      await response
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
      data?.candidates?.[0]
        ?.content?.parts
        ?.map(
          part =>
            part?.text || ""
        )
        .join("")
    );

    let parsed;

    try {
      parsed =
        JSON.parse(raw);

    } catch {
      return res
        .status(502)
        .json({
          error:
            "Gemini trả nội dung loop không đúng JSON."
        });
    }

    const summaryVi =
      clean(
        parsed?.summaryVi
      );

    const items =
      Array.isArray(
        parsed?.items
      )
        ? parsed.items
            .map(item => ({
              term:
                clean(
                  item?.term
                ),

              meaningVi:
                clean(
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

    return res
      .status(200)
      .json({
        summaryVi,
        items,
        model: MODEL
      });

  } catch (error) {
    return res
      .status(
        error?.status ||
        502
      )
      .json({
        error:
          error?.message ||
          "Không gọi được Gemini API."
      });
  }
}
