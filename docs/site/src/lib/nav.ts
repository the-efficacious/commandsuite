import { getCollection } from 'astro:content';

export interface NavEntry {
  slug: string;
  title: string;
  order: number;
  section: string;
  description?: string;
}

export interface NavSection {
  name: string;
  entries: NavEntry[];
}

export async function getDocsNav(): Promise<NavSection[]> {
  const entries = await getCollection('docs', ({ data }) => !data.draft);

  const flat: NavEntry[] = entries.map((entry) => ({
    slug: entry.id,
    title: entry.data.title,
    order: entry.data.order,
    section: entry.data.section,
    description: entry.data.description,
  }));

  const bySection = new Map<string, NavEntry[]>();
  for (const entry of flat) {
    const bucket = bySection.get(entry.section) ?? [];
    bucket.push(entry);
    bySection.set(entry.section, bucket);
  }

  const sectionOrder = ['Docs', 'Concepts', 'Guides', 'Reference'];
  const sortedSections: NavSection[] = [];

  for (const name of sectionOrder) {
    const bucket = bySection.get(name);
    if (bucket) {
      sortedSections.push({ name, entries: bucket.sort((a, b) => a.order - b.order) });
      bySection.delete(name);
    }
  }
  for (const [name, bucket] of bySection) {
    sortedSections.push({ name, entries: bucket.sort((a, b) => a.order - b.order) });
  }

  return sortedSections;
}

export function flattenNav(sections: NavSection[]): NavEntry[] {
  return sections.flatMap((s) => s.entries);
}

export function findAdjacent(entries: NavEntry[], currentSlug: string) {
  const idx = entries.findIndex((e) => e.slug === currentSlug);
  return {
    prev: idx > 0 ? entries[idx - 1] : null,
    next: idx >= 0 && idx < entries.length - 1 ? entries[idx + 1] : null,
  };
}
