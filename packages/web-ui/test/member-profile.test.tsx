/**
 * MemberProfile + AgentTimeline render tests.
 *
 * Covers:
 *   - Non-admin sees a profile (Overview/Objectives/Files) but no Activity tab
 *   - Admin sees the full page (header, metadata, activity, manage)
 *   - AgentTimeline renders each event kind correctly
 *   - Filter bar toggles hide/show per-kind rows
 *   - Empty state shows the "no activity" placeholder
 *
 * Real WebSocket behavior (connect / reconnect / dedup) is covered
 * at the lib level rather than through a rendered component; driving
 * a live WebSocket through jsdom is flaky.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { Client } from 'csuite-sdk/client';
import type { ActivityRow, BriefingResponse, Objective, RosterResponse } from 'csuite-sdk/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetAgentTimelineForTests,
  AgentTimeline,
  buildThread,
  parseToolName,
  prettyModel,
  simplifyToolResult,
} from '../src/components/AgentTimeline.js';
import { MemberProfile } from '../src/components/MemberProfile.js';
import { briefing } from '../src/lib/briefing.js';
import { __resetClientForTests, setClient } from '../src/lib/client.js';
import {
  __resetMemberActivityForTests,
  memberActivityLoading,
  memberActivityName,
  memberActivityRows,
} from '../src/lib/member-activity.js';
import { objectives as objectivesSignal } from '../src/lib/objectives.js';
import { roster } from '../src/lib/roster.js';

const originalFetch = globalThis.fetch;

const COMMANDER_BRIEFING: BriefingResponse = {
  name: 'director-1',
  role: { title: 'director', description: '' },
  permissions: ['members.manage'],
  team: { name: 'demo-team', directive: 'Ship it', context: '', permissionPresets: {} },
  teammates: [
    {
      name: 'director-1',
      role: { title: 'director', description: '' },
      permissions: ['members.manage'],
    },
    { name: 'engineer-1', role: { title: 'engineer', description: '' }, permissions: [] },
  ],
  openObjectives: [],
  toolSources: [],
  instructions: 'Lead the team.',
};

const OPERATOR_BRIEFING: BriefingResponse = {
  ...COMMANDER_BRIEFING,
  name: 'engineer-1',
  role: { title: 'engineer', description: '' },
  permissions: [],
};

const ROSTER: RosterResponse = {
  teammates: [
    {
      name: 'director-1',
      role: { title: 'director', description: '' },
      permissions: ['members.manage'],
    },
    { name: 'engineer-1', role: { title: 'engineer', description: '' }, permissions: [] },
  ],
  connected: [
    {
      name: 'engineer-1',
      connected: 1,
      createdAt: 1_700_000_000_000,
      lastSeen: 1_700_000_000_000,
      role: { title: 'engineer', description: '' },
    },
  ],
};

const OBJECTIVE: Objective = {
  id: 'obj-1',
  title: 'Ship the feature',
  body: '',
  outcome: 'Feature shipped',
  status: 'active',
  assignee: 'engineer-1',
  originator: 'director-1',
  watchers: [],
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_500,
  completedAt: null,
  result: null,
  blockReason: null,
  attachments: [],
};

const LLM_ROW: ActivityRow = {
  id: 1,
  memberName: 'engineer-1',
  createdAt: 1_700_000_000_500,
  event: {
    kind: 'llm_exchange',
    ts: 1_700_000_000_000,
    duration: 200,
    entry: {
      kind: 'anthropic_messages',
      startedAt: 1_700_000_000_000,
      endedAt: 1_700_000_000_200,
      request: {
        model: 'claude-sonnet-4-6',
        maxTokens: 1024,
        temperature: null,
        system: null,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
        tools: null,
      },
      response: {
        stopReason: 'end_turn',
        stopSequence: null,
        status: 200,
        messages: [{ role: 'assistant', content: [{ type: 'text', text: 'pong' }] }],
        usage: {
          inputTokens: 3,
          outputTokens: 1,
          cacheCreationInputTokens: null,
          cacheReadInputTokens: null,
        },
      },
    },
  },
};

const TOOL_ROW: ActivityRow = {
  id: 2,
  memberName: 'engineer-1',
  createdAt: 1_700_000_001_000,
  event: {
    kind: 'tool_action',
    ts: 1_700_000_000_500,
    durationMs: 12,
    agent: 'claude',
    source: 'hook',
    toolName: 'Bash',
    input: { command: 'ls -la' },
    result: 'total 0',
    isError: false,
  },
};

const OPEN_ROW: ActivityRow = {
  id: 3,
  memberName: 'engineer-1',
  createdAt: 1_700_000_002_000,
  event: { kind: 'objective_open', ts: 1_700_000_001_000, objectiveId: 'obj-1' },
};

const CLOSE_ROW: ActivityRow = {
  id: 4,
  memberName: 'engineer-1',
  createdAt: 1_700_000_003_000,
  event: {
    kind: 'objective_close',
    ts: 1_700_000_002_000,
    objectiveId: 'obj-1',
    result: 'done',
  },
};

/**
 * Minimal WebSocket stub — jsdom doesn't ship one, and the lib's
 * `startMemberActivitySubscribe` needs to construct one. Records
 * all constructions so tests can verify the URL, but never fires
 * real open/message/close events.
 */
