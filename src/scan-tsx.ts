import { Project, SyntaxKind } from "ts-morph";
import type {
  ArrayLiteralExpression,
  CallExpression,
  Expression,
  JsxAttribute,
  Node,
  ObjectLiteralExpression,
  PropertyAssignment,
} from "ts-morph";
import { glob } from "tinyglobby";
import { basename, resolve } from "node:path";
import {
  composeTailwindBindings,
  normalizeBindingKey,
  type TailwindThemeVars,
} from "@metalab/design-sync-core";
import type { AutoTokenMap } from "./scan-css.js";
import {
  expandDecl as expandDeclShared,
  compositeBorderTokens,
  extractBareVarToken,
} from "./binding-shape.js";
import {
  componentIdentityFromVariableName,
  type TailwindComponentScan,
  type TailwindCompoundVariant,
  type TailwindVariantAxis,
} from "./tailwind-components.js";

/**
 * TSX inline-style scanner. Walks JSX elements whose `style={{ … }}`
 * attribute is a literal object expression and extracts token bindings
 * of the form `prop: "var(--token)"` into the same selector → property →
 * token map shape the CSS scanner produces. The two scans are merged
 * downstream so a single lookup table serves both styling conventions.
 *
 * v0 limitations (intentional):
 *   - Only literal `style={{ … }}` expressions. `style={someExpr}`
 *     references or spreads (`{...labelStyle}`) are skipped — following
 *     them would require resolving imports across the project.
 *   - Only string-literal `"var(--x)"` values. Identifier-chain forms
 *     (`tokens.space[4]`) need a token-module convention; deferred.
 *   - Pseudo-states (hover/focus) are author-encoded in separate stories;
 *     this scanner doesn't try to infer state from JSX conditionals.
 *
 * Selector derivation: JSX has no native selector. We mint synthetic
 * keys from the element's literal attributes that a story author would
 * realistically pass to `parameters.designSync.target`:
 *   - role="button"           → `[role="button"]`
 *   - data-variant="primary"  → `[data-variant="primary"]`
 *   - id="x"                  → `#x`
 *   - className="foo bar"     → `.foo`, `.bar` (each token, literal only)
 * Each element's style block is recorded under every applicable key, so
 * lookup matches whichever selector the story happens to use.
 *
 * ---------------------------------------------------------------------------
 * TAILWIND (added v0.0.32)
 * ---------------------------------------------------------------------------
 * On the shadcn / Base UI / cva stack there are no inline styles and no
 * `var(--token)` references at all — the design decisions are utility classes.
 * This scanner now also:
 *
 *   1. classifies literal `className="…"` attributes through core's Tailwind
 *      mapper, landing bindings under the same synthetic selector keys; and
 *   2. records `cva()` calls as per-component *layers* (base + variant slots +
 *      compound variants) rather than flattening them. Flattening would
 *      attribute `bg-primary`, `bg-secondary` and `bg-transparent` all to
 *      `background-color`; which slot actually applied depends on the story's
 *      args, so resolution is deferred to the server channel, which has them.
 *      See `tailwind-components.ts`.
 *
 * A `cva()` call containing any non-literal class expression is dropped whole,
 * with a warning. Partially reading it would let an unseen slot silently
 * override a class we did read — absent beats wrong.
 */

/**
 * Selector key → property → the utility class that produced the binding.
 * Threaded to the fix prompt so it can say *which class to change* rather than
 * only which property drifted.
 */
export type TsxClassHintMap = Record<string, Record<string, string>>;

export interface TsxScanResult {
  map: AutoTokenMap;
  warnings: Array<{ file: string; message: string }>;
  scannedFiles: string[];
  /**
   * `cva()` components found, one entry per call. Resolved per story by
   * `resolveComponentBindings`, not merged into `map` — the applicable variant
   * slots aren't knowable at scan time.
   */
  components: TailwindComponentScan[];
  /** Class attribution for bindings that came from a literal `className`. */
  classHints: TsxClassHintMap;
}

