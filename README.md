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
| `api_search` | Ranked search over paths, operationIds, summaries, descriptions, parameters and body fields. `scope: "schemas"` finds component schemas by name or field. |
| `api_endpoint` | One endpoint as text: description, danger, auth alternatives, URL, typed parameters with defaults and ranges, request and response shapes (compact, depth-limited), documented errors. |
| `api_schema` | A component schema by name, with drill-down into nested fields and the endpoints that use it, directly or through other schemas. |
| `api_types` | TypeScript types for an endpoint's parameters, request and response, plus every type they reference, generated with `@hey-api/openapi-ts`. The doc comment of a string field names its `format` with an `@format` tag. `docs: false` drops the comments. |
| `api_get` | Calls a GET endpoint. `fields` and `max_items` narrow the response. |
| `api_request` | Calls an endpoint with any method. Registered only with `OPENAPI_ALLOW_WRITE`; destructive endpoints need `confirm_danger: true`. |
| `api_call_log` | Journal of `api_request` calls with ids from responses, for cleaning up. |
| `api_credentials` | Keeps credentials for the session or forgets them; shows where the credential of each scheme comes from, never the value. |
| `recipe` | Markdown recipes for this API. Registered only with `OPENAPI_RECIPES_DIR`. |

## Output

The exploring tools answer in plain text — an agent reads it as well as JSON and it costs a fraction of the tokens:

```
api_search(query: "equity history")

3 of 3 · accounts 1, admin/accounts 1, admin/hedge 1
GET /accounts/{accountId}/equity-history — Get the equity history of the trader account [bearer] (path: accountId; query: timestamp?, duration?)
GET /admin/accounts/account-equity-history — Get the equity history of the trader account [x-admin-token|bearer] (query: accountId, timestamp?, duration?, changeFraction?)
GET /admin/hedge/dashboard/user-history — User equity and OI history [x-admin-token|bearer] (query: userId, timeframe, from?, to?) · field initialEquity, currentEquity
```

Each line carries the auth alternatives, `destructive`, `body` and `deprecated` flags and the parameter names;
`· field …` says the endpoint was found through a field of its request or response. Schemas render as a
compact pseudo-type: a `format` or a well-known pattern is named (`string (uuid)`), enums are listed up to 20 values,
descriptions are cut at a word.

`api_get`, `api_request`, `api_credentials`, `api_spec_info` and `api_call_log` answer in compact JSON.

## Search

