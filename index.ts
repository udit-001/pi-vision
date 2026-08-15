/**
 * pi-vision — give text-only orchestrators (DeepSeek, GLM, and similar) eyes
 * by delegating visual tasks to a vision-capable model.
 *
 * Mechanism:
 *
 * - `/vision-setup` command + `select_vision_model` tool: pick any image-capable
 *   model from your configured providers via pi's TUI picker; choice persists.
 * - `input` transform: user-dropped images are materialized to disk and replaced
 *   with `[vision:dropped-image] {"path": ...}` markers. pi silently strips
 *   images for text-only models at the provider layer — without this marker the
 *   orchestrator never learns an image existed.
 * - `before_agent_start`: appends a terse `[vision] model=...` status line (or
 *   `model=not-configured` when unset) to the system prompt of text-only
 *   orchestrators.
 * - `vision` tool: runs a visual task against the chosen model with the image
 *   files attached and a strict JSON template (retries once on malformed JSON).
 * - Installs a `vision` skill into the global skills dir teaching the
 *   orchestrator when and how to delegate.
 *
 * This file is a thin adapter at the pi seam: all logic lives in vision-core.ts.
 */

import { type Model, type UserMessage } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  chooseModelRef,
  formatModelChoices,
  guessMime,
  isVisionCapable,
  modelRef,
  parseModelRef,
  runVisionCall,
  shouldDelegate,
  transformDroppedImages,
  type VisionBackend,
} from "./vision-core.ts";
import { VisionModelPicker } from "./model-picker.ts";

// ─── Paths & constants ───────────────────────────────────────────────────────

const dataDir = dirname(fileURLToPath(import.meta.url));
const BODY_TEMPLATE = readFileSync(join(dataDir, "subagent-body.txt"), "utf8");

/** Scratch dir for materialized dropped images. */
const VISION_TMP_DIR = join(tmpdir(), "pi-vision");

/** Persisted vision model choice (`provider/model`). */
const VISION_MODEL_FILE = join(getAgentDir(), "vision-model-image.txt");

// ─── Persistence ─────────────────────────────────────────────────────────────

