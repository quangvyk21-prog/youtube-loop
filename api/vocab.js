const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function checkAccess(req, res) {
  const apiKey = process.env.GEMINI_API_KEY;
  const privateCode = process.env.TRANSLATE_ACCESS_CODE;
  const suppliedCode = String(req.headers["x-translate-access"] || "");

  if (!apiKey) {
    res.status(500).json({ error: "Server chưa cấu hình GEMINI_API_KEY." });
    return null;
  }

  if (!privateCode) {
    res.status(500).json({ error: "Server chưa cấu hình TRANSLATE_ACCESS_CODE." });
    return null;
  }

  if (!suppliedCode || suppliedCode !== privateCode) {
    res.status(403).json({ error: "Mã dịch cá nhân không đúng." });
    return null;
  }

  return apiKey;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  const apiKey = checkAccess(req, res);
  if (!apiKey) return;

  const transcript = clean(req.body?.transcript).slice(0, 12000);
  const loopName = clean(req.body?.loopName);

  if (!transcript) {
    return res.status(400).json({ error: "Loop chưa có transcript để lấy từ mới." });
  }

  const prompt = [
    "Bạn là giáo viên tiếng Anh cho người Việt.",
    "Từ đoạn phụ đề của loop, chọn tối đa 8 từ hoặc cụm từ đáng học nhất.",
    "Ưu tiên phrasal verbs, idioms, collocations, slang và từ/cụm B1 trở lên.",
    "Bỏ qua từ quá cơ bản nếu nó không tạo thành cụm đáng học.",
    "Mỗi mục chỉ cần đúng 2 trường: term và meaningVi.",
    "meaningVi phải thật ngắn, tự nhiên, đúng ngữ cảnh của đoạn phụ đề.",
    "Không giải thích dài, không thêm ví dụ.",
    "",
    `LOOP: ${loopName || "Loop"}`,
    `PHỤ ĐỀ: ${transcript}`
  ].join("\n");

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: {
            maxOutputTokens: 700,
            temperature: 0.2,
            responseMimeType: "application/json",
            responseSchema: {
              type: "OBJECT",
              properties: {
                items: {
                  type: "ARRAY",
                  maxItems: 8,
                  items: {
                    type: "OBJECT",
                    properties: {
                      term: { type: "STRING" },
                      meaningVi: { type: "STRING" }
                    },
                    required: ["term", "meaningVi"]
                  }
                }
              },
              required: ["items"]
            }
          }
        })
      }
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      return res.status(response.status).json({
        error: data?.error?.message || `Gemini HTTP ${response.status}`
      });
    }

    const raw = clean(
      data?.candidates?.[0]?.content?.parts
        ?.map(part => part?.text || "")
        .join("")
    );

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return res.status(502).json({ error: "Gemini trả danh sách từ mới không đúng JSON." });
    }

    const items = Array.isArray(parsed?.items)
      ? parsed.items
          .map(item => ({
            term: clean(item?.term),
            meaningVi: clean(item?.meaningVi)
          }))
          .filter(item => item.term && item.meaningVi)
          .slice(0, 8)
      : [];

    return res.status(200).json({ items, model: MODEL });
  } catch (error) {
    return res.status(502).json({
      error: error?.message || "Không gọi được Gemini API."
    });
  }
}
