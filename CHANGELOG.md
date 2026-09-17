# Changelog

## Unreleased

### Added

- `api_types` names the `format` of a string field with an `@format` tag in its doc comment; the generated type is
  plain `string` and lost it. `binary` is left out, its type already says it. Types cached by an earlier version are
  regenerated.

## 0.2.0 — 2026-09-16

### Breaking

- `api_search`, `api_endpoint`, `api_schema` and `api_types` answer in plain text instead of JSON.
- `api_get`, `api_request`, `api_credentials`, `api_spec_info` and `api_call_log` answer in compact JSON; empty
  fields are left out and `groups` in `api_spec_info` is one line.
- `api_search` ranks results instead of requiring every word; `limit` defaults to 10 (at most 50) and admin
  endpoints are no longer pushed to the end.
- A change of the spec is announced once, in the next response, instead of in every response; `api_spec_info` keeps
  the list of added and removed operations.

### Added

- Search with MiniSearch: camelCase and punctuation splitting, stop words, English and Russian stemming by script,
  prefix and one-typo matching, field weights, relative cut-off. Descriptions, body fields, schema names and danger
  reasons are searchable; `scope: "schemas"` finds schemas by name or field; an empty result suggests how to search.
- `api_endpoint` shows the operation description, parameter types, enums, defaults and ranges, and documented errors.
- `fields` and `max_items` in `api_get` and `api_request`; oversized responses get their arrays cut before the text is.
- `docs` in `api_types`; generated types use two-space indentation and one-line doc comments and come with every type
  they reference.
- A URL spec is revalidated in the background after the TTL; only the first load waits for the network.
- `npm run bench` for search quality, latency and token counts.

### Fixed

- `api_types` dropped `| null` from nullable enums.
- `name_prefix` renamed only the declaration, not the references to it.
- The json mode of `api_endpoint` and `api_schema` reduced scalars at the depth limit to `{ type }`, and left `$ref`
  inside `oneOf`, `anyOf`, `allOf` and `additionalProperties` unresolved.
- Cycle detection in schema rendering never triggered; only the depth limit stopped recursion.
- Endpoints that reach a schema through another schema were missing from its usage.
- Descriptions were cut at 80 characters in the middle of a word; enums over 8 values showed only 5.
- A `pattern` was printed next to a `format` that already said the same.
- An array of enum parameters was typed as `'a' | 'b'[]`.
- The truncation hint suggested `depth` for tools that have no such parameter.

## 0.1.0

### Breaking

- `OPENAPI_AUTH_MODULE`, the `identity` argument, `api_auth` and the exported provider types are removed: a login
  endpoint called through `api_request` plus `api_credentials` covers minted tokens.
- A `401` is no longer retried; `note.auth` names the rejected credential.

### Added

- `credentials` in `api_get` and `api_request`, and `api_credentials` to keep credentials for the session. A scheme
  takes its value from the call, then the session, then `OPENAPI_AUTH_<SCHEME>`.

## 0.0.2

- TypeScript 5.9 pinned so `api_types` works when installed from npm; `smoke:package` checks the packed tarball.

## 0.0.1

- First release.
