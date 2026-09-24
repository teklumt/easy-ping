// Stands in for the "react-native" module under vitest (see vitest.config.ts alias).
type Handler = (state: string) => void;

const handlers = new Set<Handler>();

export const AppState = {
  currentState: "active",
  addEventListener(_type: "change", handler: Handler) {
    handlers.add(handler);
    return { remove: () => handlers.delete(handler) };
  },
  /** Test hook: moves the app between foreground and background. */
  set(state: string) {
    AppState.currentState = state;
    for (const handler of handlers) handler(state);
  },
  listenerCount: () => handlers.size,
};
