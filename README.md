# openapi-explorer-mcp

An MCP server for any OpenAPI 3 spec. It lets an AI agent find endpoints, inspect request and response shapes
without loading a megabyte of JSON, generate TypeScript types, and call endpoints — with credentials mapped to the
security schemes the spec already declares.

Unlike servers that turn every operation into its own tool, this one stays small: a handful of tools that explore
the spec and one generic caller.

## Tools

| Tool | What it does |
|---|---|
| `api_spec_info` | Spec version and age, counts, groups, security schemes with credential status, changes since the previous version. |
| `api_search` | Searches method, path, operationId, summary, tags and parameter names. |
| `api_endpoint` | Parameters, request and response shapes (compact, depth-limited), danger level, security alternatives, URL. |
| `api_schema` | A component schema by name, with drill-down into nested fields and the endpoints that use it. |
| `api_types` | TypeScript types for an endpoint's request, response and parameters, generated with `@hey-api/openapi-ts`. |
| `api_get` | Calls a GET endpoint. |
| `api_request` | Calls an endpoint with any method. Registered only with `OPENAPI_ALLOW_WRITE`; destructive endpoints need `confirm_danger: true`. |
| `api_call_log` | Journal of `api_request` calls with ids from responses, for cleaning up. |
| `api_auth` | Mints tokens through the auth module. Registered only when the module supports it. |
| `recipe` | Markdown recipes for this API. Registered only with `OPENAPI_RECIPES_DIR`. |

## Configuration

