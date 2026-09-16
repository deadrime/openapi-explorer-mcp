/**
 * Input schemas of the tools. The server infers handler argument types from them.
 */
import { z } from 'zod';

const method = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const endpoint = z.string().min(1).describe('"METHOD /path"; a unique path or operationId also works');
const depth = z.number().int().min(1).max(6).default(3).describe('How deep nested schemas are expanded');
const renderMode = z.enum(['outline', 'json']).default('outline').describe('json: the schema with $refs resolved');
const as = z.string().default('auto').describe('auto: the first alternative with credentials; anonymous; or a scheme name');
const credentialMap = z.record(z.string(), z.string().min(1));
const credentials = credentialMap.optional().describe('Credentials for this call only, keyed like api_credentials');
const pathParams = z.record(z.string(), z.union([z.string(), z.number()])).default({});
const query = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({});
const fields = z.array(z.string().min(1)).optional().describe('Keep only these fields, e.g. ["data[].id", "total"]');
const maxItems = z.number().int().min(1).max(1000).optional().describe('Cut arrays to this many items');

export const specInfoInput = {
  refresh: z.boolean().default(false).describe('Revalidate the spec now'),
};

export const searchInput = {
  query: z.string().optional().describe('Words, an identifier or a field name; omit to browse'),
  scope: z.enum(['endpoints', 'schemas']).default('endpoints').describe('schemas: find schemas by name or field'),
  method: method.optional(),
  group: z.string().optional().describe('Group or path prefix, e.g. users or admin/accounts'),
  include_admin: z.boolean().default(true),
  has_body: z.boolean().optional().describe('With (true) or without (false) a request body'),
  limit: z.number().int().min(1).max(50).default(10),
};

export const endpointInput = { endpoint, depth, mode: renderMode };

export const schemaInput = {
  name: z.string().min(1).describe('Schema name in components.schemas'),
  path: z.string().optional().describe('Dotted path inside, e.g. data.meta'),
  depth,
  mode: renderMode,
};

export const typesInput = {
  endpoint,
  include: z.array(z.enum(['request', 'response', 'params'])).default(['request', 'response', 'params']),
  name_prefix: z.string().default('').describe('Prefix for generated type names'),
  docs: z.boolean().default(true).describe('Keep doc comments; false gives bare types'),
};

export const getInput = { endpoint, path_params: pathParams, query, as, credentials, fields, max_items: maxItems };

export const requestInput = {
  method,
  endpoint,
  path_params: pathParams,
  query,
  body: z.unknown().optional().describe('JSON body'),
  as,
  credentials,
  reason: z.string().optional().describe('Why the call was made, for the journal'),
  confirm_danger: z.boolean().default(false).describe('Required for destructive operations'),
  fields,
  max_items: maxItems,
};

export const credentialsInput = {
  set: credentialMap.default({}).describe('Credentials to keep, by scheme name or apiKey header name'),
  clear: z.array(z.string()).default([]).describe('Keys to forget; ["*"] forgets all'),
};

export const callLogInput = {
  limit: z.number().int().min(1).max(500).default(50),
};

export const recipeInput = {
  name: z.string().optional().describe('Recipe name; omit to list recipes'),
};
