/**
 * pi-vision core — pure, harness-agnostic logic.
 *
 * Everything here is testable without pi: no ExtensionContext, no pi-ai.
 * The pi adapter (index.ts) implements the `VisionBackend` port with real
 * filesystem access and pi-ai `complete`; tests provide an in-memory fake.
 * The seam between core and adapter is real because it has two adapters.
 */

export interface ModelLike {
  id: string;
  name?: string;
  provider: string;
  input?: string[];
  cost?: { input: number; output: number };
}

export interface ImageLike {
  /** base64-encoded image payload */
  data: string;
  mimeType: string;
}

// ─── Model capability ────────────────────────────────────────────────────────

export function isVisionCapable(model: ModelLike | undefined): boolean {
  return Boolean(model?.input?.includes("image"));
}

/** true when the orchestrator model cannot see images and delegation applies. */
export function shouldDelegate(model: ModelLike | undefined): boolean {
  return model !== undefined && !isVisionCapable(model);
}

export function modelRef(m: ModelLike): string {
  return `${m.provider}/${m.id}`;
}

export function parseModelRef(
  ref: string,
): { provider: string; model_id: string } | undefined {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) return undefined;
  return { provider: ref.slice(0, slash), model_id: ref.slice(slash + 1) };
}

// ─── Mime helpers ────────────────────────────────────────────────────────────

export function mimeToExt(mime: string): string {
  if (mime.includes("png")) return "png";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("gif")) return "gif";
  return "png";
}

export function guessMime(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "png": return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "webp": return "image/webp";
    case "gif": return "image/gif";
    case "avif": return "image/avif";
    default: return "image/png";
  }
}

// ─── Dropped-image transform ─────────────────────────────────────────────────

/**
 * Replace user-attached images with `[vision:dropped-image]` markers so a
 * text-only orchestrator learns an image exists and can delegate its path.
 * `save` materializes the base64 payload to disk (injected for testability);
 * `stamp` makes generated names deterministic in tests.
 */
export function transformDroppedImages(
  text: string | undefined,
  images: ImageLike[],
  save: (data: string, mimeType: string, name: string) => string,
  stamp: number,
): { text: string } {
  if (images.length === 0) return { text: text ?? "" };
  const markers: string[] = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const ext = mimeToExt(img.mimeType);
    const path = save(img.data, img.mimeType, `dropped-${stamp}-${i}.${ext}`);
    markers.push(
      `[vision:dropped-image] ${JSON.stringify({
        mime: img.mimeType,
        path,
        originalFilename: `image-${i + 1}.${ext}`,
      })}`,
    );
  }
  return { text: text ? `${text}\n\n${markers.join("\n")}` : markers.join("\n") };
}

// ─── Prompt building ─────────────────────────────────────────────────────────

export function buildVisionPrompt(task: string, images: string[], template: string): string {
  return [
    `## Visual Task`,
    ``,
    task,
    ``,
    `## Images to Inspect`,
    ``,
    ...images.map((p, i) => `- ${i + 1}: ${p}`),
    ``,
    `## Response Template`,
    ``,
    template,
  ].join("\n");
}

// ─── JSON response handling ──────────────────────────────────────────────────

export function stripJsonFences(text: string): string {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (match ? match[1] : text).trim();
}

export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(stripJsonFences(text));
  } catch {
    return undefined;
  }
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ─── Vision call (port at the seam) ──────────────────────────────────────────

/** Port satisfied by the production adapter (fs + pi-ai) and by test fakes. */
export interface VisionBackend {
  /** Read an image file into base64 + mime. */
  readImage(path: string): Promise<ImageLike>;
  /** Run one completion; returns the model's raw text. */
  complete(
    systemPrompt: string,
    userText: string,
    images: ImageLike[],
    signal?: AbortSignal,
  ): Promise<string>;
}

export interface VisionCallOptions {
  task: string;
  images: string[];
  template: string;
}

export interface VisionCallResult {
  /** Raw model text (JSON per the template, after best-effort retry). */
  text: string;
  /** Parsed JSON when the response matched; undefined otherwise. */
  parsed: unknown;
  /** Whether a malformed first response triggered the single retry. */
  retried: boolean;
}

/**
 * Deep core of a visual delegation: assemble the prompt, call the backend,
 * tolerate one malformed response, and hand back raw + parsed text.
 * All behaviour behind a small interface: (backend, options, systemPrompt).
 */
