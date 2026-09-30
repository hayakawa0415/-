// 納品書・送り状の写真を Claude で読み取り、構造化データ(JSON)で返す Netlify Function
// 必要な環境変数: ANTHROPIC_API_KEY
// 任意: APP_PASSCODE（設定するとアプリ側で同じパスコードが必要）, SLIP_AI_MODEL, SLIP_AI_EFFORT
import Anthropic from "@anthropic-ai/sdk";

const MODEL = process.env.SLIP_AI_MODEL || "claude-opus-5";
const EFFORT = process.env.SLIP_AI_EFFORT || "medium";
// サーバー側フォールバック（安全分類器が誤って拒否した場合に別モデルで再実行）に対応するモデル
const FALLBACK_MODELS = new Set(["claude-opus-5", "claude-fable-5", "claude-fable-5-1"]);
const MAX_IMAGE_B64 = 5_500_000;

const nullable = (schema) => ({ anyOf: [schema, { type: "null" }] });
const FIELD_NAMES = [
  "date", "slip_no", "product", "project_name", "consignee", "net_kg",
  "gross_kg", "tare_kg", "bags", "carrier", "vehicle_no", "origin", "supplier",
];

const SLIP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    document_type: { type: "string", description: "納品書 / 送り状 など、伝票の表題" },
    date: nullable({ type: "string", description: "納品日 YYYY-MM-DD" }),
    slip_no: nullable({ type: "string", description: "伝票番号（印字どおり、先頭の0も残す）" }),
    product: nullable({ type: "string", description: "品種・品名（例: TL-2000, ユースタビラー75）" }),
    project_name: nullable({ type: "string", description: "工事名（荷受人欄の工事名を含む）" }),
    consignee: nullable({ type: "string", description: "納入先・荷受人の会社名" }),
    net_kg: nullable({ type: "number", description: "正味（正味量）を kg に換算した値" }),
    gross_kg: nullable({ type: "number", description: "全重を kg に換算した値" }),
    tare_kg: nullable({ type: "number", description: "風袋を kg に換算した値" }),
    bags: nullable({ type: "integer", description: "袋数" }),
    carrier: nullable({ type: "string", description: "運送会社" }),
    vehicle_no: nullable({ type: "string", description: "車番" }),
    origin: nullable({ type: "string", description: "出荷場所・出荷基地" }),
    supplier: nullable({ type: "string", description: "販売店または荷主（メーカー）" }),
    matched_site_index: { type: "integer", description: "登録現場リストの番号。該当なし・判断不能は -1" },
    uncertain_fields: {
      type: "array",
      items: { type: "string", enum: FIELD_NAMES },
      description: "読み取りに自信がない項目",
    },
    note: { type: "string", description: "確認が必要な点があれば短く。なければ空文字" },
  },
  required: [
    "document_type", ...FIELD_NAMES, "matched_site_index", "uncertain_fields", "note",
  ],
};

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    slips: { type: "array", items: SLIP_SCHEMA },
    rotation_cw: {
      type: "integer",
      enum: [0, 90, 180, 270],
      description: "文字を正立させるために画像を時計回りに回転すべき角度",
    },
    image_problem: { type: "string", description: "ピンボケ・見切れ等の問題。なければ空文字" },
  },
  required: ["slips", "rotation_cw", "image_problem"],
};

