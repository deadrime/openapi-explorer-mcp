import type { SchemaNode } from './spec-index.js';

const COMPONENT_REF = /#\/components\/schemas\/([A-Za-z0-9_.-]+)/g;

/**
 * References between component schemas: direct ones and everything reachable from a schema.
 */
export interface SchemaGraph {
  /** Component names each component references directly. */
  direct: Map<string, Set<string>>;
  /** Every component reachable from a component, not including itself unless it is recursive. */
  closure(name: string): Set<string>;
}

/**
 * Names of the component schemas a node references anywhere inside it.
 */
export function componentRefs(node: unknown): Set<string> {
  return new Set([...JSON.stringify(node ?? null).matchAll(COMPONENT_REF)].map((m) => m[1]));
}

/**
 * Builds the reference graph of components.schemas; closures are computed on demand and memoized.
 */
export function buildSchemaGraph(schemas: Record<string, SchemaNode>): SchemaGraph {
  const direct = new Map<string, Set<string>>();
  for (const [name, schema] of Object.entries(schemas)) direct.set(name, componentRefs(schema));
  const memo = new Map<string, Set<string>>();

  const closure = (name: string): Set<string> => {
    const cached = memo.get(name);
    if (cached) return cached;
    const reached = new Set<string>();
    const queue = [...(direct.get(name) ?? [])];
    while (queue.length) {
      const next = queue.shift() as string;
      if (reached.has(next)) continue;
      reached.add(next);
      queue.push(...(direct.get(next) ?? []));
    }
    memo.set(name, reached);
    return reached;
  };

  return { direct, closure };
}
