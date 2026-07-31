import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { normalizeTokenName } from "@metalab/design-sync-core";

/**
 * `contracts/<component>.spec.json` — read at **tool** time (issue #71).
 *
 * The contract is written by the `component-handoff` skill and, until now, was
 * read by agents and by no tool: the project notes described it as documentation,
 * not enforcement. #71 is the first case where reading it would have prevented a
 * wrong change, so this module reads exactly that much of it and no more.
 *
 * The case: one token drives two places in a component, and the comparison reaches
 * only one of them. `Space/400` is claimed by both `body`'s `gap` and `actions`'s
 * `gap` on the SDS Card, but `[data-slot=actions]` is absent from the registry
 * (Button Group is its own component set), so the comparison never sees it. Move
 * `Space/400` in Figma and the report shows **one** row. Fix that row and the two
 * consumers sit at different values for a token the contract says is one decision —
 * and the report calls that complete. The relationship is discoverable only here.
 *
 * Scope discipline, deliberately narrow:
 *  - **Read-only, and never a verdict.** Nothing here can create, suppress or
 *    re-status a drift row. It adds a sentence to a prompt about consumers the
 *    comparison could not reach. A contract that disagrees with the report is not
 *    grounds for the tool to overrule either side — the contract is validated by
 *    nothing, which is exactly why it may inform a human and not decide.
 *  - **Absent is normal.** Most consumers have no `contracts/` directory. No
 *    contract, no bullet, no warning.
 *  - **Malformed is silent-but-safe.** A spec that doesn't parse yields no
 *    bindings rather than an error: a broken sidecar must not break a drift check.
 *
 * ## Why the reader is shape-agnostic
 *
 * The two specs in existence group `tokenBindings` differently. The Card's is flat
 * (`tokenBindings.<slot>.<property>`); the starter's Button nests by axis
 * (`tokenBindings.shared.*`, `tokenBindings.bySize.small.*`,
 * `tokenBindings.byVariantAndState["neutral.default"].*`) and spells properties in
 * camelCase. Since the file is written by a skill and validated by nothing, a
 * reader that assumed one shape would silently see nothing on the other — the same
 * failure as reading nothing at all, minus the honesty. So it walks to any depth
 * and collects every leaf that names a `figmaToken`, recording the path it came
 * from as the binding's **scope**.
 */

/** One leaf of `tokenBindings` that names a Figma token. */
export interface ContractSlotBinding {
  /**
   * Where in `tokenBindings` it sits: a slot name (`body`, `actions`) in the flat
   * shape, an axis path (`shared`, `bySize.small`) in the nested one. Quoted to the
   * reader as-is — the contract's vocabulary is the human's vocabulary here.
   */
  scope: string;
  /** CSS spelling of the property (`background-color`), for comparison with rows. */
  property: string;
  /** Exactly as the contract spells it (`backgroundColor`), for quoting back. */
  declaredAs: string;
  figmaToken: string;
  figmaValue?: string | undefined;
  utility?: string | undefined;
}

export interface ComponentContract {
  /** Consumer-relative path, so a prompt can cite its source. */
  path: string;
  bindings: readonly ContractSlotBinding[];
}

/** One other consumer of the same Figma token (see `fix-prompt.ts`). */
export interface ContractSibling {
  /** The contract's scope for it (`actions`, `bySize.small`). */
  slot: string;
  property: string;
  utility?: string | undefined;
  /** Whether a row in THIS report covered it. */
  compared: boolean;
}

/** What a prompt says about a token the contract shares between consumers. */
export interface ContractReference {
  path: string;
  figmaToken: string;
  /** Other consumers of the token. Never includes the row's own. */
  siblings: readonly ContractSibling[];
}

/** Keys that group rather than name a property. Their children are scopes. */
const MAX_DEPTH = 4;

/**
 * Parse the slice of a spec this module uses: every leaf under `tokenBindings` that
 * names a `figmaToken`. Everything else the contract records (`variants`, `slots`,
 * `variantNodeIds`, `notInFigma`) is deliberately ignored — reading a field here
 * would imply the tool acts on it.
 *
 * Tolerant by design. `figmaToken: null` is a deliberate contract statement ("this
 * property has no design source"), not a token, and is skipped; a `$comment` is
 * prose; an entry that isn't the shape we expect is skipped rather than fatal. The
 * spec is hand-adjacent and a drift check must not fail over one bad entry.
 */
export function parseContract(path: string, raw: unknown): ComponentContract {
  const bindings: ContractSlotBinding[] = [];
  const tokenBindings = isRecord(raw) ? raw["tokenBindings"] : undefined;
  if (isRecord(tokenBindings)) walk(tokenBindings, [], bindings, 0);
  return { path, bindings };
}

function walk(
  node: Record<string, unknown>,
  path: string[],
  out: ContractSlotBinding[],
  depth: number,
): void {
  if (depth > MAX_DEPTH) return;
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith("$")) continue;
    if (!isRecord(value)) continue;
    const token = value["figmaToken"];
    if (typeof token === "string" && token.trim() !== "") {
      // A leaf: `key` is the property, `path` is the scope it sits under.
      const figmaValue = value["figmaValue"];
      const utility = value["utility"];
      out.push({
        scope: path.length > 0 ? path.join(".") : key,
        property: cssProperty(key),
        declaredAs: key,
        figmaToken: token.trim(),
        ...(typeof figmaValue === "string" ? { figmaValue } : {}),
        ...(typeof utility === "string" ? { utility } : {}),
      });
      continue;
    }
    // `figmaToken: null` is the contract saying "no design source" — a statement,
    // not a token. Not a leaf to recurse into either.
    if ("figmaToken" in value) continue;
    walk(value, [...path, key], out, depth + 1);
  }
}