const SYSTEM_PROMPT = `あなたは建設現場に届く資材の伝票（納品書・送り状）を読み取る担当者です。
写真に写っている伝票を1枚ずつ読み取り、指定のJSONで返してください。写真に複数枚写っていれば、左上から順にすべて返します。伝票が写っていなければ slips は空配列にします。

読み取りのルール:
- 重量は必ず kg に換算する。単位が t（トン）なら1000倍する（例: 正味 24.020 t → 24020）。kg 表記ならそのまま（例: 8,000kg → 8000）。
- 全重・風袋・正味が揃っていれば「全重 − 風袋 = 正味」になるはずなので照合し、合わなければ該当項目を uncertain_fields に入れ、note に書く。
- 日付は YYYY-MM-DD。「26/08/05」のような2桁年は 2026 年とみなす。荷渡済スタンプの日付は裏付けに使ってよい。
- 手書きのチェック印・サイン・押印は数値として読まない。
- 読めない・かすれている項目は推測で埋めず null にし、uncertain_fields に入れる。数字は1桁の誤りが請求に直結するため、少しでも迷ったら uncertain_fields に入れる。
- matched_site_index: 伝票の工事名・荷受人が、ユーザーが示す登録現場リストのどれを指すか。略記（PJT=プロジェクト、(仮称) の有無、所在地の一致など）は同一とみなしてよい。確信がなければ -1。`;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default async (req) => {
  if (req.method !== "POST") return json({ error: "POST のみ対応しています" }, 405);

  const passcode = process.env.APP_PASSCODE;
  if (passcode && req.headers.get("x-app-passcode") !== passcode) {
    return json({ error: "パスコードが違います（設定画面で入力してください）", code: "bad_passcode" }, 401);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return json({ error: "AI読み取りが未設定です（ANTHROPIC_API_KEY）", code: "not_configured" }, 503);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "リクエストが不正です" }, 400);
  }
  const { image, mediaType = "image/jpeg", sites = [] } = body ?? {};
  if (typeof image !== "string" || image.length === 0 || image.length > MAX_IMAGE_B64) {
    return json({ error: "画像がない、または大きすぎます" }, 400);
  }
  if (!["image/jpeg", "image/png", "image/webp"].includes(mediaType)) {
    return json({ error: "対応していない画像形式です" }, 400);
  }
  const siteList = Array.isArray(sites) && sites.length
    ? sites.slice(0, 100).map((s, i) => `${i}: ${String(s).slice(0, 200)}`).join("\n")
    : "（登録なし）";

  const params = {
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    output_config: {
      effort: EFFORT,
      format: { type: "json_schema", schema: OUTPUT_SCHEMA },
    },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType, data: image } },
          { type: "text", text: `登録現場リスト:\n${siteList}\n\nこの写真の伝票を読み取ってください。` },
        ],
      },
    ],
  };
  if (FALLBACK_MODELS.has(MODEL)) {
    params.betas = ["server-side-fallback-2026-07-01"];
    params.fallbacks = "default";
  }

  const client = new Anthropic({ timeout: 55_000, maxRetries: 0 });
  let response;
  try {
    response = await client.beta.messages.create(params);
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      return json({ error: "APIキーが無効です" }, 500);
    } else if (error instanceof Anthropic.RateLimitError) {
      return json({ error: "混雑しています。少し待って再読取してください", retryable: true }, 429);
    } else if (error instanceof Anthropic.BadRequestError) {
      console.error("bad request", error.message);
      return json({ error: "読み取りリクエストが拒否されました" }, 502);
    } else if (error instanceof Anthropic.APIConnectionTimeoutError) {
      return json({ error: "時間切れです。再読取してください", retryable: true }, 504);
    } else if (error instanceof Anthropic.APIError) {
      console.error("api error", error.status, error.message);
      return json({ error: `AIサービスのエラー (${error.status ?? "接続"})`, retryable: true }, 502);
    }
    throw error;
  }

  if (response.stop_reason === "refusal") {
    return json({ error: "AIが読み取りを拒否しました。手入力してください" }, 422);
  }
  if (response.stop_reason === "max_tokens") {
    return json({ error: "読み取り結果が長すぎて途中で切れました", retryable: true }, 502);
  }
  const text = response.content.find((b) => b.type === "text")?.text;
  let data;
  try {
    data = JSON.parse(text ?? "");
  } catch {
    return json({ error: "読み取り結果を解釈できませんでした", retryable: true }, 502);
  }
  return json({
    ...data,
    model: response.model,
    usage: { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens },
  });
};

export const config = { path: "/api/read-slip" };