function readPersistedChoice(): string | undefined {
  try {
    if (!existsSync(VISION_MODEL_FILE)) return undefined;
    return readFileSync(VISION_MODEL_FILE, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

function persistChoice(value: string): void {
  try {
    mkdirSync(dirname(VISION_MODEL_FILE), { recursive: true });
    writeFileSync(VISION_MODEL_FILE, value, "utf8");
  } catch {
    /* ignore */
  }
}

/** Persisted choice, but only when it still resolves to a real image-capable model. */
function readValidatedChoice(ctx: ExtensionContext): string | undefined {
  const choice = readPersistedChoice();
  if (!choice) return undefined;
  const parsed = parseModelRef(choice);
  if (!parsed) return undefined;
  const found = ctx.modelRegistry.find(parsed.provider, parsed.model_id);
  return found && isVisionCapable(found) ? choice : undefined;
}

// ─── Model discovery ─────────────────────────────────────────────────────────

/** Image-capable models from configured providers with complete auth. */
async function discoverVisionModels(ctx: ExtensionContext): Promise<Model<any>[]> {
  try {
    const available = await ctx.modelRegistry.getAvailable();
    return available.filter((m) => isVisionCapable(m));
  } catch {
    return [];
  }
}

/** Resolve the vision model: persisted choice first, else first available. */
async function resolveVisionModel(ctx: ExtensionContext): Promise<Model<any> | undefined> {
  const choice = readValidatedChoice(ctx);
  if (choice) {
    const parsed = parseModelRef(choice);
    return parsed ? ctx.modelRegistry.find(parsed.provider, parsed.model_id) : undefined;
  }
  return (await discoverVisionModels(ctx))[0];
}

// ─── Image materialization ───────────────────────────────────────────────────

/** Write base64 image data to a scratch file (0600) and return its path. */
function saveImageData(data: string, mimeType: string, name: string): string {
  mkdirSync(VISION_TMP_DIR, { recursive: true });
  const out = join(VISION_TMP_DIR, name);
  // 0600: screenshots can contain sensitive content.
  writeFileSync(out, Buffer.from(data, "base64"), { mode: 0o600 });
  return out;
}

// ─── Skill (dynamic, model-conditional) ─────────────────────────────────────

/**
 * Remove a legacy globally-installed copy of the skill. The skill is now
 * contributed per-session via `resources_discover` (only for orchestrators
 * that need delegation), so a leftover global copy would double-register.
 */
function removeLegacySkillInstall(): void {
  try {
    rmSync(join(getAgentDir(), "skills", "vision"), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ─── Setup flow ──────────────────────────────────────────────────────────────

/**
 * Show the TUI picker (image-capable models only) and persist the choice.
 * Returns the chosen `provider/model` ref, or undefined if cancelled.
 */
async function pickVisionModel(ctx: ExtensionContext): Promise<string | undefined> {
  const models = await discoverVisionModels(ctx);
  if (models.length === 0) {
    ctx.ui.notify(
      "No image-capable models found. Configure a provider with a vision model first.",
      "warning",
    );
    return undefined;
  }

  if (!ctx.hasUI) {
    // Headless: keep the persisted choice when still valid, else first available.
    const ref = chooseModelRef(models.map(modelRef), readValidatedChoice(ctx));
    if (ref) persistChoice(ref);
    return ref;
  }

  const picked = await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
    return new VisionModelPicker(models, readValidatedChoice(ctx), tui, theme, keybindings, (ref) => done(ref), () => done(undefined));
  });
  if (!picked) return undefined;
  persistChoice(picked);
  ctx.ui.notify(`Vision model set to ${picked}`, "info");
  return picked;
}

// ─── Vision backend (production adapter at the vision-call seam) ─────────────

function makeVisionBackend(ctx: ExtensionContext): VisionBackend {
  return {
    async readImage(path) {
      const buf = await readFile(path);
      return { data: buf.toString("base64"), mimeType: guessMime(path) };
    },

    async complete(systemPrompt, userText, images, signal) {
      const model = await resolveVisionModel(ctx);
      if (!model) {
        throw new Error(
          "No vision model configured. Call select_vision_model to pick an image-capable model, then retry.",
        );
      }

      const userMessage: UserMessage = {
        role: "user",
        content: [
          { type: "text", text: userText },
          ...images.map((img) => ({
            type: "image" as const,
            data: img.data,
            mimeType: img.mimeType,
          })),
        ],
        timestamp: Date.now(),
      };

      const response = await ctx.modelRegistry.complete(
        model,
        { systemPrompt, messages: [userMessage] },
        { signal },
      );
      return response.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n");
    },
  };
}

// ─── Extension (thin adapter at the pi seam) ─────────────────────────────────

export default function (pi: ExtensionAPI) {
  // Clear any previously installed global copy before resources are scanned.
  removeLegacySkillInstall();

  // Expose the vision skill only to orchestrators that need delegation.
  // Vision-capable models see images natively, so the skill stays out of their
  // prompt entirely — no context load, no misfires. Unknown model → expose
  // (fail open: the per-turn hint still gates actual delegation behavior).
  pi.on("resources_discover", async (_event, ctx) => {
    if (isVisionCapable(ctx.model)) return {};
    return { skillPaths: [dataDir] };
  });

  // User-dropped images → [vision:dropped-image] markers (text-only orchestrators).
  pi.on("input", async (event, ctx) => {
    // Native vision models see images directly; leave them alone.
    if (!shouldDelegate(ctx.model)) return;
    if (!event.images?.length) return;

    const save = (data: string, mimeType: string, name: string) =>
      saveImageData(data, mimeType, name);
    const { text } = transformDroppedImages(event.text, event.images, save, Date.now());
    return { action: "transform", text, images: [] };
  });

  // System-prompt hint: a terse, uniform status line for text-only orchestrators.
  // Same token shape in both states — the VALUE distinguishes them, so the model
  // matches a stable pattern instead of parsing prose. All conditional behavior
  // lives in the skill (single source of truth), not here.
  pi.on("before_agent_start", async (event, ctx) => {
    if (!shouldDelegate(ctx.model)) return;
    const choice = readValidatedChoice(ctx);
    const hint = `[vision] model=${choice ?? "not-configured"}`;
    return { systemPrompt: `${event.systemPrompt}\n\n${hint}` };
  });

  // Tool: pick (or switch) the vision model. The LLM calls this when the system
  // prompt says `[vision] model=not-configured`; humans can type "select the
  // vision model" or "/vision-setup".
  pi.registerTool({
    name: "select_vision_model",
    label: "Select Vision Model",
    description: [
      "Choose which image-capable model handles visual tasks; the choice persists for future sessions.",
      "With no model argument, returns the list of available image-capable models so you can pick the best one; pass model as provider/model to set it.",
    ].join(" "),
    promptGuidelines: [
      "Use select_vision_model when the system prompt says `[vision] model=not-configured`, or the user asks to choose the vision model (e.g. \"set up vision\", \"select the vision model\"): first call it with no arguments to see the available models, pick the best one for the user, then call it again with model set.",
    ],
    parameters: Type.Object({
      model: Type.Optional(
        Type.String({
          description: "provider/model of an image-capable model (from the list returned by a no-argument call)",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const models = await discoverVisionModels(ctx);

      if (params.model) {
        const m = models.find((x) => modelRef(x) === params.model);
        if (!m) {
          const available = models.map(modelRef).join(", ") || "none";
          return {
            content: [
              {
                type: "text",
                text: `Unknown or unavailable model "${params.model}". Available image-capable models: ${available}.`,
              },
            ],
            details: { ok: false, available: models.map(modelRef) },
          };
        }
        persistChoice(params.model);
        ctx.ui.notify(`Vision model set to ${params.model}`, "info");
        return {
          content: [{ type: "text", text: `Vision model set to ${params.model}.` }],
          details: { ok: true, model: params.model },
        };
      }

      // Agent-initiated: never open a TUI picker here — return the list so the
      // agent can choose the best model for the user (the /vision-setup command
      // is the user-facing picker).
      if (models.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No image-capable models found in your configured providers. Configure a provider with a vision model first.",
            },
          ],
          details: { ok: false, available: [] },
        };
      }

      const list = formatModelChoices(models);
      return {
        content: [
          {
            type: "text",
            text: [
              `Available image-capable models:\n${list}`,
              ``,
              `Call select_vision_model with model="<provider/model>" to set one.`,
            ].join("\n"),
          },
        ],
        details: { ok: true, available: models.map(modelRef) },
      };
    },
  });

  // Tool: run a visual task against the configured vision model.
  pi.registerTool({
    name: "vision",
    label: "Vision",
    description: [
      "Inspect image files with the vision model and return structured JSON findings matching your template.",
      "Use when a task needs pixel-level judgment on image files — position, color, contrast, layout, readability, visual comparison, state read.",
      "Retries once internally if the first response is malformed.",
    ].join(" "),
    promptGuidelines: [
      "When calling vision, pass the exact visual question as task, the local image paths as images, and a strict JSON object as template.",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "The exact visual question to answer" }),
      images: Type.Array(Type.String({ description: "Local paths to the image files to inspect" })),
      template: Type.String({
        description: "The exact JSON object shape the vision model must return, with placeholder values",
      }),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const model = await resolveVisionModel(ctx);
      if (!model) {
        throw new Error(
          "No vision model configured. Call select_vision_model to pick an image-capable model, then retry.",
        );
      }

      onUpdate?.({
        content: [{ type: "text", text: `Inspecting with ${modelRef(model)}…` }],
        details: { model: modelRef(model) },
      });

      const result = await runVisionCall(
        makeVisionBackend(ctx),
        params,
        BODY_TEMPLATE,
        signal,
      );
      return {
        content: [{ type: "text", text: result.text }],
        details: {
          model: modelRef(model),
          images: params.images,
          retried: result.retried,
        },
      };
    },
  });

  // Command: manual setup / re-pick anytime.
  pi.registerCommand("vision-setup", {
    description: "Set up vision: pick which image-capable model handles visual tasks",
    handler: async (_args, ctx) => {
      await pickVisionModel(ctx);
    },
  });
}
