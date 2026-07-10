# Triage Labels

Default label vocabulary for issue triage. These labels are the minimum set; additional labels may be added as the project evolves.

| Label | Purpose |
|---|---|
| `needs-triage` | New issue, not yet assessed. Every issue starts here. |
| `needs-info` | Issue lacks sufficient detail for implementation. Blocked on author response. |
| `ready-for-agent` | Issue is fully specified and safe for an autonomous agent to implement. |
| `ready-for-human` | Issue requires human judgement (architecture decisions, ambiguous scope, sensitive changes). |
| `wontfix` | Issue reviewed and intentionally not pursued. |

## Flow

```
new issue → needs-triage
           ↓
     triaged by human/agent
           ↓
  ┌────────┴────────┐
  ↓                 ↓
needs-info    ready-for-agent / ready-for-human
  ↓                 ↓
info provided   work begins
  ↓                 ↓
ready-for-*    done → closed
```
