import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
// Re-exported `z` from `astro:content` is deprecated in Astro 7.
import { z } from 'astro/zod';

/**
 * Content is the sibling `docs/` tree — this app lives at `docs/site`, so
 * the collection reads its own parent. There is no sync step: the docs and
 * the site that renders them are the same checkout.
 *
 * `!site/**` excludes this app from its own content glob. Only `.mdx` is
 * picked up, so plain `.md` under `docs/` (internal notes such as
 * `docs/audit/`, which carry no frontmatter) stays out — unchanged
 * behaviour, previously a property of the sync script.
 */
const docs = defineCollection({
  loader: glob({
    pattern: ['**/*.mdx', '!site/**'],
    base: '..',
  }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    order: z.number().default(100),
    section: z.string().default('Docs'),
    draft: z.boolean().default(false),
  }),
});

export const collections = { docs };
