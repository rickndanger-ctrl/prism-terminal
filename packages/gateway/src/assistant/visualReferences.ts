import { z } from 'zod';

export const VisualReferenceSchema = z.object({
  label: z.string().trim().min(1).max(100),
  jpegBase64: z.string().min(4).max(200_000).regex(/^[A-Za-z0-9+/]+={0,2}$/u).refine((value) => {
    const bytes = Buffer.from(value, 'base64');
    return bytes.length <= 150_000 && bytes.length >= 4
      && bytes[0] === 0xff && bytes[1] === 0xd8
      && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9
      && bytes.toString('base64') === value;
  }, 'Expected a bounded JPEG reference'),
}).strict();
export const VisualReferencesSchema = z.array(VisualReferenceSchema).min(1).max(3);
export type VisualReference = z.infer<typeof VisualReferenceSchema>;
export function immutableVisualReferences(references: readonly VisualReference[]): readonly VisualReference[] {
  return Object.freeze(references.map((reference) => Object.freeze({ ...reference })));
}
