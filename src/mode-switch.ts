/**
 * Switching a rendered story between two theme modes, and — the part that
 * matters — **knowing whether the switch landed**.
 *
 * Issue #69. The dual-mode path switched theme with
 * `root.setAttribute("data-theme", mode)`. A consumer that themes by *class*
 * (Tailwind's `@custom-variant dark (&:is(.dark *))`, which is what shadcn and
 * the reference starter use) never changed appearance, so both passes measured
 * the same rendered state and the run reported a completed two-mode comparison
 * with byte-identical totals: `409 match · 34 drift · 85 name-only · 228
 * flag-only` in both modes, same runtime, no extra rows. `setAttribute` cannot
 * set a class, so no amount of configuring `modeAttribute` could have fixed it.
 *
 * Two changes, and the second is the important one:
 *
 *  1. **A class is a switching mechanism too**, declarable, and tried by default
 *     alongside the attribute forms.
 *  2. **Nothing is claimed without evidence.** A mechanism counts as working only
 *     if applying mode B produces a computed-style difference from mode A
 *     somewhere that matters (`<html>`, `<body>`, the story root, its bound
 *     children). When none does, the caller is told, and the report says the mode
 *     comparison was **not performed** — instead of comparing one mode twice and
 *     presenting it as two.
 *
 * That predicate is also honest in the boring case: if a component genuinely
 * renders identically in both modes, there is no second state to compare, and
 * saying so is more useful than a duplicated pass.
 *
 * DOM access is injected so the resolution logic is testable without a browser
 * (jsdom resolves neither CSS variables nor Tailwind variants, so a real DOM
 * would not exercise the interesting cases anyway).
 */

/** How a consumer's theme is switched. */
export type ModeSwitchSpec =
  | { kind: "class"; on: ModeSwitchHost }
  | { kind: "attribute"; attribute: string; on: ModeSwitchHost };

/** Which element carries the theme marker. */
export type ModeSwitchHost = "html" | "body";

/**
 * The mechanisms tried when a story declares none, in order.
 *
 * Class first, deliberately: it is the majority convention in the Tailwind/shadcn
 * ecosystem this addon is most often pointed at, and it was the one case the old
 * default could not express. Attribute forms follow so existing consumers keep
 * working unchanged.
 */
export function defaultModeSwitchCandidates(): ModeSwitchSpec[] {
  return [
    { kind: "class", on: "html" },
    { kind: "class", on: "body" },
    { kind: "attribute", attribute: "data-theme", on: "html" },
    { kind: "attribute", attribute: "data-theme", on: "body" },
    { kind: "attribute", attribute: "data-mode", on: "html" },
    { kind: "attribute", attribute: "data-color-scheme", on: "html" },
  ];
}

/**
 * Read `parameters.designSync.modeSwitch` (and the older `modeAttribute` string)
 * into a spec.
 *
 * Accepted forms:
 *   modeSwitch: "class"                          → class on <html>
 *   modeSwitch: { kind: "class", on: "body" }
 *   modeSwitch: { kind: "attribute", attribute: "data-theme" }
 *   modeAttribute: "data-theme"                  → attribute on <html>
 *
 * Returns null for anything unrecognised — including a declared-but-malformed
 * value — so the caller falls back to detection rather than silently using a
 * mechanism the consumer didn't ask for. `problem` says what was wrong, because a
 * typo'd parameter that is quietly ignored is its own silent failure.
 */
export function parseModeSwitch(input: {
  modeSwitch?: unknown;
  modeAttribute?: unknown;
}): { spec: ModeSwitchSpec | null; problem?: string } {
  const raw = input.modeSwitch;
  if (typeof raw === "string") {
    const value = raw.trim().toLowerCase();
    if (value === "class") return { spec: { kind: "class", on: "html" } };
    if (value === "attribute") {
      return { spec: { kind: "attribute", attribute: attributeOf(input.modeAttribute), on: "html" } };
    }
    return {
      spec: null,
      problem:
        `parameters.designSync.modeSwitch: "${raw}" is not a mechanism ` +
        `("class" or "attribute"). Detecting instead.`,
    };
  }
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    const on = obj.on === "body" ? "body" : "html";
    if (obj.kind === "class") return { spec: { kind: "class", on } };
    if (obj.kind === "attribute") {
      const attribute =
        typeof obj.attribute === "string" && obj.attribute.trim() !== ""
          ? obj.attribute.trim()
          : attributeOf(input.modeAttribute);
      return { spec: { kind: "attribute", attribute, on } };
    }
    return {
      spec: null,
      problem:
        `parameters.designSync.modeSwitch needs \`kind: "class"\` or ` +
        `\`kind: "attribute"\`. Detecting instead.`,
    };
  }
  if (typeof input.modeAttribute === "string" && input.modeAttribute.trim() !== "") {
    // The pre-existing option. Still authoritative when set — a consumer who
    // declared it told us their mechanism.
    return { spec: { kind: "attribute", attribute: input.modeAttribute.trim(), on: "html" } };
  }
  return { spec: null };
}