/** `backgroundColor` → `background-color`. Already-hyphenated names pass through. */
export function cssProperty(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/**
 * The slot a CSS selector refers to, when the selector names one.
 *
 * `[data-slot=title]` → `title`. Only the `data-slot` convention is recognised,
 * because it is the only one that carries the slot's *name* — a class or tag
 * selector would need a guess to map onto the contract's vocabulary, and a wrong
 * mapping would attribute one slot's token to another.
 */
export function slotFromSelector(selector: string | undefined): string | undefined {
  if (!selector) return undefined;
  const matches = [...selector.matchAll(/\[data-slot\s*=\s*["']?([\w-]+)["']?\]/g)];
  const last = matches[matches.length - 1];
  return last?.[1];
}

/**
 * The contract's record of what else a token drives, from one row's point of view.
 *
 * Identifying **the row's own entry** is the delicate part, because getting it wrong
 * tells an agent to also change the thing it is already changing. Two cases:
 *
 *  - The row's selector names a slot (`[data-slot=body]`) and the contract uses slot
 *    scopes: the row's entry is (that slot, that property), and any other scope
 *    holding the same property is a genuine sibling — the Card case.
 *  - The row's scope cannot be established (no `data-slot`, or a contract scoped by
 *    variant axis rather than slot): then **every** entry for this property might be
 *    the row's own, so all of them are excluded and only entries for a *different*
 *    property are reported. Under-reporting here is the safe direction; naming the
 *    row's own binding as its sibling is not.
 *
 * Returns null whenever that leaves nothing true to say.
 */
export function contractReferenceFor(
  contract: ComponentContract | undefined,
  opts: {
    figmaToken: string | undefined;
    /** The row's property, in CSS spelling. */
    property: string;
    /** The row's selector (root or child) — used to identify its scope. */
    selector: string | undefined;
    /** Selectors the report actually compared, so a sibling can be marked. */
    comparedSelectors: readonly string[];
  },
): ContractReference | null {
  if (!contract || contract.bindings.length === 0) return null;
  if (!opts.figmaToken || opts.figmaToken.trim() === "") return null;

  const forToken = bindingsForToken(contract.bindings, opts.figmaToken);
  if (forToken.length === 0) return null;

  const ownSlot = slotFromSelector(opts.selector);
  const scopeIsKnown = !!ownSlot && forToken.some((b) => b.scope === ownSlot);
  const isOwn = (b: ContractSlotBinding): boolean =>
    scopeIsKnown
      ? b.scope === ownSlot && b.property === opts.property
      : b.property === opts.property;

  const comparedSlots = new Set(
    opts.comparedSelectors.map((s) => slotFromSelector(s)).filter((s): s is string => !!s),
  );
  const siblings = forToken
    .filter((b) => !isOwn(b))
    .map(
      (b): ContractSibling => ({
        slot: b.scope,
        property: b.declaredAs,
        ...(b.utility !== undefined ? { utility: b.utility } : {}),
        compared: comparedSlots.has(b.scope),
      }),
    );
  if (siblings.length === 0) return null;
  return { path: contract.path, figmaToken: opts.figmaToken, siblings };
}

/**
 * The contract entries that name the same Figma token as a report row.
 *
 * Exact normalized equality first — `Space/400` ≡ `space-400`, the `normalizeTokenName`
 * the rest of the addon uses. Then **one** extra step, because without it the feature
 * did not fire on the only real consumer: the contract records a variable
 * collection-qualified (`size/space/200`, as `component-handoff` extracted it) while
 * the drift report carries the variable's own name (`Space/200`). The two are the same
 * token under a longer and a shorter path.
 *
 * So a path-suffix match is accepted, on a **segment boundary** and only when it is
 * **unambiguous**: if two different contract tokens both suffix-match, the addon
 * cannot tell which the row means and says nothing rather than guessing — a wrong
 * pairing here would tell an agent to change a slot bound to a different decision,
 * which is the "two variables must never map to one token" hazard in miniature.
 */
function bindingsForToken(
  bindings: readonly ContractSlotBinding[],
  figmaToken: string,
): ContractSlotBinding[] {
  const wanted = normalizeTokenName(figmaToken);
  const exact = bindings.filter((b) => normalizeTokenName(b.figmaToken) === wanted);
  if (exact.length > 0) return exact;

  const suffixMatches = bindings.filter((b) => {
    const declared = normalizeTokenName(b.figmaToken);
    return declared.endsWith(`-${wanted}`) || wanted.endsWith(`-${declared}`);
  });
  const distinct = new Set(suffixMatches.map((b) => normalizeTokenName(b.figmaToken)));
  return distinct.size === 1 ? suffixMatches : [];
}

/**
 * Load `contracts/<component>.spec.json`, or null when there isn't one.
 *
 * Never throws: a missing directory is the normal case, and a spec that fails to
 * read or parse must not take a drift check down with it.
 */
export async function loadComponentContract(
  cwd: string,
  component: string,
): Promise<ComponentContract | null> {
  const relative = `contracts/${component}.spec.json`;
  try {
    const raw = await readFile(resolve(cwd, relative), "utf8");
    const contract = parseContract(relative, JSON.parse(raw));
    return contract.bindings.length > 0 ? contract : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
