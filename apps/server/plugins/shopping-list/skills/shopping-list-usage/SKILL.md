---
name: shopping-list-usage
description: How to manage the shopping list and pantry stock with the shopping_list tool. Use when the user wants to add something to the shopping list, check off a bought item, or track how much of something is left at home.
---

# Shopping list & pantry

The `shopping_list` tool stores both the shopping list and the pantry (Vorrat) in this plugin's OWN SQLite database.

Add something to the list:
```
[TOOL:shopping_list({"action": "add_item", "name": "Milch", "quantity": 2, "unit": "l"})]
```

List / check off / remove:
```
[TOOL:shopping_list({"action": "list_items"})]
[TOOL:shopping_list({"action": "check_item", "id": 3, "checked": true})]
[TOOL:shopping_list({"action": "remove_item", "id": 3})]
[TOOL:shopping_list({"action": "clear_checked"})]
```

Pantry (Vorrat) with a low-stock threshold — set once, then consume as it's used:
```
[TOOL:shopping_list({"action": "set_pantry", "name": "Mehl", "quantity": 2, "unit": "kg", "low_threshold": 0.5})]
[TOOL:shopping_list({"action": "list_pantry"})]
[TOOL:shopping_list({"action": "consume_pantry", "name": "Mehl", "quantity": 0.5})]
```

- `consume_pantry` automatically adds the item to the shopping list once its quantity drops to or below `low_threshold` — mention that to the user when it happens (`addedToShoppingList: true` in the result).
- Receipt/Kassenbon-OCR is NOT implemented yet — items must be added manually via `add_item`, not scanned from a photo. If the user asks for that, tell them it isn't available yet.