class StubWebSocket {
  static instances: StubWebSocket[] = [];
  readonly url: string;
  readonly listeners = new Map<string, Array<(ev: Event) => void>>();
  constructor(url: string) {
    this.url = url;
    StubWebSocket.instances.push(this);
  }
  addEventListener(type: string, listener: (ev: Event) => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(listener);
    this.listeners.set(type, arr);
  }
  removeEventListener(): void {
    /* no-op */
  }
  close(): void {
    /* no-op */
  }
  send(_data: string): void {
    /* no-op */
  }
}

const originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;

beforeEach(() => {
  __resetClientForTests();
  __resetMemberActivityForTests();
  __resetAgentTimelineForTests();
  // Stub fetch so the lib's hydration call in useEffect doesn't 500
  // every test. We replay the same listAgentActivity response for
  // every call.
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify({ activity: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )) as typeof fetch;
  // Stub WebSocket — jsdom doesn't have one.
  StubWebSocket.instances = [];
  (globalThis as { WebSocket?: unknown }).WebSocket = StubWebSocket;
  roster.value = ROSTER;
  objectivesSignal.value = [OBJECTIVE];
});

afterEach(() => {
  cleanup();
  briefing.value = null;
  roster.value = null;
  objectivesSignal.value = [];
  __resetMemberActivityForTests();
  __resetAgentTimelineForTests();
  globalThis.fetch = originalFetch;
  if (originalWebSocket === undefined) {
    delete (globalThis as { WebSocket?: unknown }).WebSocket;
  } else {
    (globalThis as { WebSocket?: unknown }).WebSocket = originalWebSocket;
  }
});

describe('MemberProfile', () => {
  it('non-admins see the profile but not the Activity or Manage tabs', () => {
    briefing.value = OPERATOR_BRIEFING;
    render(<MemberProfile name="engineer-1" tab="overview" viewer="engineer-1" />);
    expect(screen.getByRole('heading', { name: /engineer-1/ })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: /activity/i })).toBeNull();
    expect(screen.queryByRole('tab', { name: /manage/i })).toBeNull();
    expect(screen.getByRole('tab', { name: /overview/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /objectives/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /files/i })).toBeTruthy();
  });

  it('shows the member header and metadata for admins', () => {
    briefing.value = COMMANDER_BRIEFING;
    memberActivityName.value = 'engineer-1';
    render(<MemberProfile name="engineer-1" tab="overview" viewer="director-1" />);
    expect(screen.getByRole('heading', { name: /engineer-1/ })).toBeTruthy();
    expect(screen.getByText('ENGINEER')).toBeTruthy();
    expect(screen.getByText(/ONLINE/)).toBeTruthy();
    expect(screen.getByRole('tab', { name: /activity/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /manage/i })).toBeTruthy();
  });

  it('shows the "DM" shortcut when viewer is not the target member', () => {
    briefing.value = COMMANDER_BRIEFING;
    render(<MemberProfile name="engineer-1" tab="overview" viewer="director-1" />);
    expect(screen.getByText(/DM engineer-1/)).toBeTruthy();
  });

  it('does NOT show the DM shortcut when viewing your own profile', () => {
    briefing.value = COMMANDER_BRIEFING;
    render(<MemberProfile name="director-1" tab="overview" viewer="director-1" />);
    expect(screen.queryByText(/DM director-1/)).toBeNull();
  });

  it('switches to the objectives tab when that tab is active', () => {
    briefing.value = COMMANDER_BRIEFING;
    render(<MemberProfile name="engineer-1" tab="objectives" viewer="director-1" />);
    expect(screen.getByText(/Ship the feature/)).toBeTruthy();
  });
});

