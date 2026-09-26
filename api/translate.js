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

  const text = clean(req.body?.text);
  const previous = clean(req.body?.previous);
  const next = clean(req.body?.next);

  if (!text) {
    return res.status(400).json({ error: "Thiếu câu cần dịch." });
  }

  const prompt = [
    "Bạn là biên dịch viên phụ đề tiếng Anh sang tiếng Việt.",
    "Dịch tự nhiên theo đúng ngữ cảnh hội thoại, không dịch từng chữ.",
    "Hiểu thành ngữ, tiếng lóng, đại từ, chủ ngữ bị lược và sắc thái người nói.",
    "Câu trước và câu sau CHỈ dùng để hiểu ngữ cảnh.",
    "CHỈ dịch CÂU HIỆN TẠI.",
    "Đầu ra CHỈ là bản dịch tiếng Việt, không giải thích, không thêm nhãn.",
    "",
    `CÂU TRƯỚC: ${previous || "(không có)"}`,
    `CÂU HIỆN TẠI: ${text}`,
    `CÂU SAU: ${next || "(không có)"}`
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
            maxOutputTokens: 180,
            temperature: 0.2
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

    const translation = clean(
      data?.candidates?.[0]?.content?.parts
        ?.map(part => part?.text || "")
        .join("")
    )
      .replace(/^["“]|["”]$/g, "")
      .replace(/^(Bản dịch|Dịch)\s*:\s*/i, "")
      .trim();

    if (!translation) {
      return res.status(502).json({ error: "Gemini trả về bản dịch rỗng." });
    }

    return res.status(200).json({ translation, model: MODEL });
  } catch (error) {
    return res.status(502).json({
      error: error?.message || "Không gọi được Gemini API."
    });
  }
}
