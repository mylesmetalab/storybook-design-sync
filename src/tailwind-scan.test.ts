import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTailwindTheme } from "@metalab/design-sync-core";
import { scanCss } from "./scan-css.js";
import { scanTsx } from "./scan-tsx.js";
import {
  resolveComponentBindings,
  countTailwindScopes,
  componentIdentityFromVariableName,
  type TailwindComponentScan,
} from "./tailwind-components.js";

/**
 * End-to-end for the Tailwind path: consumer CSS + a `cva()` component on disk,
 * through the scanners, into per-story bindings.
 *
 * The fixture is a trimmed copy of the shape the real consumer uses (shadcn
 * `@theme inline` aliases over `:root` tokens; a cva Button with `variant` and
 * `size` axes, `hover:` and `data-disabled:` classes, and arbitrary values), so
 * these assertions double as a regression pin on the live case that reported
 * `derived bindings for 0 selector(s)`.
 */

const CSS = `
@import "tailwindcss";

@theme inline {
  --font-sans: 'Inter Variable', 'Inter', sans-serif;
  --text-base: 1rem;
  --color-primary: var(--primary);
  --color-primary-hover: var(--primary-hover);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-hover: var(--secondary-hover);
  --color-foreground: var(--foreground);
  --color-border: var(--border);
  --color-border-neutral: var(--border-neutral);
  --color-disabled: var(--disabled);
  --color-disabled-foreground: var(--disabled-foreground);
  --radius-md: var(--radius);
}

:root {
  --primary: #2c2c2c;
  --radius: 0.5rem;
}
`;

const BUTTON_TSX = `
import { cva } from "class-variance-authority"

const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 rounded-md border",
    "font-sans text-base/[1] font-normal whitespace-nowrap",
    "transition-colors",
    "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
    "data-disabled:pointer-events-none data-disabled:bg-disabled data-disabled:border-disabled-foreground data-disabled:text-disabled-foreground",
    "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        primary:
          "bg-primary border-primary text-primary-foreground hover:bg-primary-hover",
        neutral:
          "bg-secondary border-border-neutral text-foreground hover:bg-secondary-hover",
        subtle:
          "bg-transparent border-transparent text-foreground hover:border-border",
      },
      size: {
        medium: "p-3",
        small: "p-2",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "medium",
    },
  },
)

export function Button(props) {
  return <button className={cn(buttonVariants(props))} {...props} />
}
`;

let cwd: string;
let themeVars: Record<string, string>;
let components: TailwindComponentScan[];
let warnings: Array<{ file: string; message: string }>;

beforeAll(async () => {
  cwd = await mkdtemp(join(tmpdir(), "design-sync-tw-"));
  await mkdir(join(cwd, "src", "ui"), { recursive: true });
  await writeFile(join(cwd, "src", "index.css"), CSS, "utf8");
  await writeFile(join(cwd, "src", "ui", "button.tsx"), BUTTON_TSX, "utf8");

  const css = await scanCss(cwd, ["src/**/*.css"]);
  themeVars = css.themeVars;
  const tsx = await scanTsx(cwd, ["src/**/*.tsx"], css.themeVars);
  components = tsx.components;
  warnings = tsx.warnings;
});

