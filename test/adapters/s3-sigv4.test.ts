/**
 * The S3 signer reproduces AWS's published Signature Version 4 example for
 * GetObject (Amazon S3 API Reference, "Example: GET Object"): the same
 * canonical request, the same signature, to the character.
 */
import { describe, expect, it } from 'vitest';

import { amzDate, EMPTY_PAYLOAD_SHA256, signRequest } from '../../adapters/storage/s3/sigv4.ts';

// AWS's documentation example keys. Not a credential.
const keys = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
};
const at = Date.UTC(2013, 4, 24) / 1000;

describe('SigV4 for S3', () => {
  it('formats the instant as AWS does', () => {
    expect(amzDate(at)).toBe('20130524T000000Z');
  });
  it('reproduces the AWS GET Object example signature', () => {
    const headers = signRequest(
      {
        method: 'GET',
        url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
        headers: { Range: 'bytes=0-9' },
        payloadSha256Hex: EMPTY_PAYLOAD_SHA256,
      },
      keys,
      at,
    );
    expect(headers['authorization']).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
        'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, ' +
        'Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
  });
  it('never puts the secret in a header', () => {
    const headers = signRequest(
      { method: 'PUT', url: new URL('https://s.example/b/k'), headers: {}, payloadSha256Hex: EMPTY_PAYLOAD_SHA256 },
      keys,
      at,
    );
    expect(JSON.stringify(headers)).not.toContain(keys.secretAccessKey);
  });
});