Endpoints and schemas are indexed with [MiniSearch](https://github.com/lucaong/minisearch) on first use. Words are
split on punctuation, camelCase and digits (`closeReason` also matches as a whole), stop words are dropped, and each
word is stemmed by its script — English with Porter, Russian with Snowball — so no language setting is needed. Queries
match whole words, prefixes and one typo; a compound identifier outweighs its parts. Results are ranked by BM25 with
field weights (path and summary first, then operationId, danger reason, description, parameters, schema names and
body fields) and hits scoring below 30% of the best one are dropped. An exact key, path or operationId always comes
first. When nothing matches, the answer says how to search differently and lists similar words from the spec.

## Narrowing responses

`fields` keeps only the listed paths of a response; `[]` stands for every element of an array, and on an array body a
path applies to each element. `max_items` cuts every array and reports the original lengths:

```
api_get(endpoint: "GET /admin/markets", fields: ["id", "settings.isCloseOnly"], max_items: 3)
{"key":"GET /admin/markets",…,"arrays":{"[]":157},"body":[{"id":"…","settings":{"isCloseOnly":false}},…]}
```

Without `max_items`, a response over `OPENAPI_MAX_RESPONSE_CHARS` gets its arrays cut to 20, 5 or 1 items until it
fits, with a note; only then is the text truncated.

## Configuration

| Variable | |
|---|---|
| `OPENAPI_SPEC_URL` | Required. URL or file path of an OpenAPI 3 JSON spec. URLs are cached on disk and revalidated with ETag. |
| `OPENAPI_BASE_URL` | Base URL for calls. Required when a credential or header is configured in the environment; otherwise `servers[0].url` of the spec is used. |
| `OPENAPI_AUTH_<SCHEME>` | A permanent credential for a security scheme — see [Authentication](#authentication). |
| `OPENAPI_HEADER_<NAME>` | A header sent with every call, whatever the spec says. `OPENAPI_HEADER_X_API_KEY` sends `x-api-key`. |
| `OPENAPI_ENV_FILE` | Env file merged into the environment at startup; variables already set win. |
| `OPENAPI_ALLOW_WRITE` | `1`, `true` or `yes` registers `api_request`. Off by default. |
| `OPENAPI_DANGER_FILE` | JSON with danger overrides — see [Danger rules](#danger-rules). |
| `OPENAPI_RECIPES_DIR` | Directory of markdown recipes (with a `description:` line) served by `recipe`. |
| `OPENAPI_INSTRUCTIONS_FILE` | Markdown appended to the instructions the server gives the model. |
| `OPENAPI_SERVER_NAME` | Server name reported to the client. Default `openapi`. |
| `OPENAPI_CACHE_DIR` | Spec cache and generated types. Default `~/.cache/openapi-explorer-mcp/<hash of the spec source>`. |
| `OPENAPI_CALL_LOG` | Journal of `api_request` calls. Default `<cache dir>/calls.jsonl`. |
| `OPENAPI_SPEC_TTL_S` | How often a URL spec is revalidated, in the background: calls are served from memory or the disk cache meanwhile. Default `900`. |
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
goes, and each operation's `security` says which schemes it accepts. A scheme takes its value from the first of
three places that has one:

| Source | Lives | How |
|---|---|---|
| the call | one call | `credentials` argument of `api_get` and `api_request` |
| the session | until the server restarts | `api_credentials` with `set` and `clear` |
| the environment | as long as the configuration | `OPENAPI_AUTH_<SCHEME>` |

**Permanent credentials** — a static admin token, a service API key — belong in the environment: they stay out of
the conversation. The variable name is the scheme name upper-cased with every other character replaced by `_`:
`x-admin-token` → `OPENAPI_AUTH_X_ADMIN_TOKEN`, `bearer` → `OPENAPI_AUTH_BEARER`. A header every call must carry,
whatever the spec says, goes to `OPENAPI_HEADER_<NAME>`.

**Credentials the model supplies** — a token it just obtained, a key the user pasted into the chat — go through
`credentials` or `api_credentials`. Keys are scheme names as `api_spec_info` lists them; an `apiKey` scheme also
accepts its header, query or cookie name, so `X-Api-Key` finds a scheme named `ApiKeyAuth`. When the spec declares
no security schemes at all, the keys are sent as plain headers.

```
api_request(method: "POST", endpoint: "POST /auth/login", body: { … })
api_credentials(set: { "bearer": "<accessToken from the response>" })
api_get(endpoint: "GET /me")
```

When a call with a credential gets `401`, the response says so in `note.auth`: obtain a fresh value and set it again.

**Placement.** Whatever the source, the value goes where the scheme says:

| Scheme | Placement |
|---|---|
| `apiKey` in `header` / `query` / `cookie` | the named header, query parameter or cookie |
| `http` `bearer`, `oauth2`, `openIdConnect` | `Authorization: Bearer <value>` |
| `http` `basic` | `Authorization: Basic …` — give `user:password` or an already encoded value |

**Which scheme a call uses.** `security` is a list of alternatives. With `as: "auto"` (the default) the server
takes the first alternative whose schemes all have credentials, from any source. `as` can also name a scheme to
force it, or be `"anonymous"`. When nothing is available, a GET is sent anonymously with a note (many GET endpoints
declare auth but also answer without it); any other method fails and names every way to supply the credential.

**What keeps credentials safe**

- Credentials go only to the base URL. The origin of every request is checked against it before sending, and path
  parameters are URL-encoded, so a path can't redirect a request elsewhere.
- Credentials from the environment need `OPENAPI_BASE_URL` set explicitly: a server configuration is long-lived and
  often shared, while the spec's `servers` comes over the network. Credentials the model supplies go to the base URL
  that `api_spec_info` and `api_credentials` report — `OPENAPI_BASE_URL`, or the first server of the spec.
- Tool output and the call journal never contain values: they name the scheme and where its credential came from,
  e.g. `bearer (session)`. A value the model supplies is part of the conversation by nature — keep secrets that
  must not be there in the environment.

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
npm run smoke      # stdio checks against scripts/fixtures/pets.json and a local HTTP server, no internet
npm run check      # all three
npm run smoke:package  # packs the tarball, installs it in a clean directory and runs the smoke there
```

`npm publish` runs `check` and `smoke:package` first. The package depends on TypeScript 5.9 directly: the type
generator declares TypeScript as a peer dependency, and without the pin npm installs TypeScript 7, whose JavaScript
API the generator can't use.

### Bench

`npm run bench -- <queries.json>` runs a server against a query file and reports search quality (top-1/5/10 and MRR
by kind of query), latency, and the tokens of every response and of the tool list (o200k, as a proxy for comparing
formats). The file holds `env` for the server, `queries` with the endpoints each should find, and `calls` to measure:

```json
{
  "env": { "OPENAPI_SPEC_URL": "../../fixtures/pets.json" },
  "queries": [{ "q": "list pets", "expect": ["GET /pets"], "kind": "plain" }],
  "calls": [{ "label": "endpoint", "tool": "api_endpoint", "args": { "endpoint": "GET /pets" } }]
}
```

Relative paths resolve against the file and `${VAR}` expands from the environment. `--spec` overrides the spec — use a
saved snapshot to compare runs; `--server "npx -y openapi-explorer-mcp@0.1.0"` measures another version; `--json` saves
the report and `--compare` prints the difference with a saved one. `scripts/bench/queries/pets.json` is the example.

## License

MIT — see [LICENSE](LICENSE).
