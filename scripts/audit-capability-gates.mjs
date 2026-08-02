/**
 * Enumerate every web-UI control that can mutate server state, together
 * with every condition that gates whether it renders or is enabled.
 *
 * AST-derived, via the TypeScript compiler. The previous version of this
 * audit was a regex over line-shaped `&&` with a fixed 14-line lookahead;
 * it could not see ternaries, could not see a guard more than 14 lines
 * above its button, and silently omitted six controls that invoke
 * mutating SDK methods. An enumeration whose stated domain exceeds what
 * its generator can parse is worse than no enumeration, because the
 * omissions are invisible in the output.
 *
 * A "control" is a JSX element that is a <button>/<form>, or that carries
 * onClick/onSubmit. Every control is emitted; mutation and capability are
 * annotations on the row, not filters applied before it.
 *
 * Gates collected per control:
 *   - render guards: the condition of every enclosing `cond && <jsx>` and
 *     every enclosing ternary, at any depth
 *   - enablement guards: the control's own `disabled={...}` expression
 *
 * Known blind spots, unchanged and still true: a control gated by an
 * early `return null` in the component body; a gate computed in a hook
 * and passed down as a prop; anything in apps/web-host.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UI_SRC = join(REPO_ROOT, 'packages/web-ui/src');

/**
 * A handler is treated as mutating if it mentions an identifier beginning
 * with a state-changing verb. Verb-based rather than an enumerated method
 * list: the list version missed `onJoin(c.slug)` in ChannelBrowse, because
 * the component receives its mutator as a prop and no enumeration of SDK
 * method names can see that. Verbs survive indirection; names do not.
 *
 * The verb may be followed by a capital/underscore/paren (`onAddMember`,
 * `remove(`) OR end there (`onSubmit`, `onRename`) — a shorthand handler
 * whose identifier IS the verb was invisible to the first version, which
 * marked three real mutations non-mutating, one of them capability-gated.
 *
 * Deliberately over-inclusive. This annotates the candidate set, it does
 * not filter it — every control is emitted either way, so a false positive
 * costs a row and a false negative would cost coverage.
 */
const MUTATING_VERB =
  /\b(?:on)?(?:join|leave|remove|delete|destroy|create|add|update|save|set|write|put|post|send|submit|archive|rename|revoke|rotate|cancel|complete|reassign|discuss|bind|unbind|approve|reject|replay|refresh|enroll|logout|prune|clear|reset|apply|confirm|upload|move|mkdir|rm|mv)(?:[A-Z_(]|\b)/i;

function tsxFiles(dir, acc = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) tsxFiles(p, acc);
    else if (e.name.endsWith('.tsx')) acc.push(p);
  }
  return acc;
}

const isJsx = (n) => ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n);

function tagOf(node) {
  const opening = ts.isJsxElement(node) ? node.openingElement : node;
  return opening.tagName ? opening.tagName.getText() : '?';
}

function attrs(node) {
  const opening = ts.isJsxElement(node) ? node.openingElement : node;
  const out = new Map();
  for (const a of opening.attributes?.properties ?? []) {
    if (ts.isJsxAttribute(a) && a.name) out.set(a.name.getText(), a.initializer?.getText() ?? '');
  }
  return out;
}

/** Walk ancestors collecting every condition that gates this node's rendering. */
function renderGuards(node, source) {
  const guards = [];
  let cur = node.parent;
  let child = node;
  while (cur) {
    if (
      ts.isBinaryExpression(cur) &&
      cur.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      // the JSX is (transitively) the right operand — the left is the guard
      if (cur.right === child || cur.right.getStart() <= child.getStart()) {
        guards.push({ kind: '&&', text: cur.left.getText(source).replace(/\s+/g, ' ').trim() });
      }
    } else if (ts.isConditionalExpression(cur)) {
      const branch = cur.whenTrue === child ? 'then' : cur.whenFalse === child ? 'else' : null;
      if (branch) {
        guards.push({
          kind: `ternary:${branch}`,
          text: cur.condition.getText(source).replace(/\s+/g, ' ').trim(),
        });
      }
    }
    child = cur;
    cur = cur.parent;
  }
  return guards;
}

/**
 * A guard is capability-shaped if it turns on WHO the viewer is or WHAT
 * they may do. Includes explicit server-supplied capability (`canWrite`),
 * which an earlier identity/role/permission/ownership rule missed — it
 * classified the repaired FilesPanel guard as navigation, i.e. the rule
 * erased the very finding it was built to surface. A rule that cannot
 * recognise its own fixes goes blinder with every correction.
 */
const CAPABILITY_GUARD =
  /\b(?:can[A-Z]\w*|is(?:Admin|Self|Director|Assignee|Originator|Watching|Member)|viewer|owner|permissions?|myRole|joined|allMembers|isMember)\b/;

const classify = (guards, disabled) => {
  const all = [...guards.map((g) => g.text), disabled].filter(Boolean).join(' ');
  if (!all) return 'ungated';
  if (CAPABILITY_GUARD.test(all)) return 'CAPABILITY';
  if (/\b(busy|Busy|loading|Loading|submitting|sending|confirming|err|error|Error)\b/.test(all))
    return 'state';
  if (/\b(tab|mode|view|open|Open)\b/.test(all)) return 'navigation';
  return 'data';
};

const rows = [];
for (const file of tsxFiles(UI_SRC).sort()) {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const visit = (node) => {
    if (isJsx(node) && !ts.isJsxFragment(node)) {
      const tag = tagOf(node);
      const a = attrs(node);
      const handler = a.get('onClick') ?? a.get('onSubmit') ?? '';
      const isControl = tag === 'button' || tag === 'form' || handler !== '';
      if (isControl) {
        const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        rows.push({
          file: relative(REPO_ROOT, file),
          line,
          tag,
          mutating: MUTATING_VERB.test(handler),
          handler: handler.replace(/\s+/g, ' ').slice(0, 60),
          disabled: (a.get('disabled') ?? '').replace(/\s+/g, ' ').slice(0, 70),
          guards: renderGuards(node, source),
        });
        rows[rows.length - 1].klass = classify(
          rows[rows.length - 1].guards,
          rows[rows.length - 1].disabled,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

const mutating = rows.filter((r) => r.mutating);
console.error(
  `controls: ${rows.length}  mutating: ${mutating.length}  ` +
    `with-render-guard: ${mutating.filter((r) => r.guards.length > 0).length}  ` +
    `with-disabled: ${mutating.filter((r) => r.disabled).length}`,
);

const byClass = {};
for (const r of mutating) byClass[r.klass] = (byClass[r.klass] ?? 0) + 1;
console.error(`mutating controls by gate class: ${JSON.stringify(byClass)}`);

console.log('| control | mutates? | class | handler | render guards | disabled |');
console.log('|---|---|---|---|---|---|');
for (const r of rows) {
  const g = r.guards.length
    ? r.guards.map((x) => `\`${x.text}\` *(${x.kind})*`).join('<br>')
    : '_none_';
  console.log(
    `| \`${r.file.replace('packages/web-ui/src/', '')}:${r.line}\` | ${r.mutating ? '**yes**' : 'no'} | ${r.klass} | \`${r.handler || r.tag}\` | ${g} | ${r.disabled ? `\`${r.disabled}\`` : '—'} |`,
  );
}
