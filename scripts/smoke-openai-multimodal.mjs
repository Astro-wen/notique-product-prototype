import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const envPath = resolve(root, ".dev.vars");
const imagePath = resolve(
  root,
  "eval/cases/synthetic-contractor-v1/images/event-1-short-wall.png",
);

function parseEnv(text) {
  return Object.fromEntries(
    text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function mimeTypeFor(path) {
  const extension = extname(path).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  throw new Error(`Unsupported smoke-test image type: ${extension}`);
}

function extractOutputText(response) {
  if (typeof response.output_text === "string") return response.output_text;
  for (const item of response.output ?? []) {
    for (const content of item.content ?? []) {
      if (content.type === "output_text" && typeof content.text === "string") {
        return content.text;
      }
    }
  }
  throw new Error("OpenAI response did not contain output_text");
}

const env = parseEnv(await readFile(envPath, "utf8"));
const apiKey = env.AI_API_KEY;
const model = env.AI_MODEL || "gpt-5.6-luna";
const reasoningEffort = env.AI_REASONING_EFFORT || "xhigh";

if (!apiKey || apiKey.includes("PASTE_")) {
  throw new Error("AI_API_KEY is not configured in .dev.vars");
}

const imageBase64 = (await readFile(imagePath)).toString("base64");
const imageUrl = `data:${mimeTypeFor(imagePath)};base64,${imageBase64}`;

const transcript = [
  "[00:12] Maria Lopez: The main scope is to remove the short wall between the kitchen and dining room and patch the affected drywall.",
  "[01:08] Maria Lopez: My total budget cap is eighteen thousand dollars, including labor and materials.",
  "[02:14] Aaron Kim: We still need an engineer to confirm whether that short wall is load-bearing. I cannot determine that from this visit.",
].join("\n");

const response = await fetch("https://api.openai.com/v1/responses", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model,
    reasoning: { effort: reasoningEffort },
    max_output_tokens: 2_000,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: [
              "This is a multimodal capability smoke test for an evidence-backed project system.",
              "Read both the transcript and the construction-site image.",
              "Return the budget stated in the transcript, the transcript scope, and three concrete objects or features visible in the image that the transcript does not mention.",
              "Do not infer whether the wall is load-bearing. Set load_bearing_visible to false because structural status cannot be visually proven here.",
              "Transcript:",
              transcript,
            ].join("\n\n"),
          },
          {
            type: "input_image",
            image_url: imageUrl,
            detail: "high",
          },
        ],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "notique_multimodal_smoke",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            transcript_budget_usd: { type: "integer" },
            transcript_scope: { type: "string" },
            image_only_observations: {
              type: "array",
              minItems: 3,
              maxItems: 3,
              items: { type: "string" },
            },
            load_bearing_visible: { type: "boolean" },
            sources_used: {
              type: "array",
              minItems: 2,
              maxItems: 2,
              items: { type: "string", enum: ["transcript", "image"] },
            },
          },
          required: [
            "transcript_budget_usd",
            "transcript_scope",
            "image_only_observations",
            "load_bearing_visible",
            "sources_used",
          ],
        },
      },
    },
  }),
});

const body = await response.json();
if (!response.ok) {
  const error = body?.error ?? {};
  console.error(
    JSON.stringify(
      {
        ok: false,
        status: response.status,
        type: error.type ?? null,
        code: error.code ?? null,
        message: error.message ?? "OpenAI request failed",
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} else {
  const parsed = JSON.parse(extractOutputText(body));
  console.log(
    JSON.stringify(
      {
        ok: true,
        response_id: body.id,
        model: body.model,
        reasoning_effort: reasoningEffort,
        result: parsed,
        usage: {
          input_tokens: body.usage?.input_tokens ?? null,
          output_tokens: body.usage?.output_tokens ?? null,
          reasoning_tokens:
            body.usage?.output_tokens_details?.reasoning_tokens ?? null,
          total_tokens: body.usage?.total_tokens ?? null,
        },
      },
      null,
      2,
    ),
  );
}
