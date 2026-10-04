---
category: Agent chat
---

# QuestionCard

Card for questions the agent asks the user: each question with its options (single or multi-select), an 'Other…' field, and Submit / Skip.

`ask.input` is `{ questions: [{ question, header?, multiSelect?, options: [{ label, description? }] }] }`.

```tsx
<QuestionCard onAnswer={() => {}} ask={{ id: "q", tool: "AskUserQuestion", summary: "", can_always: false, input: { questions: [{ question: "Which database?", header: "Storage", options: [{ label: "Postgres" }, { label: "SQLite" }] }] } }} />
```
