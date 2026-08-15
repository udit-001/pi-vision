/**
 * Tests for the pi-vision core. Run with `bun test` from this directory
 * (or `bun test vision-core.test.ts` from the repo root).
 * These cross the vision-core seam with an in-memory fake backend — the second
 * adapter that justifies the seam.
 */
import { describe, expect, test } from "bun:test";
import {
  buildVisionPrompt,
  chooseModelRef,
  createModelSelection,
  filterModelSelection,
  formatModelChoices,
  guessMime,
  isJsonObject,
  isVisionCapable,
  mimeToExt,
  modelPickerLabels,
  modelRef,
  moveModelSelection,
  parseModelRef,
  runVisionCall,
  shouldDelegate,
  stripJsonFences,
  transformDroppedImages,
  tryParseJson,
  visibleWindow,
  type ModelFilter,
  type ModelLike,
  type VisionBackend,
} from "./vision-core.ts";

describe("model capability", () => {
  test("image-capable model is not delegated", () => {
    expect(isVisionCapable({ id: "m", provider: "p", input: ["text", "image"] })).toBe(true);
    expect(shouldDelegate({ id: "m", provider: "p", input: ["text", "image"] })).toBe(false);
  });

  test("text-only model is delegated", () => {
    expect(isVisionCapable({ id: "m", provider: "p", input: ["text"] })).toBe(false);
    expect(shouldDelegate({ id: "m", provider: "p", input: ["text"] })).toBe(true);
  });

  test("missing input capability implies text-only", () => {
    expect(isVisionCapable({ id: "m", provider: "p" })).toBe(false);
  });

  test("unknown model is not delegated (never break native vision on ambiguity)", () => {
    expect(shouldDelegate(undefined)).toBe(false);
  });
});

describe("model refs", () => {
  test("modelRef joins provider/id", () => {
    expect(modelRef({ id: "gpt-5", provider: "openai" })).toBe("openai/gpt-5");
  });

  test("parseModelRef round-trips and rejects malformed refs", () => {
    expect(parseModelRef("openai/gpt-5")).toEqual({ provider: "openai", model_id: "gpt-5" });
    expect(parseModelRef("nope")).toBeUndefined();
    expect(parseModelRef("/x")).toBeUndefined();
    expect(parseModelRef("x/")).toBeUndefined();
  });
});

describe("mime helpers", () => {
  test("mimeToExt maps known types and defaults to png", () => {
    expect(mimeToExt("image/png")).toBe("png");
    expect(mimeToExt("image/jpeg")).toBe("jpg");
    expect(mimeToExt("image/webp")).toBe("webp");
    expect(mimeToExt("image/gif")).toBe("gif");
    expect(mimeToExt("application/octet-stream")).toBe("png");
  });

  test("guessMime reads file extensions case-insensitively", () => {
    expect(guessMime("shot.png")).toBe("image/png");
    expect(guessMime("shot.jpeg")).toBe("image/jpeg");
    expect(guessMime("/tmp/x.JPG")).toBe("image/jpeg");
    expect(guessMime("noext")).toBe("image/png");
  });
});

describe("transformDroppedImages", () => {
  test("materializes each image and appends markers to the text", () => {
    const saved: string[] = [];
    const save = (data: string, mime: string, name: string) => {
      saved.push(name);
      return `/tmp/${name}`;
    };
    const { text } = transformDroppedImages(
      "check this",
      [
        { data: "AAAA", mimeType: "image/png" },
        { data: "BBBB", mimeType: "image/jpeg" },
      ],
      save,
      1234,
    );

    expect(saved).toEqual(["dropped-1234-0.png", "dropped-1234-1.jpg"]);
    expect(text).toContain("check this");
    expect(text).toContain(
      '[vision:dropped-image] {"mime":"image/png","path":"/tmp/dropped-1234-0.png","originalFilename":"image-1.png"}',
    );
    expect(text).toContain('"path":"/tmp/dropped-1234-1.jpg"');
  });

  test("no images is a no-op", () => {
    expect(transformDroppedImages("hi", [], () => "", 1)).toEqual({ text: "hi" });
  });

  test("marker-only text when there is no original text", () => {
    const { text } = transformDroppedImages(undefined, [{ data: "x", mimeType: "image/png" }], () => "/p.png", 9);
    expect(text).toContain("[vision:dropped-image]");
    expect(text).not.toContain("\n\n[vision");
  });
});

