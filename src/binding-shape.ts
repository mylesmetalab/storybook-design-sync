/**
 * Binding shape — re-export shim.
 *
 * These tables (which shorthand expands to which longhands, which key a
 * binding is filed under, how to pull a token out of a composite value) used
 * to live here. They moved to `@metalab/design-sync-core` in core v0.0.2
 * because the Tailwind utility mapper needs the same tables, and duplicating
 * them is the exact bug class this file was written to prevent: three scanners
 * disagreeing about a property key means the drift report's cross-section
 * comparisons fail *silently*.
 *
 * The file stays as a shim so every existing `./binding-shape.js` import in
 * this package keeps resolving, and so there is one obvious place to look when
 * asking "where does the shorthand table live". Edit it in core.
 *
 * Consumers of the shape:
 *   - `scan-css.ts`  — PostCSS scanner of consumer `.css` files (Node, build-time)
 *   - `scan-tsx.ts`  — ts-morph scanner of consumer `.tsx` files (Node, build-time)
 *   - `preview.ts`   — DOM scanner of the rendered story (browser, runtime)
 *   - core's `tailwind.ts` — utility class → token
 */

export {
  SHORTHAND_EXPANSIONS,
  INLINE_BINDING_KEY,
  expandDecl,
  normalizeBindingKey,
  compositeBorderTokens,
  extractBareVarToken,
} from "@metalab/design-sync-core";
