/**
 * TracePanel — admin-only view of captured LLM traces for an
 * objective.
 *
 * In the activity-stream architecture, an "objective trace" is a
 * **time-range slice** of the assignee's agent activity stream
 * rather than a separately-stored table. We query
 * `GET /members/<assignee>/activity` with:
 *
 *   - `from = objective.createdAt`
 *   - `to   = objective.completedAt ?? now`
 *   - `kind = llm_exchange`
 *
 * and render the TURN SPINE: one row per exchange, each carrying its
 * API call(s) from the GenAI inference layer
 * (`GET /members/<assignee>/genai`) — the full-fidelity request
 * records with system instructions and complete input context. The
 * join (lib/trace-join.ts) is turn-centric: exact on the API
 * `responseId` where the marker carries one (Claude rows), else by
 * interval containment in the turn's [startedAt, endedAt] window
 * gated by source class — which is how a codex turn absorbs the
 * SEVERAL Responses-API calls it aggregates. Records that belong to
 * no turn — subagent work, server-tool sidecars, away summaries —
 * render as their own attributed rows in chronological position,
 * never dropped.
 *
 * Coverage of the rich layer is best-effort, so a turn with no
 * matching record still renders its marker (model, response, usage)
 * — never fewer rows than the activity stream holds. If the genai
 * fetch itself fails (older broker, transient error) the panel
 * degrades to markers only rather than erroring.
 *
 * Permission gates match on both surfaces:
 *   - Client: the parent `ObjectiveDetail` only mounts us when the
 *     viewer has the `activity.read` permission.
 *   - Server: both GET endpoints return 403 to anyone without
 *     `activity.read` reading another member.
 *
 * The trace content is already redacted at runner upload time
 * (activity stream) / broker ingest (genai layer).
 */

import { signal } from '@preact/signals';
import type {
  ActivityLlmExchange,
  AnthropicContentBlock,
  AnthropicMessagesEntry,
  GenAiInferenceRecord,
  Objective,
} from 'csuite-sdk/types';
import type { JSX } from 'preact';
import { useEffect } from 'preact/hooks';
import { highlightXmlTags } from '../lib/channel-highlight.js';
import { getClient } from '../lib/client.js';
import { highlightJson } from '../lib/json-highlight.js';
import { describeQuerySource, parseToolName, prettyModel } from '../lib/model-format.js';
import { joinTurns } from '../lib/trace-join.js';
import { GenAiMessageBlock, GenAiRequestDetails } from './GenAiBlocks.js';
import { AlertCircle } from './icons/index.js';

// The join is shared with AgentTimeline (lib/trace-join.ts);
// re-exported here for the panel's tests.
export { type JoinResult, joinTurns, type TurnJoin } from '../lib/trace-join.js';

/** One rendered row of the objective trace, in chronological order. */
type PanelRow =
  | { kind: 'turn'; ts: number; exchange: ActivityLlmExchange; calls: GenAiInferenceRecord[] }
  | { kind: 'sidecar'; ts: number; record: GenAiInferenceRecord };

const panelRows = signal<PanelRow[]>([]);
const loading = signal(false);
const loadError = signal<string | null>(null);
const expanded = signal(true);

