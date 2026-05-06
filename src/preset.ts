import { registerServerChannel } from "./server.js";

/**
 * Storybook 10 preset. Manager + preview entries are auto-discovered from
 * the package's `./manager` and `./preview` exports — registering them
 * here too causes the addon to be loaded twice (warning in the manager,
 * duplicate declarations in the preview, infinite spinner).
 *
 * This preset only wires the Node-side server channel.
 */

interface ChannelLike {
  on(event: string, handler: (...args: unknown[]) => void): void;
  emit(event: string, ...args: unknown[]): void;
}

export const experimental_serverChannel = async (
  channel: ChannelLike,
): Promise<ChannelLike> => {
  return registerServerChannel(channel);
};
