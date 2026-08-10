# Analysis Result Contract

Write one JSON object to the bridge-provided `result_template` path. Do not add Markdown fences or commentary.

The analysis must be produced by `gpt-5.6-terra` with reasoning effort `high`. The Dashboard rejects any other model or effort.

```json
{
  "model": "gpt-5.6-terra",
  "reasoning_effort": "high",
  "summaries": [
    {
      "group_id": "conversation id copied exactly from context",
      "overview": "A concise description of what happened today in this conversation only.",
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
      "evidence_ids": ["evidence id from this conversation"]
    }
  ],
  "alerts": [
    {
      "group_id": "conversation id copied exactly from context",
      "category": "urgent",
      "severity": "high",
      "confidence": 0.91,
      "title": "Short attention title",
      "detail": "What happened, why it matters, and the current state.",
      "suggested_action": "The concrete action the user should take next.",
      "evidence_ids": ["evidence id from this conversation"]
    }
  ],
  "opportunities": [
    {
      "group_id": "conversation id copied exactly from context",
      "category": "new_demand",
      "confidence": 0.88,
      "title": "Short opportunity title",
      "detail": "The grounded opportunity signal and its context.",
      "business_value": "Why following up may matter.",
      "suggested_action": "The concrete next follow-up.",
      "owner": null,
      "due": null,
      "evidence_ids": ["evidence id from this conversation"]
    }
  ]
}
```

## Required Values

- Alert `category`: `mention`, `customer_emotion`, `urgent`, `no_response`, `conflict`, or `no_solution`.
- Opportunity `category`: `new_demand`, `budget_signal`, `collaboration`, `upsell`, `referral`, or `renewal`.
- `severity`: `critical`, `high`, `medium`, or `low`.
- `confidence`: number from 0 through 1.
- `action_items[].status`: `open`, `done`, or `unknown`.

## Output Selection

- Follow `context.job.requested_outputs` exactly.
- Keep every unrequested output array empty.
- An empty array is valid when no supported conclusion is sufficiently grounded.

## Evidence and Separation

- Read inputs from `context.conversations`.
- Copy conversation IDs into the compatibility field `group_id` exactly.
- Every cited evidence ID must exist in that same conversation.
- Produce at most one summary per conversation.
- Never combine events from different conversations into one summary, alert, or opportunity.
- Use later messages to determine whether an earlier issue was answered or resolved.
- Do not infer an @mention when `profile.my_names` is empty.
- Private-message context appears only for a platform whose explicit setting is enabled.

## Writing Style

- Write concise, natural Simplified Chinese.
- State the event, impact, current state, and next action directly.
- Prefer precision over volume. Do not exaggerate severity or expose unrelated personal content.
