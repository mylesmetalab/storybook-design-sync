/**
 * Storybook's own channel event names, as string literals.
 *
 * Deliberately NOT imported from `storybook/internal/core-events`: this module is
 * read by the manager bundle (browser), the CLI (Node), and — via
 * `headless-bridge.ts` — by code that is stringified and evaluated inside a page
 * with no module system at all. A literal that all three share is the only thing
 * that satisfies every one of those, and the values are part of Storybook's
 * documented channel protocol rather than an internal detail.
 *
 * `manager.tsx` used to declare `STORY_RENDERED_EVENT` locally. It now imports
 * from here, so the bulk loop in the panel and the bulk loop in `design-sync
 * check` wait on the same event name by construction.
 */

/** Preview → everyone: the story with this id finished rendering. */
export const STORY_RENDERED = "storyRendered";
/**
 * Preview → everyone: `{ id, parameters, initialArgs, argTypes, args }`.
 *
 * This is the event whose payload the manager stores on its index entry, and
 * therefore what `api.getData(storyId)` returns — the reader `check-request.ts`
 * builds a request from. The headless check reads the same event for the same
 * reason.
 */
export const STORY_PREPARED = "storyPrepared";
/** Manager → preview: render this story. What `api.selectStory` ends up emitting. */
export const SET_CURRENT_STORY = "setCurrentStory";
/** Preview → everyone: the requested story id is not in the index. */
export const STORY_MISSING = "storyMissing";
/** Preview → everyone: the story failed to render. */
export const STORY_ERRORED = "storyErrored";
/** Preview → everyone: the story threw while rendering. */
export const STORY_THREW_EXCEPTION = "storyThrewException";
/** Preview → everyone: the preview's own config failed to load. */
export const CONFIG_ERROR = "configError";