describe('AgentTimeline', () => {
  it('renders each event kind with distinct affordances', () => {
    briefing.value = COMMANDER_BRIEFING;
    memberActivityRows.value = [CLOSE_ROW, OPEN_ROW, TOOL_ROW, LLM_ROW];
    memberActivityLoading.value = false;
    const { container } = render(<AgentTimeline />);

    const text = container.textContent ?? '';
    // LLM turn: pretty model name in the header, its own response text.
    expect(screen.getByText('Sonnet 4.6')).toBeTruthy();
    expect(text).toContain('pong');
    // The request prompt is NOT re-rendered — the turn tells its own
    // response only.
    expect(text).not.toContain('ping');
    // Tool action with no matching tool_use renders standalone.
    expect(text).toContain('Bash');
    // Objective open marker (▼) and close marker (▲)
    expect(text).toContain('▼');
    expect(text).toContain('▲');
    expect(text).toContain('closed (done)');
  });

  it('folds a tool result into its call card and renders MCP names as server · tool', () => {
    briefing.value = COMMANDER_BRIEFING;
    memberActivityRows.value = [
      mcpTurnRow(1, 1_700_000_000_000, 'tu_send', 'mcp__csuite__send', {
        to: 'AndrewJon',
        body: 'hi',
      }),
      toolActionRow(2, 1_700_000_000_100, 'tu_send', 'mcp__csuite__send', 'delivered to AndrewJon'),
    ];
    memberActivityLoading.value = false;
    const { container } = render(<AgentTimeline />);
    const text = container.textContent ?? '';

    // MCP name split into muted server + bold tool.
    expect(screen.getByText('csuite')).toBeTruthy();
    expect(screen.getByText('send')).toBeTruthy();
    // The result folded into the call card (✓ + text), rendered once.
    expect(text).toContain('✓');
    expect(text).toContain('delivered to AndrewJon');
    // The matched tool_action is folded, not also drawn standalone —
    // the result text appears exactly once.
    expect((text.match(/delivered to AndrewJon/g) ?? []).length).toBe(1);
  });

  it('shows the empty placeholder when no rows are loaded', () => {
    briefing.value = COMMANDER_BRIEFING;
    memberActivityRows.value = [];
    memberActivityLoading.value = false;
    render(<AgentTimeline />);
    expect(screen.getByText(/No activity yet/i)).toBeTruthy();
  });

  it('filter toggle hides and shows the matching event kind', () => {
    briefing.value = COMMANDER_BRIEFING;
    memberActivityRows.value = [LLM_ROW, TOOL_ROW];
    memberActivityLoading.value = false;
    render(<AgentTimeline />);

    // Initial state: both LLM and tools chips ship ON, so both rows
    // render.
    expect(screen.getByText('Sonnet 4.6')).toBeTruthy();
    const initialText = document.body.textContent ?? '';
    expect(initialText).toContain('Bash');

    // Click the tools chip to turn it off; the tool row hides.
    const toolsButton = screen.getByRole('button', { name: /tools/ });
    fireEvent.click(toolsButton);
    const disabledText = document.body.textContent ?? '';
    expect(disabledText).not.toContain('Bash');

    // Click again to turn it back on; the row reappears.
    fireEvent.click(toolsButton);
    const enabledText = document.body.textContent ?? '';
    expect(enabledText).toContain('Bash');
    // LLM turn stays visible regardless.
    expect(screen.getByText('Sonnet 4.6')).toBeTruthy();
  });

  it('renders a codex turn (thinking then text) with no false response-only banner', () => {
    briefing.value = COMMANDER_BRIEFING;
    memberActivityRows.value = [codexRow(1, 1_700_000_000_000, 'reasoning here', 'codex answer')];
    memberActivityLoading.value = false;
    const { container } = render(<AgentTimeline />);
    const text = container.textContent ?? '';
    // The assistant turn renders (thinking then text).
    expect(text).toContain('reasoning here');
    expect(text).toContain('codex answer');
    // No per-turn "response-only" / "prompt not replayed" banner.
    expect(text).not.toContain('prompt not replayed');
    expect(text).not.toContain('response-only');
    // Pretty model in the header.
    expect(screen.getByText('GPT-5 Codex')).toBeTruthy();
  });

  it('renders a thinking block as distinct muted reasoning, labeled apart from the answer', () => {
    briefing.value = COMMANDER_BRIEFING;
    memberActivityRows.value = [
      codexRow(1, 1_700_000_000_000, 'let me reason', 'the final answer'),
    ];
    memberActivityLoading.value = false;
    const { container } = render(<AgentTimeline />);

    // A quiet `thinking` eyebrow marks the reasoning apart from the answer.
    const labels = Array.from(container.querySelectorAll('.eyebrow')).filter(
      (el) => (el.textContent ?? '').trim() === 'thinking',
    );
    expect(labels).toHaveLength(1);

    // The reasoning renders muted + italic; the spoken answer does not.
    const pres = Array.from(container.querySelectorAll('pre'));
    const reasoningPre = pres.find((p) => (p.textContent ?? '').includes('let me reason'));
    const answerPre = pres.find((p) => (p.textContent ?? '').includes('the final answer'));
    expect(reasoningPre).toBeTruthy();
    expect(answerPre).toBeTruthy();
    expect(reasoningPre?.style.fontStyle).toBe('italic');
    expect(answerPre?.style.fontStyle).not.toBe('italic');
  });

  it('renders a user_prompt as a muted opener block', () => {
    briefing.value = COMMANDER_BRIEFING;
    memberActivityRows.value = [promptRow(1, 1_700_000_000_000, 'wake up and ship it')];
    memberActivityLoading.value = false;
    const { container } = render(<AgentTimeline />);
    expect((container.textContent ?? '').toLowerCase()).toContain('prompt');
    expect(screen.getByText('wake up and ship it')).toBeTruthy();
  });
});

