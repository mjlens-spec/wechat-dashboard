# Analysis Result Contract

Write one JSON object to the bridge-provided `result_template` path. Do not add Markdown fences or commentary.

The `model` value must identify the model that actually produced the analysis. Codex normally uses `gpt-5.6-luna` or the `gpt-5.6-terra` fallback. Claude Code uses its active Claude model identifier, or `claude-code-active-model` when the exact identifier is unavailable.

```json
{
  "model": "gpt-5.6-luna",
  "summaries": [
    {
      "group_id": "group id copied exactly from context",
      "overview": "A concise description of what happened today in this group only.",
      "highlights": ["Important development"],
      "decisions": ["Confirmed decision"],
      "action_items": [
        {
          "text": "Concrete next action",
          "owner": "Name or null",
          "due": "Time expression or null",
          "status": "open"
        }
      ],
      "risks": ["Unresolved risk"],
      "evidence_ids": ["evidence id from this group"]
    }
  ],
  "alerts": [
    {
      "group_id": "group id copied exactly from context",
      "category": "urgent",
      "severity": "high",
      "confidence": 0.91,
      "title": "Short attention title",
      "detail": "What happened, why it matters, and the current state.",
      "suggested_action": "The concrete action the user should take next.",
      "evidence_ids": ["evidence id from this group"]
    }
  ]
}
```

## Required Values

- `category`: `mention`, `customer_emotion`, `urgent`, `no_response`, `conflict`, or `no_solution`.
- `severity`: `critical`, `high`, `medium`, or `low`.
- `confidence`: number from 0 through 1.
- `action_items[].status`: `open`, `done`, or `unknown`.

## Output Selection

- Follow `context.job.requested_outputs` exactly.
- If `summaries` was not requested, keep `summaries` empty.
- If `alerts` was not requested, keep `alerts` empty.
- An empty array is valid when no supported conclusion is sufficiently grounded.

## Evidence and Separation

- Copy `group_id` and `evidence_id` values exactly.
- Every cited evidence ID must exist in the same group.
- Produce at most one summary per group.
- Never combine events from different groups into a single summary or alert.
- Use later messages to determine whether an earlier problem was answered or resolved.
- Do not infer an @mention when `profile.my_names` is empty.

## Writing Style

- Write concise, natural Simplified Chinese.
- State the event, impact, current state, and next action directly.
- Do not exaggerate severity or expose unrelated personal chat content.