| Variable | |
|---|---|
| `OPENAPI_SPEC_URL` | Required. URL or file path of an OpenAPI 3 JSON spec. URLs are cached on disk and revalidated with ETag. |
| `OPENAPI_BASE_URL` | Base URL for calls. Required whenever any credential or header is configured; otherwise `servers[0].url` of the spec is used for anonymous calls. |
| `OPENAPI_AUTH_<SCHEME>` | Credential for a security scheme — see [Authentication](#authentication). |
| `OPENAPI_HEADER_<NAME>` | A header sent with every call, for specs that don't declare security schemes. `OPENAPI_HEADER_X_API_KEY` sends `x-api-key`. |
| `OPENAPI_AUTH_MODULE` | Path to an ES module that supplies credentials minted at runtime. |
| `OPENAPI_ENV_FILE` | Env file merged into the environment at startup; variables already set win. |
| `OPENAPI_ALLOW_WRITE` | `1`, `true` or `yes` registers `api_request`. Off by default. |
| `OPENAPI_DANGER_FILE` | JSON with danger overrides — see [Danger rules](#danger-rules). |
| `OPENAPI_RECIPES_DIR` | Directory of markdown recipes (with a `description:` line) served by `recipe`. |
| `OPENAPI_INSTRUCTIONS_FILE` | Markdown appended to the instructions the server gives the model. |
| `OPENAPI_SERVER_NAME` | Server name reported to the client. Default `openapi`. |
| `OPENAPI_CACHE_DIR` | Spec cache and generated types. Default `~/.cache/openapi-explorer-mcp/<hash of the spec source>`. |
| `OPENAPI_CALL_LOG` | Journal of `api_request` calls. Default `<cache dir>/calls.jsonl`. |
| `OPENAPI_SPEC_TTL_S` | How often a URL spec is revalidated. Default `900`. |
| `OPENAPI_TIMEOUT_MS` | Timeout of spec fetches and calls. Default `20000`. |
| `OPENAPI_MAX_RESPONSE_CHARS` | Cap on a tool response. Default `40000`. |

```json
{
  "mcpServers": {
    "my-api": {
      "command": "npx",
      "args": ["-y", "openapi-explorer-mcp"],
      "env": {
        "OPENAPI_SPEC_URL": "https://api.example.com/openapi.json",
        "OPENAPI_BASE_URL": "https://api.example.com",
        "OPENAPI_AUTH_X_API_KEY": "${MY_API_KEY}",
        "OPENAPI_SERVER_NAME": "my-api"
      }
    }
  }
}
```

## Authentication

The server doesn't invent headers — it reads them from the spec. `components.securitySchemes` says where a secret
goes, and each operation's `security` says which schemes it accepts. You only give a scheme its value.

**Credentials.** `OPENAPI_AUTH_<SCHEME>` holds the value for a scheme; the name is upper-cased with every other
character replaced by `_`: `x-admin-token` → `OPENAPI_AUTH_X_ADMIN_TOKEN`, `bearer` → `OPENAPI_AUTH_BEARER`. The
value is placed where the scheme says:

| Scheme | Placement |
|---|---|
| `apiKey` in `header` / `query` / `cookie` | the named header, query parameter or cookie |
| `http` `bearer`, `oauth2`, `openIdConnect` | `Authorization: Bearer <value>` |
| `http` `basic` | `Authorization: Basic …` — give `user:password` or an already encoded value |

**Which scheme a call uses.** `security` is a list of alternatives. With `as: "auto"` (the default) the server
takes the first alternative whose schemes all have credentials. `as` can also name a scheme to force it, or be
`"anonymous"`. When nothing is configured, a GET is sent anonymously with a note (many GET endpoints declare auth
but also answer without it); any other method fails with the name of the variable to set.

**Tokens minted at runtime.** `OPENAPI_AUTH_MODULE` points to an ES module whose default export creates a provider.
The `identity` argument of `api_get` and `api_request` is passed to it as is. Types are exported by the package:

```ts
import type { AuthProviderFactory } from 'openapi-explorer-mcp';

const createAuth: AuthProviderFactory = ({ baseUrl, timeoutMs, env }) => ({
  canProvide: (scheme, { identity }) => scheme === 'bearer' && Boolean(identity ?? env.DEFAULT_USER),
  getCredential: async (scheme, { identity, force }) => mintToken(baseUrl, identity ?? env.DEFAULT_USER, { force, timeoutMs }),
  // optional: registers api_auth
  authenticate: async ({ identity, force }) => ({ identity: identity ?? 'default', accessToken: await mintToken(/* … */) }),
});

export default createAuth;
```

A static credential from `OPENAPI_AUTH_<SCHEME>` wins over the module for the same scheme. When a call that used a
module credential gets `401`, the server asks the module again with `force: true` and retries once.

**What keeps credentials safe**

- Only the person configuring the server sets values; no tool accepts headers or tokens, so the model picks a
  scheme, never a value.
- Credentials go only to `OPENAPI_BASE_URL`, which must be set explicitly when any credential exists. The spec's
  `servers` is never trusted with them — the spec is fetched over the network and could point elsewhere.
- The origin of every request is checked against the base URL before sending; path parameters are URL-encoded.
- Values never appear in tool output or in the call journal: responses name the scheme, and `api_spec_info` shows
  only whether a scheme has a credential.

## Danger rules

Every non-GET operation is `write`, and `destructive` when it is a `DELETE` or its path contains `drop`, `purge`,
`reset`, `destroy`, `bulk` or `broadcast`. `api_request` refuses destructive operations without
`confirm_danger: true`. `OPENAPI_DANGER_FILE` adds exact operations and path words:

```json
{
  "operations": {
    "POST /orders": "creates a real order"
  },
  "pathPatterns": ["close", "withdraw"]
}
```

## Development

```
npm install
npm run typecheck
npm run build      # tsc into dist/
npm run smoke      # stdio checks against scripts/fixtures/pets.json, no network
npm run check      # all three
npm run smoke:package  # packs the tarball, installs it in a clean directory and runs the smoke there
```

`npm publish` runs `check` and `smoke:package` first. The package depends on TypeScript 5.9 directly: the type
generator declares TypeScript as a peer dependency, and without the pin npm installs TypeScript 7, whose JavaScript
API the generator can't use.

## License

MIT — see [LICENSE](LICENSE).