/**
 * Build an `llm_exchange` ActivityRow whose response contains a single
 * `tool_use` block (an MCP-named tool) — the intent half of a call that
 * a matching `tool_action` folds its result into.
 */
function mcpTurnRow(
  id: number,
  ts: number,
  toolUseId: string,
  toolName: string,
  input: unknown,
): ActivityRow {
  return {
    id,
    memberName: 'engineer-1',
    createdAt: ts + 100,
    event: {
      kind: 'llm_exchange',
      ts,
      duration: 2699,
      entry: {
        kind: 'anthropic_messages',
        startedAt: ts,
        endedAt: ts + 2699,
        request: {
          model: 'claude-opus-4-8',
          maxTokens: 1024,
          temperature: null,
          system: null,
          messages: [],
          tools: null,
        },
        response: {
          stopReason: 'tool_use',
          stopSequence: null,
          status: 200,
          messages: [
            {
              role: 'assistant',
              content: [{ type: 'tool_use', id: toolUseId, name: toolName, input }],
            },
          ],
          usage: {
            inputTokens: 2,
            outputTokens: 98,
            cacheCreationInputTokens: null,
            cacheReadInputTokens: 29_851,
          },
        },
      },
    },
  };
}

/** A `tool_action` row — carries a `toolUseId` to fold into a matching call. */
function toolActionRow(
  id: number,
  ts: number,
  toolUseId: string,
  toolName: string,
  result: unknown,
): ActivityRow {
  return {
    id,
    memberName: 'engineer-1',
    createdAt: ts + 10,
    event: {
      kind: 'tool_action',
      ts,
      durationMs: 17,
      agent: 'claude',
      source: 'claude_hook',
      toolName,
      input: undefined,
      result,
      isError: false,
      toolUseId,
    },
  };
}

