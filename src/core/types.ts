export const SCOPES = ['fact', 'hypothetical', 'roleplay', 'draft', 'quote'] as const;
export type Scope = (typeof SCOPES)[number];

export const ROLES = ['user', 'assistant', 'tool', 'system'] as const;
export type Role = (typeof ROLES)[number];

export const EVENT_KINDS = ['message', 'explicit_remember', 'tool_result', 'note'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
