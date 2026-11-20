// Errors whose message is meant to be read by the model that called a tool.

/**
 * A problem the caller can fix: a bad combination of arguments, a file that
 * cannot be used, an unknown id. The MCP layer returns `toToolMessage()` as
 * the tool's error text.
 */
export class ToolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolError';
  }

  toToolMessage() {
    return this.message;
  }
}