describe("JSON response handling", () => {
  test("stripJsonFences removes fenced blocks", () => {
    expect(stripJsonFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripJsonFences("plain")).toBe("plain");
  });

  test("tryParseJson handles fenced and bare JSON, rejects prose", () => {
    expect(tryParseJson('```json\n{"ok":true}\n```')).toEqual({ ok: true });
    expect(tryParseJson('{"ok":true}')).toEqual({ ok: true });
    expect(tryParseJson("not json")).toBeUndefined();
  });

  test("isJsonObject rejects arrays, null, primitives", () => {
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject(null)).toBe(false);
    expect(isJsonObject("x")).toBe(false);
  });
});

describe("runVisionCall", () => {
  function makeBackend(respond: (call: number) => string): VisionBackend & { calls: () => number } {
    let count = 0;
    return {
      async readImage(path) {
        return { data: "image-data", mimeType: guessMime(path) };
      },
      async complete(_systemPrompt, _userText, _images) {
        count++;
        return respond(count);
      },
      calls: () => count,
    };
  }

  test("returns parsed JSON on a valid first response, no retry", async () => {
    const backend = makeBackend(() => JSON.stringify({ conclusion: "pass" }));
    const result = await runVisionCall(
      backend,
      { task: "Is it centered?", images: ["/tmp/a.png"], template: '{"conclusion":"pass | fail"}' },
      "SYSTEM",
    );
    expect(result.retried).toBe(false);
    expect(result.parsed).toEqual({ conclusion: "pass" });
    expect(backend.calls()).toBe(1);
  });

  test("retries once when the first response is malformed", async () => {
    const backend = makeBackend((call) =>
      call === 1 ? "I see stuff but not JSON" : JSON.stringify({ conclusion: "fail" }),
    );
    const result = await runVisionCall(
      backend,
      { task: "x", images: ["/tmp/a.png"], template: "{}" },
      "SYSTEM",
    );
    expect(result.retried).toBe(true);
    expect(result.parsed).toEqual({ conclusion: "fail" });
    expect(backend.calls()).toBe(2);
  });

  test("fenced JSON parses without a retry", async () => {
    const backend = makeBackend(() => '```json\n{"conclusion":"pass"}\n```');
    const result = await runVisionCall(
      backend,
      { task: "x", images: ["/tmp/a.png"], template: "{}" },
      "SYSTEM",
    );
    expect(result.retried).toBe(false);
    expect(result.parsed).toEqual({ conclusion: "pass" });
    expect(backend.calls()).toBe(1);
  });

  test("second malformed response still returns raw text without throwing", async () => {
    const backend = makeBackend(() => "still not json");
    const result = await runVisionCall(
      backend,
      { task: "x", images: ["/tmp/a.png"], template: "{}" },
      "SYSTEM",
    );
    expect(result.retried).toBe(true);
    expect(result.parsed).toBeUndefined();
    expect(result.text).toBe("still not json");
  });

  test("throws with the path when an image cannot be read", async () => {
    const backend: VisionBackend = {
      async readImage() {
        throw new Error("EACCES");
      },
      async complete() {
        return "{}";
      },
    };
    await expect(
      runVisionCall(backend, { task: "x", images: ["/tmp/nope.png"], template: "{}" }, "SYSTEM"),
    ).rejects.toThrow(/nope\.png/);
  });

  test("prompt embeds task, image paths, and template", async () => {
    let seenText = "";
    const backend: VisionBackend = {
      async readImage() {
        return { data: "x", mimeType: "image/png" };
      },
      async complete(_systemPrompt, userText) {
        seenText = userText;
        return "{}";
      },
    };
    await runVisionCall(
      backend,
      { task: "Check alignment", images: ["/tmp/before.png"], template: '{"aligned":true}' },
      "SYSTEM",
    );
    expect(seenText).toContain("## Visual Task");
    expect(seenText).toContain("Check alignment");
    expect(seenText).toContain("/tmp/before.png");
    expect(seenText).toContain('{"aligned":true}');
  });
});

