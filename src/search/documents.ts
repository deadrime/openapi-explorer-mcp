/**
 * Searchable documents built from the spec index: one per endpoint and one per component schema.
 */
import type { Operation, SchemaNode, SpecIndex } from '../spec-index.js';

/**
 * Text fields of an endpoint document, in the order of their weight.
 */
export interface EndpointDocument {
  /** Position in SpecIndex.operations. */
  id: number;
  /** Path with parameter braces removed. */
  path: string;
  /** operationId. */
  opId: string;
  /** Summary. */
  summary: string;
  /** Description. */
  description: string;
  /** Tags. */
  tags: string;
  /** Parameter names. */
  params: string;
  /** Component schemas the request and response reach. */
  schemaNames: string;
  /** Property names of the request and response, two levels deep. */
  props: string;
  /** Why the endpoint is destructive, from the danger rules. */
  danger: string;
}

/**
 * Text fields of a component schema document.
 */
export interface SchemaDocument {
  /** Position in the list of schema names. */
  id: number;
  /** Schema name. */
  name: string;
  /** Description. */
  description: string;
  /** Property names, two levels deep. */
  props: string;
}

/**
 * Names reachable from a schema: properties and referenced components.
 */
export interface ShapeNames {
  /** Property names. */
  props: Set<string>;
  /** Component schema names. */
  schemas: Set<string>;
}

export const ENDPOINT_BOOST: Record<Exclude<keyof EndpointDocument, 'id'>, number> = {
  path: 3,
  opId: 2,
  summary: 2.5,
  description: 1,
  tags: 0.5,
  params: 1,
  schemaNames: 1,
  props: 0.4,
  danger: 1.5,
};

export const SCHEMA_BOOST: Record<Exclude<keyof SchemaDocument, 'id'>, number> = { name: 3, description: 1, props: 1 };

const SHAPE_DEPTH = 2;

/**
 * Collects property and component names of a schema down to a depth, following $refs once each.
 */
export function collectShape(schemas: Record<string, SchemaNode>, node: SchemaNode | null | undefined, depth = SHAPE_DEPTH, out: ShapeNames = { props: new Set(), schemas: new Set() }): ShapeNames {
  if (!node || typeof node !== 'object' || depth < 0) return out;
  if (typeof node.$ref === 'string') {
    const name = node.$ref.split('/').pop() as string;
    if (out.schemas.has(name)) return out;
    out.schemas.add(name);
    return collectShape(schemas, schemas[name], depth, out);
  }
  for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
    for (const branch of (node[key] as SchemaNode[] | undefined) ?? []) collectShape(schemas, branch, depth, out);
  }
  if (node.items) collectShape(schemas, node.items, depth, out);
  if (node.additionalProperties && typeof node.additionalProperties === 'object') collectShape(schemas, node.additionalProperties, depth - 1, out);
  for (const [prop, sub] of Object.entries<SchemaNode>(node.properties ?? {})) {
    out.props.add(prop);
    collectShape(schemas, sub, depth - 1, out);
  }
  return out;
}

/**
 * The document of an endpoint and the property names behind its props field.
 */
export function endpointDocument(index: SpecIndex, op: Operation, id: number): { doc: EndpointDocument; props: string[] } {
  const shape = collectShape(index.schemas, op.request);
  collectShape(index.schemas, op.response, SHAPE_DEPTH, shape);
  return {
    doc: {
      id,
      path: op.path.replace(/[{}]/g, ' '),
      opId: op.operationId ?? '',
      summary: op.summary,
      description: op.description,
      tags: op.tags.join(' '),
      params: Object.values(op.params)
        .flat()
        .map((p) => p.name)
        .join(' '),
      schemaNames: [...shape.schemas].join(' '),
      props: [...shape.props].join(' '),
      danger: op.dangerReason ?? '',
    },
    props: [...shape.props],
  };
}

/**
 * The document of a component schema and its property names.
 */
export function schemaDocument(index: SpecIndex, name: string, id: number): { doc: SchemaDocument; props: string[] } {
  const schema = index.schemas[name];
  const shape = collectShape(index.schemas, schema);
  return {
    doc: { id, name, description: typeof schema?.description === 'string' ? schema.description : '', props: [...shape.props].join(' ') },
    props: [...shape.props],
  };
}