afterAll(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("scanCss reads the Tailwind theme", () => {
  it("picks up @theme vars and ignores :root ones", () => {
    expect(themeVars["color-primary"]).toBe("var(--primary)");
    expect(themeVars["radius-md"]).toBe("var(--radius)");
    expect(themeVars["primary"]).toBeUndefined();
  });
});

describe("scanTsx reads cva() layers", () => {
  it("finds the component with both identities and no warnings", () => {
    expect(warnings).toEqual([]);
    expect(components).toHaveLength(1);
    // Looked up by file basename AND by the assigned variable name.
    expect(components[0]!.components.sort()).toEqual(["button"]);
  });

  it("records the base class list and the axes in declaration order", () => {
    const scan = components[0]!;
    expect(scan.base).toContain("rounded-md");
    expect(scan.axes.map((a) => a.axis)).toEqual(["variant", "size"]);
    expect(Object.keys(scan.axes[0]!.values)).toEqual(["primary", "neutral", "subtle"]);
    expect(scan.defaultVariants).toEqual({ variant: "primary", size: "medium" });
    expect(scan.compoundVariants).toEqual([]);
  });

  it("counts the resolvable binding scopes for the startup log", () => {
    // base + primary + neutral + subtle = 4. The two size slots (`p-3`, `p-2`)
    // resolve nothing, so they are not scopes.
    expect(countTailwindScopes(components, themeVars)).toBe(4);
  });
});

describe("resolveComponentBindings — per story", () => {
  it("resolves the primary/medium story from its args", () => {
    const r = resolveComponentBindings(components, "button", { variant: "primary", size: "medium" }, themeVars);
    expect(r.kind).toBe("resolved");
    if (r.kind !== "resolved") return;
    expect(r.bindings).toEqual({
      "background-color": "primary",
      "border-color": "primary",
      color: "primary-foreground",
      "border-top-left-radius": "radius",
      "border-top-right-radius": "radius",
      "border-bottom-left-radius": "radius",
      "border-bottom-right-radius": "radius",
      "font-family": "font-sans",
      "font-size": "text-base",
    });
    // The class attribution the fix prompt uses.
    expect(r.classes["background-color"]).toBe("bg-primary");
    expect(r.classes["border-top-left-radius"]).toBe("rounded-md");
    expect(r.classes["font-size"]).toBe("text-base/[1]");
  });

  it("resolves a different variant to that variant's tokens", () => {
    const r = resolveComponentBindings(components, "button", { variant: "neutral" }, themeVars);
    expect(r.kind).toBe("resolved");
    if (r.kind !== "resolved") return;
    expect(r.bindings["background-color"]).toBe("secondary");
    expect(r.bindings["border-color"]).toBe("border-neutral");
    expect(r.bindings["color"]).toBe("foreground");
  });

  it("falls back to defaultVariants when args don't pin an axis", () => {
    const r = resolveComponentBindings(components, "button", {}, themeVars);
    expect(r.kind).toBe("resolved");
    if (r.kind !== "resolved") return;
    expect(r.selection).toEqual({ variant: "primary", size: "medium" });
    expect(r.bindings["background-color"]).toBe("primary");
  });

  it("never attributes a hover: token — nothing forces hover", () => {
    const r = resolveComponentBindings(components, "button", { variant: "primary" }, themeVars);
    expect(r.kind).toBe("resolved");
    if (r.kind !== "resolved") return;
    expect(Object.values(r.bindings)).not.toContain("primary-hover");
  });

  it("ignores data-disabled: classes when the story is not disabled", () => {
    const r = resolveComponentBindings(components, "button", { variant: "primary" }, themeVars);
    expect(r.kind).toBe("resolved");
    if (r.kind !== "resolved") return;
    expect(r.state).toEqual({ disabled: false });
    expect(r.bindings["background-color"]).toBe("primary");
    expect(Object.values(r.bindings)).not.toContain("disabled");
    expect(Object.values(r.bindings)).not.toContain("disabled-foreground");
  });

  it("applies data-disabled: classes when the story IS disabled", () => {
    // `disabled: true` makes React write `data-disabled` on the element, so the
    // story really is painting `bg-disabled`. Reporting `primary` here would be
    // the confident wrong answer the modifier rules exist to prevent.
    const r = resolveComponentBindings(
      components,
      "button",
      { variant: "primary", size: "medium", disabled: true },
      themeVars,
    );
    expect(r.kind).toBe("resolved");
    if (r.kind !== "resolved") return;
    expect(r.state).toEqual({ disabled: true });
    expect(r.bindings["background-color"]).toBe("disabled");
    expect(r.bindings["border-color"]).toBe("disabled-foreground");
    expect(r.bindings["color"]).toBe("disabled-foreground");
    expect(r.classes["background-color"]).toBe("data-disabled:bg-disabled");
    // Properties the disabled state doesn't touch are unchanged.
    expect(r.bindings["border-top-left-radius"]).toBe("radius");
    expect(r.bindings["font-size"]).toBe("text-base");
  });

  it("passes the active mode through so dark: classes resolve", () => {
    const scan: TailwindComponentScan = {
      components: ["thing"],
      file: "/x/thing.tsx",
      base: "bg-primary dark:bg-secondary",
      axes: [],
      defaultVariants: {},
      compoundVariants: [],
    };
    expect(
      resolveComponentBindings([scan], "thing", {}, themeVars, "dark"),
    ).toMatchObject({ bindings: { "background-color": "secondary" } });
    expect(
      resolveComponentBindings([scan], "thing", {}, themeVars, "light"),
    ).toMatchObject({ bindings: { "background-color": "primary" } });
    // No mode supplied → `dark:` is unknowable → the property is left unbound.
    const unknown = resolveComponentBindings([scan], "thing", {}, themeVars);
    expect(unknown.kind === "resolved" && unknown.bindings["background-color"]).toBeUndefined();
    expect(unknown.kind === "resolved" && unknown.conflicts).toContain("background-color");
  });

  it("emits nothing for padding, gap, border-width or font-weight", () => {
    // `p-3` / `gap-2` are `calc(var(--spacing) * n)` with no per-step token;
    // `border` is a literal 1px; `font-normal` needs a `--font-weight-normal`
    // the consumer doesn't declare. All absent rather than guessed.
    const r = resolveComponentBindings(components, "button", { variant: "primary", size: "medium" }, themeVars);
    expect(r.kind).toBe("resolved");
    if (r.kind !== "resolved") return;
    for (const key of ["padding-top", "padding-left", "gap", "border-width", "font-weight"]) {
      expect(r.bindings[key], key).toBeUndefined();
    }
  });

  it("emits nothing for a variant whose colour class has no token", () => {
    const r = resolveComponentBindings(components, "button", { variant: "subtle" }, themeVars);
    expect(r.kind).toBe("resolved");
    if (r.kind !== "resolved") return;
    // `bg-transparent` / `border-transparent` are Tailwind defaults, not
    // consumer tokens.
    expect(r.bindings["background-color"]).toBeUndefined();
    expect(r.bindings["border-color"]).toBeUndefined();
    expect(r.bindings["color"]).toBe("foreground");
  });

  it("returns none for a component name nothing was scanned for", () => {
    expect(resolveComponentBindings(components, "dialog", {}, themeVars).kind).toBe("none");
  });

  it("resolves `disabled: true` through args without needing state forcing", () => {
    // Verifies the arg → cva-slot path for a boolean axis. (The real consumer's
    // disabled state is `data-disabled:` classes rather than a cva axis, which
    // React applies to the DOM from the same arg — see the disabled test below.)
    const scan: TailwindComponentScan = {
      components: ["thing"],
      file: "/x/thing.tsx",
      base: "bg-primary",
      axes: [{ axis: "disabled", values: { true: "bg-disabled", false: "" } }],
      defaultVariants: {},
      compoundVariants: [],
    };
    const on = resolveComponentBindings([scan], "thing", { disabled: true }, themeVars);
    expect(on.kind === "resolved" && on.bindings["background-color"]).toBe("disabled");
    const off = resolveComponentBindings([scan], "thing", { disabled: false }, themeVars);
    expect(off.kind === "resolved" && off.bindings["background-color"]).toBe("primary");
  });
});

describe("resolveComponentBindings — refuses rather than guesses", () => {
  const scanA: TailwindComponentScan = {
    components: ["button"],
    file: "/a/button.tsx",
    base: "bg-primary",
    axes: [],
    defaultVariants: {},
    compoundVariants: [],
  };
  const scanB: TailwindComponentScan = { ...scanA, file: "/b/button.tsx", base: "bg-secondary" };

  it("reports ambiguity when two scanned components share a name", () => {
    const r = resolveComponentBindings([scanA, scanB], "button", {}, themeVars);
    expect(r.kind).toBe("ambiguous");
    if (r.kind !== "ambiguous") return;
    expect(r.files).toEqual(["/a/button.tsx", "/b/button.tsx"]);
    // Two files, so `tsxEntries` narrowing / renaming is real advice.
    expect(r.sameFile).toBe(false);
  });

  /**
   * F2 — the live Card. `card.tsx` held three `cva()` calls, so three scans each
   * listed the file basename `"card"` among their identities, `"card"` matched
   * three times, and the component's Tailwind bindings were withheld wholesale:
   * token-attributed rows went 26 → 12, signalled only by an advisory that
   * printed the same path three times and said "rename one".
   *
   * `cardVariants` is named for the component; `cardHeaderVariants` and
   * `cardTitleVariants` answer only because they share the filename. The code
   * said which is which.
   */
  describe("several cva() class lists in one file", () => {
    const cardRoot: TailwindComponentScan = {
      components: ["card"],
      variableName: "cardVariants",
      file: "/src/components/ui/card.tsx",
      base: "bg-primary text-foreground rounded-md",
      axes: [],
      defaultVariants: {},
      compoundVariants: [],
    };
    const cardHeader: TailwindComponentScan = {
      ...cardRoot,
      components: ["card", "cardheader"],
      variableName: "cardHeaderVariants",
      base: "bg-secondary",
    };
    const cardTitle: TailwindComponentScan = {
      ...cardRoot,
      components: ["card", "cardtitle"],
      variableName: "cardTitleVariants",
      base: "bg-disabled",
    };
    const all = [cardRoot, cardHeader, cardTitle];

    it("derives from the class list named for the component", () => {
      const r = resolveComponentBindings(all, "card", {}, themeVars);
      expect(r.kind).toBe("resolved");
      expect(r.kind === "resolved" && r.bindings["background-color"]).toBe("primary");
      expect(r.kind === "resolved" && r.file).toBe("/src/components/ui/card.tsx");
    });

    it("still resolves the other class lists by their own names", () => {
      const header = resolveComponentBindings(all, "cardheader", {}, themeVars);
      expect(header.kind === "resolved" && header.bindings["background-color"]).toBe("secondary");
      const title = resolveComponentBindings(all, "cardtitle", {}, themeVars);
      expect(title.kind === "resolved" && title.bindings["background-color"]).toBe("disabled");
    });

    /**
     * Nothing in the file is named for the component, so all three match on the
     * filename alone and there is still no way to tell which styles the root.
     * Attributing `cardTitleVariants`' classes to the card root would be a coin
     * flip wearing a token name — so the verdict stays "refuse", and what changes
     * is that the advice is now followable: it names the identifiers, and it does
     * not tell the reader to rename one of three identical paths.
     */
    it("reports a same-file collision, deduped, when none is named for it", () => {
      const r = resolveComponentBindings([cardHeader, cardTitle], "card", {}, themeVars);
      expect(r.kind).toBe("ambiguous");
      if (r.kind !== "ambiguous") return;
      expect(r.sameFile).toBe(true);
      expect(r.files).toEqual(["/src/components/ui/card.tsx"]);
      expect(r.names).toEqual(["cardHeaderVariants", "cardTitleVariants"]);
    });

    it("names an unassigned cva() call rather than omitting it", () => {
      const { variableName: _unnamed, ...inline } = cardHeader;
      const r = resolveComponentBindings([inline, cardTitle], "card", {}, themeVars);
      expect(r.kind === "ambiguous" && r.names).toEqual([
        "(unnamed cva call)",
        "cardTitleVariants",
      ]);
    });

    /**
     * The specificity tie-break only fires when exactly one candidate claims the
     * name. Two identifiers reducing to the same identity is a genuine tie.
     */
    it("refuses when two class lists are both named for the component", () => {
      const twin: TailwindComponentScan = { ...cardRoot, variableName: "cardClasses" };
      const r = resolveComponentBindings([cardRoot, twin], "card", {}, themeVars);
      expect(r.kind).toBe("ambiguous");
    });
  });

  it("scanTsx records the identifier each cva() call was assigned to", async () => {
    const dir = await mkdtemp(join(tmpdir(), "design-sync-tw-name-"));
    await writeFile(
      join(dir, "card.tsx"),
      `const cardVariants = cva("bg-primary")\n` +
        `const cardTitleVariants = cva("bg-disabled")\n`,
      "utf8",
    );
    const tsx = await scanTsx(dir, ["*.tsx"], themeVars);
    await rm(dir, { recursive: true, force: true });

    expect(tsx.components.map((c) => c.variableName)).toEqual([
      "cardVariants",
      "cardTitleVariants",
    ]);
    // Both answer to the filename; only one is named for `card`, and that is
    // the one derived from.
    const r = resolveComponentBindings(tsx.components, "card", {}, themeVars);
    expect(r.kind === "resolved" && r.bindings["background-color"]).toBe("primary");
  });

  it("drops properties an indeterminate axis could have overridden", () => {
    // No arg and no default for `variant`, so any of its slots may have applied.
    const scan: TailwindComponentScan = {
      components: ["thing"],
      file: "/x/thing.tsx",
      base: "bg-primary rounded-md",
      axes: [{ axis: "variant", values: { a: "bg-secondary", b: "bg-foreground" } }],
      defaultVariants: {},
      compoundVariants: [],
    };
    const r = resolveComponentBindings([scan], "thing", {}, themeVars);
    expect(r.kind).toBe("resolved");
    if (r.kind !== "resolved") return;
    expect(r.bindings["background-color"]).toBeUndefined();
    expect(r.conflicts).toContain("background-color");
    // Radius is untouched by the axis, so it survives.
    expect(r.bindings["border-top-left-radius"]).toBe("radius");
  });

  it("drops properties when a story arg names a slot the axis doesn't declare", () => {
    const scan: TailwindComponentScan = {
      components: ["thing"],
      file: "/x/thing.tsx",
      base: "bg-primary",
      axes: [{ axis: "variant", values: { a: "bg-secondary" } }],
      defaultVariants: {},
      compoundVariants: [],
    };
    const r = resolveComponentBindings([scan], "thing", { variant: "nope" }, themeVars);
    expect(r.kind === "resolved" && r.bindings["background-color"]).toBeUndefined();
  });
});

describe("compound variants", () => {
  const scan: TailwindComponentScan = {
    components: ["thing"],
    file: "/x/thing.tsx",
    base: "bg-primary",
    axes: [
      { axis: "variant", values: { a: "", b: "" } },
      { axis: "size", values: { sm: "", lg: "" } },
    ],
    defaultVariants: {},
    compoundVariants: [
      { when: { variant: ["a"], size: ["lg"] }, classList: "bg-secondary" },
    ],
  };

  it("applies a compound variant whose conditions all match", () => {
    const r = resolveComponentBindings([scan], "thing", { variant: "a", size: "lg" }, themeVars);
    expect(r.kind === "resolved" && r.bindings["background-color"]).toBe("secondary");
  });

  it("excludes a compound variant whose conditions don't match", () => {
    const r = resolveComponentBindings([scan], "thing", { variant: "b", size: "lg" }, themeVars);
    expect(r.kind === "resolved" && r.bindings["background-color"]).toBe("primary");
  });

  it("drops the properties of a compound variant it cannot evaluate", () => {
    // `size` is indeterminate, so whether the compound applied is unknowable.
    const r = resolveComponentBindings([scan], "thing", { variant: "a" }, themeVars);
    expect(r.kind).toBe("resolved");
    if (r.kind !== "resolved") return;
    expect(r.bindings["background-color"]).toBeUndefined();
    expect(r.conflicts).toContain("background-color");
  });

  it("reads a compound variant with array conditions and a `className` key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "design-sync-tw-cv-"));
    await writeFile(
      join(dir, "card.tsx"),
      `const cardVariants = cva("bg-primary", {
         variants: { tone: { a: "", b: "" }, size: { sm: "", lg: "" } },
         defaultVariants: { tone: "a", size: "lg" },
         compoundVariants: [
           { tone: ["a", "b"], size: "lg", className: "bg-secondary" },
         ],
       })`,
      "utf8",
    );
    const tsx = await scanTsx(dir, ["*.tsx"], themeVars);
    await rm(dir, { recursive: true, force: true });
    expect(tsx.warnings).toEqual([]);
    expect(tsx.components[0]!.compoundVariants).toEqual([
      { when: { tone: ["a", "b"], size: ["lg"] }, classList: "bg-secondary" },
    ]);
    const r = resolveComponentBindings(tsx.components, "card", {}, themeVars);
    expect(r.kind === "resolved" && r.bindings["background-color"]).toBe("secondary");
  });
});

