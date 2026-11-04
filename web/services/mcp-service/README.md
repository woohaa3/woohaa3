# Canvas node execution through MCP

`run_canvas_node` submits media nodes through the existing Task route. Text nodes require an explicit assistant selection; a Provider `modelKey` cannot start a new text run.

```json
{
  "canvasId": "canvas-id",
  "nodeId": "text-node-id",
  "requestId": "unique-user-action-id",
  "prompt": "Write the complete Markdown document",
  "assistant": {
    "connection": {
      "connectionId": "connection-from-the-assistant-directory",
      "adapterId": "adapter-from-the-directory",
      "configRevision": 1,
      "credentialEpoch": 0
    },
    "model": "model-from-that-connection",
    "reasoningEffort": "high"
  }
}
```

Use current owner-scoped directory identities and only a Variant supported by that model. An unavailable connection/model must be corrected explicitly. Text and supported image references are compiled from the authoritative Canvas; unsupported audio/video references fail before inference. The caller supplies no owner, candidate or private delivery association.

The acceptance response includes `runId`, `jobId` and a real `execution` reference to the conversation/turn. Acceptance and candidate completion do not prove that artwork was saved. Query `get_canvas_run` with the exact canvas/node/run until the domain receipt settles it; `unknown` means the result remains unconfirmed. Reads never repeat inference. Reuse the same requestId only for transport replay of the same input; an explicit new generation needs a new requestId.

`cancel_canvas_run` stops that exact run, including an older independent round; it does not stop the node's newest run implicitly. An already durable save wins over a racing cancellation. `get_node_output` returns only that run's saved text, including archived results; failed or unsaved runs do not substitute the current node body. The text result is a normal ready Canvas asset and version, consumed by existing downstream references and history restore.

Saved candidates can be retried through the application's explicit retry-save action without calling the model again. Conversation state, credentials and native threads stay private to the local host. Text candidates have no Canvas/MCP write tools. Canvas writes still enforce the per-turn grant at Canvas read/write boundaries.

Capability declarations and automated protocol tests do not establish availability of a real account. Verify each configured OAuth/local/SDK connection against its actual model before claiming upstream support.
