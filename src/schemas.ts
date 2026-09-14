/**
 * Input schemas of the tools. The server infers handler argument types from them.
 */
import { z } from 'zod';

const method = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const endpoint = z.string().min(1).describe('"METHOD /path", a path with a single operation, or a unique operationId');
const depth = z.number().int().min(1).max(6).default(3).describe('How deep nested schemas are expanded');
const renderMode = z.enum(['outline', 'json']).default('outline').describe('outline: a compact pseudo-type; json: the schema with $refs resolved');
const as = z
  .string()
  .default('auto')
  .describe("'auto' uses the first security alternative with configured credentials; 'anonymous' sends none; or a security scheme name from the spec");
const identity = z.string().optional().describe('Identity passed to the auth module, e.g. a user id');
const pathParams = z.record(z.string(), z.union([z.string(), z.number()])).default({}).describe('Path parameters');
const query = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}).describe('Query-string parameters');

export const specInfoInput = {
  refresh: z.boolean().default(false).describe('Revalidate the spec now'),
};

export const searchInput = {
  query: z.string().optional().describe('Words separated by spaces; all of them must match'),
  method: method.optional(),
  group: z.string().optional().describe('Group or path prefix, e.g. users or admin/accounts'),
  include_admin: z.boolean().default(true).describe('Include /admin endpoints'),
  has_body: z.boolean().optional().describe('Only operations with (true) or without (false) a request body'),
  limit: z.number().int().min(1).max(100).default(30),
};

export const endpointInput = { endpoint, depth, mode: renderMode };

export const schemaInput = {
  name: z.string().min(1).describe('Schema name in components.schemas'),
  path: z.string().optional().describe('Dotted path inside the schema, e.g. data.meta'),
  depth,
  mode: renderMode,
};

export const typesInput = {
  endpoint,
  include: z.array(z.enum(['request', 'response', 'params'])).default(['request', 'response', 'params']),
  name_prefix: z.string().default('').describe('Prefix for generated type names'),
};

export const getInput = { endpoint, path_params: pathParams, query, as, identity };

export const requestInput = {
  method,
  endpoint,
  path_params: pathParams,
  query,
  body: z.unknown().optional().describe('JSON body'),
  as,
  identity,
  reason: z.string().optional().describe('Note for the call journal: why the call was made'),
  confirm_danger: z.boolean().default(false).describe('Required for operations classified as destructive'),
};

export const authInput = {
  identity,
  refresh: z.boolean().default(false).describe('Mint new tokens even if cached ones are still valid'),
  show_token: z.boolean().default(false).describe('Return full tokens instead of previews'),
};

export const callLogInput = {
  limit: z.number().int().min(1).max(500).default(50),
};

export const recipeInput = {
  name: z.string().optional().describe('Recipe name; omit to list recipes'),
};
