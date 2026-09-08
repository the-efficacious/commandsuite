/**
 * One slug grammar, proved from all three surfaces (commandsuite#15,
 * #136, #171).
 *
 * Three layers used to state three rules for the same identifier, and
 * the layer that tells the AGENT what to do was the wrong one: the
 * `variables_create` tool description said "max 64", the wire refused
 * anything over 32, and the variables store accepted 64 plus
 * `git--token` and `git-token-` that the wire rejects. The store check
 * could never fire — the schema runs first on every HTTP request — so
 * nothing failed, and an agent that believed its own tool schema got a
 * raw zod dump back with no way to learn the real rule.
 *
 * The grammar now lives once, in `csuite-sdk/protocol`, and this file
 * asserts the SAME two boundary cases (32 accepted, 33 rejected) at
 * each surface in turn — the store, the schema, the tool — plus the
 * three shapes that used to diverge. It is a shared-definition test,
 * not three coincidences: if any layer grew its own copy again, one of
 * these rows would disagree.
 *
 * This file lives in `packages/cli` because it is the only package that
 * can import all three at once: `csuite-core` (the store validators),
 * `csuite-sdk` (the wire schemas) and the MCP toolbox.
 */

import {
  ChannelsError,
  SecretsError,
  ToolSourcesError,
  validateSlug,
  validateSourceSlug,
  validateVariableSlug,
} from 'csuite-core';
import { SLUG_MAX_LENGTH } from 'csuite-sdk/protocol';
import {
  ChannelSlugSchema,
  CreateVariableRequestSchema,
  NotificationSlugSchema,
  SecretSlugSchema,
  ToolSourceSlugSchema,
} from 'csuite-sdk/schemas';
import type { InstructionsResponse } from 'csuite-sdk/types';
import { describe, expect, it } from 'vitest';
import { defineTools } from '../../src/runtime/tools.js';

/** The published bound, read from the one place that states it. */
const MAX = SLUG_MAX_LENGTH;
const AT_MAX = 'a'.repeat(MAX);
const OVER_MAX = 'a'.repeat(MAX + 1);

/** The three shapes the lenient variables copy used to let through. */
const MALFORMED = ['git--token', 'git-token-', '-git-token'] as const;

// ── Surface 1: the store ────────────────────────────────────────────

/** Every server-side validator, with the error class each one owns. */
const STORE_VALIDATORS = {
  'channels.validateSlug': { fn: validateSlug, error: ChannelsError },
  'tool-sources.validateSourceSlug': { fn: validateSourceSlug, error: ToolSourcesError },
  'variables.validateVariableSlug': { fn: validateVariableSlug, error: SecretsError },
} as const;

function storeAccepts(fn: (slug: string) => void, slug: string): boolean {
  try {
    fn(slug);
    return true;
  } catch {
    return false;
  }
}

// ── Surface 2: the wire schema ──────────────────────────────────────

/** Every published slug schema, including the one variables uses. */
const WIRE_SCHEMAS = {
  ChannelSlugSchema: (slug: string) => ChannelSlugSchema.safeParse(slug).success,
  ToolSourceSlugSchema: (slug: string) => ToolSourceSlugSchema.safeParse(slug).success,
  SecretSlugSchema: (slug: string) => SecretSlugSchema.safeParse(slug).success,
  NotificationSlugSchema: (slug: string) => NotificationSlugSchema.safeParse(slug).success,
  CreateVariableRequestSchema: (slug: string) =>
    CreateVariableRequestSchema.safeParse({ slug, envName: 'GIT_AUTHOR_NAME' }).success,
} as const;

// ── Surface 3: the agent-facing tool text ───────────────────────────

const ADMIN_PACKET: InstructionsResponse = {
  name: 'scout',
  role: { title: 'engineer', description: '' },
  // Every gate that puts a `slug` argument on a tool.
  permissions: ['secrets.manage', 'tools.manage', 'notifications.manage'],
  instructions: '',
  team: { name: 'demo', context: '', permissionPresets: {} },
  teammates: [],
  openObjectives: [],
  toolSources: [],
  teamProcess: null,
};