function camelToDash(name: string): string {
  return name.replace(/([A-Z])/g, "-$1").toLowerCase();
}

/**
 * Collect selector hooks from a JSX element's literal attributes. Returns
 * an empty array if no attribute looks targetable — the element's style
 * block will be skipped in that case (recording it under a key no story
 * would ever query would just bloat the map).
 */
function selectorKeysFromAttrs(attrs: JsxAttribute[]): string[] {
  const keys = new Set<string>();
  for (const attr of attrs) {
    const name = attr.getNameNode().getText();
    const init = attr.getInitializer();
    if (!init) continue;
    // JsxAttribute initializer is either a StringLiteral or a JsxExpression;
    // we only handle StringLiteral here — anything dynamic is ignored.
    if (init.getKind() !== SyntaxKind.StringLiteral) continue;
    const raw = init.getText();
    const literal = raw.slice(1, -1);
    if (name === "role") keys.add(`[role="${literal}"]`);
    else if (name === "id") keys.add(`#${literal}`);
    else if (name === "className") {
      for (const cls of literal.split(/\s+/).filter(Boolean)) {
        keys.add(`.${cls}`);
      }
    } else if (name.startsWith("data-")) {
      keys.add(`[${name}="${literal}"]`);
    }
  }
  return [...keys];
}

/**
 * Pull `prop: "var(--token)"` pairs out of a literal style object. Any
 * property whose value isn't a bare-var string is skipped — composite
 * values (`"1px solid var(--c)"`) aren't a token binding for our purposes
 * since the engines can't rewrite half a declaration.
 */
