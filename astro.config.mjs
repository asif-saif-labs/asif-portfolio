import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  site: "https://asif.aslabs.co.in",
  integrations: [sitemap()],
  markdown: {
    shikiConfig: { theme: "github-dark-dimmed", wrap: false },
  },
});
