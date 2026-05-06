import type { StorybookConfig } from "storybook";

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.@(ts|tsx|js|jsx|mdx)"],
  addons: [
    // Register the design-sync addon. The addon ships a preset that wires
    // up the manager panel, preview snapshot hook, and server channel.
    "@metalab/storybook-design-sync",
  ],
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
};

export default config;
