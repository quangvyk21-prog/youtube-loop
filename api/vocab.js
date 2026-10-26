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
  timeoutMs = 18000
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
          "Gemini phản hồi quá lâu."
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
  prompt
) {
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
            temperature: 0.15,
            responseMimeType:
              "application/json"
          }
        })
      },
      18000
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

function parseVocabulary(raw) {
  const parsed = parseJson(raw);

  const source =
    Array.isArray(parsed?.items)
      ? parsed.items
      : [];

  return source
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
    .slice(0, 8);
}

function shouldRetry(error) {
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

async function generateVocabulary(
  apiKey,
  prompt
) {
  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const raw =
        await callGemini(
          apiKey,
          attempt === 1
            ? prompt
            : [
                prompt,
                "",
                "QUAN TRỌNG LẦN NÀY:",
                "Chỉ trả JSON hợp lệ.",
                'Bắt buộc có dạng {"items":[{"term":"...","meaningVi":"..."}]}.',
                "Không được trả văn bản ngoài JSON."
              ].join("\n")
        );

      const items =
        parseVocabulary(raw);

      if (items.length) {
        return items;
      }

      const parseError =
        new Error(
          "Gemini trả danh sách từ mới rỗng."
        );

      parseError.status = 502;
      throw parseError;

    } catch (error) {
      lastError = error;

      if (
        attempt >= 2 ||
        !shouldRetry(error)
      ) {
        throw error;
      }
    }
  }

  throw (
    lastError ||
    new Error(
      "Không tạo được từ mới."
    )
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
    "",
    "MỤC TIÊU:",
    "Chọn các từ/cụm từ quan trọng nhất để người học chỉ cần nhìn danh sách từ vựng là có thể đoán được nội dung chính của đoạn loop trước khi nghe.",
    "",
    "QUY TẮC CHỌN:",
    "1. Ưu tiên CỤM TỪ tự nhiên hơn từ đơn.",
    "2. Ưu tiên phrasal verbs, collocations, expressions, idioms, slang và các cụm thường được người bản xứ sử dụng.",
    "3. Ưu tiên các từ/cụm đóng vai trò từ khóa nội dung: chủ đề, người/sự vật quan trọng, hành động chính, cảm xúc, trạng thái và sự kiện chính.",
    "4. Danh sách phải giúp người học hiểu hoặc đoán được ý của TOÀN BỘ đoạn loop, không chỉ một câu.",
    "5. Cố gắng phủ nội dung từ đầu đến cuối loop.",
    "6. Không chọn từ hiếm chỉ vì nó khó nếu nó không quan trọng với nội dung.",
    "7. Từ cơ bản vẫn được chọn nếu nó là từ khóa quan trọng để hiểu đoạn.",
    "8. Không tách một cụm từ tự nhiên thành nhiều từ đơn.",
    "9. Không tự tạo cụm từ không có hoặc không phù hợp với transcript.",
    "10. Không chọn nhiều mục có ý nghĩa gần như trùng nhau.",
    "11. Sắp xếp các từ/cụm theo thứ tự chúng xuất hiện trong đoạn hội thoại.",
    "12. Chọn tối đa 8 mục. Không cần cố đủ 8 nếu đoạn chỉ có ít từ/cụm đáng học.",
    "",
    "YÊU CẦU VỀ meaningVi:",
    "- Dịch thật ngắn.",
    "- Tự nhiên với người Việt.",
    "- Đúng nghĩa trong ngữ cảnh hiện tại.",
    "- Không giải thích dài.",
    "- Không thêm ví dụ.",
    "",
    "QUAN TRỌNG:",
    "Chỉ trả JSON hợp lệ theo đúng dạng:",
    '{"items":[{"term":"...","meaningVi":"..."}]}',
    "Không markdown. Không giải thích ngoài JSON.",
    "",
    `LOOP: ${loopName || "Loop"}`,
    `PHỤ ĐỀ: ${transcript}`
  ].join("\n");

  try {
    const items =
      await generateVocabulary(
        apiKey,
        prompt
      );

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
