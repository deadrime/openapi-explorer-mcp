/**
 * Text description of one endpoint: what it is, how to call it, what it takes and returns, how it fails.
 */
import { componentRef } from '../operations.js';
import type { Operation, SchemaNode } from '../spec-index.js';
import { paramLine } from './params.js';
import { authLabel } from './search.js';
import { oneLine, trimWords } from './text.js';

const DESCRIPTION_LIMIT = 400;
const ERROR_LIMIT = 300;

// Descriptions that only repeat the status name say nothing; such statuses are listed on one line.
const STATUS_TEXT: Record<string, string> = {
  '400': 'bad request',
  '401': 'unauthorized',
  '402': 'payment required',
  '403': 'forbidden',
  '404': 'not found',
  '405': 'method not allowed',
  '409': 'conflict',
  '410': 'gone',
  '413': 'payload too large',
  '415': 'unsupported media type',
  '422': 'unprocessable entity',
  '429': 'too many requests',
  '500': 'internal server error',
  '502': 'bad gateway',
  '503': 'service unavailable',
  '504': 'gateway timeout',
};

/**
 * What the renderer needs besides the operation.
 */
export interface EndpointView {
  /** The operation. */
  op: Operation;
  /** Full URL, when a base URL is known. */
  url?: string;
  /** Renders a schema in the requested mode. */
  render: (schema: SchemaNode) => string;
  /** A line about the spec itself, or an empty string. */
  note: string;
}

/**
 * Danger, auth, body and operationId on one line.
 */
function metaLine(op: Operation): string {
  const danger = op.danger === 'destructive' ? `destructive — ${op.dangerReason ?? 'irreversible'}` : op.danger;
  const body = op.request ? `body${op.requestRequired ? ' required' : ''}` : '';
  const id = op.operationId ? `operationId ${op.operationId}` : '';
  return [danger, `auth: ${authLabel(op, ' | ') || 'none'}`, body, id].filter(Boolean).join(' · ');
}

/**
 * Parameters grouped by location.
 */
function paramsBlock(op: Operation): string[] {
  const lines: string[] = [];
  for (const [where, list] of Object.entries(op.params)) {
    if (list.length === 0) continue;
    lines.push(`${where}:`, ...list.map((param) => `  ${paramLine(param)}`));
  }
  return lines;
}

/**
 * Documented errors, with bare status names folded into one "also" line.
 */
function errorsBlock(op: Operation): string[] {
  const described: string[] = [];
  const bare: string[] = [];
  for (const error of op.errors) {
    const text = oneLine(error.description);
    const body = error.schemaName ? ` (body ${error.schemaName})` : '';
    if (!text || text.toLowerCase() === STATUS_TEXT[error.status]) {
      if (body) described.push(`  ${error.status}${body}`);
      else bare.push(error.status);
    } else {
      described.push(`  ${error.status} — ${trimWords(text, ERROR_LIMIT)}${body}`);
    }
  }
  if (bare.length) described.push(`  ${described.length ? 'also: ' : ''}${bare.join(', ')}`);
  return described.length ? ['errors:', ...described] : [];
}

/**
 * Label of a body or response schema: its component name, with [] for an array of components.
 */
function schemaTitle(schema: SchemaNode): string {
  const ref = componentRef(schema);
  return ref ? ` ${ref.name}${ref.array ? '[]' : ''}` : '';
}

/**
 * Renders the endpoint as text.
 */
export function renderEndpoint({ op, url, render, note }: EndpointView): string {
  const head = [`${op.key}${op.summary ? ` — ${oneLine(op.summary)}` : ''}${op.deprecated ? ' (deprecated)' : ''}`, metaLine(op)];
  if (url) head.push(`url ${url}`);
  const description = op.description.trim().replace(/\n{3,}/g, '\n\n');
  if (description) head.push(trimWords(description, DESCRIPTION_LIMIT));

  const sections = [head.join('\n')];
  const params = paramsBlock(op);
  if (params.length) sections.push(params.join('\n'));
  if (op.request) sections.push(`body${schemaTitle(op.request)}:\n${render(op.request)}`);
  sections.push(op.response ? `response ${op.responseStatus}${schemaTitle(op.response)}:\n${render(op.response)}` : 'response: no JSON body documented');
  const errors = errorsBlock(op);
  if (errors.length) sections.push(errors.join('\n'));
  if (note) sections.push(note);
  return sections.join('\n\n');
}
