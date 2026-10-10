/* File removal stays outside the database transaction. A failed delete rolls the rows back and leaves the recordings in place. */
export async function completeAccountDeletion(work: () => Promise<string[]>, remove: (path: string) => Promise<void>) {
  const paths = await work();
  for (const relPath of paths) {
    try { await remove(relPath); }
    catch (error) { console.error('[LinguaFlow] recording delete failed', relPath, error); }
  }
}