describe("non-literal cva calls are dropped whole", () => {
  it("warns and derives nothing when a variant slot is not a literal", async () => {
    const dir = await mkdtemp(join(tmpdir(), "design-sync-tw-nl-"));
    await writeFile(
      join(dir, "widget.tsx"),
      `const extra = "bg-secondary";
       const widgetVariants = cva("bg-primary rounded-md", {
         variants: { tone: { a: extra } },
       })`,
      "utf8",
    );
    const tsx = await scanTsx(dir, ["*.tsx"], themeVars);
    await rm(dir, { recursive: true, force: true });
    // Reading only the base would report `bg-primary` while the unread slot may
    // have overridden it — absent beats wrong.
    expect(tsx.components).toEqual([]);
    expect(tsx.warnings).toHaveLength(1);
    expect(tsx.warnings[0]!.message).toContain("non-literal class expression");
  });
});

describe("literal className attributes", () => {
  it("lands Tailwind bindings under the synthetic selector keys, with class hints", async () => {
    const dir = await mkdtemp(join(tmpdir(), "design-sync-tw-cn-"));
    await writeFile(
      join(dir, "panel.tsx"),
      `export const Panel = () => (
         <div className="panel rounded-md bg-primary hover:bg-primary-hover p-3">x</div>
       )`,
      "utf8",
    );
    const tsx = await scanTsx(dir, ["*.tsx"], themeVars);
    await rm(dir, { recursive: true, force: true });
    expect(tsx.map[".panel"]).toMatchObject({
      "background-color": "primary",
      "border-top-left-radius": "radius",
    });
    // `hover:` excluded, `p-3` unresolvable.
    expect(tsx.map[".panel"]!["padding-top"]).toBeUndefined();
    expect(tsx.classHints[".panel"]!["background-color"]).toBe("bg-primary");
  });

  it("skips a className={expr} initializer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "design-sync-tw-cx-"));
    await writeFile(
      join(dir, "panel.tsx"),
      `export const Panel = ({ cls }) => <div id="p" className={cls}>x</div>`,
      "utf8",
    );
    const tsx = await scanTsx(dir, ["*.tsx"], themeVars);
    await rm(dir, { recursive: true, force: true });
    expect(tsx.map).toEqual({});
  });
});

describe("component identity", () => {
  const cases: Array<[string, string]> = [
    ["buttonVariants", "button"],
    ["cardStyles", "card"],
    ["badgeClasses", "badge"],
    ["alertClass", "alert"],
    ["dialog", "dialog"],
  ];
  for (const [input, expected] of cases) {
    it(`${input} → ${expected}`, () => {
      expect(componentIdentityFromVariableName(input)).toBe(expected);
    });
  }
});

describe("no theme means no bindings", () => {
  it("derives nothing when the consumer has no @theme block", async () => {
    const dir = await mkdtemp(join(tmpdir(), "design-sync-tw-nt-"));
    await writeFile(join(dir, "button.tsx"), BUTTON_TSX, "utf8");
    const tsx = await scanTsx(dir, ["*.tsx"], parseTailwindTheme(":root { --primary: red; }"));
    await rm(dir, { recursive: true, force: true });
    const r = resolveComponentBindings(tsx.components, "button", { variant: "primary" }, {});
    expect(r.kind === "resolved" && r.bindings).toEqual({});
  });
});
