import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  site: "https://asif.aslabs.co.in",
  integrations: [sitemap()],
  markdown: {
    // Light and dark code themes; global.css picks one to match the site theme.
    shikiConfig: {
      themes: { light: "github-light", dark: "github-dark-dimmed" },
      defaultColor: false,
      wrap: false,
    },
  },
});