function attributeOf(modeAttribute: unknown): string {
  return typeof modeAttribute === "string" && modeAttribute.trim() !== ""
    ? modeAttribute.trim()
    : "data-theme";
}

/** Wording for the panel and the report: "class `.dark` on <html>". */
export function describeModeSwitch(spec: ModeSwitchSpec, mode?: string): string {
  if (spec.kind === "class") {
    return mode
      ? `class \`.${mode}\` on <${spec.on}>`
      : `mode-named class on <${spec.on}>`;
  }
  return `attribute \`${spec.attribute}\` on <${spec.on}>`;
}

/** Every mechanism, named, for a message that lists what was tried. */
export function describeCandidates(specs: readonly ModeSwitchSpec[], modeB: string): string {
  return specs.map((s) => describeModeSwitch(s, modeB)).join(", ");
}

/* ------------------------------------------------------------------------- *
 * Applying and restoring
 * ------------------------------------------------------------------------- */

/** The subset of an element this module needs. Keeps jsdom out of the tests. */
export interface ModeSwitchElement {
  getAttribute(name: string): string | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  classList: {
    add(...tokens: string[]): void;
    remove(...tokens: string[]): void;
    contains(token: string): boolean;
  };
}

export interface ModeSwitchHosts {
  html: ModeSwitchElement;
  body: ModeSwitchElement;
}

/**
 * What the DOM looked like before we touched it, so it can be put back exactly.
 * Restoring matters more than it sounds: the story stays on screen after a check,
 * and leaving it in the wrong theme would have the panel silently redefine what
 * the user is looking at.
 */
export interface ModeSwitchRestore {
  apply(): void;
}

/**
 * Apply `mode` via `spec`, removing the other mode's marker. Returns a restore
 * handle capturing the prior state.
 *
 * For the class mechanism, both mode names are treated as candidate classes: a
 * shadcn consumer has `.dark` and *no* class for light, so switching to light
 * means removing `.dark` — adding a harmless `.light` alongside costs nothing and
 * supports consumers who do name both.
 *
 * **Restore puts back the captured `class` attribute verbatim** (issue #78), it
 * does not reconstruct it from the mode names it happens to know about. The
 * starter's root class was empty, so a reconstruction looked correct there and
 * would have quietly destroyed `class="theme-brand dark"` or a framework's
 * `class="js"` on any consumer that has one. A drift check must leave the document
 * exactly as it found it: this is a read-only tool holding a write for ~100ms.
 *
 * `forceReflow` is invoked after restoring. The consumer showed a canvas still
 * painted dark after the class was gone — computed values were correct, the paint
 * had not caught up — so the restore ends by making the browser do the work.
 */
export function applyMode(
  hosts: ModeSwitchHosts,
  spec: ModeSwitchSpec,
  mode: string,
  allModes: readonly string[],
  opts: { forceReflow?: () => void } = {},
): ModeSwitchRestore {
  const el = hosts[spec.on];
  const finish = (): void => opts.forceReflow?.();
  if (spec.kind === "attribute") {
    const previous = el.getAttribute(spec.attribute);
    el.setAttribute(spec.attribute, mode);
    return {
      apply: () => {
        if (previous === null) el.removeAttribute(spec.attribute);
        else el.setAttribute(spec.attribute, previous);
        finish();
      },
    };
  }
  // The whole attribute, exactly as the consumer's app wrote it.
  const previousClass = el.getAttribute("class");
  el.classList.remove(...allModes);
  el.classList.add(mode);
  return {
    apply: () => {
      if (previousClass === null) el.removeAttribute("class");
      else el.setAttribute("class", previousClass);
      finish();
    },
  };
}

/* ------------------------------------------------------------------------- *
 * Flushing
 * ------------------------------------------------------------------------- */

/**
 * How long to wait for a frame callback before proceeding without one.
 * One frame at 60Hz is ~16ms; 32ms is two, comfortably past a real paint.
 */
