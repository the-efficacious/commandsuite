/**
 * Renderers for GenAI inference content — the full-request layer's
 * `systemInstructions` parts and `inputMessages`. Shared by the
 * objective TracePanel and the member AgentTimeline so both trace
 * surfaces present the enriched record identically.
 *
 * Styles mirror the Anthropic-block renderers (text as mono pre with
 * channel-tag highlighting, tool calls/results as labeled JSON,
 * reasoning italic-muted) so an enriched row reads as one visual
 * system with the marker content around it.
 */

import type { GenAiMessage, GenAiPart } from 'csuite-sdk/types';
import type { JSX } from 'preact';
import { highlightXmlTags } from '../lib/channel-highlight.js';
import { highlightJson } from '../lib/json-highlight.js';
import { parseToolName } from '../lib/model-format.js';

/**
 * A <pre> that syntax-highlights JSON payloads and falls back to
 * plain preformatted text. The highlighted markup is HTML-escaped
 * inside `highlightJson`.
 */
function JsonPre({ text, style }: { text: string; style: string }): JSX.Element {
  const html = highlightJson(text);
  if (html !== null) {
    return <pre style={style} dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return <pre style={style}>{text}</pre>;
}

export function GenAiMessageBlock({ message }: { message: GenAiMessage }): JSX.Element {
  return (
    <div style="border-left:1px solid var(--rule);padding-left:10px;font-size:12px">
      <div class="eyebrow">{message.role}</div>
      {message.parts.map((part, i) => (
        <GenAiPartBlock key={i} part={part} />
      ))}
    </div>
  );
}

/** Render one GenAI content part, mirroring the Anthropic-block styles. */
export function GenAiPartBlock({ part }: { part: GenAiPart }): JSX.Element {
  if (part.type === 'text') {
    const highlighted = highlightXmlTags(part.content);
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
        {part.content}
      </pre>
    );
  }
  if (part.type === 'tool_call') {
    const { server, tool } = parseToolName(part.name ?? '?');
    return (
      <div style="font-size:12px">
        <span style="color:var(--steel)">tool_call</span>{' '}
        {server && <span style="color:var(--muted)">{server} · </span>}
        <span style="color:var(--ink);font-weight:600">{tool}</span>{' '}
        <span style="color:var(--muted)">({part.id ?? '?'})</span>
        <JsonPre
          text={JSON.stringify(part.arguments, null, 2)}
          style="font-family:var(--f-mono);font-size:11.5px;color:var(--graphite);white-space:pre-wrap;margin-top:2px"
        />
      </div>
    );
  }
  if (part.type === 'tool_call_response') {
    return (
      <div style="font-size:12px">
        <span style={`color:var(${part.is_error ? '--err' : '--steel'})`}>tool_result</span>{' '}
        <span style="color:var(--muted)">({part.id ?? '?'})</span>
        <JsonPre
          text={
            typeof part.response === 'string'
              ? part.response
              : JSON.stringify(part.response, null, 2)
          }
          style="font-family:var(--f-mono);font-size:11.5px;color:var(--graphite);white-space:pre-wrap;margin-top:2px"
        />
      </div>
    );
  }
  if (part.type === 'reasoning') {
    return (
      <div style="font-size:12px;color:var(--muted);font-style:italic">
        thinking:{' '}
        <pre style="white-space:pre-wrap;font-family:var(--f-mono);display:inline">
          {part.content}
        </pre>
      </div>
    );
  }
  if (part.type === 'blob' || part.type === 'file') {
    return (
      <div style="font-size:12px;color:var(--muted);font-style:italic">
        [{part.type}
        {part.mime_type ? ` ${part.mime_type}` : ''}]
      </div>
    );
  }
  return (
    <div style="font-size:12px;color:var(--muted);font-style:italic">
      [{part.type}: {JSON.stringify('content' in part ? part.content : part).slice(0, 60)}…]
    </div>
  );
}

/**
 * Claude Code prepends a per-call bookkeeping block to the system
 * instructions (`x-anthropic-billing-header: … cc_prev_req=req_…`)
 * whose value changes every request. It isn't part of the prompt —
 * drop it so the "system instructions" a reviewer sees is the real
 * standing prompt, not per-call noise.
 */
function isBillingHeaderPart(part: GenAiPart): boolean {
  return part.type === 'text' && part.content.startsWith('x-anthropic-billing-header:');
}

/**
 * The pair of expanders for one call's full request — system
 * instructions + full input context. Renders nothing when there is
 * nothing to expand. `defaultOpen` opens both sub-sections (used
 * when the caller already gated behind its own expand, e.g. the
 * timeline's lazy per-turn "full context").
 */
export function GenAiRequestDetails({
  systemInstructions,
  inputMessages,
  defaultOpen = false,
}: {
  systemInstructions: GenAiPart[];
  inputMessages: GenAiMessage[];
  defaultOpen?: boolean;
}): JSX.Element | null {
  const sysBlocks = systemInstructions.filter((p) => !isBillingHeaderPart(p));
  if (sysBlocks.length === 0 && inputMessages.length === 0) return null;
  return (
    <>
      {sysBlocks.length > 0 && (
        <details style="margin-top:4px" open={defaultOpen}>
          <summary style="font-family:var(--f-mono);font-size:11.5px;color:var(--muted);cursor:pointer">
            system instructions ({sysBlocks.length} {sysBlocks.length === 1 ? 'block' : 'blocks'})
          </summary>
          <div style="margin-top:4px;display:flex;flex-direction:column;gap:4px">
            {sysBlocks.map((part, i) => (
              <GenAiPartBlock key={i} part={part} />
            ))}
          </div>
        </details>
      )}
      {inputMessages.length > 0 && (
        <details style="margin-top:4px" open={defaultOpen}>
          <summary style="font-family:var(--f-mono);font-size:11.5px;color:var(--muted);cursor:pointer">
            input context ({inputMessages.length}{' '}
            {inputMessages.length === 1 ? 'message' : 'messages'})
          </summary>
          <div style="margin-top:4px;display:flex;flex-direction:column;gap:4px">
            {inputMessages.map((m, i) => (
              <GenAiMessageBlock key={i} message={m} />
            ))}
          </div>
        </details>
      )}
    </>
  );
}
