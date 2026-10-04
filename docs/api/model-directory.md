---
title: Model directory
summary: Saved model setups per company
---

Saved model setups (provider, model, address, defaults) a company can reuse for its quick agents. **No API key is ever stored or returned here**; keys stay in company secrets. All routes are board-only and require the company's owner or admin (instance admins and the local board also pass). Agents get `403`. Every mutation writes an activity entry (`model_directory_entry.created|updated|deleted|duplicated`).

## Entry shape

```
{
  "id": "uuid", "companyId": "uuid",
  "name": "Local llama",                  // unique per company, 1-80 chars
  "provider": "anthropic|openai|google|openrouter|local",
  "model": "llama3.1",                    // must fit the provider
  "baseUrl": "http://localhost:11434/v1", // required for local/openrouter; plain http(s), no query/credentials
  "providerRouting": { "only": [], "order": [], "ignore": [], "allowFallbacks": true } | null, // OpenRouter only
  "defaultThinking": "on" | "off" | null,
  "defaultTemperature": 0..1.5 | null,
  "defaultMaxOutputTokens": 64..8192 | null,
  "backupEntryIds": ["uuid"],             // other entries of the same company, max 5
  "note": "string" | null,
  "createdByUserId", "updatedByUserId", "createdAt", "updatedAt"
}
```

## Endpoints

| Method | Path | Body | Success |
| --- | --- | --- | --- |
| GET | `/api/companies/{companyId}/model-directory` | | `200` entry list |
| POST | `/api/companies/{companyId}/model-directory` | entry fields (strict; unknown fields such as `apiKey` → `400`) | `201` entry |
| GET | `/api/companies/{companyId}/model-directory/{entryId}` | | `200` entry |
| PATCH | `/api/companies/{companyId}/model-directory/{entryId}` | any entry fields | `200` entry |
| DELETE | `/api/companies/{companyId}/model-directory/{entryId}` | | `204` (also removed from other entries' backup chains) |
| POST | `/api/companies/{companyId}/model-directory/{entryId}/duplicate` | `{ "name"?: string }` (default `"<name> (copy)"`) | `201` entry |

Errors: `400` invalid body, `403` not owner/admin or agent, `404` unknown entry (including another company's), `409` duplicate name, `422` merged result invalid (e.g. backup from another company, self-backup).
