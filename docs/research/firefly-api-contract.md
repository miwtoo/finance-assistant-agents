# Firefly III API v1 — Withdrawal Sync Contract

## Endpoints

| Purpose | Method | Path | Notes |
|---------|--------|------|-------|
| List asset accounts | GET | `/api/v1/accounts?type=asset` | Paginate via `page`/`limit` |
| List expense accounts | GET | `/api/v1/accounts?type=expense` | Paginate via `page`/`limit` |
| Create withdrawal | POST | `/api/v1/transactions` | See request body below |
| Search transactions | GET | `/api/v1/search/queries` | For recovery after unknown outcome |
| Instance metadata | GET | `/api/v1/about` | Verify user's installed Firefly version before testing |

## Create Withdrawal Request Body

```json
{
  "transactions": [
    {
      "type": "withdrawal",
      "date": "2026-07-10T00:00:00+07:00",
      "amount": "125000.00",
      "description": "Normalized merchant name",
      "source_id": "1",
      "destination_id": "5",
      "currency_code": "IDR",
      "external_id": "<local stable draft id>",
      "error_if_duplicate_hash": true
    }
  ]
}
```

- `source_id` or `source_name`: asset account (resolve by exact name; block if not found).
- `destination_id`: user-selected existing expense account (UI selects from list).
- `amount`: positive decimal string.
- `external_id`: client-assigned stable identifier for recovery correlation.
- `error_if_duplicate_hash`: supplementary guard — rejects if Firefly detects same hash on same day.

## Successful Response

```json
{
  "data": {
    "id": "123",
    "attributes": {
      "transactions": [
        {
          "transaction_journal_id": "456"
        }
      ]
    }
  }
}
```

Persist both:
- `data.id` — group ID
- `data.attributes.transactions[0].transaction_journal_id` — journal ID for transaction display

## No Native Idempotency Key

Firefly III API v1 does **not** support an `Idempotency-Key` header. Duplicate prevention relies on:
1. `error_if_duplicate_hash` — same amount + date + description guard (supplementary only).
2. Client-managed `external_id` — query-based recovery (primary mechanism).

## Recovery After Timeout / Transport Unknown

1. Search: `GET /api/v1/search/queries?q=external_id_is:"<local stable draft id>"`
2. If found → extract `data.id` and `transaction_journal_id` from results; save as synced.
3. If absent → safe to resend the same payload (no duplicate created).

`external_id` is **not unique** at the database level. The search approach is best-effort; `error_if_duplicate_hash` is a supplementary guard, not a guarantee.

## Version Gate

Always call `GET /api/v1/about` against the user's installed Firefly instance before relying on endpoint behavior. API surface may vary across self-hosted versions.

## Sources

- [Firefly III API Documentation](https://api-docs.firefly-iii.org/)
- [Firefly III Search Reference](https://docs.firefly-iii.org/references/firefly-iii/search/)
- [Firefly III Duplicate Detection](https://docs.firefly-iii.org/references/data-importer/duplicate-detection/)
- [Firefly III API Reference](https://docs.firefly-iii.org/references/firefly-iii/api/)