function extractTokensFromStyleObject(
  obj: ObjectLiteralExpression,
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const prop of obj.getProperties()) {
    if (prop.getKind() !== SyntaxKind.PropertyAssignment) continue;
    const pa = prop as PropertyAssignment;
    const nameNode = pa.getNameNode();
    const initializer = pa.getInitializer();
    if (!initializer) continue;
    if (initializer.getKind() !== SyntaxKind.StringLiteral) continue;
    const raw = initializer.getText();
    const value = raw.slice(1, -1);
    const cssProp = camelToDash(nameNode.getText().replace(/['"]/g, ""));

    // Path 1: bare-var value (`"var(--x)"`) — full-value token binding.
    const bareToken = extractBareVarToken(value);
    if (bareToken) {
      for (const pair of expandDeclShared(cssProp, bareToken)) out.push(pair);
      continue;
    }
    // Path 2: composite (`"1px solid var(--x)"`) — extract the
    // side-color longhand when the prop is a border shorthand.
    for (const pair of compositeBorderTokens(cssProp, value)) out.push(pair);
  }
  return out;
}

/**
 * A "literal class expression" is a string literal, a no-substitution template
 * literal, or an array of those (nested arrays allowed — cva's base is
 * conventionally an array of grouped lines). Returns the joined class list, or
 * `null` the moment anything non-literal appears.
 *
 * Returning null is load-bearing: a slot built from a variable or a call could
 * contain a class that overrides one we *did* read, so a partial read risks
 * attributing a token the component doesn't actually apply.
 */
function literalClassList(node: Node | undefined): string | null {
  if (!node) return null;
  const kind = node.getKind();
  if (kind === SyntaxKind.StringLiteral) {
    return node.getText().slice(1, -1);
  }
  if (kind === SyntaxKind.NoSubstitutionTemplateLiteral) {
    return node.getText().slice(1, -1);
  }
  if (kind === SyntaxKind.ArrayLiteralExpression) {
    const parts: string[] = [];
    for (const element of (node as ArrayLiteralExpression).getElements()) {
      const part = literalClassList(element);
      if (part === null) return null;
      parts.push(part);
    }
    return parts.join(" ");
  }
  return null;
}

/** Read a property off an object literal, or undefined when absent. */
function prop(obj: ObjectLiteralExpression, name: string): Expression | undefined {
  const found = obj.getProperty(name);
  if (!found || found.getKind() !== SyntaxKind.PropertyAssignment) return undefined;
  return (found as PropertyAssignment).getInitializer();
}

/** Object-literal key text with quotes stripped (`"data-x"` → `data-x`). */
function propertyName(assignment: PropertyAssignment): string {
  return assignment.getNameNode().getText().replace(/^['"`]|['"`]$/g, "");
}

function objectProperties(obj: ObjectLiteralExpression): PropertyAssignment[] {
  return obj
    .getProperties()
    .filter((p): p is PropertyAssignment => p.getKind() === SyntaxKind.PropertyAssignment);
}

/**
 * Extract the `variants` axes in declaration order. Order matters: cva
 * concatenates the slots in this order and `cn()` / tailwind-merge resolves
 * last-wins, so it is the real precedence.
 */
function readAxes(variants: ObjectLiteralExpression): TailwindVariantAxis[] | null {
  const axes: TailwindVariantAxis[] = [];
  for (const axisAssignment of objectProperties(variants)) {
    const axisName = propertyName(axisAssignment);
    const init = axisAssignment.getInitializer();
    if (!init || init.getKind() !== SyntaxKind.ObjectLiteralExpression) return null;
    const values: Record<string, string> = {};
    for (const valueAssignment of objectProperties(init as ObjectLiteralExpression)) {
      const classList = literalClassList(valueAssignment.getInitializer());
      if (classList === null) return null;
      values[propertyName(valueAssignment)] = classList;
    }
    axes.push({ axis: axisName, values });
  }
  return axes;
}

function readDefaultVariants(obj: ObjectLiteralExpression | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!obj) return out;
  for (const assignment of objectProperties(obj)) {
    const init = assignment.getInitializer();
    if (!init) continue;
    const kind = init.getKind();
    // String, `true`/`false`, or a number — all stringify to a cva slot key.
    if (
      kind === SyntaxKind.StringLiteral ||
      kind === SyntaxKind.NoSubstitutionTemplateLiteral
    ) {
      out[propertyName(assignment)] = init.getText().slice(1, -1);
    } else if (
      kind === SyntaxKind.TrueKeyword ||
      kind === SyntaxKind.FalseKeyword ||
      kind === SyntaxKind.NumericLiteral
    ) {
      out[propertyName(assignment)] = init.getText();
    }
    // Anything else (a variable, a call) leaves the axis without a default,
    // which `resolveComponentBindings` treats as indeterminate.
  }
  return out;
}

function readCompoundVariants(
  array: ArrayLiteralExpression,
): TailwindCompoundVariant[] | null {
  const out: TailwindCompoundVariant[] = [];
  for (const element of array.getElements()) {
    if (element.getKind() !== SyntaxKind.ObjectLiteralExpression) return null;
    const obj = element as ObjectLiteralExpression;
    const when: Record<string, string[]> = {};
    let classList: string | null = null;
    for (const assignment of objectProperties(obj)) {
      const key = propertyName(assignment);
      const init = assignment.getInitializer();
      if (key === "class" || key === "className") {
        classList = literalClassList(init);
        if (classList === null) return null;
        continue;
      }
      if (!init) return null;
      const kind = init.getKind();
      if (kind === SyntaxKind.ArrayLiteralExpression) {
        const allowed: string[] = [];
        for (const item of (init as ArrayLiteralExpression).getElements()) {
          const literal = literalOrKeyword(item);
          if (literal === null) return null;
          allowed.push(literal);
        }
        when[key] = allowed;
      } else {
        const literal = literalOrKeyword(init);
        if (literal === null) return null;
        when[key] = [literal];
      }
    }
    if (classList === null) return null;
    out.push({ when, classList });
  }
  return out;
}

/** String literal, `true`/`false`, or a number — as the string cva keys by. */
function literalOrKeyword(node: Node): string | null {
  const kind = node.getKind();
  if (kind === SyntaxKind.StringLiteral || kind === SyntaxKind.NoSubstitutionTemplateLiteral) {
    return node.getText().slice(1, -1);
  }
  if (
    kind === SyntaxKind.TrueKeyword ||
    kind === SyntaxKind.FalseKeyword ||
    kind === SyntaxKind.NumericLiteral
  ) {
    return node.getText();
  }
  return null;
}

/**
 * Walk up from a `cva()` call to the identifier it is assigned to, so the
 * component can be looked up by name (`const buttonVariants = cva(...)` →
 * `button`). Returns null for an inline call with no name to borrow.
 */
function assignedVariableName(call: CallExpression): string | null {
  const declaration = call.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
  return declaration ? declaration.getName() : null;
}

/**
 * Turn one `cva(base, config)` call into a component scan, or null when it
 * can't be read in full.
 */
function readCvaCall(call: CallExpression, file: string): TailwindComponentScan | null {
  const args = call.getArguments();
  const base = literalClassList(args[0]);
  if (base === null) return null;

  let axes: TailwindVariantAxis[] = [];
  let defaultVariants: Record<string, string> = {};
  let compoundVariants: TailwindCompoundVariant[] = [];

  const config = args[1];
  if (config) {
    if (config.getKind() !== SyntaxKind.ObjectLiteralExpression) return null;
    const configObj = config as ObjectLiteralExpression;

    const variants = prop(configObj, "variants");
    if (variants) {
      if (variants.getKind() !== SyntaxKind.ObjectLiteralExpression) return null;
      const read = readAxes(variants as ObjectLiteralExpression);
      if (read === null) return null;
      axes = read;
    }

    const defaults = prop(configObj, "defaultVariants");
    if (defaults) {
      if (defaults.getKind() !== SyntaxKind.ObjectLiteralExpression) return null;
      defaultVariants = readDefaultVariants(defaults as ObjectLiteralExpression);
    }

    const compound = prop(configObj, "compoundVariants");
    if (compound) {
      if (compound.getKind() !== SyntaxKind.ArrayLiteralExpression) return null;
      const read = readCompoundVariants(compound as ArrayLiteralExpression);
      if (read === null) return null;
      compoundVariants = read;
    }
  }

  const components = new Set<string>();
  const fileIdentity = basename(file).replace(/\.[jt]sx?$/, "").toLowerCase();
  if (fileIdentity) components.add(fileIdentity);
  const variableName = assignedVariableName(call);
  if (variableName) {
    const identity = componentIdentityFromVariableName(variableName);
    if (identity) components.add(identity);
  }

  return {
    components: [...components],
    file,
    base,
    axes,
    defaultVariants,
    compoundVariants,
  };
}

/**
 * Classify a literal `className="…"` attribute into property → token pairs.
 * Only resting-state classes contribute (see core's `composeTailwindBindings`),
 * and only classes whose token the consumer's theme can vouch for.
 */
function tailwindPairsFromClassName(
  classList: string,
  themeVars: TailwindThemeVars,
): Array<[string, string, string]> {
  const composed = composeTailwindBindings(classList, [], themeVars);
  return Object.entries(composed.bindings).map(
    ([property, binding]) =>
      [normalizeBindingKey(property), binding.token, binding.className] as [
        string,
        string,
        string,
      ],
  );
}

export async function scanTsx(
  cwd: string,
  entries: string[],
  themeVars: TailwindThemeVars = {},
): Promise<TsxScanResult> {
  const warnings: Array<{ file: string; message: string }> = [];
  const files = await glob(entries, {
    cwd,
    absolute: true,
    onlyFiles: true,
    ignore: [
      "**/node_modules/**",
      "**/dist/**",
      "**/storybook-static/**",
      "**/*.stories.tsx",
      "**/*.test.tsx",
    ],
  });

  // One Project for the whole scan so internal type/parse caches amortize.
  // We don't need type-checking — pure syntax walks are enough — so we
  // skip adding declaration files and disable diagnostics for speed.
  const project = new Project({
    useInMemoryFileSystem: false,
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    skipLoadingLibFiles: true,
    compilerOptions: { allowJs: true, jsx: 4 /* Preserve */, noResolve: true },
  });

  const map: AutoTokenMap = {};
  const components: TailwindComponentScan[] = [];
  const classHints: TsxClassHintMap = {};

  for (const file of files) {
    let sourceFile;
    try {
      sourceFile = project.addSourceFileAtPath(file);
    } catch (err) {
      warnings.push({ file, message: `Parse failed: ${(err as Error).message}` });
      continue;
    }

    // `cva()` calls — matched by callee text so both `cva(...)` and a
    // namespaced `cvaLib.cva(...)` are picked up without resolving imports
    // (the Project runs with `noResolve`, so there are no types to ask).
    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression().getText();
      if (callee !== "cva" && !callee.endsWith(".cva")) continue;
      const scan = readCvaCall(call, file);
      if (!scan) {
        warnings.push({
          file,
          message:
            `Skipped a cva() call at line ${call.getStartLineNumber()}: it contains a ` +
            `non-literal class expression, so the class list can't be read in full. ` +
            `An unread slot could override a class that was read, so no bindings are ` +
            `derived for it rather than risk attributing the wrong token.`,
        });
        continue;
      }
      components.push(scan);
    }

    // JsxSelfClosingElement OR JsxOpeningElement both carry attributes;
    // walk both. The descendant walk is exhaustive — any nested element
    // anywhere in the file with a literal style attribute or a literal
    // className will be picked up.
    const elements = [
      ...sourceFile.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
      ...sourceFile.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
    ];

    for (const el of elements) {
      const attrs = el.getAttributes().filter((a): a is JsxAttribute =>
        a.getKind() === SyntaxKind.JsxAttribute,
      );

      // `prop: token` pairs from this element, plus the utility class that
      // produced each one (inline styles have no class, hence the `?`).
      const pairs: Array<[string, string, string?]> = [];

      const styleAttr = attrs.find((a) => a.getNameNode().getText() === "style");
      if (styleAttr) {
        const init = styleAttr.getInitializer();
        if (init && init.getKind() === SyntaxKind.JsxExpression) {
          const expr = (init as { getExpression?: () => unknown }).getExpression?.();
          if (expr && typeof expr === "object") {
            const exprNode = expr as { getKind: () => SyntaxKind };
            if (exprNode.getKind() === SyntaxKind.ObjectLiteralExpression) {
              for (const pair of extractTokensFromStyleObject(
                expr as ObjectLiteralExpression,
              )) {
                pairs.push(pair);
              }
            }
          }
        }
      }

      // Literal `className="p-4 bg-card"` — the non-cva Tailwind path. A
      // `className={expr}` initializer is skipped: same reason cva calls with
      // non-literal slots are skipped.
      const classAttr = attrs.find((a) => a.getNameNode().getText() === "className");
      const classInit = classAttr?.getInitializer();
      if (classInit && classInit.getKind() === SyntaxKind.StringLiteral) {
        const classList = classInit.getText().slice(1, -1);
        for (const [prop, token, cls] of tailwindPairsFromClassName(classList, themeVars)) {
          pairs.push([prop, token, cls]);
        }
      }

      if (pairs.length === 0) continue;

      const selectorKeys = selectorKeysFromAttrs(attrs);
      if (selectorKeys.length === 0) continue;

      for (const key of selectorKeys) {
        const bucket = map[key] ?? (map[key] = {});
        for (const [prop, token, cls] of pairs) {
          bucket[prop] = token;
          if (cls) {
            const hints = classHints[key] ?? (classHints[key] = {});
            hints[prop] = cls;
          }
        }
      }
    }

    // Drop the source file from the project to keep memory bounded — we
    // don't revisit files in a single scan pass.
    project.removeSourceFile(sourceFile);
  }

  return {
    map,
    warnings,
    scannedFiles: files.map((f) => resolve(f)),
    components,
    classHints,
  };
}