/** A `user_prompt` row — the opener that woke a turn. */
function promptRow(id: number, ts: number, text: string): ActivityRow {
  return {
    id,
    memberName: 'engineer-1',
    createdAt: ts + 1,
    event: { kind: 'user_prompt', ts, text, agent: 'claude' },
  };
}

/** Codex-shaped exchange: empty request, response with thinking then text. */
function codexRow(id: number, ts: number, thinking: string, answer: string): ActivityRow {
  return {
    id,
    memberName: 'engineer-1',
    createdAt: ts + 100,
    event: {
      kind: 'llm_exchange',
      ts,
      duration: 50,
      entry: {
        kind: 'anthropic_messages',
        startedAt: ts,
        endedAt: ts + 50,
        request: {
          model: 'gpt-5-codex',
          maxTokens: null,
          temperature: null,
          system: null,
          messages: [],
          tools: null,
        },
        response: {
          stopReason: 'end_turn',
          stopSequence: null,
          status: null,
          messages: [
            {
              role: 'assistant',
              content: [
                { type: 'thinking', text: thinking },
                { type: 'text', text: answer },
              ],
            },
          ],
          usage: {
            inputTokens: 5,
            outputTokens: 3,
            cacheCreationInputTokens: null,
            cacheReadInputTokens: null,
          },
        },
      },
    },
  };
}

describe('buildThread', () => {
  it('emits one turn per llm_exchange carrying model, usage, stop, and response', () => {
    const thread = buildThread([codexRow(1, 1_700_000_000_000, 'reasoning', 'the answer')]);
    const turns = thread.filter((i) => i.variant === 'turn');
    expect(turns).toHaveLength(1);
    const turn = turns[0];
    if (turn?.variant !== 'turn') throw new Error('expected a turn');
    expect(turn.model).toBe('gpt-5-codex');
    expect(turn.stopReason).toBe('end_turn');
    expect(turn.usage?.outputTokens).toBe(3);
    // The turn carries ONLY its response messages (request is ignored).
    const texts = turn.messages.flatMap((m) =>
      m.content.filter((b) => b.type === 'text').map((b) => (b.type === 'text' ? b.text : '')),
    );
    expect(texts).toContain('the answer');
  });

  it('folds a matching tool_action into the turn and drops it as a standalone row', () => {
    const thread = buildThread([
      mcpTurnRow(1, 1_700_000_000_000, 'tu_1', 'mcp__csuite__send', { to: 'x' }),
      toolActionRow(2, 1_700_000_000_100, 'tu_1', 'mcp__csuite__send', 'delivered'),
    ]);
    // No standalone tool-action row — the matched action is folded.
    expect(thread.some((i) => i.variant === 'tool-action')).toBe(false);
    const turn = thread.find((i) => i.variant === 'turn');
    if (turn?.variant !== 'turn') throw new Error('expected a turn');
    const fold = turn.folds.get('tu_1');
    expect(fold).toBeTruthy();
    expect(fold?.result).toBe('delivered');
    expect(fold?.isError).toBe(false);
  });

  it('keeps an unmatched tool_action as a standalone row', () => {
    const thread = buildThread([
      mcpTurnRow(1, 1_700_000_000_000, 'tu_1', 'mcp__csuite__send', { to: 'x' }),
      // toolUseId does not match any captured tool_use block.
      toolActionRow(2, 1_700_000_000_100, 'tu_orphan', 'Bash', 'total 0'),
    ]);
    const standalone = thread.filter((i) => i.variant === 'tool-action');
    expect(standalone).toHaveLength(1);
    expect(standalone[0]).toMatchObject({ variant: 'tool-action', toolName: 'Bash' });
  });

  it('emits a prompt item for a user_prompt event', () => {
    const thread = buildThread([promptRow(1, 1_700_000_000_000, 'wake up')]);
    const prompts = thread.filter((i) => i.variant === 'prompt');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ variant: 'prompt', text: 'wake up' });
  });
});

