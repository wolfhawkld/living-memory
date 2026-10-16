export function instanceStorageKey(key: string, instanceId = 'legacy'): string {
  return instanceId === 'legacy' ? key : `${key}:instance:${encodeURIComponent(instanceId)}`;
}
export function instanceStorage(storage: { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }, instanceId = 'legacy') {
  return { getItem: (key: string) => storage.getItem(instanceStorageKey(key, instanceId)),
    setItem: (key: string, value: string) => storage.setItem(instanceStorageKey(key, instanceId), value),
    removeItem: (key: string) => storage.removeItem(instanceStorageKey(key, instanceId)) };
}
