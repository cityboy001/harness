export function createPreviewDocument(options?: { allowExternalImages?: boolean }): string;
export function previewRoute(data: unknown, files: Record<string, string>): { page: string; search: string } | null;
export function previewStorageUpdate(storage: Record<string, string>, data: { key?: unknown; value?: unknown }): void;
export const previewSandbox: string;