export const STYLE_FLUSH_FALLBACK_MS = 32;

/**
 * Wait for the browser to settle style and layout after a theme change.
 *
 * **This function exists in this shape because of issue #78.** It used to be two
 * nested `requestAnimationFrame`s and nothing else. Instrumenting the live
 * consumer found:
 *
 *     document.visibilityState  →  "hidden"
 *     requestAnimationFrame     →  never fired (3s probe, top frame and iframe)
 *     setTimeout                →  fired
 *
 * A hidden document does not run frame callbacks — a backgrounded tab, an
 * inactive window, an automated session. So the promise never settled and the
 * whole check parked on the first flush, before any comparison, upstream of every
 * budget: the server's budget cannot start, because no snapshot is ever sent, and
 * the user got the panel's generic "no reply after 65s".
 *
 * A frame callback is a nice-to-have; never waiting forever is not. So the frame
 * is *raced* against a timer, and whichever arrives first wins. The timer path
 * loses nothing that matters: every measurement here goes through
 * `getComputedStyle`, which recalculates style synchronously on read, and the
 * reflow is forced explicitly.
 */
export function createStyleFlusher(deps: {
  /** Frame callback, when the environment has one. */
  raf?: ((cb: () => void) => void) | undefined;
  setTimer: (cb: () => void, ms: number) => void;
  /** Read a layout property to force a synchronous reflow. */
  forceReflow?: (() => void) | undefined;
  fallbackMs?: number | undefined;
}): () => Promise<void> {
  const fallbackMs = deps.fallbackMs ?? STYLE_FLUSH_FALLBACK_MS;
  return () =>
    new Promise<void>((resolve) => {
      deps.forceReflow?.();
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      // Two frames means "a paint has happened". Requested when available, never
      // depended on.
      if (deps.raf) deps.raf(() => deps.raf!(done));
      deps.setTimer(done, fallbackMs);
    });
}

/**
 * How long the whole theme-switching phase may take before the check gives up on
 * two modes and reports one honestly. A ceiling here — inside the preview, before
 * any snapshot is sent — is what turns #78's silent 65s park into a stated cause.
 */
export const MODE_SWITCH_PHASE_BUDGET_MS = 6_000;

/**
 * The reason a **Both modes** check fell back to one mode because the switching
 * phase itself did not finish. Distinct from `noChangeReason`: there the switch
 * worked and moved nothing, here we never got a verdict at all.
 */
export function switchUnavailableReason(phase: string, spent: string): string {
  return (
    `Not performed — the theme switch did not complete within ${spent} while ${phase}, so ` +
    `the story was measured in one mode only. The rows below describe one mode and no ` +
    `two-mode comparison was made. This is a bug in the addon, not your project: please ` +
    `report it with your theming setup.`
  );
}

/**
 * The switching mechanism was verified, but the two measurement passes read the
 * same document state — so the mode had not actually settled when the snapshots
 * were taken, and both may describe one mode.
 *
 * This is the gap #78 identified in the v0.0.41 verification: detection asserted
 * that *something changed* during a probe, not that the change had **settled at
 * the moment the compared snapshots were read**. So the evidence is re-read at
 * snapshot time, on the same elements, and a pair that cannot be told apart is
 * refused rather than compared.
 *
 * Deliberately based on the document-level evidence (which includes `<html>` and
 * `<body>`), NOT on whether the story's own rows differ: a component that renders
 * identically in both modes while Figma holds two different values is a **real
 * dark-mode drift**, and refusing there would throw away the finding this feature
 * exists to make.
 */
export function staleModeReason(opts: {
  modeA: string;
  modeB: string;
  mechanism: string;
}): string {
  return (
    `Not performed — ${opts.mechanism} was verified to switch this project's theme, but the ` +
    `two measurement passes read the same computed state, so "${opts.modeB}" had not settled ` +
    `when its snapshot was taken. Both snapshots may describe "${opts.modeA}", and comparing ` +
    `them would report a two-mode check over one rendered state. Re-run the check; if it ` +
    `persists, please report it.`
  );
}

/* ------------------------------------------------------------------------- *
 * Evidence
 * ------------------------------------------------------------------------- */

/**
 * The computed properties a theme switch is expected to move. Colour only: sizes
 * and spacing are mode-invariant in every theming system we have seen, so
 * including them would add noise without adding evidence.
 */
export const FINGERPRINT_PROPERTIES = [
  "background-color",
  "color",
  "border-top-color",
  "border-bottom-color",
  "box-shadow",
  "outline-color",
] as const;

