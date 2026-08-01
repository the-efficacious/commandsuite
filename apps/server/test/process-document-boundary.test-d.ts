/**
 * Compile-time negatives for criterion 6.
 *
 * The criterion is "invariants are enforced on the constructed next
 * document, by the same validator as creation — never on the delta."
 * That guarantee is ARCHITECTURAL: it holds because
 * `assertDocumentInvariants` cannot be handed a delta, not because a
 * test observed it being handed a document.
 *
 * WHY THIS FILE AND NOT A MUTATION. A runtime mutation cannot kill it.
 * Replacing `assertDocumentInvariants(next)` with a delta check passes
 * every store test, because the document currently has ONE editable
 * field — so the delta and the document are the same value and no
 * input distinguishes them. The mutation survives, and the survival
 * means the claim has nothing to bite on yet, not that the claim is
 * false.
 *
 * The claim is about a TYPE, so the compiler is the right instrument.
 *
 * `@ts-expect-error` INVERTS the question. Checking by eye that a
 * hostile snippet fails to compile is a one-time observation nobody
 * repeats. Here `tsc` fails the build with `TS2578: unused
 * '@ts-expect-error'` the moment the parameter widens enough to accept
 * a delta — which is exactly the day the runtime mutation would start
 * being killable, and the day nobody is looking.
 *
 * Type-only: no runtime assertions, checked by `tsc --noEmit`.
 */

import type { EditProcessDocumentRequest } from 'csuite-sdk/types';
import { assertDocumentInvariants, type EditableFields } from '../src/process-document.js';

// ─── the positive control ────────────────────────────────────────────
// A fully constructed document is what the validator is for. If this
// stopped compiling the negatives below would pass vacuously.
declare const constructed: EditableFields;
assertDocumentInvariants(constructed);

// ─── the delta cannot be validated ───────────────────────────────────
// The whole request, as the route receives it. `text` is optional here
// and required on the document, so this is the shape that could smuggle
// "I did not mention that field" past a whole-record invariant.
declare const request: EditProcessDocumentRequest;
// @ts-expect-error criterion 6: the edit request is a delta and must not be validatable
assertDocumentInvariants(request);

// A bare partial, which is what a delta is once the metadata is
// stripped. Same refusal for the same reason.
declare const delta: Partial<EditableFields>;
// @ts-expect-error criterion 6: a partial document is a delta, not a document
assertDocumentInvariants(delta);

// Nothing at all — "validate whatever you already had" is the
// degenerate delta and is refused too.
// @ts-expect-error criterion 6: the validator requires a document to validate
assertDocumentInvariants();
