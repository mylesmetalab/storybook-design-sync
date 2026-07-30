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
 */
export function applyMode(
  hosts: ModeSwitchHosts,
  spec: ModeSwitchSpec,
  mode: string,
  allModes: readonly string[],
): ModeSwitchRestore {
  const el = hosts[spec.on];
  if (spec.kind === "attribute") {
    const previous = el.getAttribute(spec.attribute);
    el.setAttribute(spec.attribute, mode);
    return {
      apply: () => {
        if (previous === null) el.removeAttribute(spec.attribute);
        else el.setAttribute(spec.attribute, previous);
      },
    };
  }
  const had = allModes.filter((m) => el.classList.contains(m));
  el.classList.remove(...allModes);
  el.classList.add(mode);
  return {
    apply: () => {
      el.classList.remove(...allModes);
      if (had.length > 0) el.classList.add(...had);
    },
  };
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