/**
 * A comparable string for "how these elements currently look". Not a hash — the
 * value is only ever compared with `===`, and keeping it readable means a future
 * debugging session can see *what* differed.
 */
export function fingerprint(
  elements: readonly unknown[],
  readStyles: (el: unknown) => Record<string, string>,
  properties: readonly string[] = FINGERPRINT_PROPERTIES,
): string {
  return elements
    .map((el) => {
      const styles = readStyles(el);
      return properties.map((p) => `${p}=${styles[p] ?? ""}`).join(";");
    })
    .join("|");
}

export interface ModeSwitchResolution {
  /** The mechanism that produced a computed change, or null when none did. */
  spec: ModeSwitchSpec | null;
  /** True when a mechanism was found to actually change the rendered state. */
  changed: boolean;
  /** Human description of the winning mechanism, or of what was tried. */
  mechanism: string;
  /** Set when `changed` is false — the sentence the report will carry. */
  reason?: string;
  /** True when the consumer declared the mechanism (so detection was skipped). */
  declared: boolean;
}

/**
 * Find a mechanism that actually switches this story's theme.
 *
 * A declared mechanism is **not** silently replaced by a working one: if a
 * consumer says "I theme by attribute" and that produces no change, the honest
 * outcome is to say so, not to go hunting and quietly compare something else. It
 * is verified, and it either works or the check refuses.
 *
 * With nothing declared, each candidate is tried: apply mode A, fingerprint,
 * apply mode B, fingerprint, compare. The first candidate that moves anything
 * wins. The DOM is restored after every attempt.
 */
export async function resolveModeSwitch(opts: {
  hosts: ModeSwitchHosts;
  /** Elements whose computed styles count as evidence. */
  evidence: readonly unknown[];
  readStyles: (el: unknown) => Record<string, string>;
  modes: readonly [string, string];
  declared?: ModeSwitchSpec | null;
  candidates?: readonly ModeSwitchSpec[];
  /** Await a style/layout flush between mutating and measuring. */
  flush: () => Promise<void>;
}): Promise<ModeSwitchResolution> {
  const [modeA, modeB] = opts.modes;
  const candidates = opts.declared
    ? [opts.declared]
    : (opts.candidates ?? defaultModeSwitchCandidates());

  for (const spec of candidates) {
    const restoreA = applyMode(opts.hosts, spec, modeA, opts.modes);
    await opts.flush();
    const fpA = fingerprint(opts.evidence, opts.readStyles);
    const restoreB = applyMode(opts.hosts, spec, modeB, opts.modes);
    await opts.flush();
    const fpB = fingerprint(opts.evidence, opts.readStyles);
    restoreB.apply();
    restoreA.apply();
    await opts.flush();
    if (fpA !== fpB) {
      return {
        spec,
        changed: true,
        mechanism: describeModeSwitch(spec, modeB),
        declared: opts.declared !== null && opts.declared !== undefined,
      };
    }
  }

  const declared = opts.declared !== null && opts.declared !== undefined;
  return {
    spec: null,
    changed: false,
    mechanism: describeCandidates(candidates, modeB),
    reason: noChangeReason({ modeA, modeB, candidates, declared }),
    declared,
  };
}

/**
 * The sentence a refused mode comparison carries. It has to do three things: say
 * plainly that the comparison did not happen, say what was tried, and give the
 * one-line fix — because the failure it replaces was a ticked checkbox over a
 * duplicated pass.
 */
export function noChangeReason(opts: {
  modeA: string;
  modeB: string;
  candidates: readonly ModeSwitchSpec[];
  declared: boolean;
}): string {
  const tried = describeCandidates(opts.candidates, opts.modeB);
  const head =
    `Not performed — switching from "${opts.modeA}" to "${opts.modeB}" produced no change in ` +
    `any computed colour on the story, its bound children, <body> or <html>, so there was one ` +
    `rendered state to measure, not two. Comparing it twice would report a two-mode check that ` +
    `did not happen.`;
  return opts.declared
    ? `${head} Declared mechanism: ${tried}. Either the declaration is wrong for this project, ` +
        `or the story renders identically in both modes.`
    : `${head} Tried: ${tried}. Declare the real one with ` +
        `\`parameters.designSync.modeSwitch\` — e.g. \`{ kind: "class", on: "html" }\` for ` +
        `Tailwind/shadcn \`.dark\`, or \`{ kind: "attribute", attribute: "data-theme" }\`.`;
}