export async function runVisionCall(
  backend: VisionBackend,
  options: VisionCallOptions,
  systemPrompt: string,
  signal?: AbortSignal,
): Promise<VisionCallResult> {
  const images: ImageLike[] = [];
  for (const path of options.images) {
    try {
      images.push(await backend.readImage(path));
    } catch (e) {
      throw new Error(`Could not read image "${path}": ${(e as Error).message}`);
    }
  }

  const userText = buildVisionPrompt(options.task, options.images, options.template);

  const first = await backend.complete(systemPrompt, userText, images, signal);
  const parsed = tryParseJson(first);
  if (isJsonObject(parsed)) {
    return { text: first, parsed, retried: false };
  }

  // One tolerance retry, feeding the invalid output back for correction.
  const retryText = [
    userText,
    ``,
    `Your previous response was not valid JSON matching the template.`,
    `Return exactly one JSON object with the template's keys.`,
    ``,
    `Previous response:`,
    first,
  ].join("\n");
  const second = await backend.complete(systemPrompt, retryText, images, signal);
  return { text: second, parsed: tryParseJson(second), retried: true };
}

// ─── Model presentation ──────────────────────────────────────────────────────

/**
 * Agent-facing list of model choices (returned by `select_vision_model` with no
 * arguments). Includes per-model cost so the agent can pick a sensible default
 * for the user. Empty models → empty string; callers handle the none case.
 */
export function formatModelChoices(models: ModelLike[]): string {
  return models
    .map((m) => {
      const cost = m.cost
        ? ` (in $${m.cost.input}/MTok, out $${m.cost.output}/MTok)`
        : "";
      return `- ${modelRef(m)} — ${m.name || m.id}${cost}`;
    })
    .join("\n");
}

// ─── Model selection state (pick-list state machine) ────────────────────────

/** Pure state of a selectable model list: full set, filtered view, selection. */
export interface ModelSelectionState {
  all: ModelLike[];
  filtered: ModelLike[];
  selectedIndex: number;
}

/**
 * Filtering strategy — injected so the core stays harness-agnostic.
 * Production adapter passes pi-tui's `fuzzyFilter`; tests use plain filters.
 */
export type ModelFilter = (models: ModelLike[], query: string) => ModelLike[];

/** Initial state: full list, selection on the current ref (else index 0). */
export function createModelSelection(
  models: ModelLike[],
  currentRef?: string,
): ModelSelectionState {
  const idx = models.findIndex((m) => modelRef(m) === currentRef);
  return { all: models, filtered: models, selectedIndex: idx >= 0 ? idx : 0 };
}

/** Apply a query: filter the full list, jump to the top match; cleared, clamp back. */
export function filterModelSelection(
  state: ModelSelectionState,
  query: string,
  filter: ModelFilter,
): ModelSelectionState {
  const hasQuery = query.trim().length > 0;
  const filtered = hasQuery ? filter(state.all, query) : state.all;
  const selectedIndex = hasQuery
    ? 0
    : Math.min(state.selectedIndex, Math.max(0, filtered.length - 1));
  return { ...state, filtered, selectedIndex };
}

/** Move the selection; `wrap` wraps around the list, otherwise clamp at the ends. */
export function moveModelSelection(
  state: ModelSelectionState,
  delta: number,
  wrap: boolean,
): ModelSelectionState {
  const len = state.filtered.length;
  if (len === 0) return state;
  const next = wrap
    ? ((state.selectedIndex + delta) % len + len) % len
    : Math.max(0, Math.min(state.selectedIndex + delta, len - 1));
  return { ...state, selectedIndex: next };
}

/** Window of rows to render around the selection, clamped to the list ends. */
export function visibleWindow(
  listLength: number,
  selectedIndex: number,
  maxVisible: number,
): { start: number; end: number } {
  if (listLength === 0 || maxVisible <= 0) return { start: 0, end: 0 };
  const start = Math.max(
    0,
    Math.min(selectedIndex - Math.floor(maxVisible / 2), listLength - maxVisible),
  );
  return { start, end: Math.min(start + maxVisible, listLength) };
}

// ─── Model choice ────────────────────────────────────────────────────────────

/** Persisted choice wins when still available; else first available; else none. */
export function chooseModelRef(models: string[], persisted?: string): string | undefined {
  if (models.length === 0) return undefined;
  if (persisted && models.includes(persisted)) return persisted;
  return models[0];
}