async function loadExchanges(objective: Objective): Promise<void> {
  loading.value = true;
  loadError.value = null;
  try {
    // `completedAt` is set iff status === 'done'. For cancelled or
    // still-active objectives we widen the upper bound to "now"
    // so recent activity lands in the view.
    const to = objective.completedAt ?? Date.now();
    const [rows, inferences] = await Promise.all([
      getClient().listActivity(objective.assignee, {
        from: objective.createdAt,
        to,
        kind: 'llm_exchange',
        limit: 500,
      }),
      // Enrichment layer — degrade to markers-only on any failure
      // (older broker without the GET route, transient error).
      getClient()
        .listGenaiInferences(objective.assignee, {
          from: objective.createdAt,
          to,
          limit: 500,
        })
        .catch((): GenAiInferenceRecord[] => []),
    ]);
    // The activity server returns newest-first; we want to render
    // oldest-first so the conversation reads top-down.
    const ordered = [...rows].reverse();
    const exchanges = ordered
      .map((row) => row.event)
      .filter((ev): ev is ActivityLlmExchange => ev.kind === 'llm_exchange');
    const joined = joinTurns(exchanges, inferences);
    const merged: PanelRow[] = [
      ...joined.turns.map(
        (t): PanelRow => ({
          kind: 'turn',
          ts: t.exchange.ts,
          exchange: t.exchange,
          calls: t.calls,
        }),
      ),
      ...joined.orphans.map((r): PanelRow => ({ kind: 'sidecar', ts: r.ts, record: r })),
    ];
    merged.sort((a, b) => a.ts - b.ts);
    panelRows.value = merged;
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

export interface TracePanelProps {
  objective: Objective;
}

export function TracePanel({ objective }: TracePanelProps): JSX.Element {
  const list = panelRows.value;
  const isLoading = loading.value;
  const err = loadError.value;
  const isOpen = expanded.value;

  useEffect(() => {
    void loadExchanges(objective);
  }, [objective.id, objective.completedAt]);

  const turnCount = list.filter((r) => r.kind === 'turn').length;
  const enrichedCount = list.filter((r) => r.kind === 'turn' && r.calls.length > 0).length;
  const sidecarCount = list.length - turnCount;
  const header = (
    <button
      type="button"
      onClick={() => {
        expanded.value = !expanded.value;
      }}
      class="w-full flex items-center justify-between"
      style="background:transparent;padding:0"
    >
      <span class="eyebrow">
        LLM turns ({turnCount}
        {enrichedCount > 0 ? ` · ${enrichedCount} with full request` : ''}
        {sidecarCount > 0 ? ` · ${sidecarCount} sidecar` : ''})
      </span>
      <span style="font-family:var(--f-mono);font-size:14px;color:var(--muted)">
        {isOpen ? '−' : '+'}
      </span>
    </button>
  );

  return (
    <section style="display:flex;flex-direction:column;gap:12px">
      {header}
      {isOpen && (
        <div style="display:flex;flex-direction:column;gap:8px">
          {isLoading && <div class="eyebrow">Loading exchanges…</div>}
          {err !== null && (
            <div class="callout err" role="alert">
              <div class="icon" aria-hidden="true">
                <AlertCircle size={16} />
              </div>
              <div class="body">
                <div class="msg">{err}</div>
              </div>
            </div>
          )}
          {!isLoading && err === null && list.length === 0 && (
            <div style="font-family:var(--f-sans);font-size:13px;color:var(--muted);font-style:italic">
              No LLM exchanges captured during this objective
            </div>
          )}
          {list.map((row, i) =>
            row.kind === 'turn' ? (
              <TurnRow key={`t${row.ts}-${i}`} exchange={row.exchange} calls={row.calls} />
            ) : (
              <SidecarRow key={`s${row.record.id}`} record={row.record} />
            ),
          )}
        </div>
      )}
    </section>
  );
}

function TurnRow({
  exchange,
  calls,
}: {
  exchange: ActivityLlmExchange;
  calls: GenAiInferenceRecord[];
}): JSX.Element {
  const source = calls[0]?.querySource ?? exchange.querySource ?? null;
  return (
    <div class="card" style="padding:12px">
      <div
        class="flex items-center justify-between"
        style="font-family:var(--f-mono);font-size:11.5px;color:var(--muted)"
      >
        <span>
          {new Date(exchange.ts).toISOString().replace('T', ' ').slice(0, 19)} · {exchange.duration}
          ms
        </span>
        {source !== null && <span>{source}</span>}
      </div>
      <div style="margin-top:8px">
        <AnthropicEntryView entry={exchange.entry} calls={calls} />
      </div>
    </div>
  );
}

/**
 * A model call with no turn marker — subagent work, a server-tool
 * sidecar (web search), an away summary. First-class forensic row:
 * the record IS the evidence here (there's no marker to show), so
 * its output renders eagerly alongside the request layers.
 */
function SidecarRow({ record }: { record: GenAiInferenceRecord }): JSX.Element {
  const u = record.usage;
  return (
    <div class="card" style="padding:12px;border-left:2px dashed var(--rule-strong)">
      <div
        class="flex items-center justify-between"
        style="font-family:var(--f-mono);font-size:11.5px;color:var(--muted)"
      >
        <span>
          ↳ {new Date(record.ts).toISOString().replace('T', ' ').slice(0, 19)} ·{' '}
          <span style="color:var(--steel)">
            {describeQuerySource(record.querySource, record.agentName)}
          </span>
        </span>
        {record.querySource !== null && <span>{record.querySource}</span>}
      </div>
      <div style="margin-top:8px;border-left:2px solid var(--steel);padding-left:8px">
        <div style="font-family:var(--f-mono);font-size:11.5px;color:var(--muted)">
          <span style="color:var(--ink);font-weight:600">
            {record.model !== null ? prettyModel(record.model) : '?'}
          </span>
          {u && (
            <span style="margin-left:8px">
              in={u.inputTokens ?? '?'} out={u.outputTokens ?? '?'}
              {u.cacheReadInputTokens !== null && u.cacheReadInputTokens > 0 && (
                <span> cache_hit={u.cacheReadInputTokens}</span>
              )}
            </span>
          )}
          {record.finishReasons[0] !== undefined && (
            <span style="margin-left:8px">stop={record.finishReasons[0]}</span>
          )}
        </div>
        {record.outputMessages.length > 0 && (
          <details style="margin-top:4px" open>
            <summary style="font-family:var(--f-mono);font-size:11.5px;color:var(--muted);cursor:pointer">
              output ({record.outputMessages.length})
            </summary>
            <div style="margin-top:4px;display:flex;flex-direction:column;gap:4px">
              {record.outputMessages.map((m, i) => (
                <GenAiMessageBlock key={i} message={m} />
              ))}
            </div>
          </details>
        )}
        <GenAiRequestDetails
          systemInstructions={record.systemInstructions}
          inputMessages={record.inputMessages}
        />
      </div>
    </div>
  );
}

function AnthropicEntryView({
  entry,
  calls,
}: {
  entry: AnthropicMessagesEntry;
  calls: GenAiInferenceRecord[];
}): JSX.Element {
  const usage = entry.response?.usage;
  return (
    <div style="border-left:2px solid var(--steel);padding-left:8px">
      <div style="font-family:var(--f-mono);font-size:11.5px;color:var(--muted)">
        <span style="color:var(--ink);font-weight:600">
          {entry.request.model ? prettyModel(entry.request.model) : '?'}
        </span>
        {usage && (
          <span style="margin-left:8px">
            in={usage.inputTokens ?? '?'} out={usage.outputTokens ?? '?'}
            {usage.cacheReadInputTokens !== null && usage.cacheReadInputTokens > 0 && (
              <span> cache_hit={usage.cacheReadInputTokens}</span>
            )}
          </span>
        )}
        {entry.response?.stopReason && (
          <span style="margin-left:8px">stop={entry.response.stopReason}</span>
        )}
        {calls.length === 0 && (
          <span
            style="margin-left:8px;font-style:italic"
            title="No captured request body for this call — showing the activity marker only"
          >
            marker only
          </span>
        )}
      </div>
      {/* Full-request layers from the joined record(s). One call is
          the Claude shape; a codex turn lists each aggregated
          Responses-API call with its own request context. */}
      {calls.length === 1 && calls[0] !== undefined && (
        <GenAiRequestDetails
          systemInstructions={calls[0].systemInstructions}
          inputMessages={calls[0].inputMessages}
        />
      )}
      {calls.length > 1 && (
        <details style="margin-top:4px">
          <summary style="font-family:var(--f-mono);font-size:11.5px;color:var(--muted);cursor:pointer">
            api calls ({calls.length})
          </summary>
          <div style="margin-top:4px;display:flex;flex-direction:column;gap:4px">
            {calls.map((call) => (
              <div key={call.id} style="border-left:1px solid var(--rule);padding-left:10px">
                <div style="font-family:var(--f-mono);font-size:11px;color:var(--muted)">
                  <span style="font-variant-numeric:tabular-nums">
                    {new Date(call.ts).toISOString().replace('T', ' ').slice(11, 19)}
                  </span>{' '}
                  <span style="color:var(--ink);font-weight:600">
                    {call.model !== null ? prettyModel(call.model) : '?'}
                  </span>
                  {call.usage && (
                    <span style="margin-left:8px">
                      in={call.usage.inputTokens ?? '?'} out={call.usage.outputTokens ?? '?'}
                    </span>
                  )}
                </div>
                <GenAiRequestDetails
                  systemInstructions={call.systemInstructions}
                  inputMessages={call.inputMessages}
                />
              </div>
            ))}
          </div>
        </details>
      )}
      {/* Legacy inline system string — only ever present on old rows. */}
      {entry.request.system && (
        <details style="margin-top:4px">
          <summary style="font-family:var(--f-mono);font-size:11.5px;color:var(--muted);cursor:pointer">
            system prompt
          </summary>
          <pre style="font-family:var(--f-mono);font-size:11.5px;color:var(--ink);white-space:pre-wrap;margin-top:4px">
            {entry.request.system}
          </pre>
        </details>
      )}
      <details style="margin-top:4px" open>
        <summary style="font-family:var(--f-mono);font-size:11.5px;color:var(--muted);cursor:pointer">
          messages ({entry.request.messages.length + (entry.response?.messages.length ?? 0)})
        </summary>
        <div style="margin-top:4px;display:flex;flex-direction:column;gap:4px">
          {entry.request.messages.map((m, i) => (
            <MessageBlock key={`req-${i}`} role={m.role} content={m.content} />
          ))}
          {entry.response?.messages.map((m, i) => (
            <MessageBlock key={`resp-${i}`} role={m.role} content={m.content} />
          ))}
        </div>
      </details>
    </div>
  );
}

function MessageBlock({
  role,
  content,
}: {
  role: string;
  content: AnthropicContentBlock[];
}): JSX.Element {
  return (
    <div style="border-left:1px solid var(--rule);padding-left:10px;font-size:12px">
      <div class="eyebrow">{role}</div>
      {content.map((block, i) => (
        <ContentBlock key={i} block={block} />
      ))}
    </div>
  );
}

/**
 * A <pre> that syntax-highlights JSON payloads (tool inputs/results)
 * and falls back to plain preformatted text for non-JSON content. The
 * highlighted markup is HTML-escaped inside `highlightJson`.
 */
function JsonPre({ text, style }: { text: string; style: string }): JSX.Element {
  const html = highlightJson(text);
  if (html !== null) {
    return <pre style={style} dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return <pre style={style}>{text}</pre>;
}

function ContentBlock({ block }: { block: AnthropicContentBlock }): JSX.Element {
  if (block.type === 'text') {
    const highlighted = highlightXmlTags(block.text);
    if (highlighted !== null) {
      return (
        <pre
          style="font-family:var(--f-mono);font-size:12px;color:var(--ink);white-space:pre-wrap"
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      );
    }
    return (
      <pre style="font-family:var(--f-mono);font-size:12px;color:var(--ink);white-space:pre-wrap">
        {block.text}
      </pre>
    );
  }
  if (block.type === 'tool_use') {
    const { server, tool } = parseToolName(block.name);
    return (
      <div style="font-size:12px">
        <span style="color:var(--steel)">tool_use</span>{' '}
        {server && <span style="color:var(--muted)">{server} · </span>}
        <span style="color:var(--ink);font-weight:600">{tool}</span>{' '}
        <span style="color:var(--muted)">({block.id})</span>
        <JsonPre
          text={JSON.stringify(block.input, null, 2)}
          style="font-family:var(--f-mono);font-size:11.5px;color:var(--graphite);white-space:pre-wrap;margin-top:2px"
        />
      </div>
    );
  }
  if (block.type === 'tool_result') {
    return (
      <div style="font-size:12px">
        <span style={`color:var(${block.isError ? '--err' : '--steel'})`}>tool_result</span>{' '}
        <span style="color:var(--muted)">({block.toolUseId})</span>
        <JsonPre
          text={
            typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content, null, 2)
          }
          style="font-family:var(--f-mono);font-size:11.5px;color:var(--graphite);white-space:pre-wrap;margin-top:2px"
        />
      </div>
    );
  }
  if (block.type === 'thinking') {
    return (
      <div style="font-size:12px;color:var(--muted);font-style:italic">
        thinking:{' '}
        <pre style="white-space:pre-wrap;font-family:var(--f-mono);display:inline">
          {block.text}
        </pre>
      </div>
    );
  }
  if (block.type === 'image') {
    return (
      <div style="font-size:12px;color:var(--muted);font-style:italic">
        [image{block.mediaType ? ` ${block.mediaType}` : ''}]
      </div>
    );
  }
  return (
    <div style="font-size:12px;color:var(--muted);font-style:italic">
      [unknown block: {JSON.stringify(block.raw).slice(0, 60)}…]
    </div>
  );
}