describe("model selection state", () => {
  const models: ModelLike[] = [
    { id: "a", provider: "p1" },
    { id: "b", provider: "p1" },
    { id: "c", provider: "p2" },
  ];
  const byRef: ModelFilter = (ms, q) => ms.filter((m) => modelRef(m).includes(q.toLowerCase()));

  test("createModelSelection starts on the current ref, else index 0", () => {
    expect(createModelSelection(models, "p2/c").selectedIndex).toBe(2);
    expect(createModelSelection(models, "nope").selectedIndex).toBe(0);
    expect(createModelSelection([], undefined).selectedIndex).toBe(0);
  });

  test("filterModelSelection jumps to the top match on query", () => {
    const s = filterModelSelection(createModelSelection(models), "p2", byRef);
    expect(s.filtered.map(modelRef)).toEqual(["p2/c"]);
    expect(s.selectedIndex).toBe(0);
  });

  test("clearing the query restores the full list and clamps the selection", () => {
    const q = filterModelSelection(createModelSelection(models), "p2", byRef);
    const cleared = filterModelSelection(q, "", byRef);
    expect(cleared.filtered).toHaveLength(3);
    expect(cleared.selectedIndex).toBe(0);
  });

  test("a query with no matches yields an empty filtered list", () => {
    const s = filterModelSelection(createModelSelection(models), "zzz", byRef);
    expect(s.filtered).toEqual([]);
    expect(s.selectedIndex).toBe(0);
  });

  test("moveModelSelection wraps when wrap=true and clamps when wrap=false", () => {
    const s = createModelSelection(models);
    expect(moveModelSelection(s, -1, true).selectedIndex).toBe(2); // wrap up past 0
    expect(moveModelSelection(s, 3, true).selectedIndex).toBe(0); // wrap around
    expect(moveModelSelection(s, 99, false).selectedIndex).toBe(2); // clamp down
    expect(moveModelSelection(s, -99, false).selectedIndex).toBe(0); // clamp up
    expect(moveModelSelection({ all: [], filtered: [], selectedIndex: 0 }, 1, true).selectedIndex).toBe(0);
  });

  test("visibleWindow centers the selection and clamps at the ends", () => {
    expect(visibleWindow(20, 10, 10)).toEqual({ start: 5, end: 15 });
    expect(visibleWindow(20, 0, 10)).toEqual({ start: 0, end: 10 });
    expect(visibleWindow(20, 19, 10)).toEqual({ start: 10, end: 20 });
    expect(visibleWindow(3, 1, 10)).toEqual({ start: 0, end: 3 });
    expect(visibleWindow(0, 0, 10)).toEqual({ start: 0, end: 0 });
    expect(visibleWindow(5, 2, 0)).toEqual({ start: 0, end: 0 });
  });
});

describe("model presentation", () => {
  test("formatModelChoices lists provider/id, name, and cost", () => {
    const out = formatModelChoices([
      { id: "gpt-5", provider: "openai", name: "GPT-5", cost: { input: 1.25, output: 10 } },
      { id: "gemini-2.5-pro", provider: "google", name: "Gemini 2.5 Pro" },
    ]);
    expect(out).toBe(
      "- openai/gpt-5 — GPT-5 (in $1.25/MTok, out $10/MTok)\n- google/gemini-2.5-pro — Gemini 2.5 Pro",
    );
  });

  test("formatModelChoices falls back to the id when unnamed", () => {
    expect(formatModelChoices([{ id: "x", provider: "p" }])).toBe("- p/x — x");
  });

  test("formatModelChoices of no models is empty", () => {
    expect(formatModelChoices([])).toBe("");
  });
});

describe("chooseModelRef", () => {
  test("persisted choice wins when still available", () => {
    expect(chooseModelRef(["a/x", "b/y"], "a/x")).toBe("a/x");
  });

  test("first available when nothing persisted", () => {
    expect(chooseModelRef(["a/x", "b/y"], undefined)).toBe("a/x");
  });

  test("stale persisted choice falls back to first available", () => {
    expect(chooseModelRef(["a/x"], "z/zz")).toBe("a/x");
  });

  test("no models yields undefined", () => {
    expect(chooseModelRef([], "a/x")).toBeUndefined();
  });
});
