---
name: meal-planner-usage
description: How to manage recipes and the weekly meal plan with the meal_planner tool, and how to turn a week's plan into shopping list entries. Use when the user wants to plan meals, save a recipe, or generate a shopping list from what's planned for the week.
---

# Meal planner

The `meal_planner` tool stores recipes and a date-keyed weekly plan in this plugin's OWN SQLite database.

Save a recipe (ingredients as a JSON array):
```
[TOOL:meal_planner({"action": "add_recipe", "name": "Spaghetti Bolognese", "servings": 4, "ingredients": [{"name": "Spaghetti", "quantity": 500, "unit": "g"}, {"name": "Hackfleisch", "quantity": 400, "unit": "g"}, {"name": "Tomaten", "quantity": 2, "unit": "Dosen"}], "instructions": "..."})]
```

List recipes / plan a day / view the week:
```
[TOOL:meal_planner({"action": "list_recipes"})]
[TOOL:meal_planner({"action": "set_plan", "date": "2026-08-24", "recipe_id": 3})]
[TOOL:meal_planner({"action": "get_week_plan", "start_date": "2026-08-24"})]
```

Generate a shopping list from the week's plan — this only AGGREGATES ingredients, it does not write anywhere by itself:
```
[TOOL:meal_planner({"action": "generate_shopping_list", "start_date": "2026-08-24"})]
```

That returns `{ ingredients: [{name, quantity, unit}, ...] }`. To actually put these on the shopping list, call the `shopping_list` tool's `add_item` action once per ingredient (see the shopping-list-usage skill) — this is a two-step, cross-plugin hand-off: aggregate here, then add there.

- `date`/`start_date` are always `YYYY-MM-DD`.
- A day can hold at most one planned recipe (`set_plan` overwrites the existing plan for that date).
