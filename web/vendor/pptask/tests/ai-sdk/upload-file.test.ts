import type { FilesV4 } from '@ai-sdk/provider';
import { uploadFile } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { createPptaskProvider } from '../../src/index.ts';

describe('AI SDK file compatibility', () => {
  it('exposes FilesV4 through both upload APIs', async () => {
    const upload = vi.fn(async options => ({
      providerReference: { fake: 'file-1' },
      mediaType: options.mediaType,
      byteSize: options.data.type === 'data' && options.data.data instanceof Uint8Array
        ? options.data.data.byteLength
        : undefined,
      warnings: [],
    }));
    const files: FilesV4 = {
      specificationVersion: 'v4',
      provider: 'fake',
      uploadFile: upload,
    };
    const provider = createPptaskProvider({ providerId: 'fake', files });

    const official = await uploadFile({
      api: provider,
      data: new Uint8Array([1, 2]),
      mediaType: 'application/octet-stream',
    });
    const direct = await provider.upload({
      data: { type: 'text', text: 'hello' },
      mediaType: 'text/plain',
    });

    expect(official.providerReference).toEqual({ fake: 'file-1' });
    expect(direct.providerReference).toEqual({ fake: 'file-1' });
    expect(upload).toHaveBeenCalledTimes(2);
  });
});
