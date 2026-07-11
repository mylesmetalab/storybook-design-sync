import { Project, SyntaxKind } from "ts-morph";
import type { JsxAttribute, ObjectLiteralExpression, PropertyAssignment } from "ts-morph";
import { glob } from "tinyglobby";
import { resolve } from "node:path";
import type { AutoTokenMap } from "./scan-css.js";
import {
  expandDecl as expandDeclShared,
  compositeBorderTokens,
  extractBareVarToken,
} from "./binding-shape.js";

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
 */

export interface TsxScanResult {
  map: AutoTokenMap;
  warnings: Array<{ file: string; message: string }>;
  scannedFiles: string[];
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

export async function scanTsx(
  cwd: string,
  entries: string[],
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

  for (const file of files) {
    let sourceFile;
    try {
      sourceFile = project.addSourceFileAtPath(file);
    } catch (err) {
      warnings.push({ file, message: `Parse failed: ${(err as Error).message}` });
      continue;
    }

    // JsxSelfClosingElement OR JsxOpeningElement both carry attributes;
    // walk both. The descendant walk is exhaustive — any nested element
    // anywhere in the file with a literal style attribute will be picked up.
    const elements = [
      ...sourceFile.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
      ...sourceFile.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
    ];

    for (const el of elements) {
      const attrs = el.getAttributes().filter((a): a is JsxAttribute =>
        a.getKind() === SyntaxKind.JsxAttribute,
      );
      const styleAttr = attrs.find((a) => a.getNameNode().getText() === "style");
      if (!styleAttr) continue;

      const init = styleAttr.getInitializer();
      if (!init || init.getKind() !== SyntaxKind.JsxExpression) continue;
      const expr = (init as { getExpression?: () => unknown }).getExpression?.();
      if (!expr || typeof expr !== "object") continue;
      const exprNode = expr as { getKind: () => SyntaxKind };
      if (exprNode.getKind() !== SyntaxKind.ObjectLiteralExpression) continue;

      const pairs = extractTokensFromStyleObject(expr as ObjectLiteralExpression);
      if (pairs.length === 0) continue;

      const selectorKeys = selectorKeysFromAttrs(attrs);
      if (selectorKeys.length === 0) continue;

      for (const key of selectorKeys) {
        const bucket = map[key] ?? (map[key] = {});
        for (const [prop, token] of pairs) bucket[prop] = token;
      }
    }

    // Drop the source file from the project to keep memory bounded — we
    // don't revisit files in a single scan pass.
    project.removeSourceFile(sourceFile);
  }

  return { map, warnings, scannedFiles: files.map((f) => resolve(f)) };
}