describe('prettyModel', () => {
  it('prettifies known model ids and passes unknown ids through', () => {
    expect(prettyModel('claude-opus-4-8')).toBe('Opus 4.8');
    expect(prettyModel('claude-opus-4-7')).toBe('Opus 4.7');
    expect(prettyModel('claude-sonnet-4-6')).toBe('Sonnet 4.6');
    expect(prettyModel('claude-sonnet-5')).toBe('Sonnet 5');
    expect(prettyModel('claude-haiku-4-5')).toBe('Haiku 4.5');
    expect(prettyModel('gpt-5-codex')).toBe('GPT-5 Codex');
    expect(prettyModel('gpt-5')).toBe('GPT-5');
    // Provider prefix stripped before lookup.
    expect(prettyModel('anthropic/claude-opus-4-8')).toBe('Opus 4.8');
    // Unknown id returned unchanged.
    expect(prettyModel('some-future-model-9')).toBe('some-future-model-9');
  });
});

describe('parseToolName', () => {
  it('splits mcp__server__tool and leaves plain tools bare', () => {
    expect(parseToolName('mcp__csuite__send')).toEqual({ server: 'csuite', tool: 'send' });
    expect(parseToolName('mcp__my_server__do_thing')).toEqual({
      server: 'my_server',
      tool: 'do_thing',
    });
    expect(parseToolName('Bash')).toEqual({ server: null, tool: 'Bash' });
    expect(parseToolName('Read')).toEqual({ server: null, tool: 'Read' });
  });
});

