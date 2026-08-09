---
name: exchange-rates-usage
description: How to answer currency / exchange-rate questions using the exchange_rates tool. Use when the user asks about currency conversion, exchange rates, or the value of one currency in another.
---

# Exchange Rates

For any currency / exchange-rate question, call the `exchange_rates` tool with the base currency (ISO code). It returns current rates against many currencies plus a ready summary.

```
[TOOL:exchange_rates({"base": "EUR"})]
```

- Default base is EUR if omitted.
- Report the `summary` field, or read specific pairs from `result.rates` (e.g. `result.rates.USD`).
- Data is cached for 1 hour - do not ask the user to provide rates.
- To convert an amount, multiply: `amount * result.rates.<TARGET>`.