/** Every `slug` argument description an agent can read, by tool name. */
function slugDescriptions(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tool of defineTools(ADMIN_PACKET)) {
    const props = (tool.inputSchema as { properties?: Record<string, { description?: string }> })
      .properties;
    const desc = props?.slug?.description;
    if (typeof desc === 'string') out[tool.name] = desc;
  }
  return out;
}

describe('the slug grammar is one definition, not three', () => {
  it(`the store accepts a ${MAX}-character slug and rejects ${MAX + 1}`, () => {
    for (const [name, { fn, error }] of Object.entries(STORE_VALIDATORS)) {
      expect(storeAccepts(fn, AT_MAX), `${name} rejected ${MAX} characters`).toBe(true);
      expect(storeAccepts(fn, OVER_MAX), `${name} accepted ${MAX + 1} characters`).toBe(false);
      // …and it is still this store's own error class, not a foreign one.
      expect(() => fn(OVER_MAX), `${name} threw the wrong class`).toThrow(error);
      expect(() => fn(OVER_MAX)).toThrow(new RegExp(`max ${MAX}`));
    }
  });

  it(`the schema accepts a ${MAX}-character slug and rejects ${MAX + 1}`, () => {
    for (const [name, accepts] of Object.entries(WIRE_SCHEMAS)) {
      expect(accepts(AT_MAX), `${name} rejected ${MAX} characters`).toBe(true);
      expect(accepts(OVER_MAX), `${name} accepted ${MAX + 1} characters`).toBe(false);
    }
  });

  it(`the tool text states max ${MAX} on every slug argument, and never 64`, () => {
    const descriptions = slugDescriptions();
    // Only the five create tools state a grammar; the rest address an
    // existing record ("The secret slug.") and state none. Pin both
    // sets, so a create tool that stops stating the rule — or a lookup
    // tool that starts inventing one — fails here.
    const stating = Object.entries(descriptions)
      .filter(([, d]) => d.includes('Lowercase'))
      .map(([name]) => name)
      .sort();
    expect(stating).toEqual([
      'notifications_create',
      'notifications_profile_create',
      'secrets_create',
      'tool_sources_create',
      'variables_create',
    ]);
    for (const tool of stating) {
      const description = descriptions[tool] as string;
      expect(description, `${tool} does not state the bound`).toContain(`max ${MAX}`);
      expect(description, `${tool} omits the dash rule`).toContain('no consecutive dashes');
    }
    // No slug argument anywhere still advertises the old 64.
    for (const [tool, description] of Object.entries(descriptions)) {
      expect(description, `${tool} still advertises the old 64`).not.toContain('64');
    }
    // The two sibling registries said the same thing in two ways; they
    // are one string now.
    expect(descriptions.variables_create).toBe(descriptions.secrets_create);
  });

  it('store and schema agree on every case, including the three that used to diverge', () => {
    const cases = [AT_MAX, OVER_MAX, 'a', 'git-token', '', ...MALFORMED];
    for (const slug of cases) {
      const storeAnswers = Object.entries(STORE_VALIDATORS).map(
        ([name, { fn }]) => [name, storeAccepts(fn, slug)] as const,
      );
      const wireAnswers = Object.entries(WIRE_SCHEMAS).map(
        ([name, accepts]) => [name, accepts(slug)] as const,
      );
      const answers = [...storeAnswers, ...wireAnswers];
      const expected = answers[0]?.[1];
      // Every surface, one verdict per slug.
      expect(Object.fromEntries(answers), `surfaces disagree on '${slug}'`).toEqual(
        Object.fromEntries(answers.map(([name]) => [name, expected])),
      );
    }
  });

  it('rejects the malformed shapes the variables store used to accept', () => {
    for (const slug of MALFORMED) {
      expect(storeAccepts(validateVariableSlug, slug), `${slug} still accepted`).toBe(false);
    }
  });
});