describe('simplifyToolResult', () => {
  it('unwraps an MCP text-content result to its text', () => {
    expect(simplifyToolResult([{ type: 'text', text: 'delivered to AndrewJon: live=2' }])).toBe(
      'delivered to AndrewJon: live=2',
    );
    expect(
      simplifyToolResult([
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('a\nb');
  });
  it('passes non-text-envelope results through untouched', () => {
    expect(simplifyToolResult('total 0')).toBe('total 0');
    expect(simplifyToolResult({ exitCode: 0 })).toEqual({ exitCode: 0 });
    expect(simplifyToolResult([{ type: 'image', data: 'x' }])).toEqual([
      { type: 'image', data: 'x' },
    ]);
    expect(simplifyToolResult([])).toEqual([]);
  });
});

// ─── Turn spine: joined calls, lazy bodies, ghost rows ──────────────

import type { GenAiInferenceRecord, GenAiInferenceSummary } from 'csuite-sdk/types';
import {
  __resetGenAiCallFeedForTests,
  memberGenAiCalls,
  memberGenAiCallsReady,
} from '../src/lib/genai-feed.js';
import {
  __resetGenAiRecordsForTests,
  genAiRecordState,
  loadGenAiRecord,
} from '../src/lib/genai-lazy.js';

const GENAI_RECORD: GenAiInferenceRecord = {
  id: 91,
  memberName: 'engineer-1',
  operationName: 'chat',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6', // matches LLM_ROW's request.model
  responseId: null, // LLM_ROW predates responseId → interval join
  finishReasons: ['end_turn'],
  usage: {
    inputTokens: 3,
    outputTokens: 1,
    cacheReadInputTokens: null,
    cacheCreationInputTokens: null,
  },
  systemInstructions: [
    { type: 'text', content: 'x-anthropic-billing-header: cc_prev_req=req_XYZ;' },
    { type: 'text', content: 'You are Claude Code, the real standing prompt.' },
  ],
  inputMessages: [{ role: 'user', parts: [{ type: 'text', content: 'the exact sent prompt' }] }],
  outputMessages: [{ role: 'assistant', parts: [{ type: 'text', content: 'pong' }] }],
  querySource: 'repl_main_thread',
  agentName: null,
  ts: 1_700_000_000_100, // inside LLM_ROW's [startedAt, endedAt] window
  receivedAt: 1_700_000_000_600,
};

/** The light projection of GENAI_RECORD, as the call feed holds it. */
const GENAI_SUMMARY: GenAiInferenceSummary = {
  id: GENAI_RECORD.id,
  memberName: GENAI_RECORD.memberName,
  operationName: GENAI_RECORD.operationName,
  provider: GENAI_RECORD.provider,
  model: GENAI_RECORD.model,
  responseId: GENAI_RECORD.responseId,
  finishReasons: GENAI_RECORD.finishReasons,
  usage: GENAI_RECORD.usage,
  querySource: GENAI_RECORD.querySource,
  agentName: GENAI_RECORD.agentName,
  ts: GENAI_RECORD.ts,
  receivedAt: GENAI_RECORD.receivedAt,
};

/** Route `/genai/<id>` to a full record; everything else stays empty. */
function routeGenaiRecord(record: GenAiInferenceRecord | null): string[] {
  const calls: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const isRecord = /\/genai\/\d+$/.test(url);
    if (isRecord && record !== null) {
      return Promise.resolve(
        new Response(JSON.stringify({ inference: record }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    const body = isRecord
      ? { error: 'inference not found' }
      : url.includes('/genai')
        ? { inferences: [] }
        : { activity: [] };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: isRecord ? 404 : 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }) as typeof fetch;
  setClient(new Client({ url: 'http://localhost', useCookies: true }));
  return calls;
}

describe('genai-lazy loadGenAiRecord', () => {
  it('is idle until asked, then loads the record by id', async () => {
    __resetGenAiRecordsForTests();
    memberActivityName.value = 'engineer-1';
    const urls = routeGenaiRecord(GENAI_RECORD);
    expect(genAiRecordState(91).status).toBe('idle');

    await loadGenAiRecord(91);
    const s = genAiRecordState(91);
    expect(s.status).toBe('loaded');
    if (s.status === 'loaded') expect(s.record.id).toBe(91);
    expect(urls.some((u) => u.endsWith('/genai/91'))).toBe(true);
  });

  it('surfaces a fetch failure as an error state, retryable', async () => {
    __resetGenAiRecordsForTests();
    memberActivityName.value = 'engineer-1';
    routeGenaiRecord(null);
    await loadGenAiRecord(91);
    expect(genAiRecordState(91).status).toBe('error');
  });
});

describe('buildThread — turn spine with the call ledger', () => {
  it('attaches a joined call to its turn and emits no ghost row', () => {
    const thread = buildThread([LLM_ROW], [GENAI_SUMMARY]);
    const turn = thread.find((i) => i.variant === 'turn');
    if (turn?.variant !== 'turn') throw new Error('expected a turn');
    expect(turn.calls.map((c) => c.id)).toEqual([91]);
    expect(thread.some((i) => i.variant === 'model-call')).toBe(false);
  });

  it('interleaves a turnless call as a model-call item at its timestamp', () => {
    const sidecar: GenAiInferenceSummary = {
      ...GENAI_SUMMARY,
      id: 92,
      querySource: 'web_search_tool',
      model: 'claude-haiku-4-5',
      ts: 1_700_000_000_150,
    };
    const thread = buildThread([LLM_ROW, TOOL_ROW], [sidecar]);
    const ghost = thread.find((i) => i.variant === 'model-call');
    if (ghost?.variant !== 'model-call') throw new Error('expected a model-call');
    expect(ghost.recordId).toBe(92);
    expect(ghost.querySource).toBe('web_search_tool');
    // Chronological: turn (t+0) → ghost (t+150) → tool row (t+500).
    const order = thread.map((i) => i.variant);
    expect(order.indexOf('turn')).toBeLessThan(order.indexOf('model-call'));
    expect(order.indexOf('model-call')).toBeLessThan(order.indexOf('tool-action'));
  });
});

describe('AgentTimeline — turn spine rendering', () => {
  beforeEach(() => {
    __resetGenAiRecordsForTests();
    __resetGenAiCallFeedForTests();
  });

  it('renders the clean stream with a collapsed "full context" affordance, then lazy-loads the body by id', async () => {
    briefing.value = COMMANDER_BRIEFING;
    memberActivityName.value = 'engineer-1';
    const urls = routeGenaiRecord(GENAI_RECORD);
    memberActivityRows.value = [LLM_ROW];
    memberGenAiCalls.value = [GENAI_SUMMARY];
    memberGenAiCallsReady.value = true;
    memberActivityLoading.value = false;

    const { container } = render(<AgentTimeline />);
    const text = container.textContent ?? '';
    // Clean stream: the turn's response is shown; the affordance is
    // present but nothing is expanded and no body was fetched.
    expect(text).toContain('pong');
    expect(text).toContain('full context');
    expect(text).not.toContain('system instructions');
    expect(urls.some((u) => /\/genai\/\d+$/.test(u))).toBe(false);

    // Expand the turn's context → lazy fetch by record id → render.
    const details = [...container.querySelectorAll('details')].find((d) =>
      d.querySelector('summary')?.textContent?.includes('full context'),
    );
    expect(details).toBeTruthy();
    (details as HTMLDetailsElement).open = true;
    details?.dispatchEvent(new Event('toggle'));

    await waitFor(() => {
      const t = container.textContent ?? '';
      expect(t).toContain('system instructions (1 block)'); // billing block stripped → 1
      expect(t).toContain('You are Claude Code, the real standing prompt.');
      expect(t).toContain('input context (1 message)');
      expect(t).toContain('the exact sent prompt');
    });
    expect(urls.some((u) => u.endsWith('/genai/91'))).toBe(true);
  });

  it('shows an honest "not captured" when the hydrated ledger has no call for the turn', async () => {
    briefing.value = COMMANDER_BRIEFING;
    memberActivityName.value = 'engineer-1';
    routeGenaiRecord(null);
    memberActivityRows.value = [LLM_ROW];
    memberGenAiCalls.value = [];
    memberGenAiCallsReady.value = true;
    memberActivityLoading.value = false;

    const { container } = render(<AgentTimeline />);
    const details = [...container.querySelectorAll('details')].find((d) =>
      d.querySelector('summary')?.textContent?.includes('full context'),
    );
    (details as HTMLDetailsElement).open = true;
    details?.dispatchEvent(new Event('toggle'));

    await waitFor(() => {
      expect((container.textContent ?? '').toLowerCase()).toContain("wasn't captured");
    });
  });

  it('renders turnless calls as attributed ghost rows, toggleable via the api-calls chip', async () => {
    __resetAgentTimelineForTests();
    briefing.value = COMMANDER_BRIEFING;
    memberActivityName.value = 'engineer-1';
    routeGenaiRecord(null);
    const sidecar: GenAiInferenceSummary = {
      ...GENAI_SUMMARY,
      id: 92,
      querySource: 'agent:builtin:general-purpose',
      agentName: 'general-purpose',
      ts: 1_700_000_000_150,
    };
    memberActivityRows.value = [LLM_ROW];
    memberGenAiCalls.value = [GENAI_SUMMARY, sidecar];
    memberGenAiCallsReady.value = true;
    memberActivityLoading.value = false;

    const { container } = render(<AgentTimeline />);
    expect(container.textContent).toContain('subagent · general-purpose');

    // Toggle the chip off → the ghost row disappears; the turn stays.
    const chip = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('api calls'),
    );
    expect(chip).toBeTruthy();
    fireEvent.click(chip as HTMLButtonElement);
    await waitFor(() => {
      expect(container.textContent).not.toContain('subagent · general-purpose');
      expect(container.textContent).toContain('pong');
    });
  });
});
