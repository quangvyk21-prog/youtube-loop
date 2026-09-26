# Gemini translation + vocabulary panel

This patch preserves the V10 loop behavior and adds:
- Gemini EN -> VI translation through `/api/translate`
- per-loop vocabulary through `/api/vocab`
- vocabulary shown in the right-side black area of the video
- only English term + Vietnamese meaning
- vocabulary saved inside each loop in localStorage
- automatic regeneration when loop timing changes

Vercel environment variables:
- `GEMINI_API_KEY`
- `TRANSLATE_ACCESS_CODE`
- optional `GEMINI_MODEL` (defaults to `gemini-3.5-flash-lite`)

Do not put the Gemini API key in GitHub source.
