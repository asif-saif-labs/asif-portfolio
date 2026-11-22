import rss from "@astrojs/rss";
import { getPosts } from "../lib";
import { profile } from "../data/profile";

export async function GET(context) {
  const posts = await getPosts();
  return rss({
    title: `${profile.name}: DevOps notes`,
    description: profile.tagline,
    site: context.site,
    items: posts.map((p) => ({
      title: p.data.title,
      description: p.data.description,
      pubDate: p.data.date,
      link: `/blog/${p.id}/`,
      categories: p.data.tags,
    })),
  });
}
